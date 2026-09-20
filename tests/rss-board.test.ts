import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryDatabaseStore } from "../src/services/database";
import { MapService } from "../src/services/map";
import { SqlService } from "../src/services/sql";
import { TracksService } from "../src/services/tracks";
import { HostedService, RuntimeHost, ServiceConfiguration } from "../src/types";

/**
 * The RSS aggregator board's own statements, run.
 *
 * The board's reading list is two statements given the same request — tracks of
 * one service — and a query reading the table afterwards. What is pinned here is
 * that the board's SQL is *correct SQL for what it claims*: the same article
 * saved twice stays one row, an intent neither statement is for leaves the table
 * alone, and removing takes exactly the article asked for.
 *
 * The statements are read out of the board rather than repeated here — a copy
 * would pass while the board was broken.
 */

const BOARD = path.join(
  __dirname,
  "../../hkp-frontend/boards/rss-demo-board.json",
);

type Service = { uuid: string; serviceId: string; state: Record<string, any> };

type Board = {
  services: Record<string, Service[]>;
  unit?: { params?: Record<string, string> };
};

const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as Board;

/**
 * The board as it runs, not as it is written.
 *
 * It is a unit, so its own `unit.params` are substituted into it when it is
 * loaded — alone or composed. A test reading the file has to do the same, or it
 * runs statements naming a database called `{{param.database}}`.
 */
function withParams<T>(value: T, params: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(
      /\{\{\s*param\.([A-Za-z0-9_.-]+)\s*\}\}/g,
      (whole, name: string) => params[name] ?? whole,
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withParams(item, params)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withParams(item, params)]),
    ) as T;
  }
  return value;
}

const services = withParams(board.services.node, board.unit?.params ?? {});

/**
 * A service the board declares, wherever it sits.
 *
 * The board's two flows are scopes now, so its statements are inside one
 * rather than in the runtime's own list. Searched by shape rather than by the
 * field a scope keeps its pipeline in, so this goes on finding them if the
 * board is rearranged again.
 */
function statementOf(uuid: string): Service {
  const svc = find(services, uuid);
  if (!svc) {
    throw new Error(`the board has no service "${uuid}"`);
  }
  return svc;
}

function find(node: unknown, uuid: string): Service | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = find(item, uuid);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!node || typeof node !== "object") {
    return null;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.serviceId === "string" && record.uuid === uuid) {
    return record as unknown as Service;
  }
  return find(Object.values(record), uuid);
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

/**
 * The board's statements, on one in-memory database, arranged as the board
 * arranges them: the writers as tracks of one service, the query after it.
 *
 * The tracks service is the real one, so what runs here is the board's own
 * configuration — the guards, the reducer, the order — rather than a retelling.
 */
function readingList() {
  const databases = createMemoryDatabaseStore();
  const create = (config: ServiceConfiguration): HostedService =>
    config.serviceId === "map"
      ? (new MapService(config) as unknown as HostedService)
      : (new SqlService(config, databases) as unknown as HostedService);

  const record = new TracksService(
    {
      uuid: "record-article",
      serviceId: "tracks",
      state: statementOf("record-article").state,
    } as never,
    create,
  );
  record.setHost(host);

  const list = new SqlService(
    { uuid: "kept-articles", serviceId: "sql", state: statementOf("kept-articles").state } as never,
    databases,
  );
  list.setHost(host);

  /** One request through both, the way the runtime would run them. */
  const send = async (request: Record<string, unknown>) => {
    const carried = await record.process(request, () => {});
    return list.process(carried, () => {}) as {
      rows: Record<string, unknown>[];
      count: number;
    };
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
  it("saves an article and reads it back in the same pass", async () => {
    const { send } = readingList();
    const result = await send(article);

    // The query at the end sees what the insert before it just wrote, so the
    // facade never has to refresh after a save.
    expect(result.count).toBe(1);
    expect(result.rows[0]).toMatchObject({
      link: article.link,
      title: article.title,
      feed: "Hacker News",
    });
  });

  it("keeps one row when the same article is saved twice", async () => {
    const { send } = readingList();
    await send(article);
    // The upsert's parse is the thing being checked: an INSERT … SELECT with
    // both a WHERE and an ON CONFLICT is exactly where SQLite is ambiguous.
    expect((await send(article)).count).toBe(1);
  });

  it("leaves the list alone for an intent neither statement is for", async () => {
    const { send } = readingList();
    await send(article);
    // What the facade sends on load to read the list without changing it.
    const result = await send({ intent: "none", link: "" });
    expect(result.count).toBe(1);
  });

  it("removes the article asked for and no other", async () => {
    const { send } = readingList();
    await send(article);
    await send({ ...article, link: "https://example.com/two", title: "Another" });
    expect((await send({ intent: "none", link: "" })).count).toBe(2);

    const left = await send({ intent: "drop", link: article.link });
    expect(left.rows.map((row) => row.link)).toEqual([
      "https://example.com/two",
    ]);
  });

  it("refuses an article with no address to open", async () => {
    const { send } = readingList();
    // A row with no link is a row nothing can be done with, and it would take
    // the table's primary key.
    expect((await send({ ...article, link: "" })).count).toBe(0);
  });
});
