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
 * What is pinned is the contract the radio relies on: an article reaches the
 * published feed only once it has a brief, the brief is what the feed's
 * description then says, and a page that cannot be read is still briefed —
 * from the title and the feed's line — while a page that gets no answer at all
 * is tried again and, after the last try, published with the feed's own line.
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

/** An OpenAI-compatible server that briefs by naming the title it was given. */
async function model() {
  const prompts: string[] = [];
  const server = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt: string = body.messages.at(-1).content;
      prompts.push(prompt);
      const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? "?";
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
  return { url: server.url, prompts };
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
  // The desk's own query, alone in a runtime of the test's: a process answers
  // with the end of its runtime, which in `briefs` is the published feed.
  const rows = BOARD.services.briefs.find(
    (svc: { uuid: string }) => svc.uuid === "rows",
  );
  await create("probe", [{ ...rows, uuid: "probe" }]);

  const process = async (runtime: string, uuid: string) =>
    (
      await api
        .post(`/runtimes/${runtime}/services/${uuid}/process`)
        .send({})
        .expect(200)
    ).body;

  const desk = async (): Promise<Row[]> =>
    (await process("probe", "probe"))?.rows ?? [];

  return {
    round: () => process("edit", "feed"),
    desk,
    /**
     * The desk once it shows what the round was for. A round is answered as
     * soon as it has begun: the feed is read and the articles run on from
     * there, after the call that started it.
     */
    settled: async (done: (rows: Record<string, Row>) => boolean) => {
      for (let i = 0; i < 100; i++) {
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
        await api.get("/runtimes/briefs/services/pub-serve").expect(200)
      ).body;
      return (await fetch(`${state.__hkpMount}/feed.xml`)).text();
    },
  };
}

type Row = { title: string; brief: string; status: string };

const byTitle = (rows: Row[]): Record<string, Row> =>
  Object.fromEntries(rows.map((row) => [row.title, row]));

describe("the Radio Editor unit", () => {
  it("briefs what it can read, and publishes only what it has briefed", async () => {
    const feed = await site();
    const llm = await model();
    const desk = await editor({
      feedUrl: `${feed.url}/feed.xml`,
      backend: "server",
      serverUrl: llm.url,
      model: "fake",
      apiKey: "",
      database: `rss-editor-test-${Date.now()}-a`,
    });

    await desk.round();
    const rows = await desk.settled(
      (rows) => !!rows.Readable?.brief && !!rows.Gone?.brief,
    );

    expect(rows.Readable.brief).toBe("Brief of Readable.");
    expect(rows.Gone.brief).toBe("Brief of Gone.");
    expect(rows.Unanswered.brief).toBe("");

    const readable = llm.prompts.find((prompt) =>
      prompt.startsWith("Title: Readable"),
    );
    expect(readable).toContain("The body of the readable article.");
    expect(readable).not.toContain("tracking()");
    // A 404 is not the article: the model is told so instead of reading it.
    const gone = llm.prompts.find((prompt) => prompt.startsWith("Title: Gone"));
    expect(gone).toContain("The article could not be read.");
    expect(gone).toContain("A line about the gone one.");

    const document = await desk.feed();
    expect(document).toContain(
      "<description><![CDATA[Brief of Readable.]]></description>",
    );
    expect(document).toContain(
      "<description><![CDATA[Brief of Gone.]]></description>",
    );
    // Claimed, not briefed, tries left: not something the radio may read yet.
    expect(document).not.toContain("Unanswered");
  });

  it("publishes an article nobody answers for with its feed's line, after the last try", async () => {
    const feed = await site();
    const llm = await model();
    const desk = await editor({
      feedUrl: `${feed.url}/feed.xml`,
      backend: "server",
      serverUrl: llm.url,
      model: "fake",
      apiKey: "",
      database: `rss-editor-test-${Date.now()}-b`,
      // A claim older than a minute from now: every round may take it again.
      retryAfter: "+1 minute",
    });

    await desk.round();
    await desk.settled((rows) => !!rows.Readable?.brief && !!rows.Gone?.brief);
    await desk.round();
    await desk.round();
    const rows = await desk.settled(
      (rows) => !!rows.Unanswered?.status.startsWith("Could not be fetched"),
    );

    expect(rows.Unanswered.status).toContain("Could not be fetched");
    expect(await desk.feed()).toContain(
      "<description><![CDATA[The feed's own line.]]></description>",
    );
    // Briefed articles are not briefed again on later rounds.
    expect(
      llm.prompts.filter((prompt) => prompt.startsWith("Title: Readable")),
    ).toHaveLength(1);
  });
});
