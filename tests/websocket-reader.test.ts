import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRuntimeServer } from "../src/server";
import { websocketReaderDescriptor } from "../src/services/websocket-reader";
import { decodeYasMessage } from "../src/yas";

/**
 * websocket-reader: clients connect to its mount, and every message they send
 * becomes a pass through the pipeline and on to the next runtime.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const KEY = "only-for-us";
const auth = { authorization: `Bearer ${KEY}` };

async function reader(state: Record<string, unknown> = {}) {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  await server.start();
  const created = await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt",
      name: "Runtime",
      secrets: { ingest: { value: KEY } },
      services: [
        {
          serviceId: websocketReaderDescriptor.serviceId,
          uuid: "in",
          state: { bypass: false, key: "{{secret.ingest}}", ...state },
        },
      ],
    })
    .expect(200);
  const readState = async () =>
    (await request(server.httpServer).get("/runtimes/rt/services/in").expect(200))
      .body;
  const { __hkpMount: url } = await readState();
  return {
    server,
    url: url as string,
    outputUrl: created.body.runtimes[0].outputUrl as string,
    state: readState,
  };
}

async function connect(
  url: string,
  headers: Record<string, string> = auth,
): Promise<WebSocket> {
  const socket = new WebSocket(url.replace(/^http/, "ws"), { headers });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) =>
      reject(new Error(String(res.statusCode))),
    );
  });
  return socket;
}

/** The runtime's results, as a board attached to it receives them. */
async function results(outputUrl: string): Promise<unknown[]> {
  const socket = await connect(outputUrl, {});
  socket.send(JSON.stringify({ type: "readwrite", id: "rt" }));
  const received: unknown[] = [];
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      received.push(decodeYasMessage(raw as Buffer)?.data);
      return;
    }
    const message = JSON.parse(raw.toString());
    if (message.type === "result") {
      received.push(message.data);
    }
  });
  return received;
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(await check()).toBe(true);
}

describe("websocket-reader", () => {
  it("hands every message on, in order and in its own form", async () => {
    const { url, outputUrl } = await reader();
    const received = await results(outputUrl);
    const client = await connect(url);

    client.send(Buffer.from([1, 2, 3]));
    client.send(JSON.stringify({ n: 1 }));
    client.send("plain text");
    for (let i = 0; i < 20; i++) {
      client.send(Buffer.from([i]));
    }

    await eventually(() => received.length === 23);
    expect(received.slice(0, 3)).toEqual([
      Buffer.from([1, 2, 3]),
      { n: 1 },
      "plain text",
    ]);
    expect(received.slice(3)).toEqual(
      Array.from({ length: 20 }, (_, i) => Buffer.from([i])),
    );
  });

  it("lets in only a client holding the key", async () => {
    const { url } = await reader();
    await expect(connect(url, {})).rejects.toThrow("401");
    await expect(
      connect(url, { authorization: "Bearer wrong" }),
    ).rejects.toThrow("401");
    await connect(url);
  });

  it("does not take the key in the query string", async () => {
    // Where proxies and access logs would keep it.
    const { url } = await reader();
    await expect(connect(`${url}?key=${KEY}`, {})).rejects.toThrow("401");
  });

  it("lets go of its clients when the key changes", async () => {
    const { server, url, state } = await reader();
    const client = await connect(url);
    const closed = new Promise((resolve) => client.once("close", resolve));

    await request(server.httpServer)
      .post("/runtimes/rt/services/in")
      .send({ key: "something-else" })
      .expect(200);
    await closed;
    expect((await state()).connections).toEqual([]);
  });

  it("keeps its clients when the same key is configured again", async () => {
    // A board re-sending its state is not a new key.
    const { server, url, state } = await reader();
    await connect(url);
    await request(server.httpServer)
      .post("/runtimes/rt/services/in")
      .send({ key: "{{secret.ingest}}" })
      .expect(200);
    expect((await state()).connections).toHaveLength(1);
  });

  it("takes no more from a client once the secret has a new value", async () => {
    const { server, url, outputUrl, state } = await reader();
    const received = await results(outputUrl);
    const client = await connect(url);
    client.send("before");
    await eventually(() => received.includes("before"));

    await request(server.httpServer)
      .post("/runtimes/rt/secrets")
      .send({ ingest: { value: "rotated" } })
      .expect(200);
    const closed = new Promise<number>((resolve) =>
      client.once("close", (code) => resolve(code)),
    );
    client.send("after");
    expect(await closed).toBe(1008);
    expect(received).not.toContain("after");
    expect((await state()).connections).toEqual([]);
    // And the new value is what lets a client in now.
    await expect(connect(url)).rejects.toThrow("401");
    await connect(url, { authorization: "Bearer rotated" });
  });

  it("lets nobody in without a key", async () => {
    // The address is public: an unset key must not mean open.
    const { url } = await reader({ key: "" });
    await expect(connect(url)).rejects.toThrow("403");
  });

  it("keeps one client when exclusive, the newest", async () => {
    const { url, outputUrl, state } = await reader({ exclusive: true });
    const received = await results(outputUrl);
    const old = await connect(url);
    const closed = new Promise((resolve) => old.once("close", resolve));
    const fresh = await connect(url);
    await closed;

    fresh.send("fresh");
    await eventually(() => received.includes("fresh"));
    expect((await state()).connections).toHaveLength(1);
  });

  it("keeps every client otherwise", async () => {
    const { url, outputUrl, state } = await reader();
    const received = await results(outputUrl);
    const a = await connect(url);
    const b = await connect(url);
    a.send("a");
    b.send("b");
    await eventually(() => received.length === 2);
    expect(new Set(received)).toEqual(new Set(["a", "b"]));
    const connections = (await state()).connections;
    expect(connections).toHaveLength(2);
    expect(connections[0].messages).toBe(1);
  });

  it("lets its clients go and its address with them when bypassed", async () => {
    const { server, url, state } = await reader();
    const client = await connect(url);
    const closed = new Promise((resolve) => client.once("close", resolve));

    await request(server.httpServer)
      .post("/runtimes/rt/services/in")
      .send({ bypass: true })
      .expect(200);
    await closed;
    const current = await state();
    expect(current.__hkpMount).toBe("");
    expect(current.connections).toEqual([]);
  });

  it("reports the key as the reference it was given", async () => {
    const { state } = await reader();
    expect((await state()).key).toBe("{{secret.ingest}}");
  });

  it("tells a plain request that it takes a WebSocket", async () => {
    const { url } = await reader();
    const response = await fetch(url);
    expect(response.status).toBe(426);
  });
});
