import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";

/**
 * The Radio Editor unit, run on hkp-node against a feed and a model of the
 * test's own.
 *
 * What is pinned is the contract the radio relies on — an article reaches the
 * published feed only once it has a brief, and the brief is what the feed's
 * description then says — and what a person sees when something goes wrong: a
 * page that cannot be read or fetched is still briefed, from the title and the
 * feed's line, with the page's problem noted; a brief that fails stays on the
 * desk with its reason until somebody retries it or publishes the feed's line.
 *
 * The services are read out of the board rather than repeated here; only the
 * params differ, the way a composition would set them.
 */

const BOARD = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../boards/rss-radio-editor-unit-board.json"),
    "utf8",
  ),
);

type Site = { url: string; close: () => Promise<void> };
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    await closers.pop()?.();
  }
});

async function serve(handler: http.RequestListener): Promise<Site> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  closers.push(close);
  return { url: `http://127.0.0.1:${port}`, close };
}

function item(title: string, link: string, summary: string): string {
  return (
    `<item><title>${title}</title><link>${link}</link><guid>${link}</guid>` +
    `<pubDate>Mon, 19 Oct 2026 08:00:00 GMT</pubDate>` +
    `<description>${summary}</description></item>`
  );
}

/** A feed of three articles: one readable, one a 404, one nobody answers for. */
async function site(): Promise<Site> {
  const site = await serve((req, res) => {
    if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>` +
          item(
            "Readable",
            `${site.url}/articles/readable`,
            "A line about it.",
          ) +
          item(
            "Gone",
            `${site.url}/articles/gone`,
            "A line about the gone one.",
          ) +
          item(
            "Unanswered",
            "http://127.0.0.1:1/nobody",
            "The feed's own line.",
          ) +
          `</channel></rss>`,
      );
      return;
    }
    if (req.url === "/articles/readable") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><head><script>tracking()</script></head>" +
          "<body><article><p>The body of the readable article.</p></article></body></html>",
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body>Not found</body></html>");
  });
  return site;
}

/**
 * An OpenAI-compatible server that briefs by naming the title it was given.
 *
 * `failing` titles are answered with a server error, and `slow` ones only after
 * the given delay — a model that is down, and one that takes its time.
 */
async function model() {
  const prompts: string[] = [];
  const failing = new Set<string>();
  const slow = new Map<string, number>();
  const server = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt: string = body.messages.at(-1).content;
      prompts.push(prompt);
      const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? "?";
      if (failing.has(title)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model unavailable" }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, slow.get(title) ?? 0));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fake",
          choices: [
            { message: { role: "assistant", content: `Brief of ${title}.` } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  return { url: server.url, prompts, failing, slow };
}

async function editor(params: Record<string, string>) {
  const values: Record<string, string> = { ...BOARD.unit.params, ...params };
  const withParams = (services: unknown) =>
    JSON.parse(
      JSON.stringify(services).replace(
        /\{\{param\.(\w+)\}\}/g,
        (_, name) => values[name] ?? "",
      ),
    );

  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  closers.push(() => server.stop());
  await server.start();
  const api = request(server.httpServer);

  const create = (id: string, services: unknown[]) =>
    api
      .post("/runtimes")
      .send({
        id,
        name: id,
        boardName: BOARD.boardName,
        services: withParams(services),
      })
      .expect(200);
  await create("edit", BOARD.services.edit);
  await create("briefs", BOARD.services.briefs);
  await create("fallback", BOARD.services.fallback);
  // The desk's own query, alone in a runtime of the test's: a process answers
  // with the end of its runtime, which in `briefs` is the published feed.
  const rows = BOARD.services.briefs.find(
    (svc: { uuid: string }) => svc.uuid === "rows",
  );
  await create("probe", [{ ...rows, uuid: "probe" }]);

  const process = async (runtime: string, uuid: string, payload: unknown = {}) =>
    (
      await api
        .post(`/runtimes/${runtime}/services/${uuid}/process`)
        .send(payload as object)
        .expect(200)
    ).body;

  const desk = async (): Promise<Row[]> =>
    (await process("probe", "probe"))?.rows ?? [];

  return {
    round: () => process("edit", "edit-feed"),
    desk,
    /** What the facade's Retry sends, for the row it is on. */
    retry: (row: Row) =>
      process("edit", "edit-each.name", {
        id: row.guid,
        link: row.link,
        title: row.title,
        summary: row.blurb,
        feed: row.feed,
        published: row.published,
        retry: 1,
      }),
    /** What the facade's "Use the feed's line" sends. */
    useFeedLine: (row: Row) =>
      process("fallback", "fb-which", { guid: row.guid, useFeedLine: true }),
    /** What the desk's and the published feed's queries last failed with. */
    errors: async () => {
      const found: Record<string, string> = {};
      for (const [runtime, uuid] of [
        ["probe", "probe"],
        ["briefs", "rows"],
        ["briefs", "briefs-doc"],
      ]) {
        const state = (
          await api.get(`/runtimes/${runtime}/services/${uuid}`).expect(200)
        ).body;
        if (state.error) found[`${runtime}/${uuid}`] = state.error;
      }
      return found;
    },
    /**
     * The desk once it shows what the round was for. A round is answered as
     * soon as it has begun: the feed is read and the articles run on from
     * there, after the call that started it.
     */
    settled: async (done: (rows: Record<string, Row>) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const rows = byTitle(await desk());
        if (done(rows)) {
          return rows;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`never settled: ${JSON.stringify(await desk())}`);
    },
    feed: async () => {
      // A pass of the published runtime is what rebuilds the document.
      await process("briefs", "rows");
      const state = (
        await api.get("/runtimes/briefs/services/briefs-serve").expect(200)
      ).body;
      return (await fetch(`${state.__hkpMount}/feed.xml`)).text();
    },
  };
}

type Row = {
  guid: string;
  title: string;
  link: string;
  feed: string;
  blurb: string;
  published: string;
  brief: string;
  status: string;
  settled: number;
};

const byTitle = (rows: Row[]): Record<string, Row> =>
  Object.fromEntries(rows.map((row) => [row.title, row]));

async function local(params: Record<string, string> = {}) {
  const feed = await site();
  const llm = await model();
  const desk = await editor({
    feedUrl: `${feed.url}/feed.xml`,
    backend: "server",
    serverUrl: llm.url,
    model: "fake",
    apiKey: "",
    database: `rss-editor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...params,
  });
  return { llm, desk };
}

describe("the Radio Editor unit", () => {
  it("briefs what it can read, and publishes only what it has briefed", async () => {
    const { llm, desk } = await local();
    llm.slow.set("Unanswered", 200);

    await desk.round();
    const midway = await desk.settled(
      (rows) => !!rows.Readable?.brief && !!rows.Gone?.brief && !!rows.Unanswered,
    );
    // Taken, not yet briefed: not something the radio may read yet.
    if (!midway.Unanswered.brief) {
      expect(midway.Unanswered.status).toMatch(/^Briefing… since /);
      expect(await desk.feed()).not.toContain("Unanswered");
    }
    const rows = await desk.settled((rows) => !!rows.Unanswered?.brief);

    expect(rows.Readable.brief).toBe("Brief of Readable.");
    expect(rows.Readable.status).toMatch(/^Briefed \S/);
    expect(rows.Gone.brief).toBe("Brief of Gone.");

    const readable = llm.prompts.find((prompt) =>
      prompt.startsWith("Title: Readable"),
    );
    expect(readable).toContain("The body of the readable article.");
    expect(readable).not.toContain("tracking()");
    // A 404 is not the article: the model is told so instead of reading it.
    const gone = llm.prompts.find((prompt) => prompt.startsWith("Title: Gone"));
    expect(gone).toContain("The article could not be read.");
    expect(gone).toContain("A line about the gone one.");

    // A page nobody answers for is briefed the same way, and the desk says
    // what happened to the page instead of hiding it.
    const unanswered = llm.prompts.find((prompt) =>
      prompt.startsWith("Title: Unanswered"),
    );
    expect(unanswered).toContain("The article could not be read.");
    expect(rows.Unanswered.status).toContain("from the title and the feed's line");
    expect(rows.Unanswered.status).toContain("the page:");

    const document = await desk.feed();
    expect(document).toContain(
      "<description><![CDATA[Brief of Readable.]]></description>",
    );
    expect(document).toContain(
      "<description><![CDATA[Brief of Unanswered.]]></description>",
    );
  });

  it("shows an empty desk and publishes an empty feed before any article arrives", async () => {
    // Only the claim used to create the table, and the claim runs once an
    // article arrives — so before that, the desk and the published feed
    // failed with "no such table".
    const desk = await editor({ feedUrl: "http://127.0.0.1:9/never" });

    expect(await desk.desk()).toEqual([]);
    await desk.feed();
    expect(await desk.errors()).toEqual({});
  });

  it("keeps a failed brief on the desk with its reason, and briefs it when retried", async () => {
    const { llm, desk } = await local();
    llm.failing.add("Readable");

    await desk.round();
    let rows = await desk.settled((rows) =>
      !!rows.Readable?.status.startsWith("Failed:") && !!rows.Gone?.brief,
    );
    expect(rows.Readable.status).toContain("HTTP 500");
    // A failed brief is the one a person can act on; a briefed one is not.
    expect(rows.Readable.settled).toBe(0);
    expect(rows.Gone.settled).toBe(1);
    expect(await desk.feed()).not.toContain("Readable");

    // Later rounds leave it alone: a failure waits for a person.
    await desk.round();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      llm.prompts.filter((prompt) => prompt.startsWith("Title: Readable")),
    ).toHaveLength(1);

    llm.failing.delete("Readable");
    await desk.retry(rows.Readable);
    rows = await desk.settled((rows) => !!rows.Readable?.brief);

    expect(rows.Readable.brief).toBe("Brief of Readable.");
    expect(rows.Readable.status).toMatch(/^Briefed /);
    expect(await desk.feed()).toContain(
      "<description><![CDATA[Brief of Readable.]]></description>",
    );
    // Retrying a briefed article does nothing: it is not taken again.
    await desk.retry(rows.Readable);
    expect(
      llm.prompts.filter((prompt) => prompt.startsWith("Title: Readable")),
    ).toHaveLength(2);
  });

  it("publishes a failed brief with its feed's line when a person chooses it", async () => {
    const { llm, desk } = await local();
    llm.failing.add("Readable");

    await desk.round();
    const failed = await desk.settled((rows) =>
      !!rows.Readable?.status.startsWith("Failed:"),
    );
    await desk.useFeedLine(failed.Readable);
    const rows = await desk.settled((rows) => !!rows.Readable?.brief);

    expect(rows.Readable.brief).toBe("A line about it.");
    expect(rows.Readable.status).toMatch(/^The feed's own line, chosen /);
    expect(await desk.feed()).toContain(
      "<description><![CDATA[A line about it.]]></description>",
    );
  });

  it("calls a brief that never finished failed, so it can be retried", async () => {
    // Any brief counts as stuck at once with a stuckAfter in the future; the
    // model taking its time stands in for one that died mid-way.
    const { llm, desk } = await local({ stuckAfter: "+1 minute" });
    llm.slow.set("Readable", 1500);

    await desk.round();
    const rows = await desk.settled((rows) =>
      !!rows.Readable?.status.startsWith("Failed: no answer since"),
    );
    expect(rows.Readable.settled).toBe(0);
  });
});
