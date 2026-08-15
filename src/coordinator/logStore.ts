import { createWriteStream, mkdirSync, statSync, WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { LogEntry } from "../types";

/**
 * Where a board's log lives on disk.
 *
 * One file per board, holding entries from every runtime it spans — that
 * stitching is the whole reason the log is kept by the coordinator rather than
 * by each runtime, which could only ever answer for its own slice.
 *
 * JSONL, one entry per line: it appends without rewriting what is already
 * there, a crash mid-write costs the last line rather than the file, and it
 * reads back a line at a time so serving a query never loads a long-running
 * board's whole history into memory. A pretty-printed array would fail all
 * three.
 *
 * Entries carry board data, so the files inherit the board store's posture:
 * per-user directories, `0o700` on the directory and `0o600` on the file —
 * the owner's to read, and nobody else's.
 *
 * Bounded by size rather than by age: what fills a disk is bytes, and a board
 * ticking once a second and one that runs twice a day would need wildly
 * different day counts to mean the same thing. When the live file passes the
 * limit it is rolled aside and a new one started; past the kept count the
 * oldest is deleted.
 */
export type LogStore = {
  append(userId: string, boardName: string, entry: LogEntry): void;
  /**
   * Entries for one board, newest last, optionally narrowed.
   *
   * `fields` exists so a caller can ask for entries *without* their `data`:
   * filtering after the fact would mean the payload had already crossed the
   * wire, which is the thing the default-off `data` setting exists to prevent.
   */
  read(
    userId: string,
    boardName: string,
    query?: {
      runId?: string;
      level?: LogEntry["level"];
      since?: string;
      limit?: number;
      withData?: boolean;
    },
  ): Promise<LogEntry[]>;
  remove(userId: string, boardName: string): Promise<void>;
  close(): Promise<void>;
};

const LEVELS: Record<LogEntry["level"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Keeps a file name from escaping its directory or colliding across boards. */
function safeName(value: string): string {
  return encodeURIComponent(value);
}

export type LogStoreOptions = {
  /** Roll the live file once it passes this many bytes. */
  maxBytes?: number;
  /** How many rolled files to keep beside the live one. */
  keepFiles?: number;
};

/** 32 MB × 4 rolled ≈ 160 MB per board before the oldest entries are dropped. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_KEEP_FILES = 4;

/**
 * How many entries a read returns when the caller does not say.
 *
 * A log is read from its end, and an unbounded default makes the whole file the
 * easy answer — which is fine on a board that has just started and ruinous on
 * one that has been running for a week.
 */
const DEFAULT_LIMIT = 500;
/** Lines read per entry wanted, to absorb the ones a filter discards. */
const OVER_READ = 4;

/**
 * The newest entries in a file, read backwards from its end.
 *
 * A limited read must not have to walk a long file to answer, and the newest
 * entries are the ones a log is asked for — so this reads chunks from the end
 * until it has enough lines, rather than reading forward and discarding almost
 * all of it.
 */
async function tailLines(
  handle: fs.FileHandle,
  wanted: number,
): Promise<string[]> {
  const { size } = await handle.stat();
  const chunk = 64 * 1024;
  let position = size;
  let carry = "";
  const lines: string[] = [];

  while (position > 0 && lines.length <= wanted) {
    const length = Math.min(chunk, position);
    position -= length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    const text = buffer.toString("utf8") + carry;
    const split = text.split("\n");
    // The first piece may be half a line whose start is in the chunk before
    // this one; carry it until that chunk is read (or the file begins).
    carry = position > 0 ? (split.shift() ?? "") : "";
    lines.unshift(...split);
  }
  if (carry) {
    lines.unshift(carry);
  }
  return lines;
}

export function createFileLogStore(
  root: string,
  options: LogStoreOptions = {},
): LogStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES;
  // One open stream per board, because a board writes entries continuously and
  // reopening per entry would cost a syscall per line.
  const streams = new Map<string, WriteStream>();
  // Bytes in the live file, so a roll does not need a stat per entry.
  const writtenBytes = new Map<string, number>();
  const rotating = new Set<string>();

  const dirFor = (userId: string) => path.join(root, safeName(userId));
  const fileFor = (userId: string, boardName: string) =>
    path.join(dirFor(userId), `${safeName(boardName)}.log.jsonl`);

  function streamFor(userId: string, boardName: string): WriteStream {
    const file = fileFor(userId, boardName);
    const existing = streams.get(file);
    if (existing) {
      return existing;
    }
    // Synchronously, because the stream opens the file immediately: an awaited
    // mkdir would still be pending when it did, the open would fail with
    // ENOENT, and the entries written before the directory appeared would be
    // lost with only a console error to show for it. This costs one syscall the
    // first time a board logs, not one per entry.
    mkdirSync(dirFor(userId), { recursive: true, mode: 0o700 });
    // Seeded from what is already there: the stream appends, so a restart that
    // started counting from zero would let the file grow past the limit by
    // whatever it held before.
    try {
      writtenBytes.set(file, statSync(file).size);
    } catch {
      writtenBytes.set(file, 0);
    }
    const stream = createWriteStream(file, { flags: "a", mode: 0o600 });
    stream.on("error", (err) => {
      console.error(`[coordinator] Log write failed for "${boardName}":`, err);
      streams.delete(file);
    });
    streams.set(file, stream);
    return stream;
  }

  /**
   * Rolls the live file aside once it is too big, dropping the oldest.
   *
   * `.1` is the most recent roll, so every kept file shifts up by one and
   * whatever was at `keepFiles` falls off. Renames rather than copies, so a
   * roll costs the same whatever the file holds.
   */
  async function rotate(userId: string, boardName: string): Promise<void> {
    const file = fileFor(userId, boardName);
    const stream = streams.get(file);
    streams.delete(file);
    await new Promise<void>((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      stream.end(() => resolve());
    });

    await fs.rm(`${file}.${keepFiles}`, { force: true });
    for (let index = keepFiles - 1; index >= 1; index -= 1) {
      await fs
        .rename(`${file}.${index}`, `${file}.${index + 1}`)
        .catch(() => {});
    }
    await fs.rename(file, `${file}.1`).catch(() => {});
  }

  return {
    append(userId, boardName, entry) {
      const line = `${JSON.stringify(entry)}\n`;
      const file = fileFor(userId, boardName);
      // Opened first: opening is what seeds the count from a file that already
      // exists, and reading the count before that would discard the seed.
      const stream = streamFor(userId, boardName);
      const written = (writtenBytes.get(file) ?? 0) + Buffer.byteLength(line);

      stream.write(line);
      writtenBytes.set(file, written);

      if (written >= maxBytes && !rotating.has(file)) {
        // One roll at a time per board: append is synchronous for the caller,
        // so a second one arriving mid-roll must not start another.
        rotating.add(file);
        void rotate(userId, boardName)
          .catch((err) =>
            console.error(
              `[coordinator] Log rotation failed for "${boardName}":`,
              err,
            ),
          )
          .finally(() => {
            writtenBytes.set(file, 0);
            rotating.delete(file);
          });
      }
    },

    async read(userId, boardName, query = {}) {
      // Defaults to info: the flow is recorded at debug, and a caller who did
      // not ask for it is asking what happened, not what ran. `level=debug`
      // opens it up.
      const minLevel = LEVELS[query.level ?? "info"];
      const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;
      // Over-read a little: a line may be filtered out, so the newest `limit`
      // lines are not always the newest `limit` entries. Bounded either way,
      // which is the point.
      const wanted = limit * OVER_READ;

      // Newest first — the live file, then the rolled ones behind it. A read
      // has to span them: right after a roll the live file is empty (it is not
      // even created until the next entry), and the entries somebody is asking
      // for are all in `.1`.
      const base = fileFor(userId, boardName);
      const candidates = [
        base,
        ...Array.from({ length: keepFiles }, (_, index) => `${base}.${index + 1}`),
      ];

      const lines: string[] = [];
      for (const candidate of candidates) {
        if (lines.length >= wanted) {
          break;
        }
        let handle;
        try {
          handle = await fs.open(candidate, "r");
        } catch {
          // A board that has not logged this far back has no such file, which
          // is an empty stretch rather than an error.
          continue;
        }
        try {
          // Each file read is older than what is already collected, so it goes
          // in front of it.
          lines.unshift(...(await tailLines(handle, wanted - lines.length)));
        } finally {
          await handle.close();
        }
      }

      const found: LogEntry[] = [];
      for (const line of lines) {
        if (!line) {
          continue;
        }
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch {
          // A torn line — the last one after a crash mid-write, or the first
          // one when a read started mid-file. Either way the rest is still
          // readable, which is why entries are one per line.
          continue;
        }
        if (query.runId && entry.runId !== query.runId) {
          continue;
        }
        if (LEVELS[entry.level] < minLevel) {
          continue;
        }
        if (query.since && entry.ts <= query.since) {
          continue;
        }
        if (!query.withData && entry.data !== undefined) {
          const { data: _dropped, ...rest } = entry;
          found.push(rest);
        } else {
          found.push(entry);
        }
      }

      // Newest last is how the files read, so the newest `limit` are the tail.
      return found.slice(-limit);
    },

    async remove(userId, boardName) {
      const file = fileFor(userId, boardName);
      streams.get(file)?.end();
      streams.delete(file);
      await fs.rm(file, { force: true });
    },

    async close() {
      await Promise.all(
        [...streams.values()].map(
          (stream) =>
            new Promise<void>((resolve) => stream.end(() => resolve())),
        ),
      );
      streams.clear();
    },
  };
}
