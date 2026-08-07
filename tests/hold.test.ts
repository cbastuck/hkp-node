import WebSocket from "ws";
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
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

/**
 * Collects a nested service's reported state off the runtime socket — the
 * channel an attached board watches — until `done` is satisfied.
 */
function collectState(
  wsUrl: string,
  instanceId: string,
  done: (seen: any[]) => boolean,
  onOpen: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const seen: any[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (
        message.type !== "notification" ||
        message.instanceId !== instanceId
      ) {
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(message.value);
      } catch {
        return;
      }
      if (payload?.__internal) {
        return;
      }
      seen.push(payload);
      if (done(seen)) {
        clearTimeout(timer);
        socket.close();
        resolve(seen);
      }
    });

    socket.on("open", () => {
      void onOpen();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function makeHold(state: Record<string, unknown>) {
  return new HoldService({
    uuid: "hold-1",
    serviceId: holdDescriptor.serviceId,
    state,
  } as never);
}

/** What an http-server request arrives as: no producer property in sight. */
const REQUEST = { meta: { method: "GET", path: "/", query: {} } };

describe("hold", () => {
  it("holds the named property and emits it under the same name", () => {
    const hold = makeHold({ property: "triggerCount" });
    expect(hold.process({ triggerCount: 1 }, () => {})).toEqual({
      triggerCount: 1,
    });
    expect(hold.getState()).toMatchObject({ held: 1, writeCount: 1 });
  });

  it("emits the same shape whichever side calls", () => {
    const hold = makeHold({ property: "triggerCount" });
    const written = hold.process({ triggerCount: 4 }, () => {});
    const read = hold.process(REQUEST, () => {});
    // What the services after Hold see does not say which side called; only the
    // counts, which nothing downstream sees, tell them apart.
    expect(read).toEqual(written);
    expect(hold.getState()).toMatchObject({ readCount: 1, writeCount: 1 });
  });

  it("replays without consuming", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 4 }, () => {});
    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 4 });
    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 4 });
  });

  it("keeps the newest value written", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 1 }, () => {});
    hold.process({ triggerCount: 2 }, () => {});
    expect(hold.process(REQUEST, () => {})).toEqual({ triggerCount: 2 });
  });

  it("drops everything but the held property", () => {
    // A producer's other fields are not part of what is held.
    const hold = makeHold({ property: "triggerCount" });
    expect(
      hold.process({ triggerCount: 5, note: "ignored" }, () => {}),
    ).toEqual({ triggerCount: 5 });
  });

  it("stops while nothing is held", () => {
    const hold = makeHold({ property: "triggerCount" });
    expect(hold.process(REQUEST, () => {})).toBeNull();
    expect(hold.getState()).toMatchObject({ held: null });
  });

  it("reads on inputs that cannot carry a property", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 6 }, () => {});
    expect(hold.process("a string", () => {})).toEqual({ triggerCount: 6 });
    expect(hold.process([1, 2, 3], () => {})).toEqual({ triggerCount: 6 });
  });

  it("reads on a null value, which is nothing to hold", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 2 }, () => {});
    expect(hold.process({ triggerCount: null }, () => {})).toEqual({
      triggerCount: 2,
    });
    expect(hold.getState()).toMatchObject({ readCount: 1, writeCount: 1 });
  });

  it("passes input through while no property is configured", () => {
    const hold = makeHold({});
    expect(hold.process(REQUEST, () => {})).toEqual(REQUEST);
    expect(hold.getState()).toMatchObject({ held: null });
  });

  it("forgets the held value and the counts on clear", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 3 }, () => {});
    hold.process(REQUEST, () => {});
    hold.configure({ action: "clear" });
    // The counts described the value that was just discarded.
    expect(hold.getState()).toMatchObject({
      held: null,
      readCount: 0,
      writeCount: 0,
    });
    expect(hold.process(REQUEST, () => {})).toBeNull();
  });

  it("forgets the held value and the counts when the property changes", () => {
    // What was held belonged to the old property name.
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 3 }, () => {});
    hold.process(REQUEST, () => {});
    hold.configure({ property: "counter" });
    expect(hold.getState()).toMatchObject({
      held: null,
      readCount: 0,
      writeCount: 0,
    });
    expect(hold.process(REQUEST, () => {})).toBeNull();
  });

  it("keeps the counts when the property is configured to what it already is", () => {
    const hold = makeHold({ property: "triggerCount" });
    hold.process({ triggerCount: 3 }, () => {});
    hold.configure({ property: "triggerCount" });
    expect(hold.getState()).toMatchObject({ held: 3, writeCount: 1 });
  });

  it("describes a held value that cannot travel as JSON", () => {
    const hold = makeHold({ property: "payload" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    hold.process({ payload: circular }, () => {});
    expect(hold.getState().held).toBe("[Object]");
    // The value itself is untouched — only the reported state is a description.
    expect(hold.process(REQUEST, () => {})).toEqual({ payload: circular });
  });
});

describe("hold behind an http-server endpoint", () => {
  /** The board: a producer writes, a request reads, one nested pipeline. */
  const subPipeline = (extra: Array<Record<string, unknown>> = []) => [
    ...extra,
    {
      serviceId: holdDescriptor.serviceId,
      uuid: "hold-1",
      state: { property: "triggerCount" },
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
    const { server } = await startServer();
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
    const { server } = await startServer();
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

  it("reports a nested service's state to an attached board", async () => {
    // Regression: a nested runtime has no notification targets of its own, so
    // everything its services reported through their host was dropped. An
    // attached board saw a Hold whose counts never moved while its endpoint
    // plainly answered.
    const { server, baseUrl } = await startServer();
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
              mode: "process_on_both",
              pipeline: subPipeline(),
            },
          },
        ],
      })
      .expect(200);

    const url = await mountUrl(server);
    const wsUrl = `${baseUrl.replace("http", "ws")}/rt-1`;

    const seen = await collectState(
      wsUrl,
      "hold-1",
      (states) => states.some((state) => state.readCount >= 1),
      async () => {
        // The producer writes, then a caller reads: both sides have to show up.
        await request(server.httpServer)
          .post("/runtimes/rt-1")
          .send({ triggerCount: 3 })
          .expect(200);
        await fetch(url);
      },
    );

    expect(seen.some((state) => state.writeCount === 1)).toBe(true);
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ held: 3, readCount: 1, writeCount: 1 });
    // Each call reports once; a second delivery channel would double these.
    expect(seen.filter((state) => state.readCount === 1)).toHaveLength(1);
  });
});
