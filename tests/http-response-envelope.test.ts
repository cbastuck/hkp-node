import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";

/**
 * What an endpoint may answer with, beside JSON.
 *
 * A request and a response are the same envelope read in two directions, so the
 * two ends worth pinning are that a handler can say what it is answering with,
 * and that a handler which passed its input through still answers as it did
 * before there was a way to say anything.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

/** An endpoint whose whole pipeline is a Map returning `template`. */
async function mountAnswering(template: Record<string, unknown>): Promise<string> {
  const server = createRuntimeServer({ externalHost: "127.0.0.1", auth: { mode: "none" } });
  servers.push(server);
  await server.start();

  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt-1",
      name: "Node",
      services: [
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid: "http-1",
          state: {
            bypass: false,
            mode: "process_on_session",
            pipeline: [
              {
                instanceId: "answer",
                serviceId: "map",
                serviceName: "Answer",
                state: { mode: "replace", template },
              },
            ],
          },
        },
      ],
    })
    .expect(200);

  const { body } = await request(server.httpServer)
    .get("/runtimes/rt-1/services/http-1")
    .expect(200);
  return body.__hkpMount as string;
}

describe("what a handler answers with", () => {
  it("is the content type it declared", async () => {
    const feed = '<?xml version="1.0"?><rss version="2.0"></rss>';
    const mount = await mountAnswering({
      meta: { status: 200, contentType: "application/rss+xml" },
      body: feed,
    });

    const res = await fetch(`${mount}/feed.xml`);

    expect(res.headers.get("content-type")).toBe("application/rss+xml");
    expect(await res.text()).toBe(feed);
  });

  it("carries the status it declared", async () => {
    const mount = await mountAnswering({
      meta: { status: 404 },
      body: { error: "no such episode" },
    });

    const res = await fetch(`${mount}/missing.mp3`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such episode" });
  });

  it("is JSON when nothing said otherwise", async () => {
    // Including an envelope with no status: that is a request passed through,
    // and answering it with the caller's own content type would change what
    // every board with an echo in it already did.
    const mount = await mountAnswering({
      meta: { contentType: "audio/mpeg" },
      body: "not audio",
    });

    const res = await fetch(`${mount}/hello`);

    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      meta: { contentType: "audio/mpeg" },
      body: "not audio",
    });
  });
});
