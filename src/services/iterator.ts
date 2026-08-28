/**
 * Service Documentation
 * Service ID: iterator
 * Service Name: Iterator
 * Runtime: hkp-node
 * Modes: one pass of the nested pipeline per item
 * Key Config: itemsFrom, limit, pipeline, bypass
 * IO: in=an array, or a single item -> out=the results, or nothing at all
 * Arrays: the point of the service
 * Binary: passed to the nested pipeline untouched
 * MixedData: not native in runtime
 *
 * Iteration as a service, so a board can express it without a service having to
 * grow its own loop.
 *
 * A pipeline pass carries one value, which is a problem for anything that
 * produces several: a poll finds four conversations, a query returns twenty
 * rows. The alternatives are both bad — hand the whole array to the next
 * service and make it, and everything after it, loop internally; or let the
 * service that found them call the rest of the pipeline itself, which buries
 * the iteration in whichever service happened to need it first. Iterator is the
 * third option, and the composable one: the thing that produced the array says
 * only what it found, and iteration is a service you can see in the board.
 *
 * **A single item is an array of one.** A board that grows from "the one that
 * arrived" to "the four that were waiting" does not change shape, and neither
 * does an Iterator fed by something that sometimes returns one row.
 *
 * What the nested pipeline returns for an item is collected, and an item whose
 * pipeline **stopped** contributes nothing — so a `filter`-shaped sub-pipeline
 * makes this a filter, using the same `null` that stops a pipeline everywhere
 * else. Nothing collected at all means nothing to pass on, and the outer
 * pipeline stops here rather than continuing with an empty array.
 *
 * Items are taken one at a time, each awaited before the next begins. A pass
 * that calls a model is then one request in flight rather than ten at once,
 * which is what an inference provider's rate limit wants; the cost is that a
 * poll takes as long as its items put together.
 *
 * **One item failing does not end the loop.** Nine conversations should not go
 * unprocessed because the tenth had a malformed address. Failures are counted
 * and reported rather than thrown.
 */
import {
  JsonRecord,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";
import { childRun } from "../runtime";
import { SubService } from "./sub-service";

export const iteratorDescriptor: ServiceRegistryEntry = {
  serviceId: "iterator",
  serviceName: "Iterator",
  version: "v1",
  // Same as SubService: this service holds a pipeline, and the board's UI needs
  // to know that to let anyone look inside it.
  capabilities: ["subservices"],
};

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

export class IteratorService extends SubService {
  readonly serviceId = iteratorDescriptor.serviceId;
  readonly serviceName = iteratorDescriptor.serviceName;
  readonly version = iteratorDescriptor.version;
  readonly capabilities = iteratorDescriptor.capabilities;

  private itemsFrom = "";
  private limit = 0;
  private lastItems = 0;
  private lastFailed = 0;

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    super(config, createService);
    // Again, and not redundantly.
    //
    // The base constructor calls `configure`, which dispatches to the override
    // below — but a subclass's fields are defined only once `super()` has
    // returned, so everything it read was then overwritten by the declarations
    // above. (Declaring them without an initialiser does not help: a class
    // field is defined as `undefined` either way.) Re-reading here is what
    // makes an Iterator configured in the board behave like one configured later.
    // `settle` touches nothing the base owns, so the pipeline is not rebuilt.
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
      itemsFrom: this.itemsFrom,
      limit: this.limit,
      lastItems: this.lastItems,
      lastFailed: this.lastFailed,
    };
  }

  /** The part of a configuration this service owns rather than its base. */
  private settle(config: JsonRecord): void {
    if (typeof config.itemsFrom === "string") {
      this.itemsFrom = config.itemsFrom;
    }
    if (typeof config.limit === "number" && config.limit >= 0) {
      this.limit = Math.floor(config.limit);
    }
  }

  async process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (
      this.bypass ||
      !this.pipeline ||
      this.pipeline.listServices().length === 0
    ) {
      // Nothing to run the items through. Passing the input on unchanged is
      // what an empty SubService does, and keeps a half-built board legible.
      return input;
    }

    const items = this.items(input);
    const parent = this.host?.currentContext() ?? null;
    const results: unknown[] = [];
    let failed = 0;

    for (const item of items) {
      try {
        // A run of its own per item, descended from the run that reached the
        // Iterator. That is what makes a log answer "what happened to this one"
        // rather than only "what happened on this tick".
        const result = await this.pipeline.process(
          item,
          () => {},
          childRun(parent),
        );
        if (result !== null && result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        failed += 1;
        this.host?.log("error", "service.failed", {
          message: `iterator item failed: ${reason(error)}`,
        });
      }
    }

    this.lastItems = items.length;
    this.lastFailed = failed;
    notify({ items: items.length, results: results.length, failed });

    return results.length > 0 ? results : null;
  }

  /**
   * What to iterate over.
   *
   * `itemsFrom` is how an Iterator reaches into a result that says more than the
   * list itself — `{ conversations, count }` rather than a bare array — so the
   * service that produced it does not have to flatten its answer for the
   * benefit of whatever comes next.
   */
  private items(input: unknown): unknown[] {
    const source = this.itemsFrom ? valueAt(input, this.itemsFrom) : input;
    if (source === null || source === undefined) {
      return [];
    }
    const list = Array.isArray(source) ? source : [source];
    return this.limit > 0 ? list.slice(0, this.limit) : list;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
