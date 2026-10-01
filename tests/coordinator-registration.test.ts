import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { monitorDescriptor } from "../src/services/monitor";
import { CoordinatorHost, FAST_LINKS, introduce, startCoordinator } from "./cloud";

/**
 * Registering the same board twice at once.
 *
 * Registering replaces a board's session, and replacing it destroys the old one
 * — which hands back the runtimes it provisioned. Overlapping registrations
 * therefore used to delete each other's work: one session's teardown removed
 * the runtime the other had just created, and that one then failed on its next
 * call against it (in practice, minting a session token: a 404 for a runtime
 * that had existed moments earlier).
 *
 * Boards are re-registered whenever they change, so overlapping calls are
 * ordinary rather than exotic.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];
const hosts: CoordinatorHost[] = [];

afterEach(async () => {
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startRuntimeServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    coordinatorLinkOptions: FAST_LINKS,
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

/** A coordinator with `server` connected to it as the board's runtime. */
async function coordinatorWith(server: Server) {
  const host = await startCoordinator();
  hosts.push(host);
  await introduce(host, "user-1", "board-1", { "rt-1": server });
  return host.coordinator;
}

function boardConfig(services: number) {
  return {
    boardName: "board-1",
    runtimes: [{ id: "rt-1", name: "Node", type: "rest" as const }],
    services: {
      "rt-1": Array.from({ length: services }, (_, index) => ({
        uuid: `mon-${index}`,
        serviceId: monitorDescriptor.serviceId,
      })),
    },
  };
}

describe("a runtime a coordinator owns", () => {
  it("survives the last socket closing", async () => {
    // A coordinator provisions without asking for cleanup, so its runtimes are
    // not tied to whoever is connected: a deployed board keeps running with
    // nobody watching, and connections come and go as sessions are replaced
    // and networks drop. A connection-driven teardown could otherwise destroy a
    // runtime a replacement session had just built.
    const { server } = await startRuntimeServer();
    const coordinator = await coordinatorWith(server);

    const session = await coordinator.registerBoard(
      "user-1",
      boardConfig(1),
    );
    expect(session.getErrors()).toEqual([]);
    await request(server.httpServer).get("/runtimes/rt-1").expect(200);

    // Every watcher goes away — which is not what releases it.
    await request(server.httpServer).get("/runtimes/rt-1").expect(200);
    await session.stop();

    // The board is stopped, so its runtimes are handed back deliberately —
    // which is the coordinator's decision, not a side effect of a disconnect.
    await request(server.httpServer).get("/runtimes/rt-1").expect(404);
  });
});

describe("registering a board while a registration is in flight", () => {
  it("keeps the runtime the winning registration provisioned", async () => {
    const { server } = await startRuntimeServer();
    const coordinator = await coordinatorWith(server);

    // What the editor does when a board changes twice in quick succession.
    const [first, second] = await Promise.all([
      coordinator.registerBoard("user-1", boardConfig(1)),
      coordinator.registerBoard("user-1", boardConfig(2)),
    ]);

    expect(first.getErrors()).toEqual([]);
    expect(second.getErrors()).toEqual([]);

    // The board that ended up registered is the one whose runtime is running.
    const live = coordinator.getBoard("user-1", "board-1");
    expect(live).toBeTruthy();
    await request(server.httpServer).get("/runtimes/rt-1").expect(200);
  });

  it("runs them one after another rather than interleaved", async () => {
    // Each registration must see a settled board: destroy, provision, then the
    // next one starts. Interleaving is what deleted a runtime mid-provision.
    const { server } = await startRuntimeServer();
    const coordinator = await coordinatorWith(server);

    const sessions = await Promise.all([
      coordinator.registerBoard("user-1", boardConfig(1)),
      coordinator.registerBoard("user-1", boardConfig(2)),
      coordinator.registerBoard("user-1", boardConfig(3)),
    ]);

    for (const session of sessions) {
      expect(session.getErrors()).toEqual([]);
    }
    // Only the last one is the board's session; the earlier ones were replaced.
    expect(coordinator.getBoard("user-1", "board-1")).toBe(
      sessions[sessions.length - 1],
    );
  });

  it("lets the next registration proceed after one fails", async () => {
    // A board whose runtime cannot be built fails; the next attempt must not
    // be blocked behind it.
    const { server } = await startRuntimeServer();
    const coordinator = await coordinatorWith(server);

    const [failed, recovered] = await Promise.all([
      coordinator.registerBoard("user-1", {
        boardName: "board-1",
        runtimes: [{ id: "rt-1", name: "Node", type: "rest" as const }],
        services: { "rt-1": [{ uuid: "x", serviceId: "no-such-service" }] },
      }),
      coordinator.registerBoard("user-1", boardConfig(1)),
    ]);

    expect(failed.getErrors().length).toBeGreaterThan(0);
    expect(recovered.getErrors()).toEqual([]);
  });
});
