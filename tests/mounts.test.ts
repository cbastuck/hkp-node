import WebSocket from "ws";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { peerServerDescriptor } from "../src/services/peer-server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import type { Authenticator, AuthenticatorOptions } from "../src/auth";

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

const ALICE = "auth0|alice";
const BOB = "auth0|bob";

/** Bearer token is the sub it authenticates as; see auth.test.ts. */
function twoPrincipalAuth(options: AuthenticatorOptions): Authenticator {
  const known = new Set([ALICE, BOB]);
  const verifyToken = async (token: string | undefined | null) => {
    if (!token) {
      return null;
    }
    const opaque = options.resolveOpaqueToken?.(token);
    if (opaque) {
      return opaque;
    }
    return known.has(token) ? { sub: token } : null;
  };
  return {
    middleware: (req, res, next) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        res.sendStatus(401);
        return;
      }
      void verifyToken(header.slice(7)).then((user) => {
        if (!user) {
          res.sendStatus(401);
          return;
        }
        req.authenticatedUser = user;
        next();
      });
    },
    verifyToken,
  };
}

async function startServer(options: Parameters<typeof createRuntimeServer>[0]) {
  const server = createRuntimeServer({ externalHost: "127.0.0.1", ...options });
  servers.push(server);
  const address = await server.start();
  return { server, baseUrl: address.baseUrl };
}

/** Resolves "open" if the socket connected, "rejected" if the upgrade failed. */
function wsOutcome(url: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.on("open", () => {
      socket.close();
      resolve("open");
    });
    socket.on("unexpected-response", () => resolve("rejected"));
    socket.on("error", () => resolve("rejected"));
  });
}

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

describe("hkp-node service mounts", () => {
  it("serves an http-server endpoint without a token", async () => {
    const { server, baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);

    expect(body.url).toMatch(
      new RegExp(`^${baseUrl}/hosted/[0-9a-f]{32}$`),
    );

    // Mounts exist to be called by outside parties, so no Authorization header.
    const res = await fetch(`${body.url}/hello?a=1`);
    expect(res.status).toBe(200);
    // A request reaches the pipeline as MixedData: JSON meta plus the body.
    const received = await res.json();
    expect(received.meta).toEqual({
      method: "GET",
      path: "/hello",
      query: { a: "1" },
    });
    // No body at all, so neither representation is carried.
    expect(received.binary).toBeUndefined();
    expect(received.body).toBeUndefined();
  });

  it("carries a request body and its content type to the pipeline", async () => {
    const { server } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);

    const res = await fetch(`${body.url}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="notes.txt"',
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);

    const received = await res.json();
    expect(received.meta).toMatchObject({
      method: "POST",
      path: "/upload",
      contentType: "application/json",
      filename: "notes.txt",
    });

    // A JSON body is decoded, so a board can reach into it directly rather than
    // decoding bytes by hand.
    expect(received.body).toEqual({ hello: "world" });
    // The raw bytes would only restate the decoded value at twice the size.
    expect(received.binary).toBeUndefined();
  });

  it("decodes bodies by content type, and leaves the rest as bytes", async () => {
    const { server } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      })
      .expect(200);

    const { body: state } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);

    const post = async (contentType: string, payload: string) => {
      const res = await fetch(`${state.url}/x`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: payload,
      });
      return res.json();
    };

    // Charset parameters must not defeat the match.
    const json = await post("application/json; charset=utf-8", '{"a":1}');
    expect(json.body).toEqual({ a: 1 });
    // A decoded body replaces the raw bytes rather than sitting alongside them.
    expect(json.binary).toBeUndefined();

    expect((await post("application/vnd.api+json", '{"a":2}')).body).toEqual({
      a: 2,
    });

    const text = await post("text/plain", "hello");
    expect(text.body).toBe("hello");
    expect(text.binary).toBeUndefined();

    const form = await post("application/x-www-form-urlencoded", "a=1&b=two");
    expect(form.body).toEqual({ a: "1", b: "two" });
    expect(form.binary).toBeUndefined();

    // Not textual: only the raw bytes, no decoded body to be wrong about.
    const binaryPost = await post("application/octet-stream", "abc");
    expect(binaryPost.body).toBeUndefined();
    expect(Object.values(binaryPost.binary)).toEqual([97, 98, 99]);

    // Malformed JSON leaves the bytes to inspect rather than failing the
    // request — a public endpoint takes whatever it is given.
    const broken = await post("application/json", "{not json");
    expect(broken.body).toBeUndefined();
    expect(Object.keys(broken.binary).length).toBeGreaterThan(0);
  });

  it("refuses a body past the configured limit", async () => {
    const { server } = await startServer({
      auth: { mode: "none" },
      quotas: { maxRequestBodyBytes: 64 },
    });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);

    // The endpoint takes no token, so an unbounded read would be available to
    // anyone holding the URL.
    const res = await fetch(`${body.url}/upload`, {
      method: "POST",
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
  });

  it("gives two tenants separate mounts for the same runtime and service id", async () => {
    const { server } = await startServer({
      buildAuthenticator: twoPrincipalAuth,
    });

    const urlFor = async (sub: string) => {
      await request(server.httpServer)
        .post("/runtimes")
        .set("Authorization", `Bearer ${sub}`)
        .send({
          id: "node",
          name: "Node",
          services: [
            {
              serviceId: httpServerSubservicesDescriptor.serviceId,
              uuid: "http-1",
              state: {
                bypass: false,
                mode: "process_on_data",
                pipeline: [],
              },
            },
          ],
        })
        .expect(200);
      const { body } = await request(server.httpServer)
        .get("/runtimes/node/services/http-1")
        .set("Authorization", `Bearer ${sub}`)
        .expect(200);
      return body.url as string;
    };

    const aliceUrl = await urlFor(ALICE);
    const bobUrl = await urlFor(BOB);

    expect(aliceUrl).not.toEqual(bobUrl);
    // Both are live: neither tenant's endpoint displaced the other's, which is
    // exactly what a shared port would have done.
    expect((await fetch(aliceUrl)).status).toBe(200);
    expect((await fetch(bobUrl)).status).toBe(200);
  });

  it("stops serving a mount once its runtime is removed", async () => {
    const { server } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    expect((await fetch(`${body.url}/hello`)).status).toBe(200);

    await request(server.httpServer).delete("/runtimes/rt-1").expect(200);

    // The endpoint must not outlive the runtime that published it.
    expect((await fetch(`${body.url}/hello`)).status).toBe(404);
  });

  it("serves PeerJS signalling over HTTP and WebSocket on a mount", async () => {
    const { server, baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: peerServerDescriptor.serviceId,
            uuid: "peer-1",
            state: { bypass: false },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/peer-1")
      .expect(200);
    expect(body.path).toMatch(/^\/hosted\/[0-9a-f]{32}$/);

    // PeerJS's own id endpoint, proving the Express sub-app is mounted.
    const idRes = await fetch(`${body.url}/peerjs/id`);
    expect(idRes.status).toBe(200);
    expect((await idRes.text()).length).toBeGreaterThan(0);

    // The signalling socket: PeerJS requires id, token and key on the query.
    const wsBase = baseUrl.replace("http", "ws");
    const peerWs = `${wsBase}${body.path}/peerjs?key=peerjs&id=peer-a&token=tok-a`;
    expect(await wsOutcome(peerWs)).toBe("open");
  });

  it("keeps runtime notification sockets working while PeerJS is mounted", async () => {
    // PeerJS attaches its WebSocketServer to whichever server it is handed, and
    // `ws` then answers 400 on every path that server owns but the socket server
    // does not. Handing PeerJS a detached carrier is what avoids that; this is
    // the guard against a refactor that passes it the shared server instead.
    const { server, baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: peerServerDescriptor.serviceId,
            uuid: "peer-1",
            state: { bypass: false },
          },
        ],
      })
      .expect(200);

    const wsBase = baseUrl.replace("http", "ws");
    expect(await wsOutcome(`${wsBase}/rt-1`)).toBe("open");
  });

  it("emits peer events as a runtime result so the chain continues", async () => {
    // A service that produces data without being asked must emit the runtime's
    // result itself. Running only the services behind it updates this runtime —
    // a Monitor here would light up — while the next runtime in the chain never
    // sees anything, which is indistinguishable from "nothing happened".
    const { server, baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: peerServerDescriptor.serviceId,
            uuid: "peer-1",
            state: { bypass: false, emitEvents: true },
          },
          { serviceId: "monitor", uuid: "mon-1" },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/peer-1")
      .expect(200);

    const wsBase = baseUrl.replace("http", "ws");
    const runtimeSocket = new WebSocket(`${wsBase}/rt-1`);
    await new Promise((resolve) => runtimeSocket.once("open", resolve));

    const resultSeen = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no runtime result for the peer event")),
        5000,
      );
      runtimeSocket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "result") {
          clearTimeout(timer);
          resolve(message.data);
        }
      });
    });

    // Joining the signalling server is what makes the peer-server emit.
    const peer = new WebSocket(
      `${wsBase}${body.path}/peerjs?key=peerjs&id=peer-a&token=tok-a`,
    );
    await new Promise((resolve) => peer.once("open", resolve));

    await expect(resultSeen).resolves.toMatchObject({
      event: "peer-connected",
      peerId: "peer-a",
    });

    peer.close();
    runtimeSocket.close();
  });

  it("releases the PeerJS mount when the service is bypassed", async () => {
    const { server, baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: peerServerDescriptor.serviceId,
            uuid: "peer-1",
            state: { bypass: false },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/peer-1")
      .expect(200);
    expect((await fetch(`${body.url}/peerjs/id`)).status).toBe(200);

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/peer-1")
      .send({ bypass: true })
      .expect(200)
      .expect(({ body: state }) => {
        expect(state.url).toBe("");
      });

    expect((await fetch(`${body.url}/peerjs/id`)).status).toBe(404);
    const wsBase = baseUrl.replace("http", "ws");
    expect(
      await wsOutcome(
        `${wsBase}${body.path}/peerjs?key=peerjs&id=peer-a&token=tok-a`,
      ),
    ).toBe("rejected");
  });
});
