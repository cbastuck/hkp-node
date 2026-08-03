import WebSocket from "ws";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import {
  createAuthenticator,
  isEmailAllowed,
  isLoopbackHost,
  type AuthConfig,
  type Authenticator,
  type AuthenticatorOptions,
} from "../src/auth";

// A non-resolvable domain keeps these tests offline: every code path we exercise
// either rejects before verifying a token (missing/blank bearer) or resolves an
// opaque session token locally, so the JWKS endpoint is never contacted.
const JWT_AUTH: AuthConfig = {
  mode: "jwt",
  domain: "auth.invalid",
  audience: "test-audience",
};

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

async function startServer(options: Parameters<typeof createRuntimeServer>[0]) {
  const server = createRuntimeServer(options);
  servers.push(server);
  const address = await server.start();
  return { server, baseUrl: address.baseUrl };
}

function wsUrl(baseUrl: string, path: string, token?: string): string {
  const url = new URL(baseUrl.replace("http", "ws") + path);
  if (token) {
    url.searchParams.set("access_token", token);
  }
  return url.toString();
}

/** Resolves "open" if the socket connected, "rejected" if the upgrade failed. */
function wsOutcome(
  url: string,
  headers?: Record<string, string>,
): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
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

describe("hkp-node authentication", () => {
  it("rejects HTTP requests with no bearer token under JWT auth", async () => {
    const { baseUrl } = await startServer({ auth: JWT_AUTH });
    await request(baseUrl).get("/runtimes").expect(401);
  });

  it("accepts a list of audiences, and refuses to run with none", () => {
    // One runtime serves users signed in through more than one Auth0
    // application (the website's SPA and the native apps' own), whose id_tokens
    // carry different client ids in `aud`.
    expect(() =>
      createAuthenticator({ ...JWT_AUTH, audience: ["spa-client", "native-client"] }),
    ).not.toThrow();
    // An empty list would make the verifier skip the audience check entirely and
    // accept tokens minted for any application in the tenant, so it must not
    // start at all.
    expect(() => createAuthenticator({ ...JWT_AUTH, audience: [] })).toThrow(
      /audience/i,
    );
  });

  it("resolves opaque session tokens before falling back to JWT verification", async () => {
    const authenticator = createAuthenticator(JWT_AUTH, {
      resolveOpaqueToken: (token) =>
        token === "sess-1" ? { sub: "auth0|user-1" } : null,
    });
    expect(await authenticator.verifyToken("sess-1")).toEqual({
      sub: "auth0|user-1",
    });
    expect(await authenticator.verifyToken(undefined)).toBeNull();
  });

  it("rejects WebSocket upgrades without a valid token under JWT auth", async () => {
    const { baseUrl } = await startServer({ auth: JWT_AUTH });
    // Auth is checked on the upgrade before the runtime is even looked up, so a
    // missing or unknown token is rejected regardless of the path.
    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1"))).toBe("rejected");
    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1", "nope"))).toBe("rejected");
  });

  it("mints a session token and accepts it on the WS Authorization header", async () => {
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(baseUrl)
      .post("/runtimes")
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1/session-token")
      .expect(200);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    // Coordinator-style: token in the Authorization header, not the URL.
    expect(
      await wsOutcome(wsUrl(baseUrl, "/rt-1"), {
        Authorization: `Bearer ${body.token}`,
      }),
    ).toBe("open");
  });

  it("rejects WebSocket upgrades from a disallowed Origin", async () => {
    const { baseUrl } = await startServer({
      auth: { mode: "none" },
      allowedOrigins: ["https://app.example"],
    });
    await request(baseUrl)
      .post("/runtimes")
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);

    const rejected = await new Promise<"open" | "rejected">((resolve) => {
      const socket = new WebSocket(wsUrl(baseUrl, "/rt-1"), {
        headers: { origin: "https://evil.example" },
      });
      socket.on("open", () => {
        socket.close();
        resolve("open");
      });
      socket.on("unexpected-response", () => resolve("rejected"));
      socket.on("error", () => resolve("rejected"));
    });
    expect(rejected).toBe("rejected");
  });

  it("classifies loopback vs public bind addresses", () => {
    for (const h of ["127.0.0.1", "127.0.0.5", "::1", "[::1]", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.4", "example.com"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("allows everything in no-auth mode (local dev default)", async () => {
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(baseUrl).get("/runtimes").expect(200);
    await request(baseUrl)
      .post("/runtimes")
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);
    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1"))).toBe("open");
  });
});

describe("hkp-node email allowlist", () => {
  const allowed = ["alice@example.com", "bob@example.com"];

  it("passes everyone when no allowlist is configured", () => {
    expect(isEmailAllowed({}, undefined)).toBe(true);
    expect(
      isEmailAllowed({ email: "mallory@evil.example", email_verified: true }, undefined),
    ).toBe(true);
  });

  it("accepts a verified, listed email — case- and whitespace-insensitively", () => {
    expect(
      isEmailAllowed({ email: "alice@example.com", email_verified: true }, allowed),
    ).toBe(true);
    expect(
      isEmailAllowed({ email: " Alice@Example.COM ", email_verified: true }, allowed),
    ).toBe(true);
  });

  it("rejects unlisted emails", () => {
    expect(
      isEmailAllowed({ email: "mallory@evil.example", email_verified: true }, allowed),
    ).toBe(false);
  });

  it("fails closed on a missing or unverified email claim", () => {
    // No email claim at all (e.g. an access token without the email scope).
    expect(isEmailAllowed({}, allowed)).toBe(false);
    // Self-signup with someone else's address: email present but not verified.
    expect(
      isEmailAllowed({ email: "alice@example.com", email_verified: false }, allowed),
    ).toBe(false);
    expect(isEmailAllowed({ email: "alice@example.com" }, allowed)).toBe(false);
    // Non-string junk in the claim.
    expect(isEmailAllowed({ email: 42, email_verified: true }, allowed)).toBe(false);
  });
});

const ALICE = "auth0|alice";
const BOB = "auth0|bob";

/**
 * Stands in for JWKS verification so tenancy can be exercised offline with two
 * distinct principals: a bearer token is simply the sub it authenticates as.
 * Session tokens are still resolved first through the resolver the server owns,
 * so the delegation path stays under test rather than being stubbed out.
 */
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

async function startTenantServer() {
  return startServer({ buildAuthenticator: twoPrincipalAuth });
}

/** Create a runtime named `id` owned by `sub`, carrying one monitor service. */
async function createRuntimeAs(
  baseUrl: string,
  sub: string,
  id: string,
  serviceUuid: string,
) {
  await request(baseUrl)
    .post("/runtimes")
    .set("Authorization", `Bearer ${sub}`)
    .send({
      id,
      name: "Node",
      services: [{ serviceId: "monitor", uuid: serviceUuid }],
    })
    .expect(200);
}

describe("hkp-node multi-tenancy", () => {
  it("gives two users their own runtime for the same runtime id", async () => {
    const { baseUrl } = await startTenantServer();
    // Boards ship stable, human-readable runtime ids, so this collision is the
    // normal case whenever two users load the same board — not an edge case.
    await createRuntimeAs(baseUrl, ALICE, "node", "alice-monitor");
    await createRuntimeAs(baseUrl, BOB, "node", "bob-monitor");

    await request(baseUrl)
      .get("/runtimes/node/services")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((s: { uuid: string }) => s.uuid)).toEqual([
          "alice-monitor",
        ]);
      });

    await request(baseUrl)
      .get("/runtimes/node/services")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((s: { uuid: string }) => s.uuid)).toEqual([
          "bob-monitor",
        ]);
      });
  });

  it("lists only the caller's runtimes", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");
    await createRuntimeAs(baseUrl, BOB, "bob-rt", "m2");

    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.runtimes.map((r: { id: string }) => r.id)).toEqual([
          "alice-rt",
        ]);
        // The registry describes the build, not the tenant.
        expect(body.registry.length).toBeGreaterThan(0);
      });
  });

  it("reports another tenant's runtime as 404 on every per-runtime route", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");
    const asBob = (path: string) =>
      request(baseUrl).get(path).set("Authorization", `Bearer ${BOB}`);

    // 404 rather than 403 — Bob must not be able to probe which runtime ids exist.
    await asBob("/runtimes/alice-rt").expect(404);
    await asBob("/runtimes/alice-rt/services").expect(404);
    await asBob("/runtimes/alice-rt/services/m1").expect(404);
    await asBob("/runtimes/alice-rt/inputs").expect(404);
    await asBob("/runtimes/alice-rt/services/m1/property/bypass").expect(404);

    await request(baseUrl)
      .post("/runtimes/alice-rt")
      .set("Authorization", `Bearer ${BOB}`)
      .send({ hello: "world" })
      .expect(404);
    await request(baseUrl)
      .post("/runtimes/alice-rt/services/m1")
      .set("Authorization", `Bearer ${BOB}`)
      .send({ bypass: true })
      .expect(404);
    await request(baseUrl)
      .post("/runtimes/alice-rt/rearrange")
      .set("Authorization", `Bearer ${BOB}`)
      .send(["m1"])
      .expect(404);
    await request(baseUrl)
      .post("/runtimes/alice-rt/session-token")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(404);
    await request(baseUrl)
      .delete("/runtimes/alice-rt/services/m1")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(404);

    // Alice's runtime and its service survived all of that.
    await request(baseUrl)
      .get("/runtimes/alice-rt/services/m1")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200);
  });

  it("keeps DELETE /runtimes inside the caller's namespace", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");
    await createRuntimeAs(baseUrl, BOB, "bob-rt", "m2");

    await request(baseUrl)
      .delete("/runtimes")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(200);

    await request(baseUrl)
      .get("/runtimes/alice-rt")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200);
    await request(baseUrl)
      .get("/runtimes/bob-rt")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(404);
  });

  it("cannot delete another tenant's runtime by id", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");

    // DELETE is idempotent and always reports success, so the check is that
    // Alice's runtime is still there afterwards.
    await request(baseUrl)
      .delete("/runtimes/alice-rt")
      .set("Authorization", `Bearer ${BOB}`)
      .expect(200);

    await request(baseUrl)
      .get("/runtimes/alice-rt")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200);
  });

  it("rejects a WebSocket upgrade onto another tenant's runtime", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");

    expect(
      await wsOutcome(wsUrl(baseUrl, "/alice-rt"), {
        Authorization: `Bearer ${BOB}`,
      }),
    ).toBe("rejected");
    expect(
      await wsOutcome(wsUrl(baseUrl, "/alice-rt"), {
        Authorization: `Bearer ${ALICE}`,
      }),
    ).toBe("open");
  });

  it("resolves a session token into the namespace of the user who minted it", async () => {
    const { baseUrl } = await startTenantServer();
    await createRuntimeAs(baseUrl, ALICE, "alice-rt", "m1");

    const { body } = await request(baseUrl)
      .post("/runtimes/alice-rt/session-token")
      .set("Authorization", `Bearer ${ALICE}`)
      .expect(200);

    // This is the coordinator's machine path: the token stands in for Alice.
    expect(
      await wsOutcome(wsUrl(baseUrl, "/alice-rt"), {
        Authorization: `Bearer ${body.token}`,
      }),
    ).toBe("open");
    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", `Bearer ${body.token}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.runtimes.map((r: { id: string }) => r.id)).toEqual([
          "alice-rt",
        ]);
      });
  });

  it("collapses to a single namespace when auth is off", async () => {
    // The dev/loopback path must keep behaving exactly as it did before tenancy.
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(baseUrl)
      .post("/runtimes")
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);
    await request(baseUrl)
      .get("/runtimes")
      .expect(200)
      .expect(({ body }) => {
        expect(body.runtimes.map((r: { id: string }) => r.id)).toEqual(["rt-1"]);
      });
    await request(baseUrl).get("/runtimes/rt-1").expect(200);
  });
});

describe("hkp-node per-tenant quotas", () => {
  it("caps runtimes per tenant without affecting another tenant", async () => {
    const { baseUrl } = await startServer({
      buildAuthenticator: twoPrincipalAuth,
      quotas: { maxRuntimesPerUser: 1 },
    });

    await createRuntimeAs(baseUrl, ALICE, "rt-1", "m1");
    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", `Bearer ${ALICE}`)
      .send({ id: "rt-2", name: "Node", services: [] })
      .expect(429);

    // Bob has his own allowance; Alice exhausting hers must not spend it.
    await createRuntimeAs(baseUrl, BOB, "rt-1", "m2");
  });

  it("lets a tenant reconnect to an existing runtime while at the cap", async () => {
    const { baseUrl } = await startServer({
      buildAuthenticator: twoPrincipalAuth,
      quotas: { maxRuntimesPerUser: 1 },
    });
    await createRuntimeAs(baseUrl, ALICE, "rt-1", "m1");

    // Re-POSTing an existing id is how a browser reattaches after a reload; the
    // cap must not turn that into a failure.
    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", `Bearer ${ALICE}`)
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);
  });

  it("caps services per runtime on create and on add", async () => {
    const { baseUrl } = await startServer({
      buildAuthenticator: twoPrincipalAuth,
      quotas: { maxServicesPerRuntime: 2 },
    });

    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", `Bearer ${ALICE}`)
      .send({
        id: "rt-big",
        name: "Node",
        services: [
          { serviceId: "monitor", uuid: "m1" },
          { serviceId: "monitor", uuid: "m2" },
          { serviceId: "monitor", uuid: "m3" },
        ],
      })
      .expect(429);

    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", `Bearer ${ALICE}`)
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          { serviceId: "monitor", uuid: "m1" },
          { serviceId: "monitor", uuid: "m2" },
        ],
      })
      .expect(200);

    await request(baseUrl)
      .post("/runtimes/rt-1/services")
      .set("Authorization", `Bearer ${ALICE}`)
      .send({ serviceId: "monitor", uuid: "m3" })
      .expect(429);
  });

  it("places no limits by default", async () => {
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    for (const id of ["rt-1", "rt-2", "rt-3"]) {
      await request(baseUrl)
        .post("/runtimes")
        .send({
          id,
          name: "Node",
          services: [
            { serviceId: "monitor", uuid: `${id}-a` },
            { serviceId: "monitor", uuid: `${id}-b` },
          ],
        })
        .expect(200);
    }
  });
});

describe("hkp-node secret redaction", () => {
  it("never echoes stored email/telegram secrets back through the API", async () => {
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(baseUrl)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: "smtp-email",
            uuid: "smtp-1",
            state: { host: "mail.example", username: "u", password: "hunter2" },
          },
          {
            serviceId: "telegram-sender",
            uuid: "tg-1",
            state: { botToken: "123:secret", chatId: "42" },
          },
        ],
      })
      .expect(200);

    await request(baseUrl)
      .get("/runtimes/rt-1/services/smtp-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.password).toBe("");
        expect(body.passwordConfigured).toBe(true);
        expect(body.host).toBe("mail.example");
      });

    await request(baseUrl)
      .get("/runtimes/rt-1/services/tg-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.botToken).toBe("");
        expect(body.botTokenConfigured).toBe(true);
        expect(body.chatId).toBe("42");
      });
  });

  it("does not wipe a stored secret when an empty value is configured", async () => {
    const { baseUrl } = await startServer({ auth: { mode: "none" } });
    await request(baseUrl)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: "smtp-email",
            uuid: "smtp-1",
            state: { host: "mail.example", username: "u", password: "hunter2" },
          },
        ],
      })
      .expect(200);

    // Re-configuring with a blank password (what a masked round-trip sends) must
    // leave the stored secret intact.
    await request(baseUrl)
      .post("/runtimes/rt-1/services/smtp-1")
      .send({ password: "", subject: "hi" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.passwordConfigured).toBe(true);
      });
  });
});
