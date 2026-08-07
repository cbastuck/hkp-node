/**
 * Service Documentation
 * Service ID: hold
 * Service Name: Hold
 * Runtime: hkp-node
 * Modes: none — a call carrying the property writes, every call reads
 * Key Config: property
 * IO: in=any -> out={ property: held value }, or null while nothing is held
 * Arrays: an array input carries no property, so it reads
 * Binary: reads; holding non-JSON values is not supported yet
 * MixedData: not native in runtime
 *
 * Sample-and-hold: a pipeline entered from two sides — a producer that runs on
 * its own schedule and a consumer that arrives whenever it arrives — needs the
 * producer's latest value to survive between runs. Hold keeps it.
 *
 * One property name is the whole configuration. An input carrying that property
 * is the producer, and its value replaces what is held. Every call, that one
 * included, then emits the held value under the same property name — so the
 * services after Hold receive the same shape whichever side called, and cannot
 * tell the two apart. That is the point: the ordered list itself cannot say
 * where a call came from, and with Hold in front of them nothing downstream
 * needs to.
 *
 * A null held value is an empty one, the way null is nothing to pass on
 * everywhere else, so a producer cannot hold null: an input carrying the
 * property as null reads like any other.
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
  private held: unknown = null;
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
    return {
      property: this.property,
      held: reportable(this.held),
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
    // Nothing named is nothing to hold: an unconfigured Hold is a wire.
    if (!this.property) {
      return input;
    }

    const incoming = carriedValue(input, this.property);
    if (incoming !== null && incoming !== undefined) {
      this.held = incoming;
      this.writeCount += 1;
    } else {
      this.readCount += 1;
    }

    this.notify(this.getState());

    return this.held === null ? null : { [this.property]: this.held };
  }

  destroy(): void {
    this.forget();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Back to how the service started. The counts go with the value: they say how
   * often each side has called for what is held now, and left running across a
   * clear they would describe a value that is gone.
   */
  private forget(): void {
    this.held = null;
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
function reportable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return `[${typeof value === "object" && value !== null ? value.constructor.name : typeof value}]`;
  }
}
