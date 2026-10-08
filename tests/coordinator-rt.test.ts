import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CloudBoardConfig } from "../src/coordinator/types";
import {
  attachBrowser,
  CoordinatorHost,
  boardRuntime,
  RuntimeServer,
  eventually,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A board across hkp-node and hkp-rt, the C++ runtime server.
 *
 * hkp-rt is started as its own process, the way it runs for real, and
 * introduced to the coordinator over its REST route — which is exactly what a
 * person's client does when it deploys. Nothing here shares code with hkp-rt:
 * what is under test is that both ends mean the same thing by the protocol,
 * bytes included.
 *
 * Skipped where hkp-rt has not been built (`hkp-rt/run-tests.sh` builds it), so
 * the suite still runs on a machine that only has Node. `HKP_RT_BIN` names a
 * binary built elsewhere.
 */

const RT_DIR = path.resolve(__dirname, "../../hkp-rt");
const RT_BIN = [
  process.env.HKP_RT_BIN,
  path.join(RT_DIR, "build-tests/exe/hkp-rt"),
  path.join(RT_DIR, "build/exe/hkp-rt"),
].find((candidate) => !!candidate && fs.existsSync(candidate));

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];
const processes: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (processes.length) {
    processes.pop()?.kill("SIGKILL");
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
  while (directories.length) {
    fs.rmSync(directories.pop()!, { recursive: true, force: true });
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

/** hkp-rt as a process of its own, on loopback and so without auth. */
async function startRt(
  port?: number,
  linksFile = "",
  env: Record<string, string> = {},
): Promise<{ baseUrl: string; port: number; child: ChildProcess }> {
  const chosen = port ?? (await freePort());
  const child = spawn(RT_BIN!, [String(chosen)], {
    env: {
      ...process.env,
      HOST: "",
      AUTH0_DOMAIN: "",
      AUTH0_AUDIENCE: "",
      ALLOWED_EMAILS: "",
      HKP_COORDINATOR_LINKS_FILE: linksFile,
      HKP_MOUNT_SECRET: "test-secret",
      HKP_EXTERNAL_URL: "",
      ...env,
    },
    stdio: "ignore",
  });
  processes.push(child);
  const baseUrl = `http://127.0.0.1:${chosen}`;
  await eventually(
    async () => {
      try {
        return (await fetch(`${baseUrl}/runtimes`)).ok;
      } catch {
        return false;
      }
    },
    "hkp-rt to start",
    15_000,
  );
  return { baseUrl, port: chosen, child };
}

async function introduceOver(
  host: CoordinatorHost,
  boardName: string,
  placement: Array<readonly [string, string]>,
  userId = "user-1",
): Promise<void> {
  const tickets = await host.coordinator.issueTickets(
    userId,
    boardName,
    placement.map(([runtimeId]) => runtimeId),
  );
  for (const [runtimeId, baseUrl] of placement) {
    const res = await fetch(`${baseUrl}/coordinator-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coordinatorUrl: host.url,
        ticket: tickets[runtimeId],
        boardName,
        runtimeId,
      }),
    });
    expect(res.status).toBe(201);
  }
}

/** What a runtime on a node server is handed as input, in order. */
function arrivals(server: RuntimeServer, runtimeId: string): unknown[] {
  const seen: unknown[] = [];
  const runtime = boardRuntime(server, runtimeId)!;
  const process = runtime.process.bind(runtime);
  runtime.process = ((input: unknown, ...rest: unknown[]) => {
    seen.push(input);
    return (process as (...args: unknown[]) => unknown)(input, ...rest);
  }) as typeof runtime.process;
  return seen;
}

const roundTrip: CloudBoardConfig = {
  boardName: "through-cpp",
  runtimes: [
    { id: "out", name: "Out", type: "rest" },
    { id: "cpp", name: "C++", type: "rest" },
    { id: "back", name: "Back", type: "rest" },
  ],
  services: {
    out: [],
    cpp: [
      {
        uuid: "stamp",
        serviceId: "map",
        // Left as it is for anything that is not a JSON object.
        state: { mode: "add", template: { via: "cpp" } },
      },
    ],
    back: [],
  },
};

describe.skipIf(!RT_BIN)("a board across hkp-node and hkp-rt", () => {
  it("says it can join a coordinator", async () => {
    const rt = await startRt();

    const said = await (await fetch(`${rt.baseUrl}/runtimes`)).json();

    expect(said.server).toBe("c++");
    expect(said.coordinatorLinks).toBe(true);
  });

  it("begins a run on hkp-rt as the browser's caller, and carries it on to node", async () => {
    // A facade's process action on a deployed board: the coordinator begins
    // the run on the runtime holding the service, as whoever attached with
    // the bridge. hkp-rt runs it and its result leaves with the run, which is
    // what lets node — the board's next runtime — know who began it.
    const host = await startCoordinator();
    hosts.push(host);
    const node = await startRuntimeServer();
    servers.push(node.server);
    const rt = await startRt();
    const shared: CloudBoardConfig = {
      boardName: "who-through-cpp",
      runtimes: [
        { id: "cpp", name: "C++", type: "rest" },
        { id: "node", name: "Node", type: "rest" },
      ],
      services: {
        cpp: [
          { uuid: "first", serviceId: "map", state: { mode: "add", template: { first: true } } },
          { uuid: "second", serviceId: "map", state: { mode: "add", template: { via: "cpp" } } },
        ],
        node: [
          {
            uuid: "who",
            serviceId: "sql",
            state: {
              mode: "query",
              statement:
                "SELECT $caller_sub AS sub, $caller_email AS email, $caller_name AS name, $via AS via, $first AS first",
            },
          },
        ],
      },
    };
    const alice = {
      sub: "auth0|alice",
      email: "alice@example.com",
      name: "Alice",
    };
    await introduceOver(
      host,
      shared.boardName,
      [
        ["cpp", rt.baseUrl],
        ["node", node.baseUrl],
      ],
      alice.sub,
    );
    const session = await host.coordinator.registerBoard(alice.sub, shared);
    expect(session.getErrors()).toEqual([]);
    const browser = await attachBrowser(session, [], { role: "owner", caller: alice });

    try {
      const answer = await browser.ask({
        type: "processService",
        requestId: "p-1",
        runtimeId: "cpp",
        serviceUuid: "second",
        payload: { hello: "there" },
      });
      expect(answer.error).toBeUndefined();
      expect(answer.data).toEqual({ accepted: true });

      const rows = () =>
        browser
          .all("notification")
          .filter((n) => n.serviceUuid === "who")
          .map((n) => (n.payload as { rows?: unknown[] }).rows)
          .find((found) => Array.isArray(found));
      await eventually(() => !!rows(), "node to say who began the run");
      // Begun at the second service — the first never ran — and as Alice.
      expect(rows()).toEqual([{ ...alice, via: "cpp", first: null }]);

      const missing = await browser.ask({
        type: "processService",
        requestId: "p-2",
        runtimeId: "cpp",
        serviceUuid: "nobody",
      });
      expect(missing.error).toMatch(/no service "nobody"/);
    } finally {
      await browser.stop();
    }
  });

  it("is built on both and driven from one to the other, with nothing dialled", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const node = await startRuntimeServer();
    servers.push(node.server);
    const rt = await startRt();
    await introduceOver(host, roundTrip.boardName, [
      ["out", node.baseUrl],
      ["cpp", rt.baseUrl],
      ["back", node.baseUrl],
    ]);

    const session = await host.coordinator.registerBoard("user-1", roundTrip);

    expect(session.getErrors()).toEqual([]);
    expect(session.getStatus()).toBe("running");
    expect(
      host.coordinator.participants
        .describe("user-1", roundTrip.boardName)
        .map((p) => [p.runtimeId, p.server, p.connected]),
    ).toEqual([
      ["out", "node", true],
      ["cpp", "c++", true],
      ["back", "node", true],
    ]);

    // The C++ runtime exists, built from the board, as the board's: the
    // coordinator can ask after it, and a client of that server is not shown
    // it among its own.
    const built = (await host.coordinator.participants
      .forBoard("user-1", roundTrip.boardName)
      .get("cpp")!
      .request({ op: "describe" })) as { services: Array<{ uuid: string }> };
    expect(built.services.map((s) => s.uuid)).toEqual(["stamp"]);
    expect((await (await fetch(`${rt.baseUrl}/runtimes`)).json()).runtimes).toEqual(
      [],
    );
    expect((await (await fetch(`${rt.baseUrl}/coordinator-links`)).json()).links)
      .toEqual([
        {
          boardName: "through-cpp",
          runtimeId: "cpp",
          coordinatorUrl: host.url,
          connected: true,
          running: true,
        },
      ]);

    const arrived = arrivals(node.server, "back");
    boardRuntime(node.server, "out")!.emitResult({ ping: 1 });

    await eventually(() => arrived.length === 1, "the value to come back");
    expect(arrived[0]).toEqual({ ping: 1, via: "cpp" });
  });

  it("carries bytes into C++ and out again unchanged", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const node = await startRuntimeServer();
    servers.push(node.server);
    const rt = await startRt();
    const plain: CloudBoardConfig = {
      ...roundTrip,
      boardName: "bytes-through-cpp",
      services: { out: [], cpp: [], back: [] },
    };
    await introduceOver(host, plain.boardName, [
      ["out", node.baseUrl],
      ["cpp", rt.baseUrl],
      ["back", node.baseUrl],
    ]);
    const session = await host.coordinator.registerBoard("user-1", plain);
    expect(session.getErrors()).toEqual([]);
    const arrived = arrivals(node.server, "back");
    const out = boardRuntime(node.server, "out")!;
    const sent = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
    const samples = new Uint8Array(new Float32Array([0.5, -1, 0.25]).buffer);

    out.emitResult(sent);
    await eventually(() => arrived.length === 1, "the bytes to come back");
    out.emitResult({ meta: { name: "a.bin" }, binary: new Uint8Array([1, 2]) });
    await eventually(() => arrived.length === 2, "the object to come back");
    out.emitResult({ type: "FloatRingBuffer", id: 3, ts: 99, binary: samples });
    await eventually(() => arrived.length === 3, "the ring buffer to come back");

    expect(arrived[0]).toEqual(sent);
    expect(arrived[1]).toEqual({
      meta: { name: "a.bin" },
      binary: new Uint8Array([1, 2]),
    });
    // A ring buffer in C++, and still one when it leaves: the same samples,
    // under the id and timestamp it arrived with.
    expect(arrived[2]).toEqual({
      type: "FloatRingBuffer",
      id: 3,
      ts: 99,
      binary: samples,
    });
  });

  it("names the C++ runtime when its server goes away, and takes it back when it returns", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-rt-links-"));
    directories.push(directory);
    const linksFile = path.join(directory, "coordinator-links.json");
    const rt = await startRt(undefined, linksFile);
    const cppOnly: CloudBoardConfig = {
      boardName: "cpp-only",
      runtimes: [{ id: "cpp", name: "C++", type: "rest" }],
      services: { cpp: [{ uuid: "seen", serviceId: "monitor" }] },
    };
    await introduceOver(host, cppOnly.boardName, [["cpp", rt.baseUrl]]);
    const session = await host.coordinator.registerBoard("user-1", cppOnly);
    expect(session.getStatus()).toBe("running");
    // Kept for its owner only: a ticket is a bearer credential.
    expect(fs.statSync(linksFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(linksFile, "utf8")).toContain("hkpt_");

    rt.child.kill("SIGKILL");

    await eventually(() => session.getStatus() === "error", "the loss to show");
    expect(session.getErrors()).toEqual([
      'Runtime "cpp" is not connected — its runtime server has to connect to this coordinator',
    ]);

    // The same server, started again: nothing but the ticket it kept. It
    // connects on its own, and the coordinator rebuilds the runtime.
    const again = await startRt(rt.port, linksFile);

    await eventually(
      () => session.getStatus() === "running",
      "the board to recover",
      10_000,
    );
    const rebuilt = (await host.coordinator.participants
      .forBoard("user-1", cppOnly.boardName)
      .get("cpp")!
      .request({ op: "describe" })) as { services: Array<{ uuid: string }> };
    expect(rebuilt.services.map((s) => s.uuid)).toEqual(["seen"]);
  });

  it("releases the runtime and forgets the ticket when the board is deleted", async () => {
    const host = await startCoordinator();
    hosts.push(host);
    const rt = await startRt();
    const cppOnly: CloudBoardConfig = {
      boardName: "cpp-deleted",
      runtimes: [{ id: "cpp", name: "C++", type: "rest" }],
      services: { cpp: [] },
    };
    await introduceOver(host, cppOnly.boardName, [["cpp", rt.baseUrl]]);
    await host.coordinator.registerBoard("user-1", cppOnly);
    const links = async () =>
      (await (await fetch(`${rt.baseUrl}/coordinator-links`)).json()).links;
    expect((await links()).map((link: { running: boolean }) => link.running))
      .toEqual([true]);

    await host.coordinator.removeBoard("user-1", "cpp-deleted");

    // Rejected with its ticket, the server drops the link and what it was for.
    await eventually(
      async () =>
        (await (await fetch(`${rt.baseUrl}/coordinator-links`)).json()).links
          .length === 0,
      "the link to be dropped",
    );
  });
});

/** A runtime with one endpoint that answers with the path it was asked for. */
const endpointRuntime = {
  id: "rt",
  name: "RT",
  boardName: "doorbell",
  services: [
    {
      uuid: "hook",
      serviceId: "http-server-subservices",
      state: {
        // Named by the board and not acted on: the endpoint is a path on the
        // server's own port.
        port: 8080,
        bypass: false,
        onRequest: [
          {
            serviceId: "map",
            instanceId: "answer",
            state: {
              mode: "replace",
              template: { servedBy: "cpp", "path=": "params.meta.path" },
            },
          },
        ],
      },
    },
  ],
};

async function createEndpoint(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/runtimes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(endpointRuntime),
  });
  expect(res.status).toBe(200);
  const built = await (await fetch(`${baseUrl}/runtimes/rt`)).json();
  return built.services[0].state.__hkpMount as string;
}

describe.skipIf(!RT_BIN)("an endpoint a service exposes on hkp-rt", () => {
  it("is a path on the server's own port, at the address hkp-node would derive", async () => {
    const rt = await startRt();

    const url = await createEndpoint(rt.baseUrl);

    // HMAC-SHA256("test-secret", "" NUL "doorbell" NUL "rt" NUL "hook"), the
    // derivation in src/mounts.ts with an empty tenant.
    const { createHmac } = await import("node:crypto");
    const id = createHmac("sha256", "test-secret")
      .update(["", "doorbell", "rt", "hook"].join("\u0000"))
      .digest("hex")
      .slice(0, 32);
    expect(url).toBe(`${rt.baseUrl}/hosted/${id}`);

    const answer = await fetch(`${url}/hello?x=1`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ servedBy: "cpp", path: "/hello" });

    const posted = await fetch(`${url}/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await posted.json()).toEqual({ servedBy: "cpp", path: "/things" });
  });

  it("does not answer for a mount nobody holds", async () => {
    const rt = await startRt();
    await createEndpoint(rt.baseUrl);

    const res = await fetch(`${rt.baseUrl}/hosted/${"0".repeat(32)}/hello`);

    expect(res.status).toBe(404);
  });

  it("releases a mounted endpoint when its runtime is removed", async () => {
    const rt = await startRt();
    const url = await createEndpoint(rt.baseUrl);
    expect((await fetch(`${url}/before`)).status).toBe(200);

    await fetch(`${rt.baseUrl}/runtimes/rt`, { method: "DELETE" });

    expect((await fetch(`${url}/after`)).status).toBe(404);
  });

  it("rotates a mounted endpoint when its mount name changes", async () => {
    const rt = await startRt();
    const before = await createEndpoint(rt.baseUrl);

    const configured = await fetch(
      `${rt.baseUrl}/runtimes/rt/services/hook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mountName: "renamed" }),
      },
    );
    expect(configured.status).toBe(200);
    const after = (await configured.json()).__hkpMount as string;

    expect(after).not.toBe(before);
    expect((await fetch(`${before}/old`)).status).toBe(404);
    expect((await fetch(`${after}/new`)).status).toBe(200);
  });

  it("keeps its address across a restart", async () => {
    const rt = await startRt();
    const before = await createEndpoint(rt.baseUrl);
    rt.child.kill("SIGKILL");
    await eventually(async () => {
      try {
        await fetch(`${rt.baseUrl}/runtimes`);
        return false;
      } catch {
        return true;
      }
    }, "hkp-rt to stop");

    const again = await startRt(rt.port);
    const after = await createEndpoint(again.baseUrl);

    expect(after).toBe(before);
    expect((await fetch(`${after}/still`)).status).toBe(200);
  });

  it("lets two servers on one machine serve the same board", async () => {
    // Each used to bind the port the board names, and the second one failed.
    const first = await startRt();
    const second = await startRt();

    const one = await createEndpoint(first.baseUrl);
    const two = await createEndpoint(second.baseUrl);

    expect(one.startsWith(first.baseUrl)).toBe(true);
    expect(two.startsWith(second.baseUrl)).toBe(true);
    expect((await fetch(`${one}/a`)).status).toBe(200);
    expect((await fetch(`${two}/b`)).status).toBe(200);
  });

  it("publishes the address it is reached at from outside", async () => {
    const rt = await startRt(undefined, "", {
      HKP_EXTERNAL_URL: "https://rt.example.com/",
    });

    const url = await createEndpoint(rt.baseUrl);

    expect(url).toMatch(/^https:\/\/rt\.example\.com\/hosted\/[0-9a-f]{32}$/);
  });

  it("still carries a runtime's notifications over its socket", async () => {
    // The api, sockets included, is reached through the same port.
    const rt = await startRt();
    await fetch(`${rt.baseUrl}/runtimes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "watched",
        name: "Watched",
        services: [{ uuid: "mon", serviceId: "monitor" }],
      }),
    });
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(`ws://127.0.0.1:${rt.port}/notifications`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => frames.push(raw));
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "reader", id: "watched" }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    await fetch(`${rt.baseUrl}/runtimes/watched`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ping: 1 }),
    });

    await eventually(() => frames.length > 0, "a frame from the runtime");
    socket.close();
  });
});
