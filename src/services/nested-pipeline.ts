/**
 * A pipeline of services hosted inside a service.
 *
 * SubService owns one of these; a dispatcher owns one per action it can take.
 * Everything a nested runtime cannot do for itself lives here: it has no
 * notification targets, no route to the board's log, and no idea which tenant
 * or board it belongs to, so the service hosting it has to carry all three in.
 * Getting any of them wrong is quiet rather than loud — a nested pipeline that
 * has not been told its scope writes to the wrong tenant's storage and reports
 * nothing amiss — which is why it is one implementation and not one per host.
 */
import { randomUUID } from "node:crypto";

import { childRun, HostedRuntime } from "../runtime";
import {
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceCreator,
} from "../types";

export type PipelineEntryState = {
  serviceId: string;
  instanceId: string;
  state: JsonRecord;
};

export class NestedPipeline {
  private config: ServiceConfiguration[] = [];
  private runtime: HostedRuntime | null = null;
  private releaseNotifications: (() => void) | null = null;
  private releaseLogs: (() => void) | null = null;
  private host: RuntimeHost | null = null;

  /**
   * @param label   Names the nested runtime in logs; the owning service's uuid,
   *                plus the branch it belongs to where there is more than one.
   */
  constructor(
    private readonly label: string,
    private readonly createService: ServiceCreator,
  ) {}

  /**
   * Hands over the host to report through, once there is one.
   *
   * A pipeline built in a service's constructor was built before its host
   * existed, so the scope and log settings the board records reach it here
   * rather than never.
   */
  attach(host: RuntimeHost): void {
    this.host = host;
    this.applyLogSettings();
    this.applyScope();
  }

  /** True while there is nothing to run. */
  isEmpty(): boolean {
    return !this.runtime || this.runtime.listServices().length === 0;
  }

  /** Replaces the whole pipeline. Throws if the configuration is malformed. */
  setPipeline(value: unknown): void {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid pipeline format for '${this.label}'`);
    }
    const next = normalizePipelineArray(value);
    if (!next) {
      throw new Error(`Invalid pipeline format for '${this.label}'`);
    }
    this.config = next;
    this.rebuild();
  }

  append(entry: unknown): void {
    const appended = normalizePipelineEntry(entry);
    if (!appended) {
      throw new Error(`Invalid appendService payload for '${this.label}'`);
    }
    this.syncStates();
    this.config.push(appended);
    this.rebuild();
  }

  remove(uuid: string): void {
    this.syncStates();
    this.config = this.config.filter((entry) => entry.uuid !== uuid);
    this.rebuild();
  }

  configureService(instanceId: string, state: JsonRecord): void {
    if (!this.runtime) {
      return;
    }
    this.runtime.configureService(instanceId, state);
    this.syncStates();
  }

  /**
   * Runs the pipeline as a run of its own, descended from `parent`.
   *
   * What happens inside stays attributable to the service hosting it rather
   * than blending into the pipeline around it.
   */
  async process(input: unknown, parent: ProcessContext | null): Promise<unknown> {
    if (!this.runtime || this.isEmpty()) {
      return input;
    }
    // No-op: the nested runtime already fans notifications out to the target
    // registered in rebuild(). Forwarding them here too would deliver each twice.
    return this.runtime.process(input, () => {}, childRun(parent));
  }

  /**
   * Hands the tenant and board down.
   *
   * The runtime calls this when its own scope is set, which is how a pipeline
   * nested more than one level deep hears about it at all: `attach` runs while
   * the service holding it is being built, and at that moment the runtime
   * holding *that* does not know its scope either. Nesting changes where a
   * service sits, not who it answers to.
   */
  setScope(scope: RuntimeScope): void {
    this.runtime?.setScope(scope);
  }

  /** The pipeline as the board records it. */
  state(): PipelineEntryState[] {
    if (!this.runtime) {
      return this.config.map((entry) => ({
        serviceId: entry.serviceId,
        instanceId: entry.uuid,
        state: entry.state ?? {},
      }));
    }
    return this.runtime.listServices().map((service) => ({
      serviceId: service.serviceId,
      instanceId: service.uuid,
      state: service.state as JsonRecord,
    }));
  }

  /** The live services, for a host that needs to read or configure them. */
  services(): ReturnType<HostedRuntime["listServices"]> {
    return this.runtime?.listServices() ?? [];
  }

  destroy(): void {
    this.releaseNotifications?.();
    this.releaseNotifications = null;
    this.releaseLogs?.();
    this.releaseLogs = null;
    // Nested services hold the same things top-level ones do — timers, sockets,
    // mounts — and nothing else will ever reach them once this is gone.
    this.runtime?.destroy();
    this.runtime = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private rebuild(): void {
    this.releaseNotifications?.();
    this.releaseLogs?.();
    // The runtime being replaced is about to become unreachable; its services
    // keep running until told otherwise. State worth carrying over has already
    // been read into `config` by syncStates().
    this.runtime?.destroy();
    this.runtime = new HostedRuntime(
      {
        id: `${this.label}:sub-runtime`,
        name: this.label,
        boardName: "",
        services: this.config,
      },
      this.createService,
    );

    // A nested runtime has no notification targets of its own, so what its
    // services report reaches nobody unless the service hosting it carries it
    // out to the board. Services report through their host precisely because it
    // is not always a call they are answering: an autonomous emitter has no
    // caller to report to.
    this.releaseNotifications = this.runtime.registerNotificationTarget(
      (notification) =>
        this.host?.notify(notification.payload, notification.instanceId),
    );

    // A nested pipeline's entries belong to the same board log as everything
    // else; only the runtime hosting this service can carry them there.
    this.releaseLogs = this.runtime.registerLogTarget((entry) =>
      this.host?.forwardLog(entry),
    );

    this.applyLogSettings();
    this.applyScope();
  }

  private applyLogSettings(): void {
    const settings = this.host?.logSettings();
    if (!settings || !this.runtime) {
      return;
    }
    this.runtime.setLogging(settings.logging);
    this.runtime.setLogData(settings.logData);
  }

  private applyScope(): void {
    const scope = this.host?.scope();
    if (scope && this.runtime) {
      this.runtime.setScope(scope);
    }
  }

  /** Reads live state back into the configuration before it is rebuilt from. */
  private syncStates(): void {
    if (!this.runtime) {
      return;
    }
    const byId = new Map(
      this.runtime
        .listServices()
        .map((service) => [service.uuid, service.state] as const),
    );
    this.config = this.config.map((entry) => {
      const state = byId.get(entry.uuid);
      if (!state || !isJsonRecord(state)) {
        return entry;
      }
      return { ...entry, state };
    });
  }
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePipelineArray(
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

export function normalizePipelineEntry(
  value: unknown,
): ServiceConfiguration | null {
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
