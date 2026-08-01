import http from "node:http";
import { AddressInfo } from "node:net";

import request from "supertest";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

// The runtimes in these tests are on loopback, which the SSRF guard blocks by
// default. Set before anything reads the policy (it is cached on first read).
process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { createRuntimeServer } from "../src/server";
import { BoardSession } from "../src/coordinator/session";
import { BridgeMessage } from "../src/coordinator/bridgeProtocol";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { monitorDescriptor } from "../src/services/monitor";

/**
 * What a browser attaching to a cloud board is told, and what it may ask for.
 *
 * The coordinator owns the board: it provisions the remote runtimes and holds
 * their state. A browser renders from what it is sent and asks the coordinator
 * to act on remote services, rather than dialling those runtimes itself — so a
 * board's runtimes may live somewhere the browser cannot reach. See
 * TODO-CLOUD-COORDINATOR.md.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startRuntimeServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

/**
 * A browser end of the bridge. The session only needs a live WebSocket, so this
 * is a real socket pair rather than a stub — the messages under test are the
 * ones that actually go over the wire.
 */
async function browserBridge(session: BoardSession, runtimeIds: string[]) {
  const received: BridgeMessage[] = [];
  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;

  const serverSide = new Promise<WebSocket>((resolve) =>
    sockets.on("connection", (ws) => resolve(ws)),
  );
  const clientSide = new WebSocket(`ws://127.0.0.1:${port}`);
  clientSide.on("message", (raw) =>
    received.push(JSON.parse(raw.toString()) as BridgeMessage),
  );
  await new Promise<void>((resolve) => clientSide.on("open", () => resolve()));

  session.registerBrowserSocket(await serverSide, runtimeIds);

  cleanups.push(async () => {
    clientSide.close();
    sockets.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  return {
    received,
    send: (message: BridgeMessage) => clientSide.send(JSON.stringify(message)),
    /** Waits for a message of this type, or throws. */
    next: async <T extends BridgeMessage["type"]>(
      type: T,
      after = 0,
    ): Promise<Extract<BridgeMessage, { type: T }>> => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const found = received
          .slice(after)
          .find((message) => message.type === type);
        if (found) {
          return found as Extract<BridgeMessage, { type: T }>;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `no "${type}" message; got: ${received.map((m) => m.type).join(", ") || "none"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

const endpointService = {
  uuid: "http-1",
  serviceId: httpServerSubservicesDescriptor.serviceId,
  state: { bypass: false, mode: "process_on_session", pipeline: [] },
};

async function startBoard(baseUrl: string) {
  const session = new BoardSession("board-1", "user-1", {
    boardName: "board-1",
    runtimes: [{ id: "rt-1", name: "Node", type: "rest", url: baseUrl }],
    services: {
      "rt-1": [
        endpointService,
        { uuid: "mon-1", serviceId: monitorDescriptor.serviceId },
      ],
    },
  });
  cleanups.push(() => session.destroy());
  await session.start();
  return session;
}

describe("attaching to a cloud board", () => {
  it("is told the board without asking", async () => {
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);

    const bridge = await browserBridge(session, ["ui"]);
    const snapshot = await bridge.next("snapshot");

    expect(snapshot.boardName).toBe("board-1");
    expect(snapshot.runtimes.map((rt) => rt.runtimeId)).toEqual(["rt-1"]);
  });

  it("is told what each runtime can run", async () => {
    // Panel selection resolves by serviceId *and* version, so a browser without
    // the registry renders the wrong UI for a versioned service.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);

    const bridge = await browserBridge(session, []);
    const snapshot = await bridge.next("snapshot");

    const ids = (snapshot.runtimes[0].registry as Array<{ serviceId: string }>)
      .map((entry) => entry.serviceId);
    expect(ids).toContain("monitor");
    expect(ids).toContain(httpServerSubservicesDescriptor.serviceId);
  });

  it("is told addresses that exist in no saved board", async () => {
    // A mount's address is assigned when the runtime is provisioned. It is the
    // reason the snapshot carries live state rather than the board's own.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);

    const bridge = await browserBridge(session, []);
    const snapshot = await bridge.next("snapshot");

    const state = snapshot.runtimes[0].services["http-1"] as Record<string, unknown>;
    expect(String(state.__hkpMount)).toMatch(
      new RegExp(`^${baseUrl}/hosted/[0-9a-f]{32}$`),
    );
  });

  it("is told the board as authored, alongside its live state", async () => {
    // Both in one message, at one seq: the structure a browser renders and the
    // state it renders into it cannot disagree. The same config is fetchable
    // over REST, which is where the board list reads it for boards nobody has
    // attached to.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);

    const bridge = await browserBridge(session, []);
    const snapshot = await bridge.next("snapshot");

    const config = snapshot.config as {
      boardName: string;
      services: Record<string, Array<{ uuid: string }>>;
    };
    expect(config.boardName).toBe("board-1");
    expect(config.services["rt-1"].map((svc) => svc.uuid)).toEqual([
      "http-1",
      "mon-1",
    ]);
    expect(snapshot.status).toBe("running");
  });

  it("can ask to be told again", async () => {
    // What a browser does after a reconnect, or on noticing a gap in the
    // sequence: start from the board as it is rather than carry on from a stale
    // view.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);

    const bridge = await browserBridge(session, []);
    const first = await bridge.next("snapshot");
    bridge.send({ type: "resync" });

    const second = await bridge.next("snapshot", bridge.received.length);
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});

describe("stopping a board so it can be edited", () => {
  it("hands its runtimes back but keeps the board", async () => {
    // Editing takes the runtimes over, so the coordinator must let go of them —
    // without losing the board, which is only in its memory.
    const { server, baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);
    const bridge = await browserBridge(session, []);
    const before = await bridge.next("snapshot");
    expect(before.runtimes).toHaveLength(1);

    await session.stop();

    expect(session.getStatus()).toBe("stopped");
    // The board is still the coordinator's, with the config it was given.
    expect((session.config.services["rt-1"] ?? []).length).toBe(2);
    // ...and its runtimes are gone from the runtime server.
    const res = await request(server.httpServer).get("/runtimes/rt-1");
    expect(res.status).toBe(404);
  });

  it("tells attached browsers that it stopped", async () => {
    // A viewer must not keep rendering services that are no longer running.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);
    const bridge = await browserBridge(session, []);
    const first = await bridge.next("snapshot");
    const seenSoFar = bridge.received.length;

    await session.stop();

    const after = await bridge.next("snapshot", seenSoFar);
    expect(after.seq).toBeGreaterThan(first.seq);
    expect(after.status).toBe("stopped");
    expect(after.runtimes).toEqual([]);
  });
});

describe("acting on a remote service", () => {
  it("configures it for the browser and answers with the result", async () => {
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);
    const bridge = await browserBridge(session, []);
    await bridge.next("snapshot");

    bridge.send({
      type: "configureService",
      requestId: "req-1",
      runtimeId: "rt-1",
      serviceUuid: "mon-1",
      config: { logToConsole: true },
    });

    const response = await bridge.next("response");
    expect(response.requestId).toBe("req-1");
    expect((response.data as Record<string, unknown>).logToConsole).toBe(true);
  });

  it("tells every attached browser what the new state is", async () => {
    // The one that asked already knows; a second viewer would otherwise render
    // state that is no longer true.
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);
    const asking = await browserBridge(session, []);
    const watching = await browserBridge(session, []);
    await watching.next("snapshot");

    asking.send({
      type: "configureService",
      requestId: "req-1",
      runtimeId: "rt-1",
      serviceUuid: "mon-1",
      config: { logToConsole: true },
    });

    const update = await watching.next("serviceState");
    expect(update.serviceUuid).toBe("mon-1");
    expect((update.state as Record<string, unknown>).logToConsole).toBe(true);
  });

  it("says so when the runtime is not part of this board", async () => {
    const { baseUrl } = await startRuntimeServer();
    const session = await startBoard(baseUrl);
    const bridge = await browserBridge(session, []);
    await bridge.next("snapshot");

    bridge.send({
      type: "configureService",
      requestId: "req-1",
      runtimeId: "rt-elsewhere",
      serviceUuid: "mon-1",
      config: {},
    });

    const response = await bridge.next("response");
    expect(response.error).toContain("rt-elsewhere");
  });
});
