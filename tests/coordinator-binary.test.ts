import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  BinaryPayload,
  decodeBinaryFrame,
  encodeBinaryFrame,
  fromBinaryPayload,
  toBinaryPayload,
} from "../src/coordinator/binaryFrame";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import { createMemoryBoardStore } from "../src/coordinator/boardStore";
import { BoardSession } from "../src/coordinator/session";
import { CloudBoardConfig } from "../src/coordinator/types";
import {
  CoordinatorHost,
  OWNER,
  RuntimeServer,
  deploy,
  eventually,
  fakeParticipants,
  settle,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * Values that hold bytes, crossing a deployed board.
 *
 * A coordinator's connections carry JSON as text. Bytes sent that way arrive
 * as an object of numbered keys, so they travel as a binary frame instead, and
 * the coordinator passes the payload on without reading it. These are about
 * that: what arrives is what was sent, whichever runtimes it passes between.
 */

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  await Promise.all(servers.splice(0).map((s) => s.stop().catch(() => {})));
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});

const bytes = (...values: number[]) => new Uint8Array(values);

describe("the frame a value holding bytes travels in", () => {
  it("carries the message and the bytes, and gives both back", () => {
    const frame = encodeBinaryFrame(
      { type: "processRuntime", context: { runId: "r1" } },
      new BinaryPayload({ kind: "bytes" }, bytes(0, 255, 7)),
    );

    const decoded = decodeBinaryFrame(frame);

    expect(decoded?.header).toEqual({
      type: "processRuntime",
      context: { runId: "r1" },
    });
    expect(decoded?.payload.shape).toEqual({ kind: "bytes" });
    expect([...decoded!.payload.bytes]).toEqual([0, 255, 7]);
  });

  it("is the same bytes for every implementation that reads it", () => {
    // The fixture hkp-frontend's and hkp-python's tests decode.
    const fixture =
      "000000777b2274797065223a2270726f6365737352756e74696d65222c2272756e74696d654964223a227569222c22726571756573744964223a22722d31222c2262696e617279223a7b226b696e64223a226d69786564222c226a736f6e223a7b226d657461223a7b226e616d65223a22612e62696e227d7d7d7d0001feff";

    const written = encodeBinaryFrame(
      { type: "processRuntime", runtimeId: "ui", requestId: "r-1" },
      new BinaryPayload(
        { kind: "mixed", json: { meta: { name: "a.bin" } } },
        bytes(0, 1, 254, 255),
      ),
    );

    expect(written.toString("hex")).toBe(fixture);
  });

  it("carries an empty payload", () => {
    const decoded = decodeBinaryFrame(
      encodeBinaryFrame(
        { type: "result" },
        new BinaryPayload({ kind: "bytes" }, bytes()),
      ),
    );

    expect(decoded?.payload.bytes.length).toBe(0);
  });

  it.each([
    ["shorter than its length prefix", Buffer.from([0, 0])],
    ["cut off inside its header", Buffer.from([0, 0, 0, 50, 123])],
    ["a header that is not JSON", Buffer.from([0, 0, 0, 1, 120])],
    [
      "a header that says nothing about the payload",
      (() => {
        const head = Buffer.from(JSON.stringify({ type: "result" }));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(head.length);
        return Buffer.concat([length, head]);
      })(),
    ],
  ])("is not read when it is %s", (_what, raw) => {
    expect(decodeBinaryFrame(raw)).toBeNull();
  });
});

describe("what hkp-node sends as bytes", () => {
  it("sends bytes as bytes", () => {
    const payload = toBinaryPayload(bytes(1, 2, 3));

    expect(payload?.shape).toEqual({ kind: "bytes" });
    expect(fromBinaryPayload(payload!)).toEqual(bytes(1, 2, 3));
  });

  it("sends an object holding bytes with the rest of it beside them", () => {
    const value = { meta: { name: "a.bin", status: 200 }, binary: bytes(9) };

    const payload = toBinaryPayload(value);

    expect(payload?.shape).toEqual({
      kind: "mixed",
      json: { meta: { name: "a.bin", status: 200 } },
    });
    expect(fromBinaryPayload(payload!)).toEqual(value);
  });

  it("passes a ring buffer through as one, though it has none of its own", () => {
    // Arrives from a runtime that has the type and may be headed for another
    // that does; turning it into something else here would lose that.
    const arrived = fromBinaryPayload(
      new BinaryPayload(
        { kind: "floatRingBuffer", id: 4, ts: 1234 },
        bytes(0, 0, 128, 63),
      ),
    );

    expect(arrived).toEqual({
      type: "FloatRingBuffer",
      id: 4,
      ts: 1234,
      binary: bytes(0, 0, 128, 63),
    });
    expect(toBinaryPayload(arrived)?.shape).toEqual({
      kind: "floatRingBuffer",
      id: 4,
      ts: 1234,
    });
  });

  it("leaves JSON to travel as text", () => {
    expect(toBinaryPayload({ a: 1 })).toBeNull();
    expect(toBinaryPayload("text")).toBeNull();
    expect(toBinaryPayload([1, 2])).toBeNull();
    expect(toBinaryPayload(null)).toBeNull();
  });

  it("hands a service bytes of its own, not a view of the frame", () => {
    const frame = Buffer.from([1, 2, 3]);
    const value = fromBinaryPayload(
      new BinaryPayload({ kind: "bytes" }, frame),
    ) as Uint8Array;

    frame[0] = 99;

    expect(value[0]).toBe(1);
  });
});

const chain: CloudBoardConfig = {
  boardName: "bytes",
  runtimes: [
    { id: "a", name: "A", type: "rest" },
    { id: "b", name: "B", type: "rest" },
  ],
  services: { a: [], b: [] },
};

const throughBrowser: CloudBoardConfig = {
  boardName: "bytes-via-browser",
  runtimes: [
    { id: "a", name: "A", type: "rest" },
    { id: "ui", name: "Browser", type: "browser" },
    { id: "b", name: "B", type: "rest" },
  ],
  services: { a: [], ui: [], b: [] },
};

/** A browser's end of the bridge, attached to a session over a real socket. */
async function attachBrowser(session: BoardSession, runtimeIds = ["ui"]) {
  const frames: Array<{ data: Buffer; isBinary: boolean }> = [];
  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  const serverSide = new Promise<WebSocket>((resolve) =>
    sockets.on("connection", (ws) => resolve(ws)),
  );
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.on("message", (data, isBinary) =>
    frames.push({ data: data as Buffer, isBinary }),
  );
  await new Promise<void>((resolve) => client.on("open", () => resolve()));
  session.registerBrowserSocket(await serverSide, runtimeIds);
  cleanups.push(async () => {
    client.close();
    sockets.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  return { client, frames };
}

/** What a runtime on `server` is handed as input, in the order it arrives. */
function arrivals(server: RuntimeServer, runtimeId: string): unknown[] {
  const seen: unknown[] = [];
  const runtime = server.runtimeApp.getRuntime(OWNER, runtimeId)!;
  const process = runtime.process.bind(runtime);
  runtime.process = ((input: unknown, ...rest: unknown[]) => {
    seen.push(input);
    return (process as (...args: unknown[]) => unknown)(input, ...rest);
  }) as typeof runtime.process;
  return seen;
}

async function twoServers(config: CloudBoardConfig, coordinator?: BoardCoordinator) {
  const host = await startCoordinator(coordinator);
  hosts.push(host);
  const a = await startRuntimeServer();
  const b = await startRuntimeServer();
  servers.push(a.server, b.server);
  const session = await deploy(host, "user-1", config, {
    a: a.server,
    b: b.server,
  });
  expect(session.getErrors()).toEqual([]);
  return { host, a: a.server, b: b.server, session };
}

describe("a session passing bytes on", () => {
  it("hands the next runtime the payload it was given, untouched", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = new BoardSession("bytes", "user-1", chain, fakes.participants);
    cleanups.push(() => board.destroy());
    await board.start();
    const payload = new BinaryPayload({ kind: "bytes" }, bytes(1, 2, 3));

    a.emit({ type: "result", data: payload });
    await settle();

    // The same object: nothing in between read it, copied it or re-encoded it.
    expect(b.processed).toEqual([payload]);
    expect(b.processed[0]).toBe(payload);
  });
});

describe("bytes across a deployed board", () => {
  it("arrive on the next runtime server as the bytes that were sent", async () => {
    const { a, b } = await twoServers(chain);
    const seen = arrivals(b, "b");
    const sent = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);

    a.runtimeApp.getRuntime(OWNER, "a")!.emitResult(sent);

    await eventually(() => seen.length === 1, "bytes to arrive");
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(seen[0]).toEqual(sent);
  });

  it("keep what travels beside them", async () => {
    const { a, b } = await twoServers(chain);
    const seen = arrivals(b, "b");
    const sent = { meta: { name: "clip.mp3", size: 3 }, binary: bytes(7, 8, 9) };

    a.runtimeApp.getRuntime(OWNER, "a")!.emitResult(sent);

    await eventually(() => seen.length === 1, "the object to arrive");
    expect(seen[0]).toEqual(sent);
  });

  it("still carry JSON as JSON", async () => {
    const { a, b } = await twoServers(chain);
    const seen = arrivals(b, "b");

    a.runtimeApp.getRuntime(OWNER, "a")!.emitResult({ n: 1, list: [1, 2] });

    await eventually(() => seen.length === 1, "the value to arrive");
    expect(seen[0]).toEqual({ n: 1, list: [1, 2] });
  });

  it("reach a browser as a binary frame, and go on from it to the runtime after", async () => {
    const { a, b, session } = await twoServers(throughBrowser);
    const browser = await attachBrowser(session);
    const seen = arrivals(b, "b");

    a.runtimeApp.getRuntime(OWNER, "a")!.emitResult(bytes(5, 6));

    await eventually(
      () => browser.frames.some((f) => f.isBinary),
      "the browser to be handed the bytes",
    );
    const asked = decodeBinaryFrame(browser.frames.find((f) => f.isBinary)!.data)!;
    expect(asked.header).toMatchObject({
      type: "processRuntime",
      runtimeId: "ui",
    });
    expect([...asked.payload.bytes]).toEqual([5, 6]);

    // The browser's runtime answers with bytes of its own.
    browser.client.send(
      encodeBinaryFrame(
        { type: "result", requestId: asked.header.requestId },
        new BinaryPayload({ kind: "bytes" }, bytes(6, 5, 4)),
      ),
    );

    await eventually(() => seen.length === 1, "the answer to reach B");
    expect(seen[0]).toEqual(bytes(6, 5, 4));
  });

  it("are dropped, not fatal, when larger than the operator allows", async () => {
    const coordinator = new BoardCoordinator(
      createMemoryBoardStore(),
      undefined,
      undefined,
      { maxFrameBytes: 64 * 1024 },
    );
    const { host, a, b, session } = await twoServers(chain, coordinator);
    const seen = arrivals(b, "b");
    const runtime = a.runtimeApp.getRuntime(OWNER, "a")!;

    runtime.emitResult(new Uint8Array(256 * 1024));
    runtime.emitResult(bytes(1));

    // The small one arrives, so the large one was passed over and the
    // connection it came on is the one still in use.
    await eventually(() => seen.length === 1, "the small value to arrive");
    expect(seen[0]).toEqual(bytes(1));
    expect(session.getStatus()).toBe("running");
    expect(
      host.coordinator.participants
        .describe("user-1", chain.boardName)
        .every((p) => p.connected),
    ).toBe(true);
  });
});
