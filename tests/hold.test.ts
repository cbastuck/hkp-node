import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { HoldService, holdDescriptor } from "../src/services/hold";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { mapDescriptor } from "../src/services/map";
import { timerDescriptor } from "../src/services/timer";

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  await server.start();
  return server;
}

function makeHold(state: Record<string, unknown>) {
  return new HoldService({
    uuid: "hold-1",
    serviceId: holdDescriptor.serviceId,
    state,
  } as never);
}

/** The predicate the http-server's request envelope satisfies and data does not. */
const READ_WHEN = "params && params.meta && params.meta.method";

const REQUEST = { meta: { method: "GET", path: "/", query: {} } };

describe("hold", () => {
  it("stores what it is given and passes it on", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    expect(hold.process({ triggerCount: 1 }, () => {})).toEqual({
      triggerCount: 1,
    });
    expect(hold.getState()).toMatchObject({
      hasHeld: true,
      held: { triggerCount: 1 },
      lastAction: "write",
      writeCount: 1,
    });
  });

  it("replays the held value on a read without consuming it", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    hold.process({ triggerCount: 4 }, () => {});

    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 4 });
    // Reading twice answers twice: the value is held, not queued.
    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 4 });
    expect(hold.getState()).toMatchObject({ readCount: 2, writeCount: 1 });
  });

  it("keeps the newest value written", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    hold.process({ triggerCount: 1 }, () => {});
    hold.process({ triggerCount: 2 }, () => {});
    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 2 });
  });

  it("stops on a read before anything is held", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    expect(hold.process(REQUEST, () => {})).toBeNull();
  });

  it("passes the read through when configured to", () => {
    const hold = makeHold({ readWhen: READ_WHEN, empty: "passthrough" });
    expect(hold.process(REQUEST, () => {})).toEqual(REQUEST);
  });

  it("merges the held value under the reading input", () => {
    const hold = makeHold({ readWhen: READ_WHEN, readMode: "merge" });
    hold.process({ triggerCount: 9 }, () => {});
    expect(hold.process(REQUEST, () => {})).toEqual({
      triggerCount: 9,
      meta: REQUEST.meta,
    });
  });

  it("treats every call as a write while no predicate is set", () => {
    const hold = makeHold({});
    expect(hold.process(REQUEST, () => {})).toEqual(REQUEST);
    expect(hold.getState()).toMatchObject({ lastAction: "write" });
  });

  it("forgets the held value on clear", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    hold.process({ triggerCount: 3 }, () => {});
    hold.configure({ action: "clear" });
    expect(hold.getState()).toMatchObject({ hasHeld: false, held: null });
    expect(hold.process(REQUEST, () => {})).toBeNull();
  });

  it("stops and reports when the predicate throws", () => {
    // Neither storing the caller's payload nor replaying stale data is safe
    // when the predicate cannot say which this is.
    const hold = makeHold({ readWhen: "params.missing.deeper" });
    hold.configure({ readWhen: "params.missing.deeper" });
    expect(hold.process({ triggerCount: 1 }, () => {})).toBeNull();
    expect(hold.getState().error).toBeTruthy();
    expect(hold.getState()).toMatchObject({ hasHeld: false });
  });

  it("describes a held value that cannot travel as JSON", () => {
    const hold = makeHold({ readWhen: READ_WHEN });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    hold.process(circular, () => {});
    expect(hold.getState().held).toBe("[Object]");
    // The value itself is untouched — only the reported state is a description.
    expect(hold.process(REQUEST, () => {})).toBe(circular);
  });
});

describe("hold behind an http-server endpoint", () => {
  /** The board: a producer writes, a request reads, one nested pipeline. */
  const subPipeline = (extra: Array<Record<string, unknown>> = []) => [
    ...extra,
    {
      serviceId: holdDescriptor.serviceId,
      uuid: "hold-1",
      state: { readWhen: READ_WHEN },
    },
    {
      serviceId: mapDescriptor.serviceId,
      uuid: "map-1",
      state: {
        mode: "replace",
        template: { "=": "'tick ' + params.triggerCount" },
      },
    },
  ];

  async function mountUrl(server: Server) {
    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    return body.__hkpMount as string;
  }

  it("answers a request with the value the data path last produced", async () => {
    const server = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: {
              bypass: false,
              // Both entry points run the nested pipeline.
              mode: "process_on_both",
              pipeline: subPipeline(),
            },
          },
        ],
      })
      .expect(200);

    // The data path: the outer chain drives the pipeline, hold stores.
    const { body: dataResult } = await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ triggerCount: 7 })
      .expect(200);
    expect(dataResult).toBe("tick 7");

    // The request path: the same pipeline, but hold replays instead of storing.
    const response = await fetch(await mountUrl(server));
    expect(await response.json()).toBe("tick 7");

    // A second producer run moves the held value on.
    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ triggerCount: 8 })
      .expect(200);
    const later = await fetch(await mountUrl(server));
    expect(await later.json()).toBe("tick 8");
  });

  it("serves a nested timer's latest tick to callers", async () => {
    const server = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: {
              bypass: false,
              // A timer inside the pipeline drives it on its own, so requests
              // are the only thing the session path has to carry.
              mode: "process_on_session",
              pipeline: subPipeline([
                {
                  serviceId: timerDescriptor.serviceId,
                  uuid: "timer-1",
                  state: {
                    periodic: true,
                    periodicValue: 60,
                    periodicUnit: "s",
                  },
                },
              ]),
            },
          },
        ],
      })
      .expect(200);

    const url = await mountUrl(server);

    // Before the first tick there is nothing held, and the read stops.
    expect(await (await fetch(url)).json()).toBeNull();

    // One tick, now, rather than waiting out the period.
    await request(server.httpServer)
      .post("/runtimes/rt-1/services/http-1")
      .send({
        configureService: {
          instanceId: "timer-1",
          state: { immediate: true, start: true },
        },
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await (await fetch(url)).json()).toBe("tick 1");
  });
});
