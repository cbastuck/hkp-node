/**
 * Service Documentation
 * Service ID: sub-service
 * Service Name: SubService
 * Runtime: hkp-node
 * Modes: sub-pipeline execution
 * Key Config: pipeline/subservices configuration
 * IO: in=any -> out=pipeline result
 * Arrays: service-defined, typically forwarded
 * Binary: depends on nested services
 * MixedData: not native in runtime
 */
import { randomUUID } from "node:crypto";

import { childRun, HostedRuntime } from "../runtime";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";

export const subServiceDescriptor: ServiceRegistryEntry = {
  serviceId: "sub-service",
  serviceName: "SubService",
  capabilities: ["subservices"],
};

type SubServiceState = JsonRecord & {
  bypass: boolean;
  pipeline: Array<{
    serviceId: string;
    instanceId: string;
    state: JsonRecord;
  }>;
};

export class SubService implements HostedService {
  readonly serviceId = subServiceDescriptor.serviceId;
  readonly serviceName = subServiceDescriptor.serviceName;
  readonly capabilities = subServiceDescriptor.capabilities;
  readonly uuid: string;

  private bypass = false;
  private pipelineConfig: ServiceConfiguration[] = [];
  private pipeline: HostedRuntime | null = null;
  private releasePipelineNotifications: (() => void) | null = null;
  private releasePipelineLogs: (() => void) | null = null;
  private readonly createService: ServiceCreator;
  private host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    this.uuid = config.uuid;
    this.createService = createService;

    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    // A pipeline built in the constructor was built before there was a host to
    // ask, so what the board records reaches it here rather than never.
    this.applyLogSettings();
  }

  /** Hands the board's log settings to the nested pipeline, if there is one. */
  private applyLogSettings(): void {
    const settings = this.host?.logSettings();
    if (!settings || !this.pipeline) {
      return;
    }
    this.pipeline.setLogging(settings.logging);
    this.pipeline.setLogData(settings.logData);
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }

    if (Array.isArray(config.pipeline)) {
      const nextPipeline = normalizePipelineArray(config.pipeline);
      if (!nextPipeline) {
        throw new Error("Invalid sub-service pipeline format");
      }
      this.pipelineConfig = nextPipeline;
      this.rebuild();
      return this.getState();
    }

    if (isJsonRecord(config.appendService)) {
      const appended = normalizePipelineEntry(config.appendService);
      if (!appended) {
        throw new Error("Invalid appendService payload");
      }
      this.syncStates();
      this.pipelineConfig.push(appended);
      this.rebuild();
      return this.getState();
    }

    if (typeof config.removeService === "string") {
      this.syncStates();
      this.pipelineConfig = this.pipelineConfig.filter(
        (entry) => entry.uuid !== config.removeService,
      );
      this.rebuild();
      return this.getState();
    }

    if (isJsonRecord(config.configureService)) {
      const payload = config.configureService;
      if (
        typeof payload.instanceId === "string" &&
        isJsonRecord(payload.state) &&
        this.pipeline
      ) {
        this.pipeline.configureService(payload.instanceId, payload.state);
        this.syncStates();
      }
    }

    return this.getState();
  }

  getState(): JsonRecord {
    const state: SubServiceState = {
      bypass: this.bypass,
      pipeline: this.getPipelineState(),
    };
    return state;
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (
      this.bypass ||
      !this.pipeline ||
      this.pipeline.listServices().length === 0
    ) {
      return input;
    }

    // No-op: the nested runtime fans these out to the target registered in
    // rebuild(). Forwarding them here as well would deliver every one twice.
    // The nested pipeline runs as a run of its own, descended from the one
    // calling it, so what happens inside stays attributable to this service
    // rather than blending into the pipeline around it.
    return this.pipeline.process(
      input,
      () => {},
      childRun(this.host?.currentContext() ?? null),
    );
  }

  destroy(): void {
    this.releasePipelineNotifications?.();
    this.releasePipelineNotifications = null;
    this.releasePipelineLogs?.();
    this.releasePipelineLogs = null;
    // Nested services hold the same things top-level ones do — timers, sockets,
    // mounts — and nothing else will ever reach them once this service is gone.
    this.pipeline?.destroy();
    this.pipeline = null;
  }

  private syncStates(): void {
    if (!this.pipeline) {
      return;
    }

    const byId = new Map(
      this.pipeline
        .listServices()
        .map((service) => [service.uuid, service.state] as const),
    );

    this.pipelineConfig = this.pipelineConfig.map((entry) => {
      const state = byId.get(entry.uuid);
      if (!state || !isJsonRecord(state)) {
        return entry;
      }
      return { ...entry, state };
    });
  }

  private rebuild(): void {
    this.releasePipelineNotifications?.();
    // The pipeline being replaced is about to become unreachable; its services
    // keep running until told otherwise. State worth carrying over has already
    // been read into pipelineConfig by syncStates().
    this.pipeline?.destroy();
    this.pipeline = new HostedRuntime(
      {
        id: `${this.uuid}:sub-runtime`,
        name: `${this.serviceName}-${this.uuid}`,
        boardName: "",
        services: this.pipelineConfig,
      },
      this.createService,
    );

    // A nested runtime has no notification targets of its own, so what its
    // services report — a Timer's tick, a Hold's counts — reaches nobody unless
    // the service hosting the pipeline carries it out to the board. Services
    // report through their host precisely because it is not always a call they
    // are answering: an autonomous emitter has no caller to report to.
    this.releasePipelineNotifications =
      this.pipeline.registerNotificationTarget((notification) =>
        this.host?.notify(notification.payload, notification.instanceId),
      );

    // A nested pipeline's entries belong to the same board log as everything
    // else; only the runtime hosting this service can carry them there, since a
    // nested runtime has no route out of its own.
    this.releasePipelineLogs = this.pipeline.registerLogTarget((entry) =>
      this.host?.forwardLog(entry),
    );

    this.applyLogSettings();
  }

  private getPipelineState(): SubServiceState["pipeline"] {
    if (!this.pipeline) {
      return this.pipelineConfig.map((entry) => ({
        serviceId: entry.serviceId,
        instanceId: entry.uuid,
        state: entry.state ?? {},
      }));
    }

    return this.pipeline.listServices().map((service) => ({
      serviceId: service.serviceId,
      instanceId: service.uuid,
      state: service.state,
    }));
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePipelineArray(
  value: unknown[],
): ServiceConfiguration[] | null {
  const result: ServiceConfiguration[] = [];
  for (const entry of value) {
    const normalized = normalizePipelineEntry(entry);
    if (!normalized) {
      return null;
    }
    result.push(normalized);
  }
  return result;
}

function normalizePipelineEntry(value: unknown): ServiceConfiguration | null {
  if (!isJsonRecord(value) || typeof value.serviceId !== "string") {
    return null;
  }

  const instanceId =
    typeof value.instanceId === "string" && value.instanceId.length > 0
      ? value.instanceId
      : typeof value.uuid === "string" && value.uuid.length > 0
        ? value.uuid
        : randomUUID();

  const state = value.state;
  if (state !== undefined && !isJsonRecord(state)) {
    return null;
  }

  return {
    serviceId: value.serviceId,
    uuid: instanceId,
    name: typeof value.name === "string" ? value.name : undefined,
    serviceName:
      typeof value.serviceName === "string" ? value.serviceName : undefined,
    state,
  };
}
