import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { holdDescriptor } from "../src/services/hold";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { mapDescriptor } from "../src/services/map";
import { subServiceDescriptor } from "../src/services/sub-service";

/**
 * An endpoint inside a scope.
 *
 * A nested runtime has no server of its own, so until mounts were delegated
 * the way secrets and slots are, an `http-server` inside a sub-pipeline
 * published no address at all — which made a scope something a board could not
 * put an endpoint in, and so something the boards that have one could not use.
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

/** An endpoint that answers with whatever the board last handed it. */
function endpoint(uuid: string, mountName?: string) {
  return {
    serviceId: httpServerSubservicesDescriptor.serviceId,
    uuid,
    state: {
      // An endpoint defaults to bypassed, so a board that wants a live one
      // says so.
      bypass: false,
      ...(mountName ? { mountName } : {}),
      onProcess: [
        {
          serviceId: holdDescriptor.serviceId,
          instanceId: "keep",
          state: { slot: "document", op: "write" },
        },
      ],
      onRequest: [
        {
          serviceId: holdDescriptor.serviceId,
          instanceId: "serve",
          state: { slot: "document", op: "read" },
        },
      ],
    },
  };
}

async function mountOf(server: Server, address: string) {
  const res = await request(server.httpServer)
    .get(`/runtimes/rt-1/services/${address}`)
    .expect(200);
  return res.body.__hkpMount as string;
}

describe("an endpoint inside a scope", () => {
  it("is given an address, and answers on it", async () => {
    const { server } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "scope",
            state: {
              pipeline: [
                {
                  serviceId: mapDescriptor.serviceId,
                  uuid: "body",
                  state: {
                    mode: "replace",
                    template: { meta: { status: 200 }, body: "from a scope" },
                  },
                },
                endpoint("serve", "in-scope"),
              ],
            },
          },
        ],
      })
      .expect(200);

    const url = await mountOf(server, "scope.serve");
    expect(url).toMatch(/\/hosted\//);

    // Drive the board so the endpoint is handed a document to keep.
    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ go: 1 })
      .expect(200);

    const res = await fetch(url);
    expect(await res.text()).toBe("from a scope");
  });

  it("gives two copies of one scope different addresses", async () => {
    // The name a mount is derived from falls back to the scoped address, so a
    // pipeline used twice does not derive one address between the two copies
    // and let either take the other's callers.
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
            state: { pipeline: [endpoint("serve")] },
          },
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "right",
            state: { pipeline: [endpoint("serve")] },
          },
        ],
      })
      .expect(200);

    const first = await mountOf(server, "left.serve");
    const second = await mountOf(server, "right.serve");
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("keeps the address a board named, when it is scoped", async () => {
    // A mount's address is derived from its name, so a board that named one
    // keeps the address it published before the service was moved into a
    // scope — which is what lets an outside caller go on working.
    const { server } = await startServer();

    const flat = {
      id: "rt-1",
      name: "Node",
      services: [endpoint("serve", "stable")],
    };
    await request(server.httpServer).post("/runtimes").send(flat).expect(200);
    const before = await mountOf(server, "serve");
    await request(server.httpServer).delete("/runtimes/rt-1").expect(200);

    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "scope",
            state: { pipeline: [endpoint("serve", "stable")] },
          },
        ],
      })
      .expect(200);
    const after = await mountOf(server, "scope.serve");

    expect(after).toBe(before);
  });
});
