import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { sqlDescriptor } from "../src/services/sql";
import { mapDescriptor } from "../src/services/map";

/**
 * A table published as a feed, with no service that knows what a feed is.
 *
 * The document is built by the statement that reads the rows, and the endpoint
 * in front of it serves the last one it was handed — `process_on_data`, which
 * is what "recompute when it changes, answer from what was computed" looks like
 * when nobody is caching anything on purpose.
 *
 * Worth a test of its own because three things have to line up that are easy to
 * get wrong separately: an item whose fields concatenate to a document, an
 * envelope that makes the answer XML rather than JSON, and a reader that is not
 * this board being able to parse what comes out.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const SCHEMA = `CREATE TABLE IF NOT EXISTS episode (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL DEFAULT '',
  rendered TEXT,
  bytes INTEGER
);`;

/** Every field a document interpolates is escaped, wherever it came from. */
const escaped = (column: string) =>
  `replace(replace(replace(${column}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

const FEED = `
SELECT '<?xml version="1.0" encoding="UTF-8"?>'
    || '<rss version="2.0"><channel>'
    || '<title><![CDATA[' || replace($channelTitle, ']]>', ']]&gt;') || ']]></title>'
    || '<link>' || ${escaped("$channelLink")} || '</link>'
    || '<description><![CDATA[' || replace($channelDescription, ']]>', ']]&gt;') || ']]></description>'
    || IFNULL(group_concat(item, '' ORDER BY sortKey DESC), '')
    || '</channel></rss>' AS feed
  FROM (
    SELECT '<item>'
        || '<title><![CDATA[' || replace(IFNULL(title, ''), ']]>', ']]&gt;') || ']]></title>'
        || '<link>' || ${escaped("IFNULL(link, '')")} || '</link>'
        || '<guid isPermaLink="false">' || ${escaped("slug")} || '</guid>'
        || '<pubDate>' || IFNULL(published, '') || '</pubDate>'
        || '<description><![CDATA[' || replace(IFNULL(summary, ''), ']]>', ']]&gt;') || ']]></description>'
        || '<enclosure url="' || ${escaped("$base || '/' || slug || '.mp3'")}
        || '" type="audio/mpeg" length="' || IFNULL(bytes, 0) || '"/>'
        || '</item>' AS item,
           rendered AS sortKey
      FROM episode
     WHERE rendered IS NOT NULL
  )`;

async function startBoard() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  await server.start();

  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt-1",
      name: "Node",
      boardName: "Feed",
      services: [
        {
          serviceId: sqlDescriptor.serviceId,
          uuid: "keep",
          serviceName: "Keep an episode",
          state: {
            mode: "run",
            emit: "input",
            database: "feed-test",
            schema: SCHEMA,
            statement: `INSERT OR REPLACE INTO episode (slug, title, summary, link, published, rendered, bytes)
                        VALUES ($slug, $title, $summary, $link, $published, datetime('now'), $bytes)`,
          },
        },
        {
          serviceId: sqlDescriptor.serviceId,
          uuid: "feed",
          serviceName: "The feed",
          state: { mode: "query", database: "feed-test", schema: SCHEMA, statement: FEED },
        },
        {
          serviceId: mapDescriptor.serviceId,
          uuid: "wrap",
          serviceName: "As a document",
          state: {
            mode: "replace",
            template: {
              "meta.status": 200,
              "meta.contentType": "application/rss+xml; charset=utf-8",
              "body=": "params.rows[0].feed",
            },
          },
        },
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid: "serve",
          serviceName: "Serve the feed",
          state: { bypass: false, mode: "process_on_data", mountName: "feed", pipeline: [] },
        },
      ],
    })
    .expect(200);

  const { body } = await request(server.httpServer)
    .get("/runtimes/rt-1/services/serve")
    .expect(200);
  return { server, mount: body.__hkpMount as string };
}

/** Puts one episode in, which recomputes the document and hands it to the endpoint. */
async function publish(
  server: ReturnType<typeof createRuntimeServer>,
  episode: Record<string, unknown>,
) {
  await request(server.httpServer)
    .post("/runtimes/rt-1/services/keep/process")
    .send({
      base: "http://listen.test/hosted/abc",
      channelTitle: "Reading Radio",
      channelLink: "http://listen.test/hosted/abc",
      channelDescription: "Everything the radio has read aloud",
      ...episode,
    })
    .expect(200);
}

describe("a table published as a feed", () => {
  it("serves the document as XML, not as JSON describing it", async () => {
    const { server, mount } = await startBoard();
    await publish(server, {
      slug: "one",
      title: "Jemalloc 5.4.0",
      summary: "A release.",
      link: "https://example.test/jemalloc",
      published: "2026-09-18T04:20:24.000Z",
      bytes: 209280,
    });

    const res = await fetch(`${mount}/feed.xml`);

    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const document = await res.text();
    expect(document).toContain("<title><![CDATA[Jemalloc 5.4.0]]></title>");
    expect(document).toContain(
      '<enclosure url="http://listen.test/hosted/abc/one.mp3" type="audio/mpeg" length="209280"/>',
    );
  });

  it("escapes what an item carries, wherever it came from", async () => {
    // A query string is the ordinary case, not a hostile one: almost every feed
    // link has an ampersand in it, and an unescaped one is not XML.
    const { server, mount } = await startBoard();
    await publish(server, {
      slug: "two",
      title: "Tom & Jerry <b>",
      summary: "a & b",
      link: "https://example.test/?a=1&b=2",
      published: "2026-09-18T11:00:00.000Z",
      bytes: 100,
    });

    const document = await (await fetch(`${mount}/feed.xml`)).text();

    expect(document).toContain("<link>https://example.test/?a=1&amp;b=2</link>");
    expect(document).toContain("<![CDATA[Tom & Jerry <b>]]>");
  });

  it("keeps an item whose byte count is missing", async () => {
    // Concatenation propagates NULL, so one absent field would otherwise take
    // the whole item out of the document — silently, which is the bad part.
    const { server, mount } = await startBoard();
    await publish(server, {
      slug: "three",
      title: "No size yet",
      summary: "",
      link: "https://example.test/three",
      published: "",
      bytes: null,
    });

    const document = await (await fetch(`${mount}/feed.xml`)).text();

    expect(document).toContain("<![CDATA[No size yet]]>");
    expect(document).toContain('length="0"');
  });

  it("is a feed the RSS service can read back", async () => {
    // The test that matters for a composition: what one unit publishes, another
    // unit's reader has to be able to parse.
    const { server, mount } = await startBoard();
    await publish(server, {
      slug: "four",
      title: "Something to read",
      summary: "A brief.",
      link: "https://example.test/four",
      published: "2026-09-18T04:20:24.000Z",
      bytes: 4242,
    });

    const document = await (await fetch(`${mount}/feed.xml`)).text();
    const { parseFeed } = await import("../src/services/rss-parse");
    const parsed = parseFeed(document);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      title: "Something to read",
      link: "https://example.test/four",
      summary: "A brief.",
    });
  });

  it("answers before anything has been published", async () => {
    // An empty library is a feed with no items, not an error and not a 404.
    const { server, mount } = await startBoard();
    await publish(server, { slug: "", title: "", summary: "", link: "", published: "", bytes: 0 });

    const res = await fetch(`${mount}/feed.xml`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<channel>");
  });
});
