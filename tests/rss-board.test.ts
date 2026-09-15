import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { RuntimeHost } from "../src/types";

/**
 * The RSS aggregator board's own statements, run.
 *
 * The board's reading list is three statements in a row acting on one request,
 * which is a design the SQL service supports and neither statement can check.
 * What is pinned here is that the board's SQL is *correct SQL for what it
 * claims*: the same article saved twice stays one row, an intent the statement
 * is not for leaves the table alone, and removing takes exactly the article
 * asked for.
 *
 * The statements are read out of the board rather than repeated here — a copy
 * would pass while the board was broken.
 */

const BOARD = path.join(
  __dirname,
  "../../hkp-frontend/boards/rss-demo-board.json",
);

type Service = { uuid: string; serviceId: string; state: Record<string, any> };

type Board = { services: Record<string, Service[]> };

const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as Board;

const services = board.services.node;

function statementOf(uuid: string): Service {
  const svc = services.find((service) => service.uuid === uuid);
  if (!svc) {
    throw new Error(`the board has no service "${uuid}"`);
  }
  return svc;
}

const host = {
  processFrom: (_uuid: string, data: unknown) => data,
  notify: () => {},
  currentContext: () => null,
  log: () => {},
  forwardLog: () => {},
  logSettings: () => ({
    logging: false,
    logData: false,
    logLevel: "info" as const,
  }),
  scope: () => ({ owner: "tester", boardName: "RSS Aggregator" }),
  emitResult: () => {},
} as unknown as RuntimeHost;

/** The board's three statements, on one in-memory database, in board order. */
function readingList() {
  const databases = createMemoryDatabaseStore();
  const chain = ["keep-article", "drop-article", "kept-articles"].map((uuid) => {
    const svc = new SqlService(
      { uuid, serviceId: "sql", state: statementOf(uuid).state } as never,
      databases,
    );
    svc.setHost(host);
    return svc;
  });

  /** One request through all three, the way the runtime would run them. */
  const send = (request: Record<string, unknown>) => {
    let value: unknown = request;
    for (const svc of chain) {
      value = svc.process(value, () => {});
    }
    return value as { rows: Record<string, unknown>[]; count: number };
  };

  return { send };
}

const article = {
  intent: "keep",
  link: "https://example.com/one",
  title: "A thing that happened",
  feed: "Hacker News",
  author: "ada",
  summary: "Something about it.",
  published: "2026-01-02T03:04:05.000Z",
};

describe("the RSS aggregator's reading list", () => {
  it("saves an article and reads it back in the same pass", () => {
    const { send } = readingList();
    const result = send(article);

    // The query at the end sees what the insert before it just wrote, so the
    // facade never has to refresh after a save.
    expect(result.count).toBe(1);
    expect(result.rows[0]).toMatchObject({
      link: article.link,
      title: article.title,
      feed: "Hacker News",
    });
  });

  it("keeps one row when the same article is saved twice", () => {
    const { send } = readingList();
    send(article);
    // The upsert's parse is the thing being checked: an INSERT … SELECT with
    // both a WHERE and an ON CONFLICT is exactly where SQLite is ambiguous.
    expect(send(article).count).toBe(1);
  });

  it("leaves the list alone for an intent neither statement is for", () => {
    const { send } = readingList();
    send(article);
    // What the facade sends on load to read the list without changing it.
    const result = send({ intent: "none", link: "" });
    expect(result.count).toBe(1);
  });

  it("removes the article asked for and no other", () => {
    const { send } = readingList();
    send(article);
    send({ ...article, link: "https://example.com/two", title: "Another" });
    expect(send({ intent: "none", link: "" }).count).toBe(2);

    const left = send({ intent: "drop", link: article.link });
    expect(left.rows.map((row) => row.link)).toEqual([
      "https://example.com/two",
    ]);
  });

  it("refuses an article with no address to open", () => {
    const { send } = readingList();
    // A row with no link is a row nothing can be done with, and it would take
    // the table's primary key.
    expect(send({ ...article, link: "" }).count).toBe(0);
  });
});
