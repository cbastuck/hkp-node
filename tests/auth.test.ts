import WebSocket from "ws";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { isLoopbackHost, type AuthConfig } from "../src/auth";

// A non-resolvable domain keeps these tests offline: every code path we exercise
// either rejects before verifying a token (missing/blank bearer) or short-circuits
// on the service token, so the JWKS endpoint is never contacted.
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

describe("hkp-node authentication", () => {
  it("rejects HTTP requests with no bearer token under JWT auth", async () => {
    const { baseUrl } = await startServer({ auth: JWT_AUTH });
    await request(baseUrl).get("/runtimes").expect(401);
  });

  it("accepts the service token as a bearer on HTTP routes", async () => {
    const { baseUrl } = await startServer({
      auth: JWT_AUTH,
      serviceToken: "s3cr3t",
    });
    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", "Bearer s3cr3t")
      .expect(200);
    await request(baseUrl)
      .get("/runtimes")
      .set("Authorization", "Bearer wrong")
      .expect(401);
  });

  it("rejects WebSocket upgrades without a valid token under JWT auth", async () => {
    const { baseUrl } = await startServer({
      auth: JWT_AUTH,
      serviceToken: "s3cr3t",
    });
    // Create a runtime (using the service token) so the path itself is valid.
    await request(baseUrl)
      .post("/runtimes")
      .set("Authorization", "Bearer s3cr3t")
      .send({ id: "rt-1", name: "Node", services: [] })
      .expect(200);

    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1"))).toBe("rejected");
    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1", "nope"))).toBe("rejected");
    expect(await wsOutcome(wsUrl(baseUrl, "/rt-1", "s3cr3t"))).toBe("open");
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
