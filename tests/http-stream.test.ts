import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { stopperDescriptor } from "../src/services/stopper";
import { websocketReaderDescriptor } from "../src/services/websocket-reader";
import { ChunkQueue, boundedRange } from "../src/services/stream";

/**
 * An endpoint's stream: callers on its path stay connected and hear what every
 * pass through the endpoint produces. Here the passes come from a
 * `websocket-reader` in front of it, the way a relay is fed by a runtime behind
 * a NAT — the endpoint itself only fans out.
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
  ingestUrl: string;
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
          serviceId: websocketReaderDescriptor.serviceId,
          uuid: "ingest",
          state: { bypass: false, key: "{{secret.radio-ingest}}", exclusive: true },
        },
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid: "radio",
          state: { bypass: false, stream, ...extra },
        },
        { serviceId: stopperDescriptor.serviceId, uuid: "end" },
      ],
    })
    .expect(200);

  const state = async () =>
    (await request(server.httpServer).get("/runtimes/relay/services/radio").expect(200)).body;
  const { __hkpMount: mount, streamUrl } = await state();
  const { __hkpMount: ingestUrl } = (
    await request(server.httpServer).get("/runtimes/relay/services/ingest").expect(200)
  ).body;
  return { server, mount, streamUrl, ingestUrl, state };
}

/** A listener reading the stream into `received` as it arrives. */
async function listen(url: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  aborts.push(abort);
  const response = await fetch(url, { headers, signal: abort.signal });
  const listener = { response, received: Buffer.alloc(0), ended: false, stop: () => abort.abort() };
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          listener.ended = true;
          return;
        }
        listener.received = Buffer.concat([listener.received, Buffer.from(value)]);
      }
    } catch {
      // Aborted here, or cut by the server.
      listener.ended = true;
    }
  })();
  return listener;
}

/** A client of the relay's `websocket-reader`, feeding the stream. */
async function source(url: string, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) {
  const socket = new WebSocket(url.replace(/^http/, "ws"), { headers });
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

const radio = { path: "/live.mp3", contentType: "audio/mpeg" };

describe("an endpoint's stream", () => {
  it("gives every listener what each pass produces", async () => {
    const { streamUrl, ingestUrl, state } = await relay(radio);
    expect(streamUrl).toMatch(/\/hosted\/[0-9a-f]+\/live\.mp3$/);

    const first = await listen(streamUrl);
    const second = await listen(streamUrl);
    expect(first.response.headers.get("content-type")).toBe("audio/mpeg");
    await eventually(async () => (await state()).listeners === 2);

    const feed = await source(ingestUrl);
    feed.send(Buffer.from("abc"));
    feed.send(Buffer.from("def"));

    await eventually(() => first.received.toString() === "abcdef");
    await eventually(() => second.received.toString() === "abcdef");
    expect((await state()).listenerDetails).toHaveLength(2);
  });

  it("carries a pass that started anywhere", async () => {
    const { server, streamUrl } = await relay(radio);
    const listener = await listen(streamUrl);
    await request(server.httpServer).post("/runtimes/relay").send(JSON.stringify("from a pass")).set("content-type", "application/json");
    await eventually(() => listener.received.toString() === "from a pass");
  });

  it("takes no WebSocket itself", async () => {
    // Feeding it is a service's job: a websocket-reader in front of it.
    const { streamUrl } = await relay(radio);
    await expect(source(streamUrl)).rejects.toThrow("404");
  });

  it("starts a late listener with the burst", async () => {
    const { streamUrl, ingestUrl } = await relay({ ...radio, burstBytes: 8 });
    const feed = await source(ingestUrl);
    for (const piece of ["0000", "1111", "2222"]) feed.send(Buffer.from(piece));
    // The pieces arrive over a socket; wait until all three have been passed.
    await new Promise((r) => setTimeout(r, 100));
    const early = await listen(streamUrl);
    await eventually(() => early.received.toString() === "11112222");
  });

  it("answers a range probe and does not count it", async () => {
    const { streamUrl, ingestUrl, state } = await relay(radio);
    const feed = await source(ingestUrl);
    feed.send(Buffer.from([0xff, 0xfb, 1, 2, 3]));
    await new Promise((r) => setTimeout(r, 100));

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
    await eventually(async () => (await state()).listeners === 1);

    await request(server.httpServer)
      .post("/runtimes/relay/services/radio")
      .send({ bypass: true })
      .expect(200);
    await eventually(() => listener.ended);
    expect((await state()).listeners).toBe(0);
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
