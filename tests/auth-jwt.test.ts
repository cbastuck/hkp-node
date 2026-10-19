import http from "node:http";
import { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, type KeyLike } from "jose";
import jwt from "jsonwebtoken";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticator, type AuthConfig } from "../src/auth";
import { createRuntimeServer } from "../src/server";
import { TICKET_TTL_MS, WsTickets } from "../src/wsTickets";

/**
 * Signed tokens against a key set this test publishes itself.
 *
 * What a token must carry is the same in every runtime (hkp-python's
 * test_auth.py, hkp-rt's auth.test.cpp, the website's auth.php): RS256, the
 * issuer whose keys signed it, an accepted audience, an expiry that is there
 * and not past, and a subject. These are signed here with keys served from a
 * local endpoint, so the verifier fetches and checks them as it does Auth0's.
 */

const KID = "test-key";
let privateKey: KeyLike;
let otherKey: KeyLike;
let jwks: http.Server;
let jwksUri = "";

beforeAll(async () => {
  ({ privateKey } = await generateKeyPair("RS256", { extractable: true }));
  const pair = await generateKeyPair("RS256", { extractable: true });
  otherKey = pair.privateKey;
  // The public half of `privateKey`, as Auth0 publishes it.
  const published = await exportJWK(privateKey);
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = published;
  jwks = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise((resolve) => jwks.close(resolve));
});

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

function config(): Extract<AuthConfig, { mode: "jwt" }> {
  return { mode: "jwt", domain: "tenant.example", audience: ["spa", "native"], jwksUri };
}

const now = () => Math.floor(Date.now() / 1000);

/** A token as Auth0 issues one, with `overrides` laid over it; undefined drops a claim. */
function sign(
  overrides: Record<string, unknown> = {},
  options: { key?: KeyLike; algorithm?: jwt.Algorithm; secret?: string } = {},
): string {
  const claims: Record<string, unknown> = {
    iss: "https://tenant.example/",
    aud: "spa",
    sub: "auth0|alice",
    email: "alice@example.com",
    email_verified: true,
    iat: now() - 60,
    exp: now() + 3600,
    ...overrides,
  };
  for (const name of Object.keys(claims)) {
    if (claims[name] === undefined) {
      delete claims[name];
    }
  }
  if (options.secret) {
    return jwt.sign(claims, options.secret, { algorithm: "HS256", keyid: KID });
  }
  const key = (options.key ?? privateKey) as unknown as jwt.Secret;
  return jwt.sign(claims, key, { algorithm: options.algorithm ?? "RS256", keyid: KID });
}

describe("a signed token", () => {
  it("is accepted with every claim in order, for each accepted audience", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign())).toEqual({
      sub: "auth0|alice",
      email: "alice@example.com",
    });
    expect(await auth.identifyToken(sign({ aud: "native" }))).not.toBeNull();
  });

  it("is refused without an expiry, past it, or before it is valid", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign({ exp: undefined }))).toBeNull();
    expect(await auth.identifyToken(sign({ exp: now() - 3600 }))).toBeNull();
    expect(await auth.identifyToken(sign({ nbf: now() + 3600 }))).toBeNull();
    // Within the minute of clock skew every runtime allows.
    expect(await auth.identifyToken(sign({ exp: now() - 30 }))).not.toBeNull();
  });

  it("is refused from another issuer, or naming none", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign({ iss: "https://elsewhere.example/" }))).toBeNull();
    expect(await auth.identifyToken(sign({ iss: undefined }))).toBeNull();
  });

  it("is refused for another audience, or without a subject", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign({ aud: "someone-else" }))).toBeNull();
    expect(await auth.identifyToken(sign({ sub: undefined }))).toBeNull();
    expect(await auth.identifyToken(sign({ sub: "" }))).toBeNull();
  });

  it("is refused signed with another key or another way", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign({}, { key: otherKey }))).toBeNull();
    expect(
      await auth.identifyToken(sign({}, { secret: "a shared secret long enough for HS256" })),
    ).toBeNull();
    const [head, body] = sign().split(".");
    expect(await auth.identifyToken(`${head}.${body}.`)).toBeNull();
  });

  it("carries an email only when it is verified", async () => {
    const auth = createAuthenticator(config());
    expect(await auth.identifyToken(sign({ email_verified: false }))).toEqual({
      sub: "auth0|alice",
    });
  });

  it("is what an HTTP route is let in by", async () => {
    const server = createRuntimeServer({
      auth: { ...config(), allowedEmails: ["alice@example.com"] },
    });
    servers.push(server);
    const { baseUrl } = await server.start();

    await request(baseUrl).get("/runtimes").set("Authorization", `Bearer ${sign()}`).expect(200);
    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", `Bearer ${sign({ exp: undefined })}`)
      .expect(401);
    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", `Bearer ${sign({ email: "bob@example.com" })}`)
      .expect(401);
  });
});

/** "open" when the socket opened, "rejected" when the upgrade was refused. */
function opens(url: string): Promise<"open" | "rejected"> {
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

describe("a WebSocket ticket", () => {
  async function listening() {
    const server = createRuntimeServer({
      auth: { ...config(), allowedEmails: ["alice@example.com"] },
    });
    servers.push(server);
    const { baseUrl } = await server.start();
    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", `Bearer ${sign()}`)
      .send({ id: "rt", name: "rt", services: [] })
      .expect(200);
    const ticket = async (token: string | null) => {
      const minted = request(baseUrl).post("/ws-tickets");
      return token ? minted.set("Authorization", `Bearer ${token}`) : minted;
    };
    return { ws: baseUrl.replace("http", "ws"), ticket };
  }

  it("opens a runtime's socket once, without the token in the address", async () => {
    const rt = await listening();
    const minted = await rt.ticket(sign());
    expect(minted.status).toBe(200);
    expect(minted.body.expiresInMs).toBe(TICKET_TTL_MS);

    expect(await opens(`${rt.ws}/rt?ticket=${minted.body.ticket}`)).toBe("open");
    // Used: it opens nothing again.
    expect(await opens(`${rt.ws}/rt?ticket=${minted.body.ticket}`)).toBe("rejected");
    expect(await opens(`${rt.ws}/rt?ticket=made-up`)).toBe("rejected");
  });

  it("is given only for a token that is let in, and opens only what it would", async () => {
    const rt = await listening();
    expect((await rt.ticket(null)).status).toBe(401);
    expect((await rt.ticket(sign({ exp: undefined }))).status).toBe(401);

    // Somebody the allowlist does not let own is told who they are — a
    // coordinator's bridge may still take them — but opens no runtime.
    const bob = await rt.ticket(sign({ email: "bob@example.com" }));
    expect(bob.status).toBe(200);
    expect(await opens(`${rt.ws}/rt?ticket=${bob.body.ticket}`)).toBe("rejected");
  });

  it("still lets a client that sends the token in the address in", async () => {
    const rt = await listening();
    expect(await opens(`${rt.ws}/rt?access_token=${sign()}`)).toBe("open");
  });

  it("is worth nothing once its time is up", () => {
    let clock = 1_000;
    const tickets = new WsTickets(() => clock);
    const holder = { identity: { sub: "a" }, owner: { sub: "a" } };
    const fresh = tickets.mint(holder);
    const stale = tickets.mint(holder);
    expect(tickets.redeem(fresh)).toEqual(holder);
    clock += TICKET_TTL_MS + 1;
    expect(tickets.redeem(stale)).toBeNull();
    expect(fresh).not.toBe(stale);
  });
});
