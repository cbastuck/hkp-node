import http from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Article, RssService } from "../src/services/rss";
import { parseFeed } from "../src/services/rss-parse";
import { RuntimeHost } from "../src/types";
import { SecretVault } from "../src/secrets";

const RSS_2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Channel &amp; Co</title>
    <item>
      <title><![CDATA[Newest thing]]></title>
      <link>https://example.com/new</link>
      <guid isPermaLink="false">tag:new</guid>
      <description>&lt;p&gt;A &lt;b&gt;bold&lt;/b&gt; claim&lt;/p&gt;</description>
      <pubDate>Wed, 02 Apr 2025 10:00:00 GMT</pubDate>
      <dc:creator>Ada</dc:creator>
    </item>
    <item>
      <title>Older thing</title>
      <link>https://example.com/old</link>
      <description>Plain words</description>
      <pubDate>Mon, 31 Mar 2025 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atomic</title>
  <link rel="self" href="https://atom.example/feed"/>
  <entry>
    <title>Middle thing</title>
    <id>urn:uuid:1234</id>
    <link rel="self" href="https://atom.example/feed/1"/>
    <link rel="alternate" href="https://atom.example/middle"/>
    <updated>2025-04-05T00:00:00Z</updated>
    <published>2025-04-01T12:00:00Z</published>
    <summary type="html">&lt;em&gt;Summary&lt;/em&gt; text</summary>
    <author><name>Grace</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Old School</title></channel>
  <item rdf:about="https://rdf.example/a">
    <title>RDF thing</title>
    <dc:date>2025-03-20T08:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

describe("parseFeed", () => {
  it("reads RSS 2.0 items, decoding entities and unwrapping CDATA", () => {
    const feed = parseFeed(RSS_2);
    expect(feed.title).toBe("Channel & Co");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      id: "tag:new",
      title: "Newest thing",
      link: "https://example.com/new",
      author: "Ada",
      published: "2025-04-02T10:00:00.000Z",
      publishedLabel: "2025-04-02 10:00",
    });
  });

  it("strips markup from a description whether it was escaped or not", () => {
    expect(parseFeed(RSS_2).items[0].summary).toBe("A bold claim");
    const cdata = RSS_2.replace(
      "&lt;p&gt;A &lt;b&gt;bold&lt;/b&gt; claim&lt;/p&gt;",
      "<![CDATA[<p>A <b>bold</b> claim</p>]]>",
    );
    expect(parseFeed(cdata).items[0].summary).toBe("A bold claim");
  });

  it("reads an Atom entry's alternate link rather than its self link", () => {
    const feed = parseFeed(ATOM);
    expect(feed.items[0]).toMatchObject({
      id: "urn:uuid:1234",
      link: "https://atom.example/middle",
      author: "Grace",
      summary: "Summary text",
    });
  });

  it("prefers the publication date over the update date", () => {
    // An entry re-dated by a typo fix would otherwise jump to the top of a
    // reader's list.
    expect(parseFeed(ATOM).items[0].published).toBe("2025-04-01T12:00:00.000Z");
  });

  it("reads an RDF item, taking its link from rdf:about", () => {
    const feed = parseFeed(RDF);
    expect(feed.items[0]).toMatchObject({
      title: "RDF thing",
      link: "https://rdf.example/a",
      published: "2025-03-20T08:00:00.000Z",
    });
  });

  it("gives an undated item a sort key of 0, so it sorts last", () => {
    const undated = parseFeed(
      `<rss><channel><item><title>No date</title></item></channel></rss>`,
    );
    expect(undated.items[0].publishedMs).toBe(0);
    expect(undated.items[0].published).toBe("");
    expect(undated.items[0].publishedLabel).toBe("");
  });

  it("reads a document that is not a feed as no items, not as an error", () => {
    expect(parseFeed("<html><body>Not a feed</body></html>").items).toEqual([]);
  });
});

// ── The service ─────────────────────────────────────────────────────────────

type Endpoint = { url: string; close: () => Promise<void> };

const endpoints: Endpoint[] = [];

afterEach(async () => {
  while (endpoints.length) {
    await endpoints.pop()?.close();
  }
});

/** A server answering each path with the feed (or failure) it was told to. */
async function feedServer(
  reply: (path: string) => { status?: number; body?: string },
): Promise<Endpoint> {
  const server = http.createServer((req, res) => {
    const answer = reply(req.url ?? "");
    res.writeHead(answer.status ?? 200, {
      "content-type": "application/rss+xml",
    });
    res.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint: Endpoint = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  endpoints.push(endpoint);
  return endpoint;
}

/** Captures what the service pushes onward and what it says while doing it. */
function hostSpy() {
  const pushed: unknown[] = [];
  const emitted: unknown[] = [];
  const host: RuntimeHost = {
    processFrom: async (_uuid, data) => {
      pushed.push(data);
      return data;
    },
    notify: () => {},
    currentContext: () => null,
    secrets: () => new SecretVault(),
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({
      logging: false,
      logData: false,
      logLevel: "info" as const,
    }),
    scope: () => ({ owner: "tester", boardName: "Board" }),
    emitResult: (output) => {
      emitted.push(output);
    },
  };
  return { host, pushed, emitted };
}

async function nextPush(pushed: unknown[]): Promise<Article[]> {
  const deadline = Date.now() + 2000;
  while (pushed.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("service pushed no result");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pushed[0] as Article[];
}

function service(state: Record<string, unknown>) {
  const spy = hostSpy();
  const notified: Record<string, unknown>[] = [];
  const svc = new RssService({ serviceId: "rss", uuid: "rss-svc", state });
  svc.setHost(spy.host);
  const notify = (payload: unknown) =>
    notified.push(payload as Record<string, unknown>);
  return { svc, notify, notified, ...spy };
}

describe("RssService", () => {
  it("merges several feeds into one list, newest first", async () => {
    const server = await feedServer((path) =>
      path === "/atom" ? { body: ATOM } : { body: RSS_2 },
    );
    const { svc, notify, pushed } = service({
      feeds: [`${server.url}/rss`, { url: `${server.url}/atom`, name: "Atom" }],
    });

    expect(svc.process(undefined, notify)).toBeNull();
    const items = await nextPush(pushed);

    expect(items.map((item) => item.title)).toEqual([
      "Newest thing",
      "Middle thing",
      "Older thing",
    ]);
    // A named feed keeps its name; an unnamed one takes the feed's own title.
    expect(items.map((item) => item.feed)).toEqual([
      "Channel & Co",
      "Atom",
      "Channel & Co",
    ]);
  });

  it("keeps one failing feed from emptying the list", async () => {
    const server = await feedServer((path) =>
      path === "/bad" ? { status: 500, body: "nope" } : { body: RSS_2 },
    );
    const { svc, notify, notified, pushed } = service({
      feeds: [`${server.url}/rss`, `${server.url}/bad`],
    });

    svc.process(undefined, notify);
    const items = await nextPush(pushed);

    expect(items).toHaveLength(2);
    const last = notified[notified.length - 1];
    expect(last.errors).toEqual([
      { url: `${server.url}/bad`, error: "HTTP 500" },
    ]);
    expect(last.error).toBe("1 of 2 failed");
  });

  it("caps the list at the configured limit", async () => {
    const server = await feedServer(() => ({ body: RSS_2 }));
    const { svc, notify, pushed } = service({
      feeds: [`${server.url}/rss`],
      limit: 1,
    });

    svc.process(undefined, notify);
    expect(await nextPush(pushed)).toHaveLength(1);
  });

  it("adds and removes feeds as commands, without repeating one", () => {
    const { svc } = service({ feeds: ["https://a.example/feed"] });

    svc.configure({ addFeed: "https://b.example/feed" });
    svc.configure({ addFeed: "https://b.example/feed" });
    expect(svc.getState().feeds).toEqual([
      { url: "https://a.example/feed", name: "" },
      { url: "https://b.example/feed", name: "" },
    ]);

    const state = svc.configure({ removeFeed: "https://a.example/feed" });
    expect(state.feeds).toEqual([{ url: "https://b.example/feed", name: "" }]);
  });

  it("keeps the articles out of the state a board is saved with", async () => {
    const server = await feedServer(() => ({ body: RSS_2 }));
    const { svc, notify, pushed } = service({ feeds: [`${server.url}/rss`] });

    svc.process(undefined, notify);
    await nextPush(pushed);

    expect(Object.keys(svc.getState()).sort()).toEqual([
      "feeds",
      "fetching",
      "limit",
      "summaryChars",
      "timeoutMs",
    ]);
  });

  it("fetches on a refresh command, which is all a remote panel can send", async () => {
    const server = await feedServer(() => ({ body: RSS_2 }));
    const { svc, notified, pushed } = service({ feeds: [`${server.url}/rss`] });

    svc.configure({ refresh: true });
    expect(await nextPush(pushed)).toHaveLength(2);
    expect(notified).toEqual([]);
  });

  it("says so and stops when no feed is configured", () => {
    const { svc, notify, notified } = service({});
    expect(svc.process(undefined, notify)).toBeNull();
    expect(notified[0]).toEqual({
      fetching: false,
      error: "No feeds configured",
    });
  });
});
