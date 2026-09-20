import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { holdDescriptor } from "../src/services/hold";
import { subServiceDescriptor } from "../src/services/sub-service";

/**
 * What a scope keeps to itself.
 *
 * A slot is a cell two pipelines share, and which cells a name reaches is the
 * first thing a scope is for. `own` means two copies of the same scope on one
 * runtime do not clobber each other; `inherit` means a name inside a scope is
 * the same cell as one beside it, which is what a pair of pipelines belonging
 * to the same arrangement wants.
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

/**
 * A scope that writes slot `shared`, and a Hold beside it that reads the same
 * name. Whether the reader sees the write is the whole question.
 */
function board(scope: Record<string, unknown>) {
  return {
    id: "rt-1",
    name: "Node",
    services: [
      {
        serviceId: subServiceDescriptor.serviceId,
        uuid: "scope",
        state: {
          ...scope,
          pipeline: [
            {
              serviceId: holdDescriptor.serviceId,
              uuid: "writer",
              state: { slot: "shared", op: "write" },
            },
          ],
        },
      },
      {
        serviceId: holdDescriptor.serviceId,
        uuid: "reader",
        state: { slot: "shared", op: "read" },
      },
    ],
  };
}

async function runAndReadOutside(server: Server) {
  await request(server.httpServer)
    .post("/runtimes/rt-1")
    .send({ value: 7 })
    .expect(200);
  const res = await request(server.httpServer)
    .get("/runtimes/rt-1/services/reader")
    .expect(200);
  return res.body;
}

describe("what a scope keeps to itself", () => {
  it("holds in its own cells unless told otherwise", async () => {
    const { server } = await startServer();
    await request(server.httpServer).post("/runtimes").send(board({})).expect(200);

    // The name is the same on both sides and still reaches a different cell.
    expect(await runAndReadOutside(server)).toMatchObject({ held: null });

    const state = await request(server.httpServer)
      .get("/runtimes/rt-1/services/scope")
      .expect(200);
    expect(state.body.scope).toEqual({ slots: "own" });
  });

  it("reaches the runtime's cells when it says it inherits", async () => {
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send(board({ scope: { slots: "inherit" } }))
      .expect(200);

    expect(await runAndReadOutside(server)).toMatchObject({
      held: { value: 7 },
    });
  });

  it("keeps two copies of one scope apart", async () => {
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "left",
            state: {
              pipeline: [
                {
                  serviceId: holdDescriptor.serviceId,
                  uuid: "cell",
                  state: { slot: "shared", op: "write" },
                },
              ],
            },
          },
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "right",
            state: {
              pipeline: [
                {
                  serviceId: holdDescriptor.serviceId,
                  uuid: "cell",
                  state: { slot: "shared", op: "read" },
                },
              ],
            },
          },
        ],
      })
      .expect(200);

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ value: 7 })
      .expect(200);

    // Same scope shape, same slot name, same instanceId inside: still separate.
    const right = await request(server.httpServer)
      .get("/runtimes/rt-1/services/right.cell")
      .expect(200);
    expect(right.body.held).toBeNull();
  });

  it("changes which cells it reaches without rebuilding the pipeline", async () => {
    const { server } = await startServer();
    await request(server.httpServer).post("/runtimes").send(board({})).expect(200);

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/scope")
      .send({ scope: { slots: "inherit" } })
      .expect(200);

    expect(await runAndReadOutside(server)).toMatchObject({
      held: { value: 7 },
    });
  });
});
