import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { monitorDescriptor } from "../src/services/monitor";

/**
 * Handing a running runtime its values, over the wire.
 *
 * The unit tests say what the vault does with them; this says a browser can
 * actually deliver them — the route exists, the verb is one the server's CORS
 * allowlist permits, and what comes back names aliases rather than values.
 *
 * The verb matters more than it looks: the first version of this used PUT,
 * which every route in this server otherwise avoids, and the browser's
 * preflight refused it before the request was ever made.
 */

describe("secrets endpoint", () => {
  const server = createRuntimeServer({ externalHost: "127.0.0.1" });
  const runtimeId = "secrets-rt";

  beforeAll(async () => {
    await server.start();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: runtimeId,
        name: "Node",
        services: [{ serviceId: monitorDescriptor.serviceId, uuid: "mon-1" }],
      })
      .expect(200);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("takes values and answers with the aliases it now holds", async () => {
    const res = await request(server.httpServer)
      .post(`/runtimes/${runtimeId}/secrets`)
      .send({ "gmail.imap": { value: "hunter2" } })
      .expect(200);

    expect(res.body).toEqual({ aliases: ["gmail.imap"] });
  });

  it("merges, so sending one entry does not strip the others", async () => {
    await request(server.httpServer)
      .post(`/runtimes/${runtimeId}/secrets`)
      .send({ slack: { value: "xoxb" } })
      .expect(200);

    const res = await request(server.httpServer)
      .post(`/runtimes/${runtimeId}/secrets`)
      .send({ slack: { value: "changed" } })
      .expect(200);

    expect(res.body.aliases.sort()).toEqual(["gmail.imap", "slack"]);
  });

  it("uses a verb the browser is allowed to send", async () => {
    // What actually broke: the route worked, and the preflight refused it.
    const preflight = await request(server.httpServer)
      .options(`/runtimes/${runtimeId}/secrets`)
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("has no way to read a value back out", async () => {
    await request(server.httpServer).get(`/runtimes/${runtimeId}/secrets`).expect(404);
  });

  it("answers 404 for a runtime that does not exist", async () => {
    await request(server.httpServer)
      .post("/runtimes/nope/secrets")
      .send({ a: { value: "1" } })
      .expect(404);
  });
});
