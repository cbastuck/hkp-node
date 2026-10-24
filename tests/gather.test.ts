import { describe, expect, it } from "vitest";

import { GatherService, isPart } from "../src/services/gather";
import { MapService } from "../src/services/map";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/**
 * The other half of Spread. What is worth pinning is when a group counts as
 * complete, what it becomes, and what happens to one that never completes —
 * the rest is the pipeline's, and pinned where the pipeline is.
 */

/** Stands in for a reducer that stops: the one behaviour `map` cannot show. */
function stopping(config: ServiceConfiguration): HostedService {
  const state = config.state ?? {};
  return {
    serviceId: config.serviceId,
    serviceName: "Stops",
    uuid: config.uuid,
    configure: () => state,
    getState: () => state,
    process: () => null,
  };
}

function createService(config: ServiceConfiguration): HostedService {
  return config.serviceId === "map" ? new MapService(config) : stopping(config);
}

function gather(state: Record<string, unknown> = {}) {
  const logged: Array<{ level: string; event: string; data: JsonRecord }> = [];
  const host = {
    processFrom: () => null,
    notify: () => {},
    currentContext: () => null,
    log: (level: string, event: string, data: JsonRecord) =>
      logged.push({ level, event, data }),
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => ({ owner: "tester", boardName: "SYN" }),
    emitResult: () => {},
  } as unknown as RuntimeHost;
  const service = new GatherService(
    { uuid: "gather-1", serviceId: "gather", state } as never,
    createService,
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

const part = (group: string, index: number, total: number, item: unknown) => ({
  item,
  group,
  index,
  total,
});

const JOIN = [
  {
    serviceId: "map",
    uuid: "join",
    state: { template: { "=": "join(params.items, '')" } },
  },
];

describe("when a group is complete", () => {
  it("passes nothing on until every part is in, then the items in order", async () => {
    const t = gather();

    expect(await t.run(part("g", 0, 3, "ab"))).toBeNull();
    expect(await t.run(part("g", 1, 3, "cd"))).toBeNull();
    expect(await t.run(part("g", 2, 3, "ef"))).toEqual(["ab", "cd", "ef"]);
  });

  it("puts parts back in order whatever order they arrived in", async () => {
    const t = gather();

    await t.run(part("g", 2, 3, "c"));
    await t.run(part("g", 0, 3, "a"));

    expect(await t.run(part("g", 1, 3, "b"))).toEqual(["a", "b", "c"]);
  });

  it("keeps two groups apart", async () => {
    const t = gather();

    await t.run(part("one", 0, 2, "1a"));
    await t.run(part("two", 0, 2, "2a"));

    expect(await t.run(part("two", 1, 2, "2b"))).toEqual(["2a", "2b"]);
    expect(await t.run(part("one", 1, 2, "1b"))).toEqual(["1a", "1b"]);
  });

  it("counts a part sent twice once", async () => {
    const t = gather();

    await t.run(part("g", 0, 2, "a"));
    expect(await t.run(part("g", 0, 2, "a again"))).toBeNull();

    expect(await t.run(part("g", 1, 2, "b"))).toEqual(["a", "b"]);
  });

  it("says how far a group has got", async () => {
    const t = gather();

    await t.run(part("g", 0, 2, "a"));

    expect(t.notifications).toEqual([{ group: "g", received: 1, total: 2, pending: 1 }]);
    expect(t.service.getState().pending).toBe(1);
  });

  it("passes on what is not a part, so a whole value still gets through", async () => {
    const t = gather({ pipeline: JOIN });

    expect(await t.run("a whole file")).toBe("a whole file");
    expect(await t.run({ item: "x", group: "g" })).toEqual({ item: "x", group: "g" });
  });
});

describe("what a group becomes", () => {
  it("is what the pipeline makes of it — here, one text", async () => {
    const t = gather({ pipeline: JOIN });

    await t.run(part("g", 1, 2, "world"));

    expect(await t.run(part("g", 0, 2, "hello "))).toBe("hello world");
  });

  it("stops here when the pipeline stops", async () => {
    const t = gather({
      pipeline: [{ serviceId: "stops", uuid: "s" }],
    });

    expect(await t.run(part("g", 0, 1, "a"))).toBeNull();
  });

  it("is nothing passed on when the board says so", async () => {
    const t = gather({ stopPropagation: true });

    expect(await t.run(part("g", 0, 1, "a"))).toBeNull();
  });
});

describe("a group that does not complete", () => {
  it("is refused once it grows past maxBytes, with what is still on its way", async () => {
    const t = gather({ maxBytes: 5 });

    expect(await t.run(part("g", 0, 3, "abc"))).toBeNull();
    expect(await t.run(part("g", 1, 3, "def"))).toBeNull();
    // The rest of a refused group does not start it again.
    expect(await t.run(part("g", 2, 3, "g"))).toBeNull();

    expect(t.service.getState().pending).toBe(0);
    expect(t.service.getState().error).toMatch(/larger than 5 bytes/);
    expect(t.logged.map((entry) => entry.event)).toEqual(["gather.refused"]);
    expect(t.notifications).toContainEqual({
      error: "group g is larger than 5 bytes",
      pending: 0,
    });
  });

  it("is let go after timeoutMs, and said so", async () => {
    const t = gather({ timeoutMs: 10 });

    await t.run(part("old", 0, 2, "a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await t.run(part("new", 0, 2, "b"));

    expect(t.service.getState().pending).toBe(1);
    expect(t.logged).toEqual([
      {
        level: "warn",
        event: "gather.timed-out",
        data: { group: "old", received: 1, total: 2 },
      },
    ]);
  });

  it("is refused when its parts disagree on how many there are", async () => {
    const t = gather();

    await t.run(part("g", 0, 2, "a"));

    expect(await t.run(part("g", 1, 3, "b"))).toBeNull();
    expect(t.service.getState().error).toMatch(/said 2 parts, then 3/);
  });
});

describe("what counts as a part", () => {
  it("is an item and where it sits", () => {
    expect(isPart(part("g", 0, 1, null))).toBe(true);
    expect(isPart({ group: "g", index: 0, total: 1 })).toBe(false);
    expect(isPart(part("", 0, 1, "x"))).toBe(false);
    expect(isPart(part("g", 1, 1, "x"))).toBe(false);
    expect(isPart(part("g", 0.5, 2, "x"))).toBe(false);
    expect(isPart([part("g", 0, 1, "x")])).toBe(false);
  });
});

describe("configuration", () => {
  it("is read from the board as well as set later", () => {
    const t = gather({ maxBytes: 1000, timeoutMs: 5000 });

    expect(t.service.getState()).toMatchObject({ maxBytes: 1000, timeoutMs: 5000 });
    t.service.configure({ maxBytes: 2000 });
    expect(t.service.getState()).toMatchObject({ maxBytes: 2000, timeoutMs: 5000 });
  });
});
