import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import { createFileBoardStore } from "../src/coordinator/fileBoardStore";
import { CloudBoardConfig } from "../src/coordinator/types";
import { createMemoryLinkStore } from "../src/coordinatorLinks";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import {
  CoordinatorHost,
  boardRuntime,
  OWNER,
  RuntimeServer,
  deploy,
  eventually,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * Restarting a coordinator, and restarting a runtime server.
 *
 * Both sides keep exactly one thing about a deployed board's connection: the
 * ticket. The runtime server keeps it to present again; the coordinator keeps
 * what recognises it. So after either restarts, the runtime server reconnects
 * on its own and the coordinator builds the runtime from the board's config —
 * with nobody present, and with no user token anywhere.
 *
 * What does not come back is the run: a rebuilt runtime starts from the
 * board's config, not from where the old one had got to.
 */

const servers: RuntimeServer[] = [];
const roots: string[] = [];
const hosts: CoordinatorHost[] = [];

afterEach(async () => {
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function runtimeServer(
  options: Parameters<typeof startRuntimeServer>[0] = {},
) {
  const started = await startRuntimeServer(options);
  servers.push(started.server);
  return started;
}

async function freshRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-restart-"));
  roots.push(root);
  return root;
}

/** A coordinator reading and writing the given directory, as a restart does. */
async function coordinatorOn(root: string, port?: number) {
  const coordinator = new BoardCoordinator(createFileBoardStore(root));
  await coordinator.restore();
  const host = await startCoordinator(coordinator, port);
  hosts.push(host);
  return host;
}

/** Stops a coordinator the way a restart does: it keeps what is on disk. */
async function shutDown(host: CoordinatorHost) {
  hosts.splice(hosts.indexOf(host), 1);
  await host.stop();
}

function boardConfig(): CloudBoardConfig {
  return {
    boardName: "doorbell",
    runtimes: [{ id: "node", name: "Node", type: "rest" }],
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

async function publishedMount(server: RuntimeServer): Promise<string> {
  return String(
    boardRuntime(server, "node")?.getService("http-1")?.getState().__hkpMount,
  );
}

describe("a coordinator that has been restarted", () => {
  it("has the board it was given, with the config it was deployed with", async () => {
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    await shutDown(first);

    const second = await coordinatorOn(root);

    const boards = second.coordinator.getBoards("user-1");
    expect(boards.map((b) => b.boardName)).toEqual(["doorbell"]);
    expect(boards[0].config).toEqual(boardConfig());
  });

  it("runs the board again once its runtime server reconnects, with nobody present", async () => {
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    const address = await publishedMount(server);
    await shutDown(first);

    // Back where it was, which is what a restart is to whoever kept its address.
    const second = await coordinatorOn(root, first.port);

    await eventually(
      () => second.coordinator.getBoards("user-1")[0].status === "running",
      "the board to run again",
    );
    // Rebuilt from the board's config, under the same id — one runtime, not two
    // — and at the address it had, so what was configured against it elsewhere
    // still reaches it.
    expect(
      server.runtimeApp.getBoardRuntimes(OWNER).map((runtime) => runtime.id),
    ).toEqual(["node"]);
    expect(await publishedMount(server)).toBe(address);
    expect((await fetch(address)).status).toBe(200);
  });

  it("says which runtime it is waiting for until then", async () => {
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    await shutDown(first);
    // The runtime server is gone too: nothing will reconnect.
    servers.splice(servers.indexOf(server), 1);
    await server.stop();

    const second = await coordinatorOn(root);

    const [board] = second.coordinator.getBoards("user-1");
    expect(board.status).toBe("error");
    expect(board.errors[0]).toMatch(/Runtime "node" is not connected/);
  });

  it("leaves the runtimes running while it is away", async () => {
    // Built to persist, so they outlive the coordinator. A webhook arriving in
    // the meantime is still answered.
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    const address = await publishedMount(server);

    await shutDown(first);

    expect(boardRuntime(server, "node")).toBeTruthy();
    expect((await fetch(address)).status).toBe(200);
  });

  it("keeps a stopped board stopped, and leaves its runtime server alone", async () => {
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    await first.coordinator.stopBoard("user-1", "doorbell");
    await shutDown(first);

    const second = await coordinatorOn(root, first.port);
    await eventually(
      () =>
        second.coordinator.participants.describe("user-1", "doorbell")[0]
          ?.connected === true,
      "the runtime server to reconnect",
    );

    expect(second.coordinator.getBoards("user-1")[0].status).toBe("stopped");
    expect(boardRuntime(server, "node")).toBeUndefined();
  });

  it("does not bring back a board that was deleted", async () => {
    const root = await freshRoot();
    const { server } = await runtimeServer();
    const first = await coordinatorOn(root);
    await deploy(first, "user-1", boardConfig(), { node: server });
    await first.coordinator.removeBoard("user-1", "doorbell");
    await shutDown(first);

    const second = await coordinatorOn(root);

    expect(second.coordinator.getBoards("user-1")).toEqual([]);
  });
});

describe("a runtime server that has been restarted", () => {
  it("reconnects with the ticket it kept and is given its runtime again", async () => {
    const root = await freshRoot();
    const kept = createMemoryLinkStore();
    const before = await runtimeServer({ coordinatorLinks: kept });
    const host = await coordinatorOn(root);
    await deploy(host, "user-1", boardConfig(), { node: before.server });
    const session = host.coordinator.getBoard("user-1", "doorbell")!;

    servers.splice(servers.indexOf(before.server), 1);
    await before.server.stop();
    await eventually(() => session.getStatus() === "error", "the stop to show");

    const after = await runtimeServer({ coordinatorLinks: kept });
    after.server.coordinatorLinks.restore();

    await eventually(() => session.getStatus() === "running", "the rebuild");
    expect(boardRuntime(after.server, "node")).toBeTruthy();
    expect((await fetch(await publishedMount(after.server))).status).toBe(200);
  });

  it("forgets a ticket the coordinator no longer holds, and the runtime with it", async () => {
    // The board was deleted while this server was away. What it kept is a
    // ticket for nothing, and it must not go on presenting it.
    const root = await freshRoot();
    const kept = createMemoryLinkStore();
    const before = await runtimeServer({ coordinatorLinks: kept });
    const host = await coordinatorOn(root);
    await deploy(host, "user-1", boardConfig(), { node: before.server });
    servers.splice(servers.indexOf(before.server), 1);
    await before.server.stop();
    await host.coordinator.removeBoard("user-1", "doorbell");
    expect(kept.load()).toHaveLength(1);

    const after = await runtimeServer({ coordinatorLinks: kept });
    after.server.coordinatorLinks.restore();

    await eventually(() => kept.load().length === 0, "the ticket to be dropped");
    expect(after.server.coordinatorLinks.list(OWNER)).toEqual([]);
  });
});
