import { describe, expect, it } from "vitest";

import { IteratorService } from "../src/services/iterator";
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/**
 * Iteration as a service. What is worth pinning is the shape of the loop — how
 * many times the nested pipeline runs, what comes back, and what happens when
 * one item goes wrong — rather than anything about the services inside it.
 */

/** What the nested pipeline saw, in the order it saw it. */
const seen: Array<{ input: unknown; runId: string | undefined }> = [];

/**
 * A one-service pipeline standing in for whatever a board would nest. Its
 * behaviour is chosen by the service's own state, so one fake covers every
 * case the loop has to handle.
 */
function fakeService(config: ServiceConfiguration): HostedService {
  let host: RuntimeHost | null = null;
  const state = config.state ?? {};
  return {
    serviceId: config.serviceId,
    serviceName: "Fake",
    uuid: config.uuid,
    configure: () => state,
    getState: () => state,
    setHost: (h) => {
      host = h;
    },
    process(input: unknown) {
      seen.push({ input, runId: host?.currentContext()?.runId });
      if (state.throws) {
        throw new Error("nope");
      }
      if (state.stopOn !== undefined && input === state.stopOn) {
        return null;
      }
      return typeof input === "number" ? input * 2 : { saw: input };
    },
  };
}

function hostFor(context: ProcessContext | null) {
  const logged: JsonRecord[] = [];
  const host = {
    processFrom: () => null,
    notify: () => {},
    currentContext: () => context,
    log: (_l: string, _e: string, data: JsonRecord) => logged.push(data),
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => ({ owner: "tester", boardName: "SYN" }),
    emitResult: () => {},
  } as unknown as RuntimeHost;
  return { host, logged };
}

function iterator(
  state: Record<string, unknown> = {},
  nested: Record<string, unknown> = {},
  context: ProcessContext | null = null,
) {
  seen.length = 0;
  const { host, logged } = hostFor(context);
  const service = new IteratorService(
    {
      uuid: "iter-1",
      serviceId: "iterator",
      state: {
        pipeline: [{ serviceId: "fake", uuid: "inner-1", state: nested }],
        ...state,
      },
    } as never,
    fakeService,
  );
  service.setHost(host);
  const notifications: unknown[] = [];
  return {
    service,
    logged,
    notifications,
    run: (input: unknown) =>
      service.process(input, (payload) => notifications.push(payload)),
  };
}

describe("what gets iterated", () => {
  it("runs the nested pipeline once per element", async () => {
    const t = iterator();

    const out = await t.run([1, 2, 3]);

    expect(seen.map((s) => s.input)).toEqual([1, 2, 3]);
    expect(out).toEqual([2, 4, 6]);
  });

  it("treats a single item as an array of one", async () => {
    // A board that grows from "the one that arrived" to "the four that were
    // waiting" should not have to change shape.
    const t = iterator();

    expect(await t.run(7)).toEqual([14]);
    expect(seen.map((s) => s.input)).toEqual([7]);
  });

  it("treats an object as a single item, not as its values", async () => {
    const t = iterator();

    expect(await t.run({ a: 1 })).toEqual([{ saw: { a: 1 } }]);
    expect(seen).toHaveLength(1);
  });

  it("reaches into a result that says more than the list", async () => {
    // `actionable` answers { conversations, count } rather than a bare array,
    // so that it can say how many it found.
    const t = iterator({ itemsFrom: "conversations" });

    await t.run({ conversations: ["a@x", "b@x"], count: 2 });

    expect(seen.map((s) => s.input)).toEqual(["a@x", "b@x"]);
  });

  it("stops before the limit runs away with it", async () => {
    const t = iterator({ limit: 2 });

    await t.run([1, 2, 3, 4, 5]);

    expect(seen.map((s) => s.input)).toEqual([1, 2]);
  });

  it("does nothing at all with nothing to do", async () => {
    const t = iterator();

    expect(await t.run([])).toBeNull();
    expect(await t.run(null)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("what comes back", () => {
  it("drops the items whose pipeline stopped", async () => {
    // `null` stops a pipeline everywhere else, and means the same here — which
    // is what makes a filter-shaped sub-pipeline a filter.
    const t = iterator({}, { stopOn: 2 });

    expect(await t.run([1, 2, 3])).toEqual([2, 6]);
  });

  it("passes nothing on when every item stopped", async () => {
    const t = iterator({}, { stopOn: 1 });

    expect(await t.run([1])).toBeNull();
    // Still reports what it did, so an empty pass is visible rather than silent.
    expect(t.notifications).toEqual([{ items: 1, results: 0, failed: 0 }]);
  });

  it("says how many it ran, kept and lost", async () => {
    const t = iterator();

    await t.run([1, 2]);

    expect(t.notifications).toEqual([{ items: 2, results: 2, failed: 0 }]);
    expect(t.service.getState()).toMatchObject({ lastItems: 2, lastFailed: 0 });
  });
});

describe("when an item goes wrong", () => {
  it("keeps going, and counts it", async () => {
    // Nine conversations should not go unprocessed because the tenth had a
    // malformed address.
    let calls = 0;
    seen.length = 0;
    const { host, logged } = hostFor(null);
    const service = new IteratorService(
      {
        uuid: "iter-1",
        serviceId: "iterator",
        state: {
          pipeline: [{ serviceId: "fake", uuid: "inner-1", state: {} }],
        },
      } as never,
      (config) => {
        const inner = fakeService(config);
        return {
          ...inner,
          process(input: unknown) {
            calls += 1;
            if (input === 2) {
              throw new Error("malformed");
            }
            return input;
          },
        };
      },
    );
    service.setHost(host);
    const notifications: unknown[] = [];

    const out = await service.process([1, 2, 3], (p) => notifications.push(p));

    expect(calls).toBe(3);
    expect(out).toEqual([1, 3]);
    expect(notifications).toEqual([{ items: 3, results: 2, failed: 1 }]);
    expect(logged[0]?.message).toContain("malformed");
  });
});

describe("attribution", () => {
  it("gives each item a run of its own, descended from the caller's", async () => {
    const t = iterator({}, {}, { runId: "outer-run" });

    await t.run([1, 2, 3]);

    const runs = seen.map((s) => s.runId);
    expect(new Set(runs).size).toBe(3);
    expect(runs.every(Boolean)).toBe(true);
  });
});

describe("an Iterator with nothing in it", () => {
  it("passes its input straight through", async () => {
    // The same thing an empty SubService does, so a half-built board stays
    // legible rather than going quiet.
    const empty = new IteratorService(
      { uuid: "iter-1", serviceId: "iterator", state: { pipeline: [] } } as never,
      fakeService,
    );
    empty.setHost(hostFor(null).host);

    expect(await empty.process([1, 2], () => {})).toEqual([1, 2]);
  });

  it("passes through when bypassed", async () => {
    const t = iterator({ bypass: true });
    expect(await t.run([1, 2])).toEqual([1, 2]);
    expect(seen).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("survives being set in the constructor", async () => {
    // A subclass's field initialisers run after the base constructor has
    // already called configure, so a default written as a field initialiser
    // would silently overwrite what the board configured.
    const t = iterator({ itemsFrom: "rows", limit: 5 });

    expect(t.service.getState()).toMatchObject({ itemsFrom: "rows", limit: 5 });
  });
});
