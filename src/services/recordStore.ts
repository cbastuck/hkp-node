import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { RuntimeScope } from "../types";

/**
 * What a board keeps between calls.
 *
 * ```
 * <root>/<sha256(owner)>/<sha256(boardName)>/[<sha256(namespace)>/]<sha256(key)>.json
 * ```
 *
 * The same shape and the same reasoning as `coordinator/fileBoardStore.ts`: the
 * names in those paths are **derived, never used directly**, because they all
 * come from outside — an Auth0 `sub` contains characters that have no business
 * in a path, and a key called `../../etc/passwd` must not be able to escape the
 * root. Hashing also keeps `Foo` and `foo`, which are two keys here, from
 * becoming one file on a case-insensitive filesystem. The real names are
 * inside the file.
 *
 * One file per record rather than one map per board: a board that dumps every
 * incoming message writes constantly and reads rarely, so appending a file must
 * not mean rewriting everything before it, and a crash mid-write must cost the
 * record being written rather than the table. Writes go to a temporary name and
 * are renamed into place, which within one directory is atomic.
 *
 * Records carry whatever a board put in them, which for the workflows this
 * exists for is correspondence — so the directories are `0o700` and the files
 * `0o600`, the owner's to read and nobody else's.
 */

/** Bumped only when the shape on disk changes; an unknown one is left alone. */
const FORMAT_VERSION = 1;

/**
 * A record, and whether somebody is currently dealing with it.
 *
 * A lease is what makes "released" different from "gone": the record has been
 * handed to a pipeline and is no longer waiting, but it has not been settled
 * either. Nothing removes it until something says the work finished, so a
 * pipeline that fails leaves it recoverable rather than lost.
 */
export type RecordLease = {
  /** When it was handed out. What a lease timeout would read. */
  at: string;
  /**
   * The run it was handed to.
   *
   * How an acknowledgement at the far end of a pipeline knows which record it
   * is settling: the run id threads through every service, including the ones
   * that answer long after the pass that started them, so it survives the gap
   * that the record's own key does not.
   */
  run?: string;
};

export type StoredRecord = {
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
  /** Absent while the record is waiting; present once it is being dealt with. */
  lease?: RecordLease;
};

type RecordFile = StoredRecord & { version: number };

/**
 * Which table a call means.
 *
 * The tenant and board come from the runtime and cannot be asked for; the
 * namespace is the one part a board chooses, and it only ever subdivides what
 * the runtime already granted. Empty means the board's own table — so a board
 * that never mentions a namespace has exactly one, which is the common case.
 */
export type StoreScope = RuntimeScope & { namespace?: string };

export type RecordStore = {
  put(scope: StoreScope, key: string, value: unknown): Promise<StoredRecord>;
  get(scope: StoreScope, key: string): Promise<StoredRecord | null>;
  /** Every record of one table, oldest first. */
  list(scope: StoreScope): Promise<StoredRecord[]>;
  /**
   * Hands a record out, or takes it back. Returns the record as it now stands,
   * or null when there is none by that key.
   */
  setLease(
    scope: StoreScope,
    key: string,
    lease: RecordLease | null,
  ): Promise<StoredRecord | null>;
  /** True when there was something to delete. */
  remove(scope: StoreScope, key: string): Promise<boolean>;
  /** Everything this table kept. Returns how many records went. */
  clear(scope: StoreScope): Promise<number>;
};

function hashed(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecordFile(value: unknown): value is RecordFile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    "value" in record
  );
}

export function createFileRecordStore(root: string): RecordStore {
  // A namespace is a directory *inside* the board's, so the board's own table
  // keeps the path it always had and a namespaced one cannot be reached from
  // outside the board. Records are files ending in .json and namespaces are
  // directories, so listing one never sees the other.
  const tableDir = (scope: StoreScope) => {
    const board = path.join(root, hashed(scope.owner), hashed(scope.boardName));
    return scope.namespace ? path.join(board, hashed(scope.namespace)) : board;
  };
  const recordPath = (scope: StoreScope, key: string) =>
    path.join(tableDir(scope), `${hashed(key)}.json`);

  async function read(file: string): Promise<StoredRecord | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // Missing is the common case and not an error; unreadable is rare and
      // must not take the rest of the table down with it.
      return null;
    }
    if (!isRecordFile(parsed) || parsed.version !== FORMAT_VERSION) {
      return null;
    }
    const { key, value, createdAt, updatedAt, lease } = parsed;
    return { key, value, createdAt, updatedAt, ...(lease ? { lease } : {}) };
  }

  /**
   * Writes a record whole, beside its target and then renamed into place: a
   * rename within one directory is atomic, so a crash mid-write leaves the
   * previous record intact rather than half of the new one.
   */
  async function write(
    scope: StoreScope,
    record: StoredRecord,
  ): Promise<StoredRecord> {
    const dir = tableDir(scope);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = recordPath(scope, record.key);
    const contents: RecordFile = { version: FORMAT_VERSION, ...record };
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(contents), { mode: 0o600 });
    try {
      await fs.rename(temporary, file);
    } catch (err) {
      await fs.rm(temporary, { force: true });
      throw err;
    }
    return record;
  }

  return {
    async put(scope, key, value) {
      const file = recordPath(scope, key);
      const now = new Date().toISOString();
      // Overwriting keeps the record's original age: when it first arrived is
      // what orders a queue, and re-reading it later must not move it to the
      // back of one.
      const existing = await read(file);
      const record: StoredRecord = {
        key,
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      return write(scope, record);
    },

    async setLease(scope, key, lease) {
      const record = await read(recordPath(scope, key));
      if (!record) {
        return null;
      }
      // The value and its age are untouched: handing a record out is a fact
      // about who is dealing with it, not an edit to what it says.
      const updated: StoredRecord = { ...record };
      if (lease) {
        updated.lease = lease;
      } else {
        delete updated.lease;
      }
      return write(scope, updated);
    },

    async get(scope, key) {
      return read(recordPath(scope, key));
    },

    async list(scope) {
      let entries: string[];
      try {
        entries = await fs.readdir(tableDir(scope));
      } catch {
        // A board that has stored nothing has no directory, which is an empty
        // table rather than an error.
        return [];
      }
      const records: StoredRecord[] = [];
      for (const entry of entries) {
        // Only finished files: one still being written is under a temporary
        // name, which does not end in .json.
        if (!entry.endsWith(".json")) {
          continue;
        }
        const record = await read(path.join(tableDir(scope), entry));
        if (record) {
          records.push(record);
        }
      }
      // Oldest first, so a board reading its own table gets the order things
      // arrived in — which is the order a queue is worked through.
      records.sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.key.localeCompare(b.key)
          : a.createdAt.localeCompare(b.createdAt),
      );
      return records;
    },

    async remove(scope, key) {
      const file = recordPath(scope, key);
      try {
        await fs.rm(file);
        return true;
      } catch {
        // Already gone is the outcome asked for, and worth saying apart from
        // having deleted something.
        return false;
      }
    },

    async clear(scope) {
      // Only this table's own records: removing the directory outright would
      // take the namespaces nested inside it too, and emptying one table has no
      // business emptying another.
      const records = await this.list(scope);
      await Promise.all(
        records.map((record) =>
          fs.rm(recordPath(scope, record.key), { force: true }),
        ),
      );
      return records.length;
    },
  };
}

/**
 * A store that keeps nothing beyond the life of the process.
 *
 * What a runtime told to persist nothing uses, and what tests use. The service
 * behaves identically against it — which is the point: a board should not have
 * to know which one it is talking to.
 */
export function createMemoryRecordStore(): RecordStore {
  const boards = new Map<string, Map<string, StoredRecord>>();
  // NUL cannot occur in any of the three, so the join is unambiguous — the
  // same reasoning as `tenantKey` in the server. Written as an escape rather
  // than a literal control character, which does not survive an editor.
  const keyOf = (scope: StoreScope) =>
    `${scope.owner}\u0000${scope.boardName}\u0000${scope.namespace ?? ""}`;
  const boardOf = (scope: StoreScope) => {
    const id = keyOf(scope);
    let board = boards.get(id);
    if (!board) {
      board = new Map();
      boards.set(id, board);
    }
    return board;
  };

  return {
    async put(scope, key, value) {
      const board = boardOf(scope);
      const now = new Date().toISOString();
      const record: StoredRecord = {
        key,
        value,
        createdAt: board.get(key)?.createdAt ?? now,
        updatedAt: now,
      };
      board.set(key, record);
      return record;
    },

    async get(scope, key) {
      return boardOf(scope).get(key) ?? null;
    },

    async setLease(scope, key, lease) {
      const board = boardOf(scope);
      const record = board.get(key);
      if (!record) {
        return null;
      }
      const updated: StoredRecord = { ...record };
      if (lease) {
        updated.lease = lease;
      } else {
        delete updated.lease;
      }
      board.set(key, updated);
      return updated;
    },

    async list(scope) {
      return [...boardOf(scope).values()].sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.key.localeCompare(b.key)
          : a.createdAt.localeCompare(b.createdAt),
      );
    },

    async remove(scope, key) {
      return boardOf(scope).delete(key);
    },

    async clear(scope) {
      const board = boardOf(scope);
      const size = board.size;
      board.clear();
      return size;
    },
  };
}
