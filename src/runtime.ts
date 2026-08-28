import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  HostedService,
  HostedServiceFactory,
  JsonRecord,
  LogEntry,
  LogLevel,
  ProcessContext,
  RuntimeConfiguration,
  RuntimeDescriptor,
  RuntimeHost,
  RuntimeNotification,
  RuntimeScope,
  ServiceCreator,
  ServiceConfiguration,
  ServiceDescriptor,
} from "./types";
import { ANONYMOUS_SUB } from "./auth";
import { MountHandle, MountHandlers } from "./mounts";

/** Severity order, so a runtime can drop anything below what it records. */
export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** A run with no parent: something outside the board asked for this. */
export function newRun(): ProcessContext {
  return { runId: randomUUID() };
}

/**
 * Reads a context a peer sent, filling in what it left out.
 *
 * A caller that names no run is not continuing one, so a run is begun rather
 * than left unidentified — work that cannot be attributed to anything is worse
 * than work attributed to a run of its own. Returns undefined only when there
 * was no context at all, which lets the caller decide.
 */
export function contextFromWire(value: unknown): ProcessContext | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const wire = value as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof wire[key] === "string" && wire[key] ? (wire[key] as string) : undefined;

  return {
    runId: str("runId") ?? randomUUID(),
    parentRunId: str("parentRunId"),
    requestId: str("requestId"),
  };
}

/**
 * A run invoked from inside another one, as a nested pipeline is.
 *
 * The child gets an identity of its own rather than borrowing its parent's, so
 * that work done inside a sub-pipeline stays distinguishable from work done
 * around it — which is the whole difference between a trace that shows nesting
 * and one that shows a flat list in timestamp order.
 */
export function childRun(parent: ProcessContext | null): ProcessContext {
  return parent
    ? { runId: randomUUID(), parentRunId: parent.runId }
    : newRun();
}

/**
 * Grants a runtime's services public endpoints. Supplied by the server, which
 * owns the listening socket; absent for inner sub-service pipelines, which are
 * not addressable from outside.
 */
export type RuntimeMounts = {
  mount(
    serviceUuid: string,
    handlers: MountHandlers,
    options?: { boardName?: string; mountName?: string },
  ): MountHandle | null;
};

export class HostedRuntime implements RuntimeHost {
  readonly id: string;
  readonly name: string;
  boardName: string;
  /** The tenant this runtime answers to; see RuntimeScope. */
  private owner: string;
  /** See RuntimeConfiguration.garbageCollected. Absent means persist. */
  readonly garbageCollected: boolean;

  private readonly services = new Map<string, HostedService>();
  private serviceOrder: string[] = [];
  private readonly notificationTargets = new Set<
    (notification: RuntimeNotification) => void
  >();
  private readonly resultTargets = new Set<(result: unknown) => void>();
  private readonly createService: ServiceCreator;
  private readonly mounts?: RuntimeMounts;
  /**
   * The call being processed right now, and which service it is inside.
   *
   * Async-local rather than a field: a pass awaits the services it calls, so
   * two runs started independently — a timer tick and an arriving message —
   * interleave freely. A plain field would let the second overwrite the first's
   * context mid-await, and every log entry and captured run id after that point
   * would name the wrong run. `AsyncLocalStorage` gives each run its own view
   * and restores the outer one on the way out, which is what a nested pull
   * needs.
   */
  private readonly runState = new AsyncLocalStorage<{
    context: ProcessContext;
    service: string | null;
  }>();
  private readonly logTargets = new Set<(entry: LogEntry) => void>();
  /** See RuntimeConfiguration.logData. A board-wide override, not the gate. */
  private logData = true;
  /** Whether anything is recorded at all; see RuntimeConfiguration.logging. */
  private logging = false;
  /** The least severe level recorded; see RuntimeConfiguration.logLevel. */
  private logLevel: LogLevel = "info";

  constructor(
    config: RuntimeConfiguration,
    createService: (config: ServiceConfiguration) => HostedService,
    mounts?: RuntimeMounts,
    // Known only to whoever resolved the caller, so it is passed in rather than
    // read from the config a client sent. Absent collapses to the single tenant
    // an unauthenticated server already uses.
    owner: string = ANONYMOUS_SUB,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.owner = owner;
    this.boardName = config.boardName ?? "";
    this.garbageCollected = config.garbageCollected === true;
    this.logData = config.logData !== false;
    this.logging = config.logging === true;
    if (config.logLevel && config.logLevel in LOG_LEVELS) {
      this.logLevel = config.logLevel;
    }
    this.createService = createService;
    this.mounts = mounts;

    for (const serviceConfig of config.services) {
      this.addService(serviceConfig);
    }
  }

  serialize(outputUrl?: string): RuntimeDescriptor {
    const descriptor: RuntimeDescriptor = {
      id: this.id,
      name: this.name,
      garbageCollected: this.garbageCollected,
      boardName: this.boardName,
      services: this.listServices(),
      inputs: [],
    };

    if (outputUrl) {
      descriptor.outputUrl = outputUrl;
    }

    return descriptor;
  }

  listServices(): ServiceDescriptor[] {
    return this.serviceOrder
      .map((serviceId) => this.services.get(serviceId))
      .filter((service): service is HostedService => Boolean(service))
      .map((service) => ({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        version: service.version,
        capabilities: service.capabilities,
        uuid: service.uuid,
        state: service.getState(),
      }));
  }

  getService(uuid: string): HostedService | undefined {
    return this.services.get(uuid);
  }

  addService(config: ServiceConfiguration): JsonRecord {
    if (this.services.has(config.uuid)) {
      throw new Error(`Service already exists: ${config.uuid}`);
    }

    const service = this.createService(config);

    service.setHost?.(this);

    this.services.set(service.uuid, service);
    this.serviceOrder.push(service.uuid);
    return service.getState();
  }

  configureService(uuid: string, config: JsonRecord): JsonRecord | null {
    const service = this.services.get(uuid);
    if (!service) {
      return null;
    }
    return service.configure(config);
  }

  removeService(uuid: string): boolean {
    const service = this.services.get(uuid);
    service?.destroy?.();

    const deleted = this.services.delete(uuid);
    if (deleted) {
      this.serviceOrder = this.serviceOrder.filter(
        (serviceUuid) => serviceUuid !== uuid,
      );
    }
    return deleted;
  }

  destroy(): void {
    for (const service of this.services.values()) {
      service.destroy?.();
    }
    this.services.clear();
    this.serviceOrder = [];
    this.notificationTargets.clear();
    this.resultTargets.clear();
    this.logTargets.clear();
  }

  registerNotificationTarget(
    target: (notification: RuntimeNotification) => void,
  ): () => void {
    this.notificationTargets.add(target);
    return () => {
      this.notificationTargets.delete(target);
    };
  }

  registerResultTarget(target: (result: unknown) => void): () => void {
    this.resultTargets.add(target);
    return () => {
      this.resultTargets.delete(target);
    };
  }

  emitResult(output: unknown): void {
    for (const target of this.resultTargets) {
      target(output);
    }
  }

  rearrangeServices(newOrder: string[]): boolean {
    if (newOrder.length !== this.serviceOrder.length) {
      return false;
    }

    const known = new Set(this.serviceOrder);
    for (const uuid of newOrder) {
      if (!known.has(uuid)) {
        return false;
      }
    }

    this.serviceOrder = [...newOrder];
    return true;
  }

  process(
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
    context?: ProcessContext,
  ): Promise<unknown> {
    return this.withContext(context ?? newRun(), () =>
      this.processFromIndex(0, input, onNotification),
    );
  }

  // ── RuntimeHost ────────────────────────────────────────────────────────────

  currentContext(): ProcessContext | null {
    return this.runState.getStore()?.context ?? null;
  }

  /** Which service the current pass is inside, for a log entry to name. */
  private get currentService(): string | null {
    return this.runState.getStore()?.service ?? null;
  }

  processFrom(
    startAfterUuid: string,
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
    context?: ProcessContext,
  ): Promise<unknown> {
    const startIndex = this.serviceOrder.indexOf(startAfterUuid) + 1;
    // Three ways to arrive here, and each wants a different run:
    //
    // - Named explicitly: a service that left its call and came back — an HTTP
    //   response, an awaited write — handing back what it captured.
    // - Called from inside a call: a service pulling the services after it
    //   rather than returning to them. Still the same run, and the current
    //   context already says which, so nothing has to be threaded by hand.
    // - Neither: a timer tick, an arriving message. Nothing to continue, so
    //   this begins a run.
    //
    // A service that leaves its call and forgets to capture lands in the third
    // case, which splits its trace in two rather than attributing its work to
    // whichever run happened to be in flight. Fragmentation is visible in a
    // trace; misattribution reads as fact.
    const runContext = context ?? this.currentContext() ?? newRun();

    // A service pushing from itself (a Timer tick, an inbound message, a peer
    // event) was never called by the loop below, so the loop never reported it.
    // Report it here, or the UI shows a service producing nothing while the
    // service after it plainly receives data.
    this.emitNotification(
      {
        instanceId: startAfterUuid,
        payload: { __internal: { state: "call-process", data: null } },
      },
      onNotification,
    );
    this.emitNotification(
      {
        instanceId: startAfterUuid,
        payload: { __internal: { state: "call-process-finished", data: input } },
      },
      onNotification,
    );

    return this.withContext(runContext, () =>
      this.processFromIndex(startIndex, input, onNotification),
    );
  }

  /**
   * Runs the pipeline starting **at** a service rather than after it.
   *
   * `processFrom` exists for a service handing work onward — it means "carry on
   * behind me", so it advances past the caller. This is the other question:
   * something outside the pipeline wants a particular service to do its job
   * with a given payload, and that service must actually run.
   *
   * hkp-rt spells the same distinction as `processFrom(service, data,
   * advanceBefore)`; kept as a separate entry point here so the advancing call,
   * which every service uses, cannot change shape by accident.
   */
  processAt(
    startAtUuid: string,
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
    context?: ProcessContext,
  ): Promise<unknown> {
    const startIndex = this.serviceOrder.indexOf(startAtUuid);
    if (startIndex < 0) {
      throw new Error(`No such service: ${startAtUuid}`);
    }
    // Nothing to continue: whoever asked for this is outside the board, so it
    // begins a run rather than joining one.
    return this.withContext(context ?? newRun(), () =>
      this.processFromIndex(startIndex, input, onNotification),
    );
  }

  notify(payload: unknown, instanceId: string): void {
    this.emitNotification({ instanceId, payload }, () => {});
  }

  log(level: LogLevel, event: string, data?: unknown): void {
    // Nothing to attribute an entry to means nothing worth recording: a service
    // logging outside a call has no run, and an entry that names no run cannot
    // be found again.
    // Off means off: no entry is built, so nothing is spent deciding what it
    // would have said.
    if (
      !this.logging ||
      LOG_LEVELS[level] < LOG_LEVELS[this.logLevel] ||
      this.logTargets.size === 0
    ) {
      return;
    }

    const run = this.currentContext();
    if (!run) {
      return;
    }

    const entry: LogEntry = {
      runId: run.runId,
      ts: new Date().toISOString(),
      runtimeId: this.id,
      serviceUuid: this.currentService ?? "",
      level,
      event,
    };
    if (run.parentRunId) {
      entry.parentRunId = run.parentRunId;
    }
    if (this.logData && data !== undefined) {
      entry.data = data;
    }

    for (const target of this.logTargets) {
      target(entry);
    }
  }

  /** service.processed, carrying how long the call took. */
  private logProcessed(result: unknown, durationMs: number): void {
    if (!this.logging || LOG_LEVELS.debug < LOG_LEVELS[this.logLevel]) {
      return;
    }
    const before = this.logTargets.size;
    const run = this.currentContext();
    if (before === 0 || !run) {
      return;
    }
    for (const target of this.logTargets) {
      target({
        runId: run.runId,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ts: new Date().toISOString(),
        runtimeId: this.id,
        serviceUuid: this.currentService ?? "",
        level: "debug",
        event: "service.processed",
        durationMs,
      });
    }
  }

  /**
   * Where this runtime's entries go. The server registers one to carry them to
   * the board's coordinator; a nested pipeline's host registers one to carry
   * them out to the runtime around it.
   */
  registerLogTarget(target: (entry: LogEntry) => void): () => void {
    this.logTargets.add(target);
    return () => {
      this.logTargets.delete(target);
    };
  }

  /** Forwards an entry produced by a nested pipeline, unchanged. */
  forwardLog(entry: LogEntry): void {
    for (const target of this.logTargets) {
      target(entry);
    }
  }

  setLogData(enabled: boolean): void {
    this.logData = enabled;
  }

  getLogData(): boolean {
    return this.logData;
  }

  logSettings(): { logging: boolean; logData: boolean; logLevel: LogLevel } {
    return {
      logging: this.logging,
      logData: this.logData,
      logLevel: this.logLevel,
    };
  }

  scope(): RuntimeScope {
    return { owner: this.owner, boardName: this.boardName };
  }

  /**
   * Adopt the scope of the runtime around this one.
   *
   * A nested pipeline is built by the service hosting it, which knows neither
   * tenant nor board — so a runtime created that way starts anonymous, and
   * anything it stores would land beside every other anonymous board's. The
   * host hands it the scope once there is one to hand.
   */
  setScope(scope: RuntimeScope): void {
    this.owner = scope.owner;
    this.boardName = scope.boardName;
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  getLogLevel(): LogLevel {
    return this.logLevel;
  }

  setLogging(enabled: boolean): void {
    this.logging = enabled;
  }

  getLogging(): boolean {
    return this.logging;
  }

  mount(
    serviceUuid: string,
    handlers: MountHandlers,
    options: { mountName?: string } = {},
  ): MountHandle | null {
    // The board comes from the runtime, not from the service: a mount's address
    // is derived from where it sits, and a service does not know that.
    return (
      this.mounts?.mount(serviceUuid, handlers, {
        boardName: this.boardName,
        mountName: options.mountName,
      }) ?? null
    );
  }

  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Runs `fn` with `context` as the current one, restoring what was there
   * before.
   *
   * Restoring rather than clearing is what makes this survive a service that
   * calls back into this runtime from inside its own `process` — the pull that
   * a cache miss or a router performs. That inner call is still part of the
   * outer run, and when it returns the outer loop has more services to visit,
   * so the context it was running under has to come back.
   *
   * Safe as ambient state only because a pass is synchronous: the loop never
   * yields, so no second call can interleave with this one and observe a
   * context that is not its own. A pass that awaited would need the context
   * threaded through the call instead.
   */
  private withContext<T>(context: ProcessContext, fn: () => T): T {
    // The service is carried alongside the context so both are restored
    // together on the way out of a nested pull.
    return this.runState.run({ context, service: this.currentService }, fn);
  }

  /** Runs `fn` with the pass recorded as being inside `uuid`. */
  private inService<T>(uuid: string | null, fn: () => T): T {
    const store = this.runState.getStore();
    if (!store) {
      return fn();
    }
    const outer = store.service;
    store.service = uuid;
    try {
      return fn();
    } finally {
      store.service = outer;
    }
  }

  private async processFromIndex(
    startIndex: number,
    input: unknown,
    onNotification: (notification: RuntimeNotification) => void,
  ): Promise<unknown> {
    let result: unknown = input;

    for (const uuid of this.serviceOrder.slice(startIndex)) {
      const service = this.services.get(uuid);
      if (!service) {
        continue;
      }

      this.emitNotification(
        {
          instanceId: uuid,
          payload: {
            __internal: {
              state: "call-process",
              data: result,
            },
          },
        },
        onNotification,
      );

      const startedAt = Date.now();
      // Restored rather than cleared, for the same reason the context is: a
      // service that pulls the ones after it re-enters this loop, and when it
      // returns the entries that follow still belong to the service that
      // pulled.
      const pending = this.inService(uuid, () => {
        // The flow itself, at debug: which service the runtime called, and
        // below, what it returned and how long it took.
        //
        // Deliberately without the value flowing through. The level says how
        // much of the shape of a run to keep, and turning it up must not also
        // start recording the data — a board author reaching for more detail
        // about *what ran* is not asking to write payloads to disk. What flows
        // through is recorded only where a service was configured to record it.
        this.log("debug", "service.process");
        return service.process(result, (payload, instanceId) => {
          this.emitNotification(
            { instanceId: instanceId ?? uuid, payload },
            onNotification,
          );
        });
      });

      // A service may answer within the call or after it. Awaiting either is
      // what lets the one that answers late still be a service the pipeline
      // reads a result from, rather than one that has to call the rest of the
      // pipeline itself. Awaiting a plain value costs a microtask.
      result = isThenable(pending) ? await pending : pending;
      this.inService(uuid, () =>
        this.logProcessed(result, Date.now() - startedAt),
      );

      this.emitNotification(
        {
          instanceId: uuid,
          payload: {
            __internal: {
              state: "call-process-finished",
              data: result,
            },
          },
        },
        onNotification,
      );

      if (result === null || result === undefined) {
        // Where the run ended, named. Recorded above debug because it is the
        // outcome of the run rather than a step in it: a board that keeps only
        // what matters still wants to know its flow stopped, and where.
        this.inService(uuid, () => this.log("info", "pipeline.stopped"));
        break;
      }
    }

    return result;
  }

  private emitNotification(
    notification: RuntimeNotification,
    onNotification: (notification: RuntimeNotification) => void,
  ): void {
    onNotification(notification);
    for (const target of this.notificationTargets) {
      target(notification);
    }
  }
}

/**
 * A single tenant's view of the runtime app. Runtime ids are only unique within
 * an owner — boards ship stable, human-readable ids (`node`, `chat-node`), so
 * two users loading the same board must each get their own runtime rather than
 * sharing one. Every route resolves runtimes through one of these views, so a
 * handler cannot reach another tenant's runtime even by id.
 */
export class TenantRuntimes {
  constructor(
    readonly owner: string,
    private readonly app: RuntimeApp,
  ) {}

  createRuntime(config: RuntimeConfiguration): HostedRuntime {
    return this.app.createRuntime(this.owner, config);
  }

  getRuntime(runtimeId: string): HostedRuntime | undefined {
    return this.app.getRuntime(this.owner, runtimeId);
  }

  getRuntimes(): HostedRuntime[] {
    return this.app.getRuntimes(this.owner);
  }

  removeRuntime(runtimeId: string): boolean {
    return this.app.removeRuntime(this.owner, runtimeId);
  }

  removeAllRuntimes(): void {
    this.app.removeAllRuntimes(this.owner);
  }
}

export class RuntimeApp {
  // ownerKey → runtimeId → runtime. The owner key is the authenticated `sub`
  // (or "anonymous" when auth is off, collapsing to a single bucket).
  private readonly runtimes = new Map<string, Map<string, HostedRuntime>>();

  constructor(
    private readonly registry: Map<string, HostedServiceFactory>,
    // Supplied by the server, which owns the listening socket. Absent in tests
    // and anywhere runtimes need no public endpoints.
    private readonly mountsFor?: (
      owner: string,
      runtimeId: string,
    ) => RuntimeMounts,
  ) {}

  /** A tenant-scoped view; the only way route handlers reach runtimes. */
  forOwner(owner: string): TenantRuntimes {
    return new TenantRuntimes(owner, this);
  }

  createRuntime(owner: string, config: RuntimeConfiguration): HostedRuntime {
    const owned = this.ownerRuntimes(owner);
    const existing = owned.get(config.id);
    existing?.destroy();

    const runtime = new HostedRuntime(
      config,
      (serviceConfig) => this.createService(serviceConfig),
      this.mountsFor?.(owner, config.id),
      owner,
    );
    owned.set(runtime.id, runtime);
    return runtime;
  }

  getRuntime(owner: string, runtimeId: string): HostedRuntime | undefined {
    return this.runtimes.get(owner)?.get(runtimeId);
  }

  getRuntimes(owner: string): HostedRuntime[] {
    const owned = this.runtimes.get(owner);
    return owned ? [...owned.values()] : [];
  }

  removeRuntime(owner: string, runtimeId: string): boolean {
    const owned = this.runtimes.get(owner);
    if (!owned) {
      return false;
    }
    const runtime = owned.get(runtimeId);
    runtime?.destroy();
    const deleted = owned.delete(runtimeId);
    if (owned.size === 0) {
      this.runtimes.delete(owner);
    }
    return deleted;
  }

  removeAllRuntimes(owner: string): void {
    const owned = this.runtimes.get(owner);
    if (!owned) {
      return;
    }
    for (const runtime of owned.values()) {
      runtime.destroy();
    }
    this.runtimes.delete(owner);
  }

  getRegistry() {
    return [...this.registry.values()].map((entry) => entry.descriptor);
  }

  private ownerRuntimes(owner: string): Map<string, HostedRuntime> {
    const existing = this.runtimes.get(owner);
    if (existing) {
      return existing;
    }
    const created = new Map<string, HostedRuntime>();
    this.runtimes.set(owner, created);
    return created;
  }

  createService(config: ServiceConfiguration): HostedService {
    const factory = this.registry.get(config.serviceId);
    if (!factory) {
      throw new Error(`Unknown serviceId: ${config.serviceId}`);
    }
    return factory.create(config, (serviceConfig) =>
      this.createService(serviceConfig),
    );
  }
}

/** Whether a value is worth awaiting — a promise, or anything promise-like. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}
