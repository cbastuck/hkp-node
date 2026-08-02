import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { createRuntimeServer } from "../src/server";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import { createFileBoardStore } from "../src/coordinator/fileBoardStore";
import { CloudBoardConfig } from "../src/coordinator/types";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";

/**
 * Restarting a coordinator.
 *
 * The boards come back; the runs do not. A restored board is a config that is
 * not running, because starting one needs the user's JWT and at boot there is
 * nobody. Its runtimes, meanwhile, are still going: the coordinator provisioned
 * them to persist, so they outlive it and nothing is left tracking them. That
 * is the state Start has to be able to walk into.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];
const roots: string[] = [];
const coordinators: BoardCoordinator[] = [];

afterEach(async () => {
  while (coordinators.length) {
    const coordinator = coordinators.pop()!;
    for (const board of coordinator.getBoards("user-1")) {
      await coordinator.removeBoard("user-1", board.boardName);
    }
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
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

async function freshRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-restart-"));
  roots.push(root);
  return root;
}

/** A coordinator reading and writing the given directory, as a restart does. */
async function coordinatorOn(root: string) {
  const coordinator = new BoardCoordinator(createFileBoardStore(root));
  await coordinator.restore();
  coordinators.push(coordinator);
  return coordinator;
}

function boardConfig(url: string): CloudBoardConfig {
  return {
    boardName: "doorbell",
    runtimes: [{ id: "node", name: "Node", type: "rest", url }],
    services: {
      node: [
        {
          uuid: "http-1",
          serviceId: httpServerSubservicesDescriptor.serviceId,
          state: {
            bypass: false,
            mode: "process_on_session",
            pipeline: [
              {
                instanceId: "answer",
                serviceId: "map",
                serviceName: "Answer",
                state: { mode: "replace", template: { answer: "hello" } },
              },
            ],
          },
        },
      ],
    },
  };
}

async function publishedMount(server: Server): Promise<string> {
  const { body } = await request(server.httpServer)
    .get("/runtimes/node/services/http-1")
    .expect(200);
  return String(body.__hkpMount);
}

describe("a coordinator that has been restarted", () => {
  it("has the board it was given, with the config it was deployed with", async () => {
    const root = await freshRoot();
    const { baseUrl } = await startRuntimeServer();
    const first = await coordinatorOn(root);
    await first.registerBoard("user-1", boardConfig(baseUrl));

    const second = await coordinatorOn(root);

    const boards = second.getBoards("user-1");
    expect(boards.map((b) => b.boardName)).toEqual(["doorbell"]);
    expect(boards[0].config).toEqual(boardConfig(baseUrl));
  });

  it("has it stopped, whatever it was doing before", async () => {
    const root = await freshRoot();
    const { baseUrl } = await startRuntimeServer();
    const first = await coordinatorOn(root);
    await first.registerBoard("user-1", boardConfig(baseUrl));
    expect(first.getBoards("user-1")[0].status).toBe("running");

    const second = await coordinatorOn(root);

    expect(second.getBoards("user-1")[0].status).toBe("stopped");
  });

  it("has not touched the runtimes, which are still running without it", async () => {
    // Provisioned to persist, so they survive — and nothing is tracking them.
    // The orphan is real; the point is that starting the board reclaims it.
    const root = await freshRoot();
    const { server, baseUrl } = await startRuntimeServer();
    const first = await coordinatorOn(root);
    await first.registerBoard("user-1", boardConfig(baseUrl));
    const before = await publishedMount(server);

    await coordinatorOn(root);

    await request(server.httpServer).get("/runtimes/node").expect(200);
    expect((await fetch(before)).status).toBe(200);
  });

  it("rebuilds them when the board is started, leaving no second copy", async () => {
    // Start registers the same config, and posting a runtime id replaces what
    // is under it — so the orphan is destroyed rather than duplicated.
    const root = await freshRoot();
    const { server, baseUrl } = await startRuntimeServer();
    const first = await coordinatorOn(root);
    await first.registerBoard("user-1", boardConfig(baseUrl));
    const orphaned = await publishedMount(server);

    const second = await coordinatorOn(root);
    const restored = second.getBoards("user-1")[0];
    await second.registerBoard("user-1", restored.config!);

    const { body } = await request(server.httpServer)
      .get("/runtimes")
      .expect(200);
    expect(body.runtimes.map((rt: { id: string }) => rt.id)).toEqual(["node"]);
    expect(second.getBoards("user-1")[0].status).toBe("running");
    // The old mount went with the runtime it belonged to; the new one answers.
    expect((await fetch(orphaned)).status).toBe(404);
    expect((await fetch(await publishedMount(server))).status).toBe(200);
  });

  it("does not bring back a board that was deleted", async () => {
    const root = await freshRoot();
    const { baseUrl } = await startRuntimeServer();
    const first = await coordinatorOn(root);
    await first.registerBoard("user-1", boardConfig(baseUrl));
    await first.removeBoard("user-1", "doorbell");

    const second = await coordinatorOn(root);

    expect(second.getBoards("user-1")).toEqual([]);
  });
});
