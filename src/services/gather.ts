/**
 * Service Documentation
 * Service ID: gather
 * Service Name: Gather
 * Runtime: hkp-node
 * Modes: none — the items as an array, or what the nested pipeline makes of them
 * Key Config: pipeline, maxBytes, timeoutMs, bypass
 * IO: in=one part a Spread sent on -> out=the whole group, once every part is in; null until then
 * Arrays: what a group becomes, in the order it was spread
 * Binary: an item may be bytes; joining bytes is the nested pipeline's to do
 * MixedData: not native in runtime
 *
 * The other half of Spread. Spread turns one array into as many values as it
 * has items, each sent on by itself; Gather waits until it has seen them all
 * and turns them back into one.
 *
 *     ui:   file-source (chunkSize) → spread     one value per chunk
 *     node: gather → measure                      one value per file
 *
 * What makes that worth doing is the space between the two. A value leaving a
 * runtime travels as one message, and a coordinator drops a message above its
 * frame limit (`HKP_COORDINATOR_MAX_FRAME_BYTES`) — so a file too large to send
 * at once can still be sent as chunks, each under the limit, and arrive whole.
 *
 * **A part says which whole it belongs to.** Spread sends each item as
 * `{ item, group, index, total }`: the item itself, untouched under `item`, and
 * where it sits in the array it came from. The index is what puts the group
 * back in order, so parts may arrive in any order; the total is what says it is
 * complete. Anything that is not a part passes through, so the same Gather sits
 * on a board that sometimes sends a file whole.
 *
 * **What the group becomes is a pipeline, not a list of strategies** — the same
 * answer Tracks gives its reducer. With no pipeline the items travel on as an
 * array. With one, the pipeline is given `{ group, items }` and its answer is
 * what goes on: joining text is one `map` term (`join(params.items, '')`), and
 * a board that needs something stranger writes more services rather than
 * waiting for a strategy to be added here. A pipeline that stops stops this
 * service too.
 *
 * **Collecting a group holds it in memory**, which a frame limit set to bound
 * memory would otherwise have prevented. `maxBytes` bounds one group, and a
 * group still incomplete after `timeoutMs` is let go; both are said in the log
 * rather than kept quiet, because a group that never arrives looks, from
 * outside, exactly like nothing having been sent.
 */
import { Buffer } from "node:buffer";

import { childRun } from "../runtime";
import {
  JsonRecord,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";
import { SubService } from "./sub-service";

export const gatherDescriptor: ServiceRegistryEntry = {
  serviceId: "gather",
  serviceName: "Gather",
  version: "v1",
  // Like every service holding a pipeline: the board's UI needs to know there
  // is something to look inside.
  capabilities: ["subservices"],
};

/** As much as the coordinator lets through in one frame by default. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** One item of an array a Spread sent on, and where it sits in it. */
export type Part = {
  item: unknown;
  group: string;
  index: number;
  total: number;
};

/** Whether a value is a part, rather than a value to pass through. */
export function isPart(value: unknown): value is Part {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const part = value as JsonRecord;
  return (
    "item" in part &&
    typeof part.group === "string" &&
    part.group !== "" &&
    Number.isInteger(part.total) &&
    (part.total as number) > 0 &&
    Number.isInteger(part.index) &&
    (part.index as number) >= 0 &&
    (part.index as number) < (part.total as number)
  );
}

type Collecting = {
  /**
   * By index rather than an array of `total`: a part names its own total, and
   * an array that size would be allocated — or refused outright — before a
   * second part had arrived.
   */
  items: Map<number, unknown>;
  total: number;
  bytes: number;
  startedAt: number;
};

/** What a part costs to hold, near enough to bound memory by. */
function sizeOf(item: unknown): number {
  if (typeof item === "string") {
    return Buffer.byteLength(item, "utf8");
  }
  if (item instanceof Uint8Array) {
    return item.byteLength;
  }
  if (item === null || item === undefined) {
    return 0;
  }
  try {
    return Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
  } catch {
    return 0;
  }
}

export class GatherService extends SubService {
  readonly serviceId = gatherDescriptor.serviceId;
  readonly serviceName = gatherDescriptor.serviceName;
  readonly version = gatherDescriptor.version;
  readonly capabilities = gatherDescriptor.capabilities;

  private maxBytes = DEFAULT_MAX_BYTES;
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private lastError = "";
  private collecting = new Map<string, Collecting>();
  /**
   * Groups given up on, and when. The parts of a group still on their way when
   * it was refused would otherwise start it again, and wait out the timeout
   * for parts that went with the refusal.
   */
  private refused = new Map<string, number>();

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    super(config, createService);
    // Again, for the reason Iterator gives: the base constructor's configure
    // ran before this class's fields were defined, and they overwrote it.
    if (config.state) {
      this.settle(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    this.settle(config);
    // The pipeline, bypass and the editing commands belong to the base.
    super.configure(config);
    return this.getState();
  }

  getState(): JsonRecord {
    return {
      ...super.getState(),
      maxBytes: this.maxBytes,
      timeoutMs: this.timeoutMs,
      pending: this.collecting?.size ?? 0,
      error: this.lastError ?? "",
    };
  }

  /** The part of a configuration this service owns rather than its base. */
  private settle(config: JsonRecord): void {
    if (typeof config.maxBytes === "number" && config.maxBytes > 0) {
      this.maxBytes = Math.floor(config.maxBytes);
    }
    if (typeof config.timeoutMs === "number" && config.timeoutMs > 0) {
      this.timeoutMs = Math.floor(config.timeoutMs);
    }
  }

  async process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (this.bypass || !isPart(input)) {
      return input;
    }

    const now = Date.now();
    this.letGoOfStale(now, notify);

    const { group, index, total, item } = input;
    if (this.refused.has(group)) {
      return null;
    }

    let collecting = this.collecting.get(group);
    if (!collecting) {
      collecting = {
        items: new Map(),
        total,
        bytes: 0,
        startedAt: now,
      };
      this.collecting.set(group, collecting);
    }

    if (collecting.total !== total) {
      this.refuse(
        group,
        now,
        `group ${group} said ${collecting.total} parts, then ${total}`,
        notify,
      );
      return null;
    }
    if (collecting.items.has(index)) {
      // Sent twice; the first one counts.
      return null;
    }

    collecting.bytes += sizeOf(item);
    if (collecting.bytes > this.maxBytes) {
      this.refuse(
        group,
        now,
        `group ${group} is larger than ${this.maxBytes} bytes`,
        notify,
      );
      return null;
    }

    collecting.items.set(index, item);
    notify({
      group,
      received: collecting.items.size,
      total,
      pending: this.collecting.size,
    });

    if (collecting.items.size < total) {
      return null;
    }

    this.collecting.delete(group);
    const items = Array.from({ length: total }, (_, i) => collecting.items.get(i));
    if (!this.pipeline || this.pipeline.listServices().length === 0) {
      return this.stopPropagation ? null : items;
    }
    // The run that brought the last part is the one the whole arrives in; the
    // pipeline making it runs as a run of its own beneath it, like a scope's.
    const result = await this.pipeline.process(
      { group, items },
      () => {},
      childRun(this.host?.currentContext() ?? null),
    );
    return this.stopPropagation ? null : result;
  }

  destroy(): void {
    this.collecting.clear();
    this.refused.clear();
    super.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private refuse(
    group: string,
    now: number,
    message: string,
    notify: (payload: unknown) => void,
  ): void {
    this.collecting.delete(group);
    this.refused.set(group, now);
    this.lastError = message;
    this.host?.log("error", "gather.refused", { group, message });
    notify({ error: message, pending: this.collecting.size });
  }

  /** Lets go of groups that stopped arriving, and of refusals that are old. */
  private letGoOfStale(now: number, notify: (payload: unknown) => void): void {
    for (const [group, collecting] of this.collecting) {
      if (now - collecting.startedAt > this.timeoutMs) {
        this.collecting.delete(group);
        this.lastError = `group ${group} timed out with ${collecting.items.size} of ${collecting.total} parts`;
        this.host?.log("warn", "gather.timed-out", {
          group,
          received: collecting.items.size,
          total: collecting.total,
        });
        notify({ error: this.lastError, pending: this.collecting.size });
      }
    }
    for (const [group, at] of this.refused) {
      if (now - at > this.timeoutMs) {
        this.refused.delete(group);
      }
    }
  }
}
