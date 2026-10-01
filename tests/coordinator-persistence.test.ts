import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import {
  BoardStore,
  createMemoryBoardStore,
  PersistedBoard,
} from "../src/coordinator/boardStore";
import { CloudBoardConfig } from "../src/coordinator/types";
import { monitorDescriptor } from "../src/services/monitor";
import {
  eventually,
  introduce,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * What a coordinator keeps, and what it does not.
 *
 * A board is a document — a name, an owner, the config that was deployed,
 * whether it was stopped, and the tickets its runtime servers connect with. A
 * run of it is not: the runtimes, what they reported, the addresses their
 * mounts had. So a board that comes back from the store has nothing running
 * until its runtime servers reconnect — and one that was stopped stays stopped.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function boardConfig(boardName: string): CloudBoardConfig {
  return {
    boardName,
    runtimes: [{ id: "node", name: "Node", type: "rest" }],
    services: {
      node: [{ uuid: "mon-1", serviceId: monitorDescriptor.serviceId }],
    },
  };
}

/** A coordinator with a runtime server connected for the board's runtime. */
async function coordinatorWith(store?: BoardStore, boardName = "doorbell") {
  const { server } = await startRuntimeServer();
  const host = await startCoordinator(new BoardCoordinator(store));
  cleanups.push(host.stop);
  let stopped = false;
  const stopRuntimeHost = async () => {
    if (!stopped) {
      stopped = true;
      await server.stop();
    }
  };
  cleanups.push(stopRuntimeHost);
  await introduce(host, "user-1", boardName, { node: server });
  return { coordinator: host.coordinator, host, server, stopRuntimeHost };
}

describe("deploying a board", () => {
  it("writes it to the store", async () => {
    const store = createMemoryBoardStore();
    const { coordinator } = await coordinatorWith(store);

    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    const held = await store.load();
    expect(held).toHaveLength(1);
    expect(held[0].userId).toBe("user-1");
    expect(held[0].boardName).toBe("doorbell");
    expect(held[0].config.services.node[0].uuid).toBe("mon-1");
    expect(held[0].stopped).toBe(false);
  });

  it("writes down what recognises its tickets, and nothing that could be presented", async () => {
    const store = createMemoryBoardStore();
    const { coordinator } = await coordinatorWith(store);

    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    const [held] = await store.load();
    expect(held.tickets?.map((ticket) => ticket.runtimeId)).toEqual(["node"]);
    expect(held.tickets?.[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(held)).not.toContain("hkpt_");
  });

  it("remembers that a board was stopped", async () => {
    const store = createMemoryBoardStore();
    const { coordinator } = await coordinatorWith(store);
    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    await coordinator.stopBoard("user-1", "doorbell");

    expect((await store.load())[0].stopped).toBe(true);
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
    const { coordinator } = await coordinatorWith(failing);

    const session = await coordinator.registerBoard(
      "user-1",
      boardConfig("doorbell"),
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
    config: boardConfig("doorbell"),
    stopped: false,
    tickets: [],
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

  it("brings a running board back waiting for its runtime servers, by name", async () => {
    // Nothing is connected at boot and nothing is dialled. The board says
    // which runtime it is waiting for, and runs when that server reconnects.
    const coordinator = new BoardCoordinator(storeHolding(stored));

    await coordinator.restore();

    const [board] = coordinator.getBoards("user-1");
    expect(board.status).toBe("error");
    expect(board.errors).toEqual([
      'Runtime "node" is not connected — its runtime server has to connect to this coordinator',
    ]);
  });

  it("brings a stopped board back stopped", async () => {
    const coordinator = new BoardCoordinator(
      storeHolding({ ...stored, stopped: true }),
    );

    await coordinator.restore();

    expect(coordinator.getBoards("user-1")[0].status).toBe("stopped");
  });

  it("brings back stopped a board stored before there were tickets", async () => {
    // Nothing holds a ticket for it, so nothing could ever reconnect: saying
    // it is waiting would be a promise nobody can keep.
    const { stopped: _stopped, tickets: _tickets, ...legacy } = stored;
    const coordinator = new BoardCoordinator(storeHolding(legacy));

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
    const { coordinator } = await coordinatorWith(storeHolding(stored));
    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    await coordinator.restore();

    const boards = coordinator.getBoards("user-1");
    expect(boards).toHaveLength(1);
    expect(boards[0].status).toBe("running");
  });
});

describe("deleting a board", () => {
  it("takes it out of the store, so a restart cannot bring it back", async () => {
    const store = createMemoryBoardStore();
    const { coordinator } = await coordinatorWith(store);
    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    expect(await coordinator.removeBoard("user-1", "doorbell")).toBe(true);

    expect(await store.load()).toEqual([]);
  });

  it("reports nothing to delete when there is no such board", async () => {
    const { coordinator } = await coordinatorWith();
    expect(await coordinator.removeBoard("user-1", "nope")).toBe(false);
  });
});

describe("stopping a board whose runtime server has gone", () => {
  it("still releases the board, and says what it could not release", async () => {
    // A server that is away must not make a board impossible to stop. But the
    // runtime may well still be running — built to persist, holding its mount
    // — so the board says so rather than reporting a clean stop.
    const { coordinator, stopRuntimeHost } = await coordinatorWith();
    await coordinator.registerBoard("user-1", boardConfig("doorbell"));
    const session = coordinator.getBoard("user-1", "doorbell")!;
    // The server disappears between deploy and stop.
    await stopRuntimeHost();
    await eventually(() => session.getStatus() === "error", "the drop to show");

    await session.stop();

    expect(session.getStatus()).toBe("stopped");
    expect(session.getErrors()).toHaveLength(1);
    expect(session.getErrors()[0]).toContain('Runtime "node"');
    expect(session.getErrors()[0]).toContain("is not connected");
    expect(session.getErrors()[0]).toContain("may still be running");
  });

  it("reports nothing when every runtime let go", async () => {
    const { coordinator } = await coordinatorWith();
    await coordinator.registerBoard("user-1", boardConfig("doorbell"));

    const session = coordinator.getBoard("user-1", "doorbell")!;
    await session.stop();

    expect(session.getErrors()).toEqual([]);
  });
});
