import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { AddressInfo, createServer } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { CloudBoardConfig } from "../src/coordinator/types";
import {
  CoordinatorHost,
  OWNER,
  RuntimeServer,
  eventually,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A board across two runtime servers written in two languages.
 *
 * hkp-python is started as its own process, the way it runs for real, and
 * introduced to the coordinator over its REST route — which is exactly what a
 * person's client does when it deploys. Nothing here shares code with
 * hkp-python: what is under test is that both ends mean the same thing by the
 * protocol.
 *
 * Skipped where hkp-python has no virtualenv, so the suite still runs on a
 * machine that only has Node.
 */

const PYTHON_DIR = path.resolve(__dirname, "../../hkp-python");
const PYTHON = path.join(PYTHON_DIR, ".venv/bin/python");
const hasPython = fs.existsSync(PYTHON);

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  while (processes.length) {
    processes.pop()?.kill();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** hkp-python as a process of its own, on loopback and so without auth. */
async function startPython(): Promise<string> {
  const port = await freePort();
  const child = spawn(PYTHON, ["-m", "hkp"], {
    cwd: PYTHON_DIR,
    env: {
      ...process.env,
      PYTHONPATH: path.join(PYTHON_DIR, "src"),
      SKIP_LOADING_ENV: "true",
      HOST: "127.0.0.1",
      PORT: String(port),
      HKP_COORDINATOR_LINKS_FILE: "",
      HKP_MOUNT_SECRET: "test",
      AUTH0_DOMAIN: "",
      AUTH0_AUDIENCE: "",
    },
    stdio: "ignore",
  });
  processes.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await eventually(
    async () => {
      try {
        return (await fetch(`${baseUrl}/runtimes`)).ok;
      } catch {
        return false;
      }
    },
    "hkp-python to start",
    15_000,
  );
  return baseUrl;
}

const board: CloudBoardConfig = {
  boardName: "two-languages",
  runtimes: [
    { id: "node", name: "Node", type: "rest", requires: { kind: "node" } },
    { id: "py", name: "Python", type: "rest", requires: { kind: "python" } },
  ],
  services: {
    node: [
      {
        uuid: "stamp",
        serviceId: "map",
        state: { mode: "add", template: { via: "node" } },
      },
    ],
    py: [{ uuid: "seen", serviceId: "monitor" }],
  },
};

describe.skipIf(!hasPython)("a board across hkp-node and hkp-python", () => {
  it("is built on both and driven from one to the other, with nothing dialled", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const node = await startRuntimeServer();
    servers.push(node.server);
    const pythonUrl = await startPython();

    // What a person's client does: a ticket per runtime, handed to the runtime
    // server it chose, over that server's own REST api.
    const tickets = await host.coordinator.issueTickets(
      "user-1",
      board.boardName,
      ["node", "py"],
    );
    for (const [runtimeId, baseUrl] of [
      ["node", node.baseUrl],
      ["py", pythonUrl],
    ] as const) {
      const res = await fetch(`${baseUrl}/coordinator-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coordinatorUrl: host.url,
          ticket: tickets[runtimeId],
          boardName: board.boardName,
          runtimeId,
        }),
      });
      expect(res.status).toBe(201);
    }

    const session = await host.coordinator.registerBoard("user-1", board);

    expect(session.getErrors()).toEqual([]);
    expect(session.getStatus()).toBe("running");
    expect(
      host.coordinator.participants
        .describe("user-1", board.boardName)
        .map((p) => [p.runtimeId, p.server, p.connected]),
    ).toEqual([
      ["node", "node", true],
      ["py", "python", true],
    ]);

    // The python runtime exists, built from the board, as the coordinator's.
    const built = await (await fetch(`${pythonUrl}/runtimes/py`)).json();
    expect(built.services.map((s: { uuid: string }) => s.uuid)).toEqual(["seen"]);
    expect(built.boardName).toBe("two-languages");

    // Watch the python runtime the way any client of that server can, then
    // set the first runtime going. What it emits is carried to the coordinator
    // over node's connection and on to python over python's.
    const watching = new WebSocket(`${pythonUrl.replace("http", "ws")}/py`);
    const said: Array<{ type?: string; instanceId?: string; value?: string }> =
      [];
    watching.on("message", (raw) => said.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => watching.on("open", () => resolve()));

    node.server.runtimeApp.getRuntime(OWNER, "node")!.emitResult({ ping: 1 });

    await eventually(
      () =>
        said.some(
          (message) =>
            message.type === "notification" &&
            message.instanceId === "seen" &&
            String(message.value).includes("ping"),
        ),
      "the python monitor to see what node emitted",
    );
    watching.close();
  });

  it("names the python runtime when its server goes away, and recovers nothing by dialling", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const pythonUrl = await startPython();
    const pyOnly: CloudBoardConfig = {
      boardName: "py-only",
      runtimes: [{ id: "py", name: "Python", type: "rest" }],
      services: { py: [{ uuid: "seen", serviceId: "monitor" }] },
    };
    const tickets = await host.coordinator.issueTickets("user-1", "py-only", [
      "py",
    ]);
    await fetch(`${pythonUrl}/coordinator-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinatorUrl: host.url,
        ticket: tickets.py,
        boardName: "py-only",
        runtimeId: "py",
      }),
    });
    const session = await host.coordinator.registerBoard("user-1", pyOnly);
    expect(session.getStatus()).toBe("running");

    processes.pop()?.kill();

    await eventually(() => session.getStatus() === "error", "the loss to show");
    expect(session.getErrors()).toEqual([
      'Runtime "py" is not connected — its runtime server has to connect to this coordinator',
    ]);
  });
});
