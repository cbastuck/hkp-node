import http from "node:http";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import type { AuthConfig } from "../src/auth";

/**
 * A page in somebody's browser against a runtime server listening on their
 * machine.
 *
 * Every request here is sent over a real socket to a real server, with the
 * headers a browser would put on it — a page cannot choose its `Origin`, its
 * `Sec-Fetch-Site` or its `Host`, which is what makes them worth checking. The
 * rule itself is pinned row by row in origins.test.ts; this is that it is
 * applied, to every way in.
 */

// A non-resolvable domain keeps this offline: a request without a token is
// rejected before any key is fetched.
const JWT_AUTH: AuthConfig = {
  mode: "jwt",
  domain: "auth.invalid",
  audience: "test-audience",
};

const EVIL = "https://evil.example";
// A runtime a page would create to get at the machine.
const RUNTIME = JSON.stringify({ id: "planted", name: "planted", services: [] });

type Server = ReturnType<typeof createRuntimeServer>;
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()!.stop();
  }
});

type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function listening(options: Parameters<typeof createRuntimeServer>[0]) {
  const server = createRuntimeServer(options);
  servers.push(server);
  const { baseUrl } = await server.start();
  const { port } = new URL(baseUrl);

  /** Headers are sent as given; a `Host` among them replaces the real one. */
  function send(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, method, path, headers },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: text,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  function upgrade(headers: Record<string, string> = {}, path = "/planted") {
    return new Promise<"open" | "rejected">((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      socket.on("open", () => {
        socket.close();
        resolve("open");
      });
      socket.on("unexpected-response", () => resolve("rejected"));
      socket.on("error", () => resolve("rejected"));
    });
  }

  async function runtimeCount(): Promise<number> {
    const listed = await send("GET", "/runtimes");
    expect(listed.status).toBe(200);
    return JSON.parse(listed.body).runtimes.length;
  }

  const json = { "Content-Type": "application/json" };
  return { send, upgrade, runtimeCount, json, port };
}

describe("a page against a server without auth", () => {
  it("a caller that is not a browser drives the server as before", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    const listed = await rt.send("GET", "/runtimes");
    expect(listed.status).toBe(200);
    expect(listed.headers["access-control-allow-origin"]).toBeUndefined();

    expect((await rt.send("POST", "/runtimes", rt.json, RUNTIME)).status).toBe(200);
    expect(await rt.runtimeCount()).toBe(1);
    expect(await rt.upgrade()).toBe("open");
  });

  it("a foreign page cannot create a runtime with a request that needs no preflight", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    // text/plain is one of the types a browser sends cross-origin without
    // asking first.
    const refused = await rt.send(
      "POST",
      "/runtimes",
      { Origin: EVIL, "Content-Type": "text/plain" },
      RUNTIME,
    );

    expect(refused.status).toBe(403);
    // Nothing that lets the page read the answer, so it cannot tell this from
    // a server that is not running.
    expect(refused.body).toBe("");
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    expect(await rt.runtimeCount()).toBe(0);
  });

  it("a foreign page is refused whatever it asks for", async () => {
    const rt = await listening({ auth: { mode: "none" } });
    expect((await rt.send("POST", "/runtimes", rt.json, RUNTIME)).status).toBe(200);

    const evil = { Origin: EVIL, ...rt.json };
    const attempts: [string, string, string?][] = [
      ["GET", "/runtimes"],
      ["POST", "/runtimes", JSON.stringify({ id: "second", name: "second", services: [] })],
      ["POST", "/runtimes/planted/services", JSON.stringify({ serviceId: "http-client", instanceId: "out" })],
      ["POST", "/runtimes/planted", JSON.stringify({ url: "http://169.254.169.254/" })],
      ["POST", "/runtimes/planted/session-token"],
      ["DELETE", "/runtimes/planted"],
    ];
    for (const [method, path, body] of attempts) {
      const refused = await rt.send(method, path, evil, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    }

    expect(await rt.runtimeCount()).toBe(1);
  });

  it("a foreign page's preflight is answered with nothing that lets it proceed", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    const preflight = await rt.send("OPTIONS", "/runtimes", {
      Origin: EVIL,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    });

    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a cross-site request sent without an origin is refused", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    // What an <img> or <script> on another site's page produces.
    expect(
      (await rt.send("GET", "/runtimes", { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    // The address typed into the address bar.
    expect(
      (await rt.send("GET", "/runtimes", { "Sec-Fetch-Site": "none" })).status,
    ).toBe(200);
  });

  it("a page that resolved its own name to this machine is refused", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    // DNS rebinding: same-origin to the browser, so no Origin on a GET and the
    // page's own on a POST.
    expect(
      (await rt.send("GET", "/runtimes", { Host: "attacker.example:8080" })).status,
    ).toBe(403);
    expect(
      (
        await rt.send(
          "POST",
          "/runtimes",
          {
            Host: "attacker.example:8080",
            Origin: "http://attacker.example:8080",
            ...rt.json,
          },
          RUNTIME,
        )
      ).status,
    ).toBe(403);
    expect(
      (await rt.send("GET", "/runtimes", { Host: `localhost:${rt.port}` })).status,
    ).toBe(200);
    expect(await rt.runtimeCount()).toBe(0);
  });

  it("a server answers to the name it was given", async () => {
    const rt = await listening({
      auth: { mode: "none" },
      externalHost: "node.example.com",
    });

    expect(
      (await rt.send("GET", "/runtimes", { Host: "node.example.com" })).status,
    ).toBe(200);
    expect(
      (await rt.send("GET", "/runtimes", { Host: "attacker.example" })).status,
    ).toBe(403);
  });

  it("the apps and pages served from this machine are answered, and told so", async () => {
    const rt = await listening({ auth: { mode: "none" } });

    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:8555",
      "saucer://embedded",
      "hkp://app",
      "https://appassets.androidplatform.net",
    ]) {
      const listed = await rt.send("GET", "/runtimes", { Origin: origin });
      expect(listed.status, origin).toBe(200);
      expect(listed.headers["access-control-allow-origin"]).toBe(origin);
      expect(listed.headers.vary).toContain("Origin");
    }

    const preflight = await rt.send("OPTIONS", "/runtimes", {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    });
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("the website is a site like any other until the server is told otherwise", async () => {
    const website = { Origin: "https://readymadeit.com" };

    const closed = await listening({ auth: { mode: "none" } });
    expect((await closed.send("GET", "/runtimes", website)).status).toBe(403);

    const opened = await listening({
      auth: { mode: "none" },
      allowedOrigins: ["https://readymadeit.com"],
    });
    const listed = await opened.send("GET", "/runtimes", website);
    expect(listed.status).toBe(200);
    expect(listed.headers["access-control-allow-origin"]).toBe(
      "https://readymadeit.com",
    );
  });

  it("a star does not open a server without auth to every page", async () => {
    const rt = await listening({ auth: { mode: "none" }, allowedOrigins: "*" });

    const refused = await rt.send(
      "POST",
      "/runtimes",
      { Origin: EVIL, ...rt.json },
      RUNTIME,
    );
    expect(refused.status).toBe(403);
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      (await rt.send("GET", "/runtimes", { Origin: "http://localhost:5173" })).status,
    ).toBe(200);
    expect(await rt.runtimeCount()).toBe(0);
  });

  it("a list replaces who may call unasked", async () => {
    const rt = await listening({
      auth: { mode: "none" },
      allowedOrigins: ["https://app.example"],
    });

    expect(
      (await rt.send("GET", "/runtimes", { Origin: "https://app.example" })).status,
    ).toBe(200);
    expect(
      (await rt.send("GET", "/runtimes", { Origin: "http://localhost:5173" })).status,
    ).toBe(403);
    expect((await rt.send("GET", "/runtimes")).status).toBe(200);
  });

  it("a foreign page cannot open a runtime's socket", async () => {
    const rt = await listening({ auth: { mode: "none" } });
    expect((await rt.send("POST", "/runtimes", rt.json, RUNTIME)).status).toBe(200);

    expect(await rt.upgrade({ Origin: EVIL })).toBe("rejected");
    expect(
      await rt.upgrade({
        Origin: "http://attacker.example:8080",
        Host: "attacker.example:8080",
      }),
    ).toBe("rejected");
    expect(await rt.upgrade({ Origin: "http://localhost:5173" })).toBe("open");
    expect(await rt.upgrade()).toBe("open");
  });

  it("a mount is reached by anyone, as it is meant to be", async () => {
    const rt = await listening({ auth: { mode: "none" } });
    const created = await rt.send(
      "POST",
      "/runtimes",
      rt.json,
      JSON.stringify({
        id: "hook",
        name: "hook",
        services: [
          {
            uuid: "endpoint",
            serviceId: "http-server-subservices",
            serviceName: "Endpoint",
            state: { bypass: false, mode: "process_on_session", pipeline: [] },
          },
        ],
      }),
    );
    expect(created.status).toBe(200);
    const state = await rt.send("GET", "/runtimes/hook/services/endpoint");
    const mount = String(JSON.parse(state.body).__hkpMount);
    expect(mount).toContain("/hosted/");

    // An outside caller holds no token and is on no list; the address is what
    // lets it in. Whatever the pipeline answers, it is not this server's refusal.
    const reached = await rt.send("POST", new URL(mount).pathname, {
      Origin: EVIL,
      ...rt.json,
    }, "{}");
    expect(reached.status).not.toBe(403);
  });
});

describe("a page against a server with auth", () => {
  it("is asked for a token, wherever it is from", async () => {
    const rt = await listening({ auth: JWT_AUTH });

    expect((await rt.send("GET", "/runtimes")).status).toBe(401);
    expect(
      (await rt.send("GET", "/runtimes", { Origin: "http://localhost:5173" })).status,
    ).toBe(401);

    // A page this server does not allow cannot read even that.
    const foreign = await rt.send("GET", "/runtimes", { Origin: EVIL });
    expect(foreign.status).toBe(401);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    expect(await rt.upgrade({ Origin: EVIL })).toBe("rejected");
  });

  it("with a star, any page may read that it needs one", async () => {
    const rt = await listening({ auth: JWT_AUTH, allowedOrigins: "*" });

    const asked = await rt.send("GET", "/runtimes", { Origin: EVIL });
    expect(asked.status).toBe(401);
    // What lets a page that does hold a token learn it was not accepted.
    expect(asked.headers["access-control-allow-origin"]).toBe(EVIL);
  });
});
