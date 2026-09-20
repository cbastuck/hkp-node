import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { collectState } from "./collectState";
import { holdDescriptor } from "../src/services/hold";
import { mapDescriptor } from "../src/services/map";
import { monitorDescriptor } from "../src/services/monitor";
import { subServiceDescriptor } from "../src/services/sub-service";

/**
 * Reaching a service inside a scope by the path through the services holding
 * it. Until these, a runtime's flat list was the whole of what a board could
 * name, so nesting a service put it out of reach of the board that nested it.
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

/** A scope holding a Hold, and a scope inside that one holding another. */
async function nestedBoard(server: Server) {
  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt-1",
      name: "Node",
      services: [
        {
          serviceId: subServiceDescriptor.serviceId,
          uuid: "outer",
          state: {
            pipeline: [
              {
                serviceId: holdDescriptor.serviceId,
                uuid: "hold-1",
                state: { property: "triggerCount" },
              },
              {
                serviceId: subServiceDescriptor.serviceId,
                uuid: "inner",
                state: {
                  pipeline: [
                    {
                      // Reports on every call and passes its input on, which
                      // is what makes it the one to watch at this depth.
                      serviceId: monitorDescriptor.serviceId,
                      uuid: "monitor-1",
                      state: {},
                    },
                    {
                      serviceId: mapDescriptor.serviceId,
                      uuid: "map-1",
                      state: {
                        mode: "replace",
                        template: { deep: true },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    })
    .expect(200);
}

describe("scoped addresses", () => {
  it("reads the state of a service one level down", async () => {
    const { server } = await startServer();
    await nestedBoard(server);

    const res = await request(server.httpServer)
      .get("/runtimes/rt-1/services/outer.hold-1")
      .expect(200);

    expect(res.body).toMatchObject({ property: "triggerCount" });
  });

  it("reads the state of a service two levels down", async () => {
    const { server } = await startServer();
    await nestedBoard(server);

    const res = await request(server.httpServer)
      .get("/runtimes/rt-1/services/outer.inner.map-1")
      .expect(200);

    expect(res.body).toMatchObject({ mode: "replace" });
  });

  it("configures a service by its address", async () => {
    const { server } = await startServer();
    await nestedBoard(server);

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/outer.hold-1")
      .send({ property: "other" })
      .expect(200);

    const res = await request(server.httpServer)
      .get("/runtimes/rt-1/services/outer.hold-1")
      .expect(200);
    expect(res.body).toMatchObject({ property: "other" });
  });

  it("enters a scope at one of its services and runs the rest of it", async () => {
    const { server } = await startServer();
    await nestedBoard(server);

    // Starting at the inner scope means the Hold before it does not run; what
    // comes back is what the rest of the outer pipeline made of the input.
    const res = await request(server.httpServer)
      .post("/runtimes/rt-1/services/outer.inner/process")
      .send({ ignored: true })
      .expect(200);

    expect(res.body).toMatchObject({ deep: true });
  });

  it("answers 404 for an address nothing claims", async () => {
    const { server } = await startServer();
    await nestedBoard(server);

    await request(server.httpServer)
      .get("/runtimes/rt-1/services/outer.nope")
      .expect(404);
    await request(server.httpServer)
      .get("/runtimes/rt-1/services/nope.hold-1")
      .expect(404);
  });

  it("reports a nested service under its address, at every depth", async () => {
    const { server, baseUrl } = await startServer();
    await nestedBoard(server);

    const seen = await collectState(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      "outer.inner.monitor-1",
      (states) => states.length > 0,
      async () => {
        await request(server.httpServer)
          .post("/runtimes/rt-1")
          .send({ triggerCount: 1 })
          .expect(200);
      },
    );

    expect(seen.length).toBeGreaterThan(0);
  });
});
