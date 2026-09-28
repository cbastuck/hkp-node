import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { ChunkQueue, boundedRange } from "../src/services/stream";

/**
 * An endpoint's stream: callers on its path stay connected and hear what the
 * endpoint is given, and a source elsewhere — a runtime behind a NAT — feeds it
 * over a WebSocket on the same path.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
const sockets: WebSocket[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  aborts.splice(0).forEach((abort) => abort.abort());
  sockets.splice(0).forEach((socket) => socket.terminate());
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const KEY = "let-me-broadcast";

type Relay = {
  server: ReturnType<typeof createRuntimeServer>;
  mount: string;
  streamUrl: string;
  state: () => Promise<Record<string, any>>;
};

async function relay(stream: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Relay> {
  const server = createRuntimeServer({ externalHost: "127.0.0.1", auth: { mode: "none" } });
  servers.push(server);
  await server.start();

  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "relay",
      name: "Relay",
      secrets: { "radio-ingest": { value: KEY } },
      services: [
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid: "radio",
          state: { bypass: false, stream, ...extra },
        },
      ],
    })
    .expect(200);

  const state = async () =>
    (await request(server.httpServer).get("/runtimes/relay/services/radio").expect(200)).body;
  const { __hkpMount: mount, streamUrl } = await state();
  return { server, mount, streamUrl, state };
}

/** A listener reading the stream into `received` as it arrives. */
async function listen(url: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  aborts.push(abort);
  const response = await fetch(url, { headers, signal: abort.signal });
  const listener = { response, received: Buffer.alloc(0), stop: () => abort.abort() };
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        listener.received = Buffer.concat([listener.received, Buffer.from(value)]);
      }
    } catch {
      // aborted
    }
  })();
  return listener;
}

async function source(streamUrl: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(streamUrl.replace(/^http/, "ws"), { headers });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
  });
  return socket;
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(await check()).toBe(true);
}

const radio = { path: "/live.mp3", contentType: "audio/mpeg", ingestKey: "{{secret.radio-ingest}}" };
const auth = { authorization: `Bearer ${KEY}` };

describe("an endpoint's stream", () => {
  it("is fed by a source and heard by every listener", async () => {
    const { streamUrl, state } = await relay(radio);
    expect(streamUrl).toMatch(/\/hosted\/[0-9a-f]+\/live\.mp3$/);

    const first = await listen(streamUrl);
    const second = await listen(streamUrl);
    expect(first.response.headers.get("content-type")).toBe("audio/mpeg");
    await eventually(async () => (await state()).listeners === 2);

    const feed = await source(streamUrl, auth);
    feed.send(Buffer.from("abc"));
    feed.send(Buffer.from("def"));

    await eventually(() => first.received.toString() === "abcdef");
    await eventually(() => second.received.toString() === "abcdef");
    const current = await state();
    expect(current.source.bytesReceived).toBe(6);
    expect(current.listenerDetails).toHaveLength(2);
  });

  it("carries what a pass produces, too", async () => {
    const { server, streamUrl } = await relay(radio);
    const listener = await listen(streamUrl);
    await request(server.httpServer).post("/runtimes/relay").send(JSON.stringify("from a pass")).set("content-type", "application/json");
    await eventually(() => listener.received.toString() === "from a pass");
  });

  it("refuses a source without the key", async () => {
    const { streamUrl } = await relay(radio);
    await expect(source(streamUrl)).rejects.toThrow("401");
    await expect(source(streamUrl, { authorization: "Bearer wrong" })).rejects.toThrow("401");
  });

  it("refuses every source when no key was declared", async () => {
    // A public endpoint anybody could broadcast on is not a default.
    const { streamUrl } = await relay({ path: "/live.mp3" });
    await expect(source(streamUrl, auth)).rejects.toThrow("403");
  });

  it("accepts the key as a query parameter, for clients that cannot set headers", async () => {
    const { streamUrl, state } = await relay(radio);
    await source(`${streamUrl}?key=${KEY}`);
    await eventually(async () => (await state()).source !== null);
  });

  it("lets a new source replace the old one", async () => {
    // What a source reconnecting after its network dropped looks like here.
    const { streamUrl } = await relay(radio);
    const listener = await listen(streamUrl);
    const old = await source(streamUrl, auth);
    const closed = new Promise((resolve) => old.once("close", resolve));
    const fresh = await source(streamUrl, auth);
    await closed;
    fresh.send(Buffer.from("fresh"));
    await eventually(() => listener.received.toString() === "fresh");
  });

  it("starts a late listener with the burst", async () => {
    const { streamUrl } = await relay({ ...radio, burstBytes: 8 });
    const feed = await source(streamUrl, auth);
    for (const piece of ["0000", "1111", "2222"]) feed.send(Buffer.from(piece));
    const early = await listen(streamUrl);
    await eventually(() => early.received.toString() === "11112222");
  });

  it("answers a range probe and does not count it", async () => {
    const { streamUrl, state } = await relay(radio);
    const feed = await source(streamUrl, auth);
    feed.send(Buffer.from([0xff, 0xfb, 1, 2, 3]));
    await eventually(async () => (await state()).source?.bytesReceived === 5);

    const probe = await fetch(streamUrl, { headers: { range: "bytes=0-1" } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe("bytes 0-1/*");
    expect(Buffer.from(await probe.arrayBuffer())).toEqual(Buffer.from([0xff, 0xfb]));
    expect((await state()).listeners).toBe(0);
  });

  it("lets a listener that hangs up leave", async () => {
    const { streamUrl, state } = await relay(radio);
    const listener = await listen(streamUrl);
    await eventually(async () => (await state()).listeners === 1);
    listener.stop();
    await eventually(async () => (await state()).listeners === 0);
  });

  it("lets everyone go when the endpoint stops", async () => {
    const { server, streamUrl, state } = await relay(radio);
    const listener = await listen(streamUrl);
    const feed = await source(streamUrl, auth);
    const closed = new Promise((resolve) => feed.once("close", resolve));
    await eventually(async () => (await state()).listeners === 1);

    await request(server.httpServer)
      .post("/runtimes/relay/services/radio")
      .send({ bypass: true })
      .expect(200);
    await closed;
    expect((await state()).listeners).toBe(0);
    void listener;
  });

  it("still answers other paths as requests", async () => {
    const { mount } = await relay(radio, {
      onRequest: [
        {
          instanceId: "page",
          serviceId: "map",
          state: {
            mode: "replace",
            template: { meta: { status: 200, contentType: "text/html" }, body: "<p>player</p>" },
          },
        },
      ],
    });
    const page = await fetch(`${mount}/`);
    expect(page.headers.get("content-type")).toBe("text/html");
    expect(await page.text()).toBe("<p>player</p>");
  });
});

describe("the pieces", () => {
  it("drops a slow listener's oldest chunks, never its newest", () => {
    const queue = new ChunkQueue(8);
    queue.push(Buffer.alloc(4, 1));
    queue.push(Buffer.alloc(4, 2));
    expect(queue.push(Buffer.alloc(4, 3))).toBe(1);
    expect(queue.shift()![0]).toBe(2);
    expect(queue.push(Buffer.alloc(32, 4))).toBe(1);
    expect(queue.size).toBe(1);
  });

  it("reads only a bounded byte range as a probe", () => {
    expect(boundedRange("bytes=0-1")).toEqual([0, 1]);
    expect(boundedRange("bytes=0-")).toBeNull();
    expect(boundedRange("bytes=5-1")).toBeNull();
    expect(boundedRange(undefined)).toBeNull();
  });
});
