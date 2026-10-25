/**
 * Service Documentation
 * Service ID: spread
 * Service Name: Spread
 * Runtime: hkp-node
 * Modes: none
 * Key Config: itemsFrom, bypass
 * IO: in=an array, or a single item -> out=one { item, group, index, total } per item, each sent on by itself
 * Arrays: the point of the service
 * Binary: an item may be bytes; it travels untouched under `item`
 * MixedData: not native in runtime
 *
 * One value in, as many out as it has items — the browser's
 * `hookup.to/service/spread`, for a board whose array is produced here.
 *
 * A pipeline pass carries one value, and so does a value leaving a runtime: a
 * query's hundred rows cross to the next runtime as one message. Spread sends
 * each item down the rest of the board on its own — the services after it,
 * and the runtimes after this one — so each crosses as a message of its own,
 * and a Gather on the far side puts them back together.
 *
 * It is not an Iterator. An Iterator runs a pipeline of its own once per item
 * and comes back with the answers, so one value still leaves it. Spread holds
 * no pipeline: what follows it on the board is what each item goes through,
 * and nothing comes back. It returns null and continues the run itself, once
 * per item — the pull pattern — so every item goes on in the run that reached
 * it, and with the caller that run carries.
 *
 * **Each item goes on wrapped**, as `{ item, group, index, total }`: the item
 * itself, untouched, and where it sat in the array — what a Gather needs to
 * put the array back in order. **A single item is an array of one**, as for an
 * Iterator, so a board fed sometimes one value and sometimes several does not
 * change shape.
 *
 * Items go on one at a time, each awaited before the next: the services after
 * this one see them in order, and a hundred are not all in flight at once.
 */
import { randomUUID } from "node:crypto";

import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const spreadDescriptor: ServiceRegistryEntry = {
  serviceId: "spread",
  serviceName: "Spread",
  version: "v1",
  capabilities: [],
};

/** The value at a dotted path, or undefined where the path does not lead. */
function valueAt(input: unknown, path: string): unknown {
  let current: unknown = input;
  for (const step of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as JsonRecord)[step];
  }
  return current;
}

export class SpreadService implements HostedService {
  readonly serviceId = spreadDescriptor.serviceId;
  readonly serviceName = spreadDescriptor.serviceName;
  readonly version = spreadDescriptor.version;
  readonly capabilities = spreadDescriptor.capabilities;
  readonly uuid: string;

  private bypass = false;
  private itemsFrom = "";
  private lastTotal = 0;
  private host: RuntimeHost | null = null;

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
      bypass: this.bypass,
      itemsFrom: this.itemsFrom,
      lastTotal: this.lastTotal,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }
    if (typeof config.itemsFrom === "string") {
      this.itemsFrom = config.itemsFrom;
    }
    return this.getState();
  }

  async process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<unknown> {
    if (this.bypass || !this.host) {
      return input;
    }
    const host = this.host;
    // Before anything is awaited: the run this call is in is only this call's
    // until it gives up control.
    const run = host.currentContext();

    const items = this.items(input);
    if (items.length > 0) {
      const group = randomUUID();
      const total = items.length;
      for (const [index, item] of items.entries()) {
        const output = await host.processFrom(
          this.uuid,
          { item, group, index, total },
          // No-op: the runtime already fans these out to its notification
          // targets. Re-notifying through the host would deliver every one twice.
          () => {},
          run ?? undefined,
        );
        // An item the rest of the pipeline stopped goes no further; the
        // others still do.
        if (output !== null && output !== undefined) {
          host.emitResult(output, run);
        }
      }
      this.lastTotal = total;
      notify({ lastTotal: total });
    }
    // Every item has gone on already; there is nothing left to pass.
    return null;
  }

  private items(input: unknown): unknown[] {
    const source = this.itemsFrom ? valueAt(input, this.itemsFrom) : input;
    if (source === null || source === undefined) {
      return [];
    }
    return Array.isArray(source) ? source : [source];
  }
}
