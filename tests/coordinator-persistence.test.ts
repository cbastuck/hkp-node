import { afterEach, describe, expect, it, vi } from "vitest";

process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import {
  BoardStore,
  createMemoryBoardStore,
  PersistedBoard,
} from "../src/coordinator/boardStore";
import { CloudBoardConfig } from "../src/coordinator/types";
import { monitorDescriptor } from "../src/services/monitor";
import { startStubRuntime } from "./stubRuntime";

/**
 * What a coordinator keeps, and what it does not.
 *
 * A board is a document — a name, an owner, the config that was deployed. A run
 * of it is not: the runtimes, what they reported, the tokens that reach them.
 * So a board that comes back from the store comes back *stopped*, and there is
 * no way for it to come back otherwise: provisioning needs the user's JWT, and
 * at boot there is no user.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function boardConfig(boardName: string, url: string): CloudBoardConfig {
  return {
    boardName,
    runtimes: [{ id: "node", name: "Node", type: "rest", url }],
    services: {
      node: [{ uuid: "mon-1", serviceId: monitorDescriptor.serviceId }],
    },
  };
}

/** A coordinator with a runtime it can actually provision against. */
async function coordinatorWith(store?: BoardStore) {
  const runtime = await startStubRuntime("node");
  cleanups.push(runtime.close);
  const coordinator = new BoardCoordinator(store);
  cleanups.push(async () => {
    for (const board of coordinator.getBoards("user-1")) {
      await coordinator.removeBoard("user-1", board.boardName);
    }
  });
  return {
    coordinator,
    runtimeUrl: runtime.url,
    stopRuntimeHost: runtime.close,
  };
}

describe("deploying a board", () => {
  it("writes it to the store", async () => {
    const store = createMemoryBoardStore();
    const { coordinator, runtimeUrl } = await coordinatorWith(store);

    await coordinator.registerBoard("user-1", boardConfig("doorbell", runtimeUrl));

    const held = await store.load();
    expect(held).toHaveLength(1);
    expect(held[0].userId).toBe("user-1");
    expect(held[0].boardName).toBe("doorbell");
    expect(held[0].config.services.node[0].uuid).toBe("mon-1");
  });

  it("still runs the board when the store cannot take it", async () => {
    // Only its survival of a restart is in doubt. Failing the deploy over that
    // would be the worse trade.
    const failing: BoardStore = {
      load: async () => [],
      save: async () => {
        throw new Error("disk is full");
      },
      remove: async () => {},
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { coordinator, runtimeUrl } = await coordinatorWith(failing);

    const session = await coordinator.registerBoard(
      "user-1",
      boardConfig("doorbell", runtimeUrl),
    );

    expect(session.getStatus()).toBe("running");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("a coordinator that starts with boards in its store", () => {
  const stored: PersistedBoard = {
    userId: "user-1",
    boardName: "doorbell",
    createdAt: "2026-01-01T00:00:00.000Z",
    config: boardConfig("doorbell", "http://127.0.0.1:9/unused"),
  };

  function storeHolding(...boards: PersistedBoard[]): BoardStore {
    const memory = createMemoryBoardStore();
    return {
      ...memory,
      load: async () => boards,
    };
  }

  it("lists them, with the config they were deployed with", async () => {
    const coordinator = new BoardCoordinator(storeHolding(stored));

    await coordinator.restore();

    const boards = coordinator.getBoards("user-1");
    expect(boards.map((b) => b.boardName)).toEqual(["doorbell"]);
    expect(boards[0].config).toEqual(stored.config);
  });

  it("brings them back stopped, having provisioned nothing", async () => {
    // The store's url points nowhere: restoring must not dial it. Nothing can
    // be started without the user, so nothing is tried.
    const coordinator = new BoardCoordinator(storeHolding(stored));

    await coordinator.restore();

    expect(coordinator.getBoards("user-1")[0].status).toBe("stopped");
  });

  it("keeps the date the board was first deployed", async () => {
    const coordinator = new BoardCoordinator(storeHolding(stored));

    await coordinator.restore();

    expect(coordinator.getBoards("user-1")[0].createdAt).toBe(stored.createdAt);
  });

  it("does not displace a board that is already running here", async () => {
    // Restoring late would otherwise replace a live session with an older copy
    // of the same document — and the live one is the truth.
    const { coordinator, runtimeUrl } = await coordinatorWith(
      storeHolding(stored),
    );
    await coordinator.registerBoard("user-1", boardConfig("doorbell", runtimeUrl));

    await coordinator.restore();

    const boards = coordinator.getBoards("user-1");
    expect(boards).toHaveLength(1);
    expect(boards[0].status).toBe("running");
  });
});

describe("deleting a board", () => {
  it("takes it out of the store, so a restart cannot bring it back", async () => {
    const store = createMemoryBoardStore();
    const { coordinator, runtimeUrl } = await coordinatorWith(store);
    await coordinator.registerBoard("user-1", boardConfig("doorbell", runtimeUrl));

    expect(await coordinator.removeBoard("user-1", "doorbell")).toBe(true);

    expect(await store.load()).toEqual([]);
  });

  it("reports nothing to delete when there is no such board", async () => {
    const { coordinator } = await coordinatorWith();
    expect(await coordinator.removeBoard("user-1", "nope")).toBe(false);
  });
});

describe("stopping a board whose runtime host has gone", () => {
  it("still releases the board, and says what it could not reach", async () => {
    // A host that is down must not make a board impossible to stop. But the
    // runtime is very likely still running — provisioned to persist, holding
    // its mount — so the board says so rather than reporting a clean stop.
    const { coordinator, runtimeUrl, stopRuntimeHost } = await coordinatorWith();
    await coordinator.registerBoard("user-1", boardConfig("doorbell", runtimeUrl));
    // The host disappears between deploy and stop.
    await stopRuntimeHost();

    const session = coordinator.getBoard("user-1", "doorbell")!;
    await session.stop();

    expect(session.getStatus()).toBe("stopped");
    expect(session.getErrors()).toHaveLength(1);
    expect(session.getErrors()[0]).toContain("could not be reached");
    expect(session.getErrors()[0]).toContain("may still be running");
  });

  it("reports nothing when every runtime let go", async () => {
    const { coordinator, runtimeUrl } = await coordinatorWith();
    await coordinator.registerBoard("user-1", boardConfig("doorbell", runtimeUrl));

    const session = coordinator.getBoard("user-1", "doorbell")!;
    await session.stop();

    expect(session.getErrors()).toEqual([]);
  });
});
