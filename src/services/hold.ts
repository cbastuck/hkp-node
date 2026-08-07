/**
 * Service Documentation
 * Service ID: hold
 * Service Name: Hold
 * Runtime: hkp-node
 * Modes: write (store and pass on) | read (replay what is held)
 * Key Config: readWhen, readMode, empty
 * IO: in=any -> out=input on a write, the held value on a read
 * Arrays: held as one opaque value, never concatenated
 * Binary: held as an opaque value; kept out of reported state
 * MixedData: not native in runtime
 *
 * Sample-and-hold: a pipeline entered from two sides — a producer that runs on
 * its own schedule and a consumer that arrives whenever it arrives — needs the
 * producer's latest value to survive between runs. Hold keeps it.
 *
 * Which of the two a given call is comes from `readWhen`, an expression over
 * the input: truthy means the caller is reading, anything else means a new
 * value is arriving. Discriminating on the input is what lets one ordered list
 * serve both entry points, since the list itself cannot say where a call came
 * from. Prefer a predicate over a shape the *producing service* guarantees
 * rather than over one a payload happens to have today.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { CompiledExpression, compileExpression } from "./expression";

export const holdDescriptor: ServiceRegistryEntry = {
  serviceId: "hold",
  serviceName: "Hold",
};

/** What a read emits: the held value alone, or the held value under the input. */
type ReadMode = "replace" | "merge";

/** What a read does before anything has been held. */
type EmptyMode = "stop" | "passthrough";

type LastAction = "read" | "write" | "none";

export class HoldService implements HostedService {
  readonly serviceId = holdDescriptor.serviceId;
  readonly serviceName = holdDescriptor.serviceName;
  readonly uuid: string;

  private host: RuntimeHost | null = null;

  private readWhenSource = "";
  private readWhen: CompiledExpression | null = null;
  private readMode: ReadMode = "replace";
  private empty: EmptyMode = "stop";

  private held: unknown = undefined;
  private hasHeld = false;
  private lastAction: LastAction = "none";
  private readCount = 0;
  private writeCount = 0;
  private error = "";

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
      readWhen: this.readWhenSource,
      readMode: this.readMode,
      empty: this.empty,
      hasHeld: this.hasHeld,
      held: reportable(this.held),
      lastAction: this.lastAction,
      readCount: this.readCount,
      writeCount: this.writeCount,
      error: this.error,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.readWhen === "string") {
      this.readWhenSource = config.readWhen;
      // An empty predicate is "never a read": every call stores, which makes an
      // unconfigured Hold a recorder rather than something that replays.
      this.readWhen = config.readWhen.trim()
        ? compileExpression(config.readWhen)
        : null;
      this.error = "";
    }

    if (config.readMode === "replace" || config.readMode === "merge") {
      this.readMode = config.readMode;
    }

    if (config.empty === "stop" || config.empty === "passthrough") {
      this.empty = config.empty;
    }

    if (config.action === "clear") {
      this.held = undefined;
      this.hasHeld = false;
      this.lastAction = "none";
    }

    const state = this.getState();
    this.notify(state);
    return state;
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    let isRead = false;
    if (this.readWhen) {
      try {
        isRead = !!this.readWhen(input);
        this.error = "";
      } catch (error) {
        // Neither branch is safe to guess at: storing would overwrite the held
        // value with a caller's payload, replaying would answer a producer with
        // stale data. Stop instead, and say why in the state.
        this.error = error instanceof Error ? error.message : String(error);
        this.notify(this.getState());
        return null;
      }
    }

    return isRead ? this.read(input) : this.write(input);
  }

  destroy(): void {
    this.held = undefined;
    this.hasHeld = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private write(input: unknown): unknown {
    this.held = input;
    this.hasHeld = true;
    this.writeCount += 1;
    this.lastAction = "write";
    this.notify(this.getState());
    return input;
  }

  private read(input: unknown): unknown {
    this.readCount += 1;
    this.lastAction = "read";
    this.notify(this.getState());

    if (!this.hasHeld) {
      return this.empty === "passthrough" ? input : null;
    }

    // Merging only applies between two plain objects; anything else has no
    // sensible union, so the held value stands on its own.
    if (
      this.readMode === "merge" &&
      isJsonRecord(this.held) &&
      isJsonRecord(input)
    ) {
      return { ...this.held, ...input };
    }

    return this.held;
  }

  private notify(payload: JsonRecord): void {
    this.host?.notify(payload, this.uuid);
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The held value as it can be reported over REST. A service may hold anything
 * the pipeline carries, including bytes, and state travels as JSON — so what
 * does not survive the trip is described rather than sent.
 */
function reportable(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return `[${typeof value === "object" && value !== null ? value.constructor.name : typeof value}]`;
  }
}
