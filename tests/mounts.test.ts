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
    const res = await fetch(`${body.url}/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/hello", method: "GET" });
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
