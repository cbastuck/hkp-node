import { randomUUID } from "node:crypto";

import { HostedRuntime } from "../runtime";
import {
  HostedService,
  JsonRecord,
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
  private readonly createService: ServiceCreator;

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    this.uuid = config.uuid;
    this.createService = createService;

    if (config.state) {
      this.configure(config.state);
    }
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
    notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (
      this.bypass ||
      !this.pipeline ||
      this.pipeline.listServices().length === 0
    ) {
      return input;
    }

    return this.pipeline.process(input, (notification) => {
      notify(notification.payload, notification.instanceId);
    });
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
    this.pipeline = new HostedRuntime(
      {
        id: `${this.uuid}:sub-runtime`,
        name: `${this.serviceName}-${this.uuid}`,
        boardName: "",
        services: this.pipelineConfig,
      },
      this.createService,
    );
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
