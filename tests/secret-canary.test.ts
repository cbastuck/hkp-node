import http from "node:http";
import { AddressInfo } from "node:net";

import request from "supertest";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import { BoardStore, createMemoryBoardStore } from "../src/coordinator/boardStore";
import { LogStore } from "../src/coordinator/logStore";
import { CloudBoardConfig } from "../src/coordinator/types";
import { createRuntimeServer } from "../src/server";
import { LogEntry } from "../src/types";
import {
  CoordinatorHost,
  OWNER,
  RuntimeServer,
  eventually,
  openBridge,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A secret's value, used and then looked for everywhere it must not be.
 *
 * A board names a secret; the value reaches the runtime separately and is
 * used where the service needs it — here, a header an HTTP Client sends. It
 * must come back out nowhere else: not in what a runtime reports or saves, not
 * in what it notifies or logs, not in an error, and not in what a coordinator
 * keeps or tells a browser. Each case uses the secret, makes the use fail so
 * the error paths run too, and then reads every surface for the value.
 */

const CANARY = "canary-6f1d0e2a-secret-value";

const servers: Array<{ stop: () => Promise<unknown> }> = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) {
    await closers.pop()!();
  }
  await Promise.all(servers.splice(0).map((s) => s.stop().catch(() => {})));
});

/** A server the HTTP Client calls, which fails and remembers what it was sent. */
async function failingUpstream() {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    received.push(JSON.stringify(req.headers));
    res.statusCode = 500;
    res.end("upstream failed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, received };
}

/** Everything written to the console while `run` ran, as one string. */
function capturingConsole(): () => string {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    });
  }
  return () => lines.join("\n");
}

const services = (url: string) => [
  {
    serviceId: "http-client",
    uuid: "call",
    serviceName: "Call",
    state: {
      url,
      method: "POST",
      headers: { Authorization: "Bearer {{secret.api}}" },
    },
  },
  { serviceId: "monitor", uuid: "watch", serviceName: "Watch", state: { logToBoard: true } },
];

describe("a secret's value", () => {
  it("leaves a runtime server only where its service uses it", async () => {
    const upstream = await failingUpstream();
    const consoleText = capturingConsole();
    const server = createRuntimeServer({ auth: { mode: "none" }, externalHost: "127.0.0.1" });
    servers.push(server);
    const { baseUrl } = await server.start();

    await request(baseUrl)
      .post("/runtimes")
      .send({
        id: "rt",
        name: "Node",
        services: services(upstream.url),
        secrets: { api: { value: CANARY } },
      })
      .expect(200);

    const frames: string[] = [];
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/rt`);
    socket.on("message", (data: Buffer) => frames.push(data.toString("latin1")));
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));
    socket.send(JSON.stringify({ type: "readwrite", id: "rt" }));
    closers.push(async () => socket.close());

    const ran = await request(baseUrl).post("/runtimes/rt").send({ go: true });
    await eventually(() => upstream.received.length > 0, "the upstream to be called");

    // Used: it went where the board sent it.
    expect(upstream.received.join()).toContain(CANARY);

    const surfaces: Record<string, string> = {
      "the run's answer": ran.text,
      "the runtimes": (await request(baseUrl).get("/runtimes")).text,
      "the runtime": (await request(baseUrl).get("/runtimes/rt")).text,
      "its services": (await request(baseUrl).get("/runtimes/rt/services")).text,
      "the service using it": (await request(baseUrl).get("/runtimes/rt/services/call")).text,
      "the socket": frames.join("\n"),
      "the console": consoleText(),
    };
    for (const [where, text] of Object.entries(surfaces)) {
      expect(text, where).not.toContain(CANARY);
    }
  });

  it("leaves a deployed board only where its service uses it", async () => {
    const upstream = await failingUpstream();
    const consoleText = capturingConsole();

    const logged: LogEntry[] = [];
    const logStore: LogStore = {
      append: (_user, _board, entry) => void logged.push(entry),
      read: async () => logged,
      remove: async () => {},
      close: async () => {},
    };
    const saved: string[] = [];
    const memory = createMemoryBoardStore();
    const boardStore: BoardStore = {
      ...memory,
      save: (board) => {
        saved.push(JSON.stringify(board));
        return memory.save(board);
      },
    };
    const host: CoordinatorHost = await startCoordinator(
      new BoardCoordinator(boardStore, logStore),
    );
    servers.push(host);
    const runtime: { server: RuntimeServer } = await startRuntimeServer();
    servers.push(runtime.server);

    const board: CloudBoardConfig = {
      boardName: "canary",
      runtimes: [{ id: "node", name: "Node", type: "rest" }],
      services: { node: services(upstream.url) },
    } as CloudBoardConfig;
    const tickets = await host.coordinator.issueTickets(OWNER, board.boardName, ["node"]);
    // As the person's client hands them over when deploying: beside the link,
    // never in the board.
    await runtime.server.coordinatorLinks.introduce(
      {
        owner: OWNER,
        boardName: board.boardName,
        runtimeId: "node",
        coordinatorUrl: host.url,
        ticket: tickets.node,
      },
      { api: { value: CANARY } },
    );
    await host.coordinator.registerBoard(OWNER, board);

    const owner = await openBridge(host, null, OWNER, board.boardName);
    await eventually(() => !!owner.last("snapshot"), "the owner's snapshot");
    await owner.ask({
      type: "processService",
      requestId: "go",
      runtimeId: "node",
      serviceUuid: "call",
      payload: { go: true },
    });
    await eventually(() => upstream.received.length > 0, "the upstream to be called");
    expect(upstream.received.join()).toContain(CANARY);

    const surfaces: Record<string, string> = {
      "what the owner's browser was told": JSON.stringify(owner.received),
      "the board's log": JSON.stringify(logged),
      "what the coordinator saved": saved.join("\n"),
      "the board it holds": JSON.stringify(host.coordinator.getBoard(OWNER, board.boardName)?.config ?? null),
      "the console": consoleText(),
    };
    for (const [where, text] of Object.entries(surfaces)) {
      expect(text, where).not.toContain(CANARY);
    }
  });
});
