import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileLogStore } from "../src/coordinator/logStore";
import { LogEntry } from "../src/types";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-"));
  roots.push(root);
  return { root, log: createFileLogStore(root) };
}

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    runId: "run-1",
    ts: "2026-08-15T10:00:00.000Z",
    runtimeId: "node",
    serviceUuid: "svc",
    level: "info",
    event: "handled",
    ...over,
  };
}

/** The stream writes asynchronously; a read has to see what was appended. */
async function settle(log: { close(): Promise<void> }) {
  await log.close();
}

describe("log store", () => {
  it("keeps entries from every runtime in one board's log", async () => {
    const { log } = await store();

    log.append("u1", "board", entry({ runtimeId: "node" }));
    log.append("u1", "board", entry({ runtimeId: "python", event: "second" }));
    await settle(log);

    const entries = await log.read("u1", "board");
    expect(entries.map((e) => e.runtimeId)).toEqual(["node", "python"]);
  });

  it("keeps one user's log out of another's", async () => {
    const { log } = await store();

    log.append("u1", "board", entry({ event: "mine" }));
    log.append("u2", "board", entry({ event: "theirs" }));
    await settle(log);

    expect((await log.read("u1", "board")).map((e) => e.event)).toEqual(["mine"]);
    expect((await log.read("u2", "board")).map((e) => e.event)).toEqual(["theirs"]);
  });

  it("withholds `data` unless it is asked for", async () => {
    // Filtering after the fact would mean the payload had already been sent,
    // which is what withholding it exists to prevent.
    const { log } = await store();

    log.append("u1", "board", entry({ data: { secret: "shhh" } }));
    await settle(log);

    expect((await log.read("u1", "board"))[0].data).toBeUndefined();
    expect(
      (await log.read("u1", "board", { withData: true }))[0].data,
    ).toEqual({ secret: "shhh" });
  });

  it("narrows to one run", async () => {
    const { log } = await store();

    log.append("u1", "board", entry({ runId: "a" }));
    log.append("u1", "board", entry({ runId: "b" }));
    log.append("u1", "board", entry({ runId: "a", event: "again" }));
    await settle(log);

    const entries = await log.read("u1", "board", { runId: "a" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.runId === "a")).toBe(true);
  });

  it("narrows to a level and above", async () => {
    const { log } = await store();

    log.append("u1", "board", entry({ level: "debug" }));
    log.append("u1", "board", entry({ level: "warn" }));
    log.append("u1", "board", entry({ level: "error" }));
    await settle(log);

    const entries = await log.read("u1", "board", { level: "warn" });
    expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("returns the newest when a limit is given", async () => {
    // A log is read from its end.
    const { log } = await store();

    for (const n of [1, 2, 3]) {
      log.append("u1", "board", entry({ event: `e${n}` }));
    }
    await settle(log);

    expect(
      (await log.read("u1", "board", { limit: 2 })).map((e) => e.event),
    ).toEqual(["e2", "e3"]);
  });

  it("reads a board that has logged nothing as an empty log", async () => {
    const { log } = await store();

    expect(await log.read("u1", "never-logged")).toEqual([]);
  });

  it("survives a torn last line", async () => {
    // What a crash mid-write leaves behind. One entry per line is what makes
    // the rest of the file still readable.
    const { root, log } = await store();

    log.append("u1", "board", entry({ event: "intact" }));
    await settle(log);
    const file = path.join(root, "u1", "board.log.jsonl");
    await fs.appendFile(file, '{"runId":"half-writ');

    const entries = await createFileLogStore(root).read("u1", "board");
    expect(entries.map((e) => e.event)).toEqual(["intact"]);
  });

  it("rolls the file aside once it is too big, and drops the oldest", async () => {
    // Bounded by bytes, because bytes are what fill a disk.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-"));
    roots.push(root);
    const log = createFileLogStore(root, { maxBytes: 400, keepFiles: 2 });

    for (let n = 0; n < 40; n += 1) {
      log.append("u1", "board", entry({ event: `e${n}` }));
      // Let the roll finish before the next batch, so this exercises repeated
      // rotation rather than one roll racing forty appends.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Closing waits for a roll still in flight, so what is on disk after this
    // is settled rather than caught mid-rename.
    await settle(log);

    const names = (await fs.readdir(path.join(root, "u1"))).sort();
    // At most the live file plus `keepFiles` rolled beside it — that bound is
    // the point of rotating. Which roll index happens to be on disk depends on
    // where the last roll got to, so it is not what this asserts.
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names.every((n) => n.startsWith("board.log.jsonl"))).toBe(true);
    // It did roll: 40 entries of ~245 bytes cannot fit in one 400-byte file.
    expect(names.some((n) => /\.jsonl\.\d+$/.test(n))).toBe(true);
  });

  it("reads across the files it has rolled", async () => {
    // Right after a roll the live file does not exist yet, and everything
    // somebody is asking for is in the one behind it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-"));
    roots.push(root);
    const log = createFileLogStore(root, { maxBytes: 500, keepFiles: 3 });

    for (let n = 0; n < 12; n += 1) {
      log.append("u1", "board", entry({ event: `e${n}` }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await settle(log);

    const entries = await log.read("u1", "board");
    // Spans the roll rather than seeing only whatever the live file holds.
    expect(entries.length).toBeGreaterThan(3);
    expect(entries[entries.length - 1].event).toBe("e11");
    // And in order across the boundary.
    const order = entries.map((e) => Number(e.event.slice(1)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps counting from what a file already held", async () => {
    // A restart appends to the existing file; starting the count at zero would
    // let it grow past the limit by whatever was there before.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-"));
    roots.push(root);

    const first = createFileLogStore(root, { maxBytes: 400, keepFiles: 2 });
    for (let n = 0; n < 3; n += 1) {
      first.append("u1", "board", entry({ event: `a${n}` }));
    }
    await settle(first);

    const reopened = createFileLogStore(root, { maxBytes: 400, keepFiles: 2 });
    reopened.append("u1", "board", entry({ event: "after-restart" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle(reopened);

    // Four entries of ~245 bytes are well past 400, so reopening and writing
    // one more must have rolled rather than carried on appending.
    const names = await fs.readdir(path.join(root, "u1"));
    expect(names).toContain("board.log.jsonl.1");
  });

  it("answers a read without a limit from the end of the file", async () => {
    // An unbounded default makes the whole file the easy answer, which is
    // ruinous on a board that has been running for a week.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-"));
    roots.push(root);
    const log = createFileLogStore(root);

    for (let n = 0; n < 600; n += 1) {
      log.append("u1", "board", entry({ event: `e${n}` }));
    }
    await settle(log);

    const entries = await log.read("u1", "board");
    expect(entries).toHaveLength(500);
    // The newest, not the oldest.
    expect(entries[entries.length - 1].event).toBe("e599");
  });

  it("writes where only the owner can read", async () => {
    const { root, log } = await store();

    log.append("u1", "board", entry());
    await settle(log);

    const dir = await fs.stat(path.join(root, "u1"));
    const file = await fs.stat(path.join(root, "u1", "board.log.jsonl"));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });
});
