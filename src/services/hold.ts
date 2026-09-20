/**
 * Service Documentation
 * Service ID: hold
 * Service Name: Hold
 * Runtime: hkp-node
 * Modes: none — either a slot with a declared role, or a property that discriminates
 * Key Config: slot + op, or property
 * IO: in=any -> out=the held value, or null while nothing is held
 * Arrays: an array input carries no property, so it reads
 * Binary: holdable in a slot; a property cannot discriminate on one
 * MixedData: not native in runtime
 *
 * Sample-and-hold: a pipeline entered from two sides — a producer that runs on
 * its own schedule and a consumer that arrives whenever it arrives — needs the
 * producer's latest value to survive between runs. Hold keeps it.
 *
 * **Which side is calling can be said two ways**, and a board picks one.
 *
 * With a `slot`, the board says outright: `op` is `write` or `read`, and two
 * Holds naming one slot are the two ends of it. Nothing inspects the value, so
 * anything can be held — bytes, a document, null — and the two ends may sit in
 * pipelines that never meet, which is what an endpoint's separate entry points
 * are. Where the cells live is the host's to decide (`RuntimeHost.slots`): the
 * service owning both pipelines, or failing that the runtime.
 *
 * With a `property` and no slot, the input says: an input carrying that
 * property is the producer, its value replaces what is held, and every call —
 * that one included — emits the held value under the same property name, so
 * the services after Hold cannot tell the two sides apart. That is the older
 * arrangement, and it is the only one available where the two sides share one
 * pipeline, since there is nothing but the value to tell them apart. A null
 * held value is an empty one, so a producer cannot hold null: an input carrying
 * the property as null reads like any other.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const holdDescriptor: ServiceRegistryEntry = {
  serviceId: "hold",
  serviceName: "Hold",
};

export class HoldService implements HostedService {
  readonly serviceId = holdDescriptor.serviceId;
  readonly serviceName = holdDescriptor.serviceName;
  readonly uuid: string;

  private host: RuntimeHost | null = null;

  private property = "";
  /** See the header: named, this is a cell the host owns rather than this one. */
  private slot = "";
  private op: "read" | "write" = "read";
  /** What is held when no slot names somewhere else to hold it. */
  private own: unknown = null;
  private readCount = 0;
  private writeCount = 0;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    // Only the arrangement in use is reported. A state property a service does
    // not act on is one a board keeps and a reader has to discount, and an
    // omitted one is erased from the board the next time it is saved — which is
    // what should happen to the half of this service a board is not using.
    const which: JsonRecord = this.slot
      ? { slot: this.slot, op: this.op }
      : { property: this.property };
    return {
      ...which,
      held: reportable(this.read()),
      readCount: this.readCount,
      writeCount: this.writeCount,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.property === "string") {
      if (config.property !== this.property) {
        // What is held belongs to the property it was written for.
        this.forget();
      }
      this.property = config.property;
    }

    if (typeof config.slot === "string") {
      if (config.slot !== this.slot) {
        // A slot is an address, and what was held belongs to the old one — but
        // it belongs to whoever else is still reading it, so only this
        // service's own cell is cleared, never the host's.
        this.own = null;
        this.readCount = 0;
        this.writeCount = 0;
      }
      this.slot = config.slot;
    }

    if (config.op === "read" || config.op === "write") {
      this.op = config.op;
    }

    if (config.action === "clear") {
      this.forget();
    }

    const state = this.getState();
    this.notify(state);
    return state;
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (this.slot) {
      return this.useSlot(input);
    }

    // Nothing named is nothing to hold: an unconfigured Hold is a wire.
    if (!this.property) {
      return input;
    }

    const incoming = carriedValue(input, this.property);
    if (incoming !== null && incoming !== undefined) {
      this.write(incoming);
      this.writeCount += 1;
    } else {
      this.readCount += 1;
    }

    this.notify(this.getState());

    const held = this.read();
    return held === null ? null : { [this.property]: held };
  }

  destroy(): void {
    // Only what this service holds itself. A slot belongs to the host, and the
    // other end of it outlives this one — a pipeline rebuilt while a board is
    // running destroys the services in it, and that must not empty a cell the
    // service on the other side is still answering from.
    this.own = null;
    this.readCount = 0;
    this.writeCount = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * A call on a Hold whose role is declared rather than inferred.
   *
   * A write emits **its input unchanged**, so the pass it belongs to carries on
   * as though the Hold were not there; a read emits what is held, **raw**, so
   * it can be the whole of what a pipeline answers with. Neither looks at the
   * value, which is what lets a slot hold what a property never could.
   */
  private useSlot(input: unknown): unknown {
    if (this.op === "write") {
      this.write(input);
      this.writeCount += 1;
      this.notify(this.getState());
      return input;
    }

    this.readCount += 1;
    this.notify(this.getState());
    // Nothing held is nothing to pass on, the same as everywhere else — a
    // consumer that arrives before the producer has run stops here.
    return this.read() ?? null;
  }

  /** What is held, from wherever this Hold holds it. */
  private read(): unknown {
    if (!this.slot) {
      return this.own;
    }
    const store = this.host?.slots?.();
    return (store ? store.get(this.slot) : this.own) ?? null;
  }

  private write(value: unknown): void {
    const store = this.slot ? this.host?.slots?.() : null;
    if (store) {
      store.set(this.slot, value);
      return;
    }
    // No store to share through — a Hold outside any host that provides one
    // still holds, for itself alone, rather than dropping what it was given.
    this.own = value;
  }

  /**
   * Back to how the service started. The counts go with the value: they say how
   * often each side has called for what is held now, and left running across a
   * clear they would describe a value that is gone.
   */
  private forget(): void {
    this.own = null;
    if (this.slot) {
      this.host?.slots?.()?.set(this.slot, null);
    }
    this.readCount = 0;
    this.writeCount = 0;
  }

  private notify(payload: JsonRecord): void {
    this.host?.notify(payload, this.uuid);
  }
}

/**
 * The value an input carries for the held property, if it carries one at all —
 * anything else makes the call a read rather than a write.
 */
function carriedValue(input: unknown, property: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return (input as Record<string, unknown>)[property];
}

/**
 * The held value as it can be reported over REST. State travels as JSON, so a
 * value that does not survive the trip is described rather than sent.
 */
/**
 * What is held, as something safe to put in state.
 *
 * State is read back into the board and sent to everyone watching, so what a
 * Hold reports has to be worth carrying. A value that is bytes, or simply large
 * — a rendered document, an audio buffer — is described instead of copied: the
 * size is what a reader is looking for at that point, and the value itself is
 * on its way to whatever asked for it regardless.
 */
const REPORTABLE_LIMIT = 2048;

function reportable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `[${value.byteLength} bytes]`;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return null;
    }
    if (json.length > REPORTABLE_LIMIT) {
      return `[${describe(value)}, ${json.length} characters]`;
    }
    return JSON.parse(json);
  } catch {
    return `[${describe(value)}]`;
  }
}

function describe(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return value.constructor?.name ?? "object";
  }
  return typeof value;
}
