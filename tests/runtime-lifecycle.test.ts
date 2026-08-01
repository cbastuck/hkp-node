import http from "node:http";
import { AddressInfo } from "node:net";

import WebSocket from "ws";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { monitorDescriptor } from "../src/services/monitor";

/**
 * How long a runtime lives.
 *
 * Whoever creates a runtime says whether it should be cleaned up when the last
 * client that was connected to it disconnects — they are the only ones who
 * know. A browser running a board is its controller and asks for cleanup: its
 * runtimes should not outlive the tab. A coordinator, a config file or a script
 * says nothing and gets a runtime that lives until it is deleted.
 *
 * Cleanup is opted into rather than assumed, so a runtime is never reaped
 * because of who happened to connect to it — which is also what stops a
 * replaced coordinator session from destroying a runtime its successor had just
 * built.
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
  const address = await server.start();
  return { server, ...address };
}

async function createRuntime(
  server: Server,
  runtimeId: string,
  extra: Record<string, unknown>,
) {
  const { body } = await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: runtimeId,
      name: "Node",
      services: [{ uuid: "mon-1", serviceId: monitorDescriptor.serviceId }],
      ...extra,
    })
    .expect(200);
  return String(body.runtimes[0].outputUrl);
}

/** Connects a client, then drops it — a tab closing. */
async function connectThenClose(outputUrl: string, runtimeId: string) {
  const socket = new WebSocket(outputUrl);
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  socket.send(JSON.stringify({ type: "readwrite", id: runtimeId }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("a runtime whose creator asked for cleanup", () => {
  it("is torn down when its last client disconnects", async () => {
    const { server } = await startServer();
    const outputUrl = await createRuntime(server, "rt-1", {
      garbageCollected: true,
    });

    await connectThenClose(outputUrl, "rt-1");

    await request(server.httpServer).get("/runtimes/rt-1").expect(404);
  });

  it("survives while another client is still connected", async () => {
    // "Last client", not "the one that created it": something is still using it.
    const { server } = await startServer();
    const outputUrl = await createRuntime(server, "rt-1", {
      garbageCollected: true,
    });

    const staying = new WebSocket(outputUrl);
    await new Promise<void>((resolve) => staying.on("open", () => resolve()));
    staying.send(JSON.stringify({ type: "readwrite", id: "rt-1" }));

    await connectThenClose(outputUrl, "rt-1");
    await request(server.httpServer).get("/runtimes/rt-1").expect(200);

    staying.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await request(server.httpServer).get("/runtimes/rt-1").expect(404);
  });
});

describe("a runtime whose creator asked for nothing", () => {
  it("outlives the clients that were watching it", async () => {
    // A coordinator's board keeps running with no browser attached. So does a
    // runtime someone started from a script or a config file.
    const { server } = await startServer();
    const outputUrl = await createRuntime(server, "rt-1", {});

    await connectThenClose(outputUrl, "rt-1");

    await request(server.httpServer).get("/runtimes/rt-1").expect(200);
  });

  it("still goes when it is deleted", async () => {
    const { server } = await startServer();
    await createRuntime(server, "rt-1", {});

    await request(server.httpServer).delete("/runtimes/rt-1").expect(200);

    await request(server.httpServer).get("/runtimes/rt-1").expect(404);
  });

  it("is what an explicit false asks for too", async () => {
    const { server } = await startServer();
    const outputUrl = await createRuntime(server, "rt-1", {
      garbageCollected: false,
    });

    await connectThenClose(outputUrl, "rt-1");

    await request(server.httpServer).get("/runtimes/rt-1").expect(200);
  });
});

describe("a runtime nobody ever connected to", () => {
  it("is never reaped, whatever it asked for", async () => {
    // Cleanup happens when a client goes away. With no client there is no
    // going away — a headless runtime is not an abandoned one.
    const { server } = await startServer();
    await createRuntime(server, "rt-1", { garbageCollected: true });

    await new Promise((resolve) => setTimeout(resolve, 100));

    await request(server.httpServer).get("/runtimes/rt-1").expect(200);
  });
});
