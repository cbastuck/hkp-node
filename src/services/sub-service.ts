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

import { joinAddress } from "../address";
import { childRun, HostedRuntime } from "../runtime";
import { MOUNT_FIELD, collectMountRefs } from "../coordinator/mount";
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
  SlotStore,
} from "../types";

export const subServiceDescriptor: ServiceRegistryEntry = {
  serviceId: "sub-service",
  serviceName: "SubService",
  capabilities: ["subservices"],
};

/**
 * Where a scope's pipeline holds what it holds.
 *
 * `own` is a store of this service's, so two copies of the same scope on one
 * runtime do not clobber each other's cells and a name used inside means
 * nothing outside. `inherit` reaches the runtime around it, so a slot named
 * inside a scope is the same cell as one named next to it.
 */
export type ScopeSlots = "own" | "inherit";

type SubServiceState = JsonRecord & {
  bypass: boolean;
  stopPropagation: boolean;
  scope: { slots: ScopeSlots };
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

  // Protected, not private: an Iterator is a sub-service that runs its pipeline
  // once per item rather than once, and needs these to do it.
  protected bypass = false;
  /**
   * Whether what this pipeline produced leaves this service.
   *
   * A scope that ends here rather than feeding the services after it: the two
   * flows on one runtime that a Stopper between them used to mark by
   * convention. False — and absent — is the pipeline a board already has, so
   * every board that says nothing about it goes on passing its result along.
   *
   * It closes **both** routes out, which is the whole of the work: `process`
   * returns null, and `emitOutward` drops what the pipeline emitted on its own
   * — a Timer tick, or a service that answered null and came back later. A
   * scope holding one of those would otherwise go on pushing into the board
   * long after its own answer stopped.
   */
  protected stopPropagation = false;
  /**
   * What this scope keeps to itself.
   *
   * One block rather than a flat key because a scope has more than one thing
   * to say about what its children can see — which credentials they resolve,
   * what they log — and those should read as one statement about a boundary
   * rather than as keys added one at a time.
   */
  protected scopeSlots: ScopeSlots = "own";
  /**
   * The cells a scope of its own holds values in.
   *
   * Owned here rather than left to the nested runtime so that rebuilding the
   * pipeline — which a board does on every edit to it — does not drop what was
   * being held across it.
   */
  private readonly slotStore: SlotStore = new Map<string, unknown>();
  private pipelineConfig: ServiceConfiguration[] = [];
  protected pipeline: HostedRuntime | null = null;
  private releasePipelineNotifications: (() => void) | null = null;
  private releasePipelineLogs: (() => void) | null = null;
  private releasePipelineResults: (() => void) | null = null;
  private readonly createService: ServiceCreator;
  protected host: RuntimeHost | null = null;

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
    this.applyScope();
    this.applySecrets();
    this.applySlots();
    this.applyMounts();
  }

  /**
   * Passes the scope on to the nested pipeline.
   *
   * The runtime calls this when its own scope is set, which is how a pipeline
   * nested more than one level deep hears about it at all: `setHost` runs while
   * this service is being built, and at that moment the runtime holding it does
   * not know its scope either.
   */
  setScope(scope: RuntimeScope): void {
    this.pipeline?.setScope(scope);
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

  /**
   * Hands the tenant and board down to the nested pipeline.
   *
   * A pipeline this service builds knows neither, so a service inside it that
   * keeps something durable would otherwise store it outside the board it
   * belongs to — and outside its tenant, which is worse. Nesting changes where
   * a service sits, not who it answers to.
   */
  /**
   * Points the nested pipeline at this service's own secrets.
   *
   * Nothing provisions a nested runtime, so its vault is always empty: a
   * service inside the pipeline holds the same `{{secret.…}}` reference as one
   * at the top level and would have nothing to resolve it against. The host is
   * read on each lookup rather than now, both because a value may be pushed
   * after the board is running and because a pipeline nested deeper reaches
   * its own host the same way — so the chain composes to whichever runtime was
   * actually given something.
   */
  private applySecrets(): void {
    this.pipeline?.delegateSecrets(() => this.host?.secrets?.() ?? null);
  }

  /**
   * Points the nested pipeline at the cells its values are held in.
   *
   * Read on each lookup rather than now, so that changing what a scope keeps
   * to itself takes effect without rebuilding the pipeline, and so that a
   * scope inside a scope reaches outward the same way one level at a time.
   */
  private applySlots(): void {
    this.pipeline?.delegateSlots(() =>
      this.scopeSlots === "inherit"
        ? (this.host?.slots?.() ?? null)
        : this.slotStore,
    );
  }

  /**
   * Lets the services inside claim an endpoint on the runtime outside.
   *
   * A nested runtime has no server, so without this an `http-server` inside a
   * scope published no address and a board could not put one there. The name a
   * mount is derived from falls back to the **scoped address** rather than the
   * bare instanceId, so two copies of one scope do not derive the same address
   * and quietly take each other's callers; a board that named its mount keeps
   * that name, and with it the address it already had before being scoped.
   */
  private applyMounts(): void {
    this.pipeline?.delegateMounts((serviceUuid, handlers, options) =>
      this.host?.mount?.(serviceUuid, handlers, {
        // `||`, not `??`: an endpoint that was never named carries an empty
        // mountName rather than none, the same spelling mounts.ts reads.
        mountName: options.mountName || joinAddress(this.uuid, serviceUuid),
      }) ?? null,
    );
  }

  private applyScope(): void {
    const scope = this.host?.scope();
    if (scope && this.pipeline) {
      this.pipeline.setScope(scope);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }
    // Read only when it is a boolean, so a board that never mentions it keeps
    // the default rather than having one written over it by silence.
    if (typeof config.stopPropagation === "boolean") {
      this.stopPropagation = config.stopPropagation;
    }
    if (isJsonRecord(config.scope)) {
      const slots = config.scope.slots;
      if (slots === "own" || slots === "inherit") {
        this.scopeSlots = slots;
      }
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

    // An address handed to a service that holds a pipeline is handed on to the
    // services inside it. The board's coordinator resolves a mount reference
    // wherever it appears in a service's state — a nested pipeline included —
    // but configures the *service* it found it on, which for a nested consumer
    // is this one. Passing it down is what makes a mount callable from inside a
    // pipeline at all, and it is the same inheritance the nested runtime
    // already gets for secrets, scope and log settings.
    if (typeof config[MOUNT_FIELD] === "string" && config[MOUNT_FIELD]) {
      this.handDownMount(config[MOUNT_FIELD] as string);
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
      // Reported even when false, like the bypass beside it: a saved board
      // then says outright what each scope does with its answer, instead of
      // leaving a reader to infer a boundary from what follows it.
      stopPropagation: this.stopPropagation,
      scope: { slots: this.scopeSlots },
      pipeline: this.getPipelineState(),
    };
    return state;
  }

  /**
   * The nested service a scoped address names inside this one.
   *
   * What makes a sub-pipeline addressable from outside: without it the board
   * can reach this service but nothing it contains, so a facade could drive a
   * scope but not read what the scope is doing.
   */
  /**
   * Passes the retry down: an endpoint two levels in gave up on its mount for
   * the same reason one level in did, and is reached the same way.
   */
  remount(): void {
    for (const service of this.pipeline?.listServices() ?? []) {
      this.pipeline?.getService(service.uuid)?.remount?.();
    }
  }

  findNested(instanceId: string): HostedService | undefined {
    return this.pipeline?.getService(instanceId);
  }

  /**
   * Enters this service's pipeline at one of its services.
   *
   * The nested pipeline is a chain like any other, so this is `processAt` one
   * level down — what follows the named service inside this scope runs, and
   * what precedes it does not. The notifications go nowhere from here because
   * the nested runtime already carries its own out to the board; see rebuild().
   */
  processNested(
    address: string,
    input: unknown,
    context?: ProcessContext,
  ): Promise<unknown> {
    if (!this.pipeline) {
      throw new Error(`No such service: ${address}`);
    }
    return this.pipeline.processAt(address, input, () => {}, context);
  }

  async process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (
      this.bypass ||
      !this.pipeline ||
      this.pipeline.listServices().length === 0
    ) {
      // A scope that passes nothing on passes nothing on when there is nothing
      // to run either: what leaves this service is the board author's to say,
      // and it does not become the input again because the pipeline was empty.
      return this.stopPropagation ? null : input;
    }

    // No-op: the nested runtime fans these out to the target registered in
    // rebuild(). Forwarding them here as well would deliver every one twice.
    // The nested pipeline runs as a run of its own, descended from the one
    // calling it, so what happens inside stays attributable to this service
    // rather than blending into the pipeline around it.
    const result = await this.pipeline.process(
      input,
      () => {},
      childRun(this.host?.currentContext() ?? null),
    );
    return this.stopPropagation ? null : result;
  }

  destroy(): void {
    this.releasePipelineNotifications?.();
    this.releasePipelineNotifications = null;
    this.releasePipelineLogs?.();
    this.releasePipelineLogs = null;
    this.releasePipelineResults?.();
    this.releasePipelineResults = null;
    // Nested services hold the same things top-level ones do — timers, sockets,
    // mounts — and nothing else will ever reach them once this service is gone.
    this.pipeline?.destroy();
    this.pipeline = null;
  }

  /**
   * Gives an address to the nested services that named a mount.
   *
   * Only those that named one: a nested service holding no reference is calling
   * something it already has an address for, and must not be repointed at
   * whatever this service was told about. A reference that has been resolved
   * once keeps its own field, so this stays idempotent — `__hkpMount` is what
   * the run produced and the reference is what the board says.
   */
  private handDownMount(url: string): void {
    if (!this.pipeline) {
      return;
    }
    for (const service of this.pipeline.listServices()) {
      if (collectMountRefs(service.state).size === 0) {
        continue;
      }
      if (service.state?.[MOUNT_FIELD] === url) {
        continue;
      }
      this.pipeline.configureService(service.uuid, { [MOUNT_FIELD]: url });
    }
    this.syncStates();
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

  /**
   * Carries what the nested pipeline emitted on its own into the pipeline
   * around this service.
   *
   * A nested service that emits without being called — a Timer tick, an
   * arriving message, a deferred result from a service that returned null and
   * came back later — hands its output to its runtime, and a nested runtime's
   * output is this service's output. Nothing else forwards it: the value
   * `process` returns is the only route out of a sub-pipeline, and an
   * autonomous emitter is by definition not answering a `process` call. So the
   * services after this one are run here, and what they produce leaves the
   * board the way this service's own output would.
   */
  private async emitOutward(result: unknown): Promise<void> {
    // Null is a nested pipeline saying it has nothing to pass on, and that
    // answer is this service's answer too — the services after it do not run.
    if (result === null || result === undefined) {
      return;
    }
    // The second route out, and the one a scope would otherwise leak through.
    // What arrives here was not produced by a call this service is answering,
    // so nothing has already been stopped on its behalf: a Timer inside a
    // scope, or a service that answered null and came back with the result
    // later, would go on driving the board after the scope's own answers had
    // stopped. `process` returning null does not cover this, which is why
    // stopping propagation has to be said in both places.
    if (this.stopPropagation) {
      return;
    }
    const host = this.host;
    if (!host) {
      return;
    }
    // No-op: the runtime fans these out to its own targets, and forwarding
    // them again here would deliver every one twice.
    const output = await host.processFrom(this.uuid, result, () => {});
    host.emitResult(output);
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
    // Carried out under a scoped address rather than the bare instanceId the
    // nested service reported: an instanceId is unique only inside its own
    // pipeline, so on its own it is a name, not an address. Prefixing at each
    // boundary is what makes the path a listener hears the path it can dial.
    this.releasePipelineNotifications =
      this.pipeline.registerNotificationTarget((notification) =>
        this.host?.notify(
          notification.payload,
          joinAddress(this.uuid, notification.instanceId),
        ),
      );

    // A nested pipeline's entries belong to the same board log as everything
    // else; only the runtime hosting this service can carry them there, since a
    // nested runtime has no route out of its own.
    this.releasePipelineLogs = this.pipeline.registerLogTarget((entry) =>
      this.host?.forwardLog(entry),
    );

    // What the nested pipeline emits by itself is this service's output; see
    // emitOutward.
    this.releasePipelineResults?.();
    this.releasePipelineResults = this.pipeline.registerResultTarget(
      (result) => void this.emitOutward(result),
    );

    this.applyLogSettings();
    this.applyScope();
    this.applySecrets();
    this.applySlots();
    this.applyMounts();
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
