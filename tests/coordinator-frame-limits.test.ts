import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import { createMemoryBoardStore } from "../src/coordinator/boardStore";
import {
  DEFAULT_MAX_FRAME_BYTES,
  frameLimitFrom,
  socketCeiling,
} from "../src/coordinator/frameLimits";
import { CloudBoardConfig } from "../src/coordinator/types";
import {
  CoordinatorHost,
  FAST_LINKS,
  OWNER,
  RuntimeServer,
  deploy,
  eventually,
  openBridge,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * How large one message on a coordinator's connections may be
 * (coordinator/frameLimits.ts).
 *
 * A value over the frame limit is dropped and the connection kept — that is
 * pinned in coordinator-binary.test.ts. These are about what lies past it: the
 * WebSocket library's own ceiling, which every coordinator connection now has,
 * so that nothing is buffered without bound before a handler can look at it.
 */

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];
const fakes: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop().catch(() => {})));
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  for (const fake of fakes.splice(0)) {
    for (const client of fake.clients) {
      client.terminate();
    }
    await new Promise((resolve) => fake.close(resolve));
  }
});

const SMALL_LIMIT = 64 * 1024;
/** Past the socket ceiling that comes with SMALL_LIMIT. */
const PAST_CEILING = socketCeiling(SMALL_LIMIT) + 1024;

const board: CloudBoardConfig = {
  boardName: "limits",
  runtimes: [{ id: "a", name: "A", type: "rest" }],
  services: { a: [] },
};

describe("the limits", () => {
  it("is never off: unset and 0 are the default", () => {
    expect(frameLimitFrom(undefined)).toBe(DEFAULT_MAX_FRAME_BYTES);
    expect(frameLimitFrom(0)).toBe(DEFAULT_MAX_FRAME_BYTES);
    expect(frameLimitFrom(1024)).toBe(1024);
    expect(new BoardCoordinator().maxFrameBytes).toBe(DEFAULT_MAX_FRAME_BYTES);
  });

  it("puts the socket ceiling above the frame limit", () => {
    expect(socketCeiling(1024)).toBeGreaterThan(1024);
    expect(socketCeiling()).toBeGreaterThan(DEFAULT_MAX_FRAME_BYTES);
    expect(socketCeiling(0)).toBe(socketCeiling(DEFAULT_MAX_FRAME_BYTES));
  });
});

describe("a coordinator's connections", () => {
  it("close an admitted bridge that sends past the ceiling", async () => {
    const host = await startCoordinator(
      new BoardCoordinator(createMemoryBoardStore(), undefined, undefined, {
        maxFrameBytes: SMALL_LIMIT,
      }),
    );
    hosts.push(host);
    const a = await startRuntimeServer();
    servers.push(a.server);
    await deploy(host, OWNER, board, { a: a.server });

    const browser = await openBridge(host, null, OWNER, board.boardName);
    await eventually(() => !!browser.last("snapshot"), "the bridge to be admitted");

    // Over the frame limit, under the ceiling: dropped, and the bridge stays.
    browser.socket.send(Buffer.alloc(SMALL_LIMIT * 2));
    // Past the ceiling: the library refuses it, as "message too big".
    browser.socket.send(Buffer.alloc(PAST_CEILING));
    expect(await browser.closed).toBe(1009);
  });

  it("include this server's own link, which refuses a frame past the ceiling", async () => {
    // A coordinator that sends something no coordinator should.
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    fakes.push(fake);
    await new Promise((resolve) => fake.once("listening", resolve));
    const { port } = fake.address() as { port: number };
    const closedWith = new Promise<number>((resolve) =>
      fake.once("connection", (socket) => {
        socket.on("close", (code) => resolve(code));
        socket.send(Buffer.alloc(PAST_CEILING));
      }),
    );

    const a = await startRuntimeServer({
      coordinatorLinkOptions: { ...FAST_LINKS, maxFrameBytes: SMALL_LIMIT, introduceTimeoutMs: 2_000 },
    });
    servers.push(a.server);
    const introduced = a.server.coordinatorLinks
      .introduce({
        owner: OWNER,
        boardName: board.boardName,
        runtimeId: "a",
        coordinatorUrl: `http://127.0.0.1:${port}/coordinator`,
        ticket: "ticket",
      })
      .catch(() => "refused");

    expect(await closedWith).toBe(1009);
    expect(await introduced).toBe("refused");
  });
});
