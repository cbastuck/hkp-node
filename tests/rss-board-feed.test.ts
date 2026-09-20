import { readFileSync } from "node:fs";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";

// Read rather than imported: the boards live in the frontend checkout, outside
// this package's sources, and a board is data here rather than a module.
const board = JSON.parse(
  readFileSync(
    join(__dirname, "../../hkp-frontend/boards/rss-demo-board.json"),
    "utf8",
  ),
);

/**
 * The reader board, loaded as it ships and asked for its feed.
 *
 * Not a unit test of anything: it is the board file itself going through a real
 * runtime. Every part of the arrangement is covered on its own elsewhere — the
 * endpoint's entry points, the slot two Holds share, the statement that saves
 * an article — and none of that says the board people actually open still
 * works. This does, and it is the test that would have caught the endpoint
 * being migrated wrongly.
 *
 * `unit.params` are substituted here because a board host does it: a board
 * opened on its own gets its own defaults, and a runtime is handed the result.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

describe("the reader board as it ships", () => {
  it("publishes its reading list as a feed", async () => {
    const server = createRuntimeServer({
      externalHost: "127.0.0.1",
      auth: { mode: "none" },
    });
    servers.push(server);
    await server.start();

    // Unit params are substituted by the board host; the runtime is given the
    // services as they stand, so the database name is spelled out here.
    let text = JSON.stringify(board.services.node);
    const params: Record<string, string> = {
      ...board.unit.params,
      database: "rss-reader-e2e",
    };
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{{param.${name}}}`, value);
    }
    const services = JSON.parse(text);

    await request(server.httpServer)
      .post("/runtimes")
      .send({ id: "node", name: "Node", boardName: "RSS", services })
      .expect(200);

    // Save an article, which is the pass that rebuilds the feed and hands it to
    // the endpoint.
    // Addressed through the scope holding it: the board's two flows are scopes
    // now, so a service inside one is named by the path through it. This is
    // also what the facade's buttons send.
    await request(server.httpServer)
      .post("/runtimes/node/services/list.record-article/process")
      .send({
        intent: "keep",
        title: "Jemalloc 5.4.0",
        link: "https://example.test/jemalloc",
        summary: "A release.",
        feed: "Hacker News",
        author: "",
        published: "2026-09-18T04:20:24.000Z",
      })
      .expect(200);



    const { body } = await request(server.httpServer)
      .get("/runtimes/node/services/list.feed-serve")
      .expect(200);

    const res = await fetch(`${body.__hkpMount}/feed.xml`);
    const document = await res.text();

    expect(res.headers.get("content-type")).toContain("rss+xml");
    expect(document).toContain("<title><![CDATA[Jemalloc 5.4.0]]></title>");
  });
});
