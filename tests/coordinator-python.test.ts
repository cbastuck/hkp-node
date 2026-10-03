import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { AddressInfo, createServer } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CloudBoardConfig } from "../src/coordinator/types";
import {
  CoordinatorHost,
  boardRuntime,
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
    { id: "node", name: "Node", type: "rest", remote: "Node" },
    { id: "py", name: "Python", type: "rest", remote: "Python" },
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

    // The python runtime exists, built from the board, as the board's: the
    // coordinator can ask after it, and a client of that server is not shown
    // it among its own.
    const python = host.coordinator.participants
      .forBoard("user-1", board.boardName)
      .get("py")!;
    const built = (await python.request({ op: "describe" })) as {
      services: Array<{ uuid: string }>;
    };
    expect(built.services.map((s) => s.uuid)).toEqual(["seen"]);
    expect((await (await fetch(`${pythonUrl}/runtimes`)).json()).runtimes).toEqual(
      [],
    );
    expect(
      (await (await fetch(`${pythonUrl}/coordinator-links`)).json()).links.map(
        (link: { boardName: string; runtimeId: string }) => [
          link.boardName,
          link.runtimeId,
        ],
      ),
    ).toEqual([["two-languages", "py"]]);

    // Set the first runtime going. What it emits is carried to the coordinator
    // over node's connection and on to python over python's, where the monitor
    // says what it was handed.
    const said: Array<{ type?: string; serviceUuid?: string; payload?: unknown }> =
      [];
    python.listen((event) => said.push(event as (typeof said)[number]));

    boardRuntime(node.server, "node")!.emitResult({ ping: 1 });

    await eventually(
      () =>
        said.some(
          (message) =>
            message.type === "notification" &&
            message.serviceUuid === "seen" &&
            JSON.stringify(message.payload).includes("ping"),
        ),
      "the python monitor to see what node emitted",
    );
  });

  it("carries bytes into python and out again unchanged", async () => {
    // Node makes them, python is handed them and passes them on, node receives
    // them: two links and two implementations of the frame in between.
    const host = await startCoordinator();
    hosts.push(host);
    const node = await startRuntimeServer();
    servers.push(node.server);
    const pythonUrl = await startPython();
    const roundTrip: CloudBoardConfig = {
      boardName: "bytes-round-trip",
      runtimes: [
        { id: "out", name: "Out", type: "rest" },
        { id: "py", name: "Python", type: "rest" },
        { id: "back", name: "Back", type: "rest" },
      ],
      services: {
        out: [],
        py: [{ uuid: "seen", serviceId: "monitor" }],
        back: [],
      },
    };
    const tickets = await host.coordinator.issueTickets(
      "user-1",
      roundTrip.boardName,
      ["out", "py", "back"],
    );
    for (const [runtimeId, baseUrl] of [
      ["out", node.baseUrl],
      ["py", pythonUrl],
      ["back", node.baseUrl],
    ] as const) {
      const res = await fetch(`${baseUrl}/coordinator-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coordinatorUrl: host.url,
          ticket: tickets[runtimeId],
          boardName: roundTrip.boardName,
          runtimeId,
        }),
      });
      expect(res.status).toBe(201);
    }
    const session = await host.coordinator.registerBoard("user-1", roundTrip);
    expect(session.getErrors()).toEqual([]);

    const arrived: unknown[] = [];
    const back = boardRuntime(node.server, "back")!;
    const process = back.process.bind(back);
    back.process = ((input: unknown, ...rest: unknown[]) => {
      arrived.push(input);
      return (process as (...args: unknown[]) => unknown)(input, ...rest);
    }) as typeof back.process;

    const out = boardRuntime(node.server, "out")!;
    const sent = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
    out.emitResult(sent);
    out.emitResult({ meta: { name: "a.bin" }, binary: new Uint8Array([1, 2]) });
    out.emitResult({
      type: "FloatRingBuffer",
      id: 3,
      ts: 99,
      binary: new Uint8Array(new Float32Array([0.5, -1]).buffer),
    });

    await eventually(() => arrived.length === 3, "all three to come back");
    expect(arrived[0]).toEqual(sent);
    expect(arrived[1]).toEqual({
      meta: { name: "a.bin" },
      binary: new Uint8Array([1, 2]),
    });
    // A ring buffer in python, and still one when it leaves.
    expect(arrived[2]).toEqual({
      type: "FloatRingBuffer",
      id: 3,
      ts: 99,
      binary: new Uint8Array(new Float32Array([0.5, -1]).buffer),
    });
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
