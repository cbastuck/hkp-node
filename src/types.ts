import { MountHandle, MountHandlers } from "./mounts";

export type JsonRecord = Record<string, unknown>;

export type ServiceRegistryEntry = {
  serviceId: string;
  serviceName: string;
  version?: string;
  capabilities?: string[];
};

export type ServiceConfiguration = {
  serviceId: string;
  uuid: string;
  name?: string;
  serviceName?: string;
  state?: JsonRecord;
};

export type RuntimeConfiguration = {
  id: string;
  name: string;
  boardName?: string;
  /**
   * Whether this runtime should be torn down once the last client that was
   * connected to it disconnects.
   *
   * Declared by whoever creates it, because only they know: a browser
   * provisioning a board it is running says `true` — it is the controller, and
   * its runtimes should not outlive it — while a coordinator, a config file or
   * a script says nothing and gets a runtime that lives until it is deleted.
   *
   * Absent means persist. Cleanup is opted into, so nothing that exists today
   * starts disappearing, and a runtime is never reaped because of who happened
   * to connect to it.
   */
  garbageCollected?: boolean;
  /**
   * Whether this runtime records anything at all.
   *
   * Off unless the board turns it on. A board that is not being looked into has
   * no reason to be writing a line per call to somebody's disk, and a log kept
   * by default is one nobody decided to keep — including for the data it holds.
   * Turning it on is the act that makes the rest of this meaningful.
   */
  logging?: boolean;
  /**
   * The least severe level this runtime records. Absent means `info`.
   *
   * The flow itself — every service call and return — is recorded at `debug`,
   * so this is what decides whether a board keeps a trace of what ran or only
   * what its services chose to say. That is the difference between a log that
   * answers "where did this stop" and one that costs almost nothing to keep.
   */
  logLevel?: LogLevel;
  /**
   * Whether this runtime's log entries may carry their `data` payload.
   *
   * Declared by the board, in the runtime's state, because it is a decision
   * about what the board is willing to record rather than one a service can
   * make for itself: `data` is the one free-form field, so it is the only place
   * a service can put something it did not mean to keep. Absent means off, so
   * the quiet default is the safe one and switching it on is deliberate.
   */
  logData?: boolean;
  services: ServiceConfiguration[];
  inputs?: Array<Record<string, unknown>>;
};

export type RuntimeDescriptor = {
  id: string;
  name: string;
  /** How this runtime is cleaned up; see RuntimeConfiguration. Reported so a
   *  client can see whether it outlives them. */
  garbageCollected?: boolean;
  boardName: string;
  services: ServiceDescriptor[];
  inputs: Array<Record<string, unknown>>;
  outputUrl?: string;
};

export type ServiceDescriptor = {
  serviceId: string;
  serviceName: string;
  version?: string;
  capabilities?: string[];
  uuid: string;
  state: JsonRecord;
};

export interface HostedService {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly version?: string;
  readonly capabilities?: string[];
  readonly uuid: string;
  configure(config: JsonRecord): JsonRecord;
  getState(): JsonRecord;
  process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): unknown;
  setHost?(host: RuntimeHost): void;
  destroy?(): void;
}

export type ServiceCreator = (config: ServiceConfiguration) => HostedService;

export type HostedServiceFactory = {
  descriptor: ServiceRegistryEntry;
  create: (
    config: ServiceConfiguration,
    createService: ServiceCreator,
  ) => HostedService;
};

export type RuntimeNotification = {
  instanceId: string;
  payload: unknown;
};

/**
 * The tenant and board a runtime belongs to.
 *
 * Board rather than runtime, because a board is the unit a person thinks in:
 * two runtimes of one board are two halves of one app, and something one half
 * stored is something the other half should find.
 */
export type RuntimeScope = {
  /** The authenticated `sub`, or ANONYMOUS_SUB where auth is off. */
  owner: string;
  boardName: string;
};

/**
 * What travels with a process call rather than with the data it carries.
 *
 * The ordered service list says what runs; this says which invocation it is
 * running as. The distinction matters as soon as anything has to attribute work
 * after the fact — which run produced this, and what invoked that run — because
 * the payload cannot answer it: the same data can flow through the same
 * services for entirely unrelated reasons.
 *
 * Kept deliberately separate from `requestId`, which the browser and hkp-rt
 * runtimes carry for a different purpose: `requestId` is a *reply address*,
 * exists only while someone awaits a response, and is consumed on resolution.
 * A run outlives any number of those, so the two are not interchangeable — see
 * TODO-CONSOLIDATION.md section 4.
 */
export type ProcessContext = {
  /**
   * Identifies one invocation of a board — one webhook, one timer tick, one
   * user action — across every service and runtime it reaches.
   */
  runId: string;
  /**
   * The run this one was invoked from, for a nested pipeline. Absent on a run
   * that was triggered from outside rather than from inside another run, which
   * is what makes a trace reconstructable as a tree rather than a list.
   */
  parentRunId?: string;
  /**
   * Where to send a result somebody is waiting for. Absent for the fire-and-
   * forget calls that make up most traffic. Unused by this runtime today; named
   * here so the shape matches the runtimes that do carry one.
   */
  requestId?: string;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One thing worth recording about a run.
 *
 * A board's log is assembled by its coordinator from every runtime it spans,
 * because only the coordinator can see the whole board — a log held per runtime
 * would have to be stitched back together by timestamp to answer the first
 * question anyone asks it, which is what one run did.
 *
 * `data` is the only free-form field and therefore the only one that can carry
 * something a service did not mean to record. It is dropped unless a board asks
 * for it, so a service that forgets to redact can only leak through a channel
 * somebody deliberately opened.
 */
export type LogEntry = {
  runId: string;
  parentRunId?: string;
  /** ISO 8601, set by the runtime that produced the entry. */
  ts: string;
  runtimeId: string;
  serviceUuid: string;
  level: LogLevel;
  /** What happened, as a short stable name a reader can group by. */
  event: string;
  data?: unknown;
  durationMs?: number;
};

export interface RuntimeHost {
  /**
   * Runs the services after `startAfterUuid` and answers with what they
   * produced.
   *
   * Asynchronous because a pass is: the runtime awaits each service, so a
   * service that pulls the ones behind it has to await them too.
   */
  processFrom(
    startAfterUuid: string,
    data: unknown,
    onNotification: (notification: RuntimeNotification) => void,
    context?: ProcessContext,
  ): Promise<unknown>;
  notify(payload: unknown, instanceId: string): void;
  emitResult(output: unknown): void;
  /**
   * The context of the call currently being processed, or null outside one.
   *
   * A service that finishes its work after its `process` returns — an HTTP
   * response arriving, a socket pushing — has left the call it belongs to by
   * the time it has something to pass on. Capturing this while still inside
   * `process` and handing it back to `processFrom` is what keeps the two halves
   * recognisable as one run.
   */
  currentContext(): ProcessContext | null;
  /**
   * Record something about the run in progress.
   *
   * Unlike `notify`, which exists for whoever is watching and may be dropped
   * when nobody is, an entry has to survive with nobody attached — a board
   * running unwatched is exactly the case a log is for. The run and the service
   * are taken from the call in progress, so a service says only what happened.
   */
  log(level: LogLevel, event: string, data?: unknown): void;
  /**
   * Pass an entry a nested pipeline produced outward, unchanged.
   *
   * Distinct from `log` because the entry already names its own run and
   * service: re-deriving those from the call in progress would relabel work
   * done inside a sub-pipeline as the work of the service hosting it, which is
   * the nesting the entry exists to record.
   */
  forwardLog(entry: LogEntry): void;
  /**
   * What the runtime around a nested pipeline records, so the pipeline can
   * record the same.
   *
   * A nested runtime is built from a service's own configuration, which says
   * nothing about logging — so without asking, a sub-pipeline would sit silent
   * inside a board that is being looked into, which is where its entries are
   * most wanted.
   */
  logSettings(): { logging: boolean; logData: boolean; logLevel: LogLevel };
  /**
   * Who this runtime belongs to and which board it is part of.
   *
   * For a service that keeps something between calls: this server is
   * multi-tenant and runtimes are namespaced by the authenticated `sub`, so
   * anything durable has to be namespaced the same way or one tenant's data
   * becomes another's. A service cannot work that out for itself — it is told
   * its own configuration and nothing about who asked for it — which is why it
   * comes from the host rather than from state.
   */
  scope(): RuntimeScope;
  /**
   * Claim a publicly reachable endpoint served by the shared server, for a
   * service that needs to be called from outside (an HTTP endpoint, a
   * signalling server). Returns null when the host cannot serve mounts — an
   * inner sub-service pipeline, or a server that is not listening yet — in
   * which case the service has no public endpoint and should say so in its
   * state rather than falling back to a port of its own.
   */
  mount?(
    serviceUuid: string,
    handlers: MountHandlers,
    options?: { mountName?: string },
  ): MountHandle | null;
}
