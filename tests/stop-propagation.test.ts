import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { collectState } from "./collectState";
import { holdDescriptor } from "../src/services/hold";
import { mapDescriptor } from "../src/services/map";
import { monitorDescriptor } from "../src/services/monitor";
import { subServiceDescriptor } from "../src/services/sub-service";
import { timerDescriptor } from "../src/services/timer";

/**
 * A scope that passes nothing on.
 *
 * Two flows on one runtime used to be separated by a Stopper between them,
 * which says "nothing continues from here" and leaves a reader to infer that
 * everything above it belongs to one flow. A scope that ends says it of
 * itself, and says it about **both** routes out — what it answers, and what
 * its pipeline emits without being asked.
 */

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

/** A scope, then a Hold that records whatever got past it. */
function board(scopeState: Record<string, unknown>, inner: unknown[]) {
  return {
    id: "rt-1",
    name: "Node",
    services: [
      {
        serviceId: subServiceDescriptor.serviceId,
        uuid: "scope",
        state: { pipeline: inner, ...scopeState },
      },
      {
        serviceId: holdDescriptor.serviceId,
        uuid: "after",
        state: { slot: "seen", op: "write" },
      },
    ],
  };
}

/** A pipeline whose answer is recognisable on the far side. */
const producesAMark = [
  {
    serviceId: mapDescriptor.serviceId,
    uuid: "mark",
    state: { mode: "replace", template: { mark: true } },
  },
];

/**
 * Says, from inside the scope, that a value reached it.
 *
 * A Monitor because it reports on every call and passes its input on; a Map
 * only answers, so watching one says nothing about whether it ran.
 */
const witness = {
  serviceId: monitorDescriptor.serviceId,
  uuid: "witness",
  state: {},
};

describe("a scope that stops propagation", () => {
  it("is absent from a board that never mentions it, and passes its result on", async () => {
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(board({}, producesAMark))
      .expect(200);

    const res = await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ go: 1 })
      .expect(200);

    // The default is the pipeline a board already has.
    expect(res.body).toMatchObject({ mark: true });
    const state = await request(server.httpServer)
      .get("/runtimes/rt-1/services/scope")
      .expect(200);
    expect(state.body.stopPropagation).toBe(false);
  });

  it("answers nothing, so the services after it do not run", async () => {
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(board({ stopPropagation: true }, producesAMark))
      .expect(200);

    const res = await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ go: 1 })
      .expect(200);

    expect(res.body).toBeNull();
    const after = await request(server.httpServer)
      .get("/runtimes/rt-1/services/after")
      .expect(200);
    expect(after.body.writeCount).toBe(0);
  });

  it("drops what its pipeline emits on its own", async () => {
    // The route `process` returning null does not cover: a Timer inside the
    // scope hands its tick to the nested runtime, whose output is this
    // service's output, and emitOutward runs the services after it directly.
    const { server, baseUrl } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(
        board({ stopPropagation: true }, [
          {
            serviceId: timerDescriptor.serviceId,
            uuid: "tick",
            state: { periodic: true, periodicValue: 60, periodicUnit: "s" },
          },
          witness,
          ...producesAMark,
        ]),
      )
      .expect(200);

    // Wait for the tick to have been seen inside the scope, so that "nothing
    // got out" is a claim about a tick that happened rather than about one
    // that had not happened yet.
    const seen = await collectState(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      "scope.witness",
      (states) => states.length > 0,
      async () => {
        await request(server.httpServer)
          .post("/runtimes/rt-1/services/scope")
          .send({
            configureService: {
              instanceId: "tick",
              state: { immediate: true, start: true },
            },
          })
          .expect(200);
      },
    );
    expect(seen.length).toBeGreaterThan(0);

    const after = await request(server.httpServer)
      .get("/runtimes/rt-1/services/after")
      .expect(200);
    expect(after.body.writeCount).toBe(0);
  });

  it("lets the same tick out when it does not stop", async () => {
    // The other half of the one above: without the flag the tick reaches the
    // Hold, so the test above is measuring the flag and not a broken Timer.
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(
        board({}, [
          {
            serviceId: timerDescriptor.serviceId,
            uuid: "tick",
            state: { periodic: true, periodicValue: 60, periodicUnit: "s" },
          },
          ...producesAMark,
        ]),
      )
      .expect(200);

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/scope")
      .send({
        configureService: {
          instanceId: "tick",
          state: { immediate: true, start: true },
        },
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await request(server.httpServer)
      .get("/runtimes/rt-1/services/after")
      .expect(200);
    expect(after.body.writeCount).toBeGreaterThan(0);
  });

  it("passes nothing on when there is nothing to run either", async () => {
    // bypass + stopPropagation is a Stopper: the pipeline is skipped and the
    // input does not become the answer.
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(board({ stopPropagation: true, bypass: true }, producesAMark))
      .expect(200);

    const res = await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ go: 1 })
      .expect(200);

    expect(res.body).toBeNull();
  });
});
