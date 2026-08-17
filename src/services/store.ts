/**
 * Service Documentation
 * Service ID: store
 * Service Name: Store
 * Runtime: hkp-node
 * Modes: put, get, list, delete, clear, release
 * Key Config: mode, namespace, key, keyFrom, valueFrom, limit,
 *             keys (release, transient)
 * IO: in=anything to keep (put), or the key to act on (get/delete/release)
 *     out=null immediately; the outcome is pushed through the rest of the
 *     pipeline when the disk answers:
 *       put     -> { key, value, createdAt, updatedAt }
 *       get     -> the same, or nothing at all when the key is unknown
 *       list    -> { records: [...], count }
 *       delete  -> { key, deleted }
 *       clear   -> { cleared }
 *       release -> one pass per released record, each { key, value, ... }
 *
 * What a board remembers between runs. Scoped to the board and to the tenant
 * that owns it — a service is told its own configuration and nothing about who
 * asked for it, so that scope comes from the runtime rather than from state and
 * a board cannot widen it.
 *
 * Every `store` on a board therefore reads and writes the same table without
 * being told to: `key` names a record *within* a table, never the table itself.
 * `namespace` subdivides it, for a board that keeps two unrelated sets of
 * things — enquiries and invoices — and would otherwise get one list holding
 * both. It only ever narrows what the runtime already granted, so it is safe
 * for a board to choose.
 *
 * This is deliberately not a database. It is the missing half of two patterns
 * that otherwise cannot be expressed in one board:
 *
 *   - **Dump cheaply, process expensively.** Something arrives, is stored, and
 *     costs nothing more; a timer later reads the batch and does the expensive
 *     work once. Without somewhere to put it, the choice is to process every
 *     arrival immediately or to lose it.
 *   - **Work that outlives whoever started it.** A person clicks a button, a
 *     model takes a minute, and they close the tab. The answer lands here, and
 *     is still here when they come back.
 *
 * A miss in `get` mode returns nothing, which stops the pipeline — the same
 * signal a cache miss gives, and what makes "look it up, and if it is not there
 * go and fetch it" expressible as two services rather than a branch.
 *
 * `release` is the human checkpoint: a person looks at what is waiting and lets
 * some of it through. The records they picked continue down the pipeline, one
 * pass each, and leave the store; the rest stay exactly where they were. It
 * runs from `configure` as well as from an input, because a facade button can
 * only configure a service — which is also why `keys` is never reported in
 * `getState`: a key list that survived into a saved board would release again
 * the next time the board was opened.
 */
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { RecordStore, StoredRecord, StoreScope } from "./recordStore";

export const storeDescriptor: ServiceRegistryEntry = {
  serviceId: "store",
  serviceName: "Store",
  version: "v1",
  capabilities: [],
};

type Mode = "put" | "get" | "list" | "delete" | "clear" | "release";

const MODES: Mode[] = ["put", "get", "list", "delete", "clear", "release"];

type Notify = (payload: unknown, instanceId?: string) => void;

/** The value at a dotted path, or undefined where the path does not lead. */
function valueAt(input: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  let current: unknown = input;
  for (const step of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as JsonRecord)[step];
  }
  return current;
}

/** A key that sorts by when it was made, so an unkeyed dump keeps its order. */
function generatedKey(): string {
  return `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The keys named by whatever was handed over.
 *
 * A list of keys, a list of records, or one of either — a facade sends the
 * first, a service upstream tends to send the second, and neither should have
 * to know which the other prefers.
 */
function readKeys(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  const keys: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item) {
      keys.push(item);
    } else if (item && typeof item === "object") {
      const key = (item as JsonRecord).key;
      if (typeof key === "string" && key) {
        keys.push(key);
      }
    }
  }
  return keys;
}

export class StoreService implements HostedService {
  readonly serviceId = storeDescriptor.serviceId;
  readonly serviceName = storeDescriptor.serviceName;
  readonly version = storeDescriptor.version;
  readonly capabilities = storeDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private mode: Mode = "put";
  /** Which of the board's tables; empty is the board's own. See StoreScope. */
  private namespace = "";
  private key = "";
  private keyFrom = "";
  private valueFrom = "";
  private limit = 0;
  private lastCount = 0;
  /** Why the last attempt failed; see the note in text-generation. */
  private lastError = "";

  constructor(
    config: ServiceConfiguration,
    private readonly store: RecordStore,
  ) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    return {
      mode: this.mode,
      namespace: this.namespace,
      key: this.key,
      keyFrom: this.keyFrom,
      valueFrom: this.valueFrom,
      limit: this.limit,
      // What the last pass saw, so a panel shows whether anything is in there
      // without having to run a `list` to find out.
      lastCount: this.lastCount,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.mode === "string" && MODES.includes(config.mode as Mode)) {
      this.mode = config.mode as Mode;
    }
    if (typeof config.namespace === "string") {
      this.namespace = config.namespace;
    }
    if (typeof config.key === "string") {
      this.key = config.key;
    }
    if (typeof config.keyFrom === "string") {
      this.keyFrom = config.keyFrom;
    }
    if (typeof config.valueFrom === "string") {
      this.valueFrom = config.valueFrom;
    }
    if (typeof config.limit === "number" && config.limit >= 0) {
      this.limit = Math.trunc(config.limit);
    }

    // Releasing happens here rather than in `process` because a facade can only
    // configure a service — a button sends a payload, it does not start a pass.
    // The same shape a Timer uses for `start: true`.
    const keys = readKeys(config.keys);
    if (keys.length > 0) {
      void this.releaseKeys(keys, (payload) => this.host?.notify(payload, this.uuid));
    }
    return this.getState();
  }

  /**
   * Starts the work and stops the synchronous push.
   *
   * The disk answers asynchronously and the runtime calls services one after
   * another without awaiting, so the outcome cannot be returned from here. The
   * rest of the pipeline is called with it once it is known — the same
   * inversion-of-control path `http-client` takes.
   */
  process(input: unknown, notify: Notify): unknown {
    const scope = this.scope();
    if (!scope) {
      // Nothing can be scoped without a host, and storing outside a board's
      // own space is worse than not storing.
      this.fail(notify, "store has no runtime to scope its records to");
      return null;
    }

    void this.run(input, scope, notify, this.host?.currentContext() ?? undefined);
    return null;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** The table this service reads and writes: the board's, narrowed by name. */
  private scope(): StoreScope | null {
    const runtime = this.host?.scope();
    return runtime ? { ...runtime, namespace: this.namespace } : null;
  }

  private async run(
    input: unknown,
    scope: StoreScope,
    notify: Notify,
    context?: ProcessContext,
  ): Promise<void> {
    try {
      const result = await this.perform(input, scope, notify);
      if (result === null) {
        // A miss, or a mode that decided there was nothing to pass on. The
        // pipeline stops here rather than continuing with an empty answer.
        return;
      }
      this.lastError = "";
      notify(result);
      this.push(result, notify, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(notify, `store failed: ${message}`);
      // Nothing is passed on: a board that continued here would be acting on a
      // record that was never written.
    }
  }

  private async perform(
    input: unknown,
    scope: StoreScope,
    notify: Notify,
  ): Promise<JsonRecord | null> {
    switch (this.mode) {
      case "put": {
        const record = await this.store.put(
          scope,
          this.resolveKey(input) || generatedKey(),
          this.resolveValue(input),
        );
        this.lastCount = 1;
        return { ...record };
      }

      case "get": {
        const key = this.resolveKey(input);
        if (!key) {
          this.fail(notify, "get needs a key — from `key`, `keyFrom`, or the input");
          return null;
        }
        const record = await this.store.get(scope, key);
        this.lastCount = record ? 1 : 0;
        // A miss stops the pipeline, which is what makes it usable as a cache:
        // whatever follows is the "go and fetch it" path.
        return record ? { ...record } : null;
      }

      case "list": {
        const all = await this.store.list(scope);
        const records = this.limit > 0 ? all.slice(0, this.limit) : all;
        this.lastCount = records.length;
        // Kept whole rather than reduced to values: when a record arrived and
        // what it is called is most of what a batch pass needs to work with.
        return { records: records as unknown as JsonRecord[], count: records.length };
      }

      case "delete": {
        const key = this.resolveKey(input);
        if (!key) {
          this.fail(notify, "delete needs a key — from `key`, `keyFrom`, or the input");
          return null;
        }
        const deleted = await this.store.remove(scope, key);
        this.lastCount = deleted ? 1 : 0;
        return { key, deleted };
      }

      case "clear": {
        const cleared = await this.store.clear(scope);
        this.lastCount = 0;
        return { cleared };
      }

      case "release": {
        const keys = readKeys(
          input && typeof input === "object" && "keys" in (input as JsonRecord)
            ? (input as JsonRecord).keys
            : input,
        );
        if (keys.length === 0) {
          this.fail(notify, "release needs the keys to let through");
          return null;
        }
        await this.releaseKeys(keys, notify);
        // Each record was pushed on its own; there is no single result to
        // continue with here.
        return null;
      }
    }
  }

  /**
   * Lets the named records through, one pass each, and forgets them.
   *
   * One pass per record rather than one batch of all of them: what follows an
   * approval is per-item work — read this document, write this row — and a
   * board should not have to unpack a batch to do it.
   *
   * A released record is deleted. That is what "the rest stay" means: the queue
   * is what has *not* been dealt with. It also means a failure downstream loses
   * the record, which is what retry and dead-lettering exist to fix; until then
   * the honest description is that approving is final.
   */
  private async releaseKeys(keys: string[], notify: Notify): Promise<void> {
    const scope = this.scope();
    if (!scope) {
      this.fail(notify, "store has no runtime to scope its records to");
      return;
    }

    const context = this.host?.currentContext() ?? undefined;
    let released = 0;
    for (const key of keys) {
      const record = await this.store.get(scope, key);
      if (!record) {
        // Someone else already dealt with it. Not an error: two people looking
        // at the same queue is the normal case.
        continue;
      }
      await this.store.remove(scope, key);
      released += 1;
      this.push({ ...record }, notify, context);
    }
    this.lastCount = released;
    notify({ released, requested: keys.length });
  }

  /**
   * The key this pass acts on.
   *
   * The input decides before the configuration does: a board that names a key
   * per record is being specific, and a configured key is the fallback for the
   * common case where every pass means the same slot.
   */
  private resolveKey(input: unknown): string {
    if (this.keyFrom) {
      const found = valueAt(input, this.keyFrom);
      if (typeof found === "string" && found) {
        return found;
      }
      if (typeof found === "number") {
        return String(found);
      }
    }
    if (input && typeof input === "object") {
      const wrapper = input as JsonRecord;
      if (typeof wrapper.key === "string" && wrapper.key) {
        return wrapper.key;
      }
    }
    if (typeof input === "string" && input && this.mode !== "put") {
      // For a lookup, a bare string is the key — which is what an upstream
      // service that produced one is offering.
      return input;
    }
    return this.key;
  }

  /** What gets stored: a named part of the input, or the whole of it. */
  private resolveValue(input: unknown): unknown {
    if (this.valueFrom) {
      return valueAt(input, this.valueFrom);
    }
    if (input && typeof input === "object") {
      const wrapper = input as JsonRecord;
      // `{key, value}` is a record being handed over as one, so the wrapper
      // itself is not what was meant to be kept.
      if ("value" in wrapper && typeof wrapper.key === "string") {
        return wrapper.value;
      }
    }
    return input;
  }

  /** Reports a failure and keeps the reason, so a panel can still show it. */
  private fail(notify: Notify, error: string): void {
    this.lastError = error;
    // What a board running unattended has instead of somebody watching a panel.
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
  }

  private push(result: JsonRecord, notify: Notify, context?: ProcessContext): void {
    if (!this.host) {
      return;
    }
    const output = this.host.processFrom(
      this.uuid,
      result,
      (n: RuntimeNotification) => notify(n.payload, n.instanceId),
      context,
    );
    if (output !== null && output !== undefined) {
      this.host.emitResult(output);
    }
  }
}

export type { StoredRecord };
