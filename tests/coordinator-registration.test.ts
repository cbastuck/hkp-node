import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

// The runtimes in these tests are on loopback, which the SSRF guard blocks by
// default. Set before anything reads the policy (it is cached on first read).
process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { createRuntimeServer } from "../src/server";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import { monitorDescriptor } from "../src/services/monitor";

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
const coordinators: BoardCoordinator[] = [];

afterEach(async () => {
  while (coordinators.length) {
    coordinators.pop()?.destroyAll();
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

function boardConfig(baseUrl: string, services: number) {
  return {
    boardName: "board-1",
    runtimes: [
      { id: "rt-1", name: "Node", type: "rest" as const, url: baseUrl },
    ],
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
    // nobody watching, and the coordinator's own sockets come and go as
    // sessions are replaced. That close is also delivered late, so a
    // connection-driven teardown could otherwise destroy a runtime a
    // replacement session had just built.
    const { server, baseUrl } = await startRuntimeServer();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    const session = await coordinator.registerBoard(
      "user-1",
      boardConfig(baseUrl, 1),
    );
    expect(session.getErrors()).toEqual([]);
    await request(server.httpServer).get("/runtimes/rt-1").expect(200);

    // Every watcher goes away.
    await session.stop();

    // The board is stopped, so its runtimes are handed back deliberately —
    // which is the coordinator's decision, not a side effect of a disconnect.
    await request(server.httpServer).get("/runtimes/rt-1").expect(404);
  });
});

describe("registering a board while a registration is in flight", () => {
  it("keeps the runtime the winning registration provisioned", async () => {
    const { server, baseUrl } = await startRuntimeServer();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    // What the editor does when a board changes twice in quick succession.
    const [first, second] = await Promise.all([
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 1)),
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 2)),
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
    const { baseUrl } = await startRuntimeServer();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    const sessions = await Promise.all([
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 1)),
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 2)),
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 3)),
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
    // A board pointed at a runtime that is not there fails to provision; the
    // next attempt must not be blocked behind it.
    const { baseUrl } = await startRuntimeServer();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    const [failed, recovered] = await Promise.all([
      coordinator.registerBoard("user-1", {
        boardName: "board-1",
        runtimes: [
          {
            id: "rt-1",
            name: "Nowhere",
            type: "rest" as const,
            url: "http://127.0.0.1:1",
          },
        ],
        services: { "rt-1": [] },
      }),
      coordinator.registerBoard("user-1", boardConfig(baseUrl, 1)),
    ]);

    expect(failed.getErrors().length).toBeGreaterThan(0);
    expect(recovered.getErrors()).toEqual([]);
  });
});
