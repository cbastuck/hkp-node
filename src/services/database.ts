/**
 * SQL databases, one per board.
 *
 * The counterpart to `recordStore` for work a key-value store cannot do:
 * "every message in this conversation, oldest first" is a query, and answering
 * it by listing a whole namespace and filtering in an expression stops being
 * reasonable at a few hundred records.
 *
 * A module rather than a service, for the same reason `recordStore` is one.
 * Two services need this — a generic one that hands SQL straight through, and
 * a conversation-aware one that owns its own tables — and they need it at the
 * level of a call, not of a pipeline. A service instance wrapping another
 * service instance would be a service with a host no runtime gave it and a
 * uuid nobody registered.
 *
 * SQLite comes from Node itself (`node:sqlite`), so this adds no dependency to
 * a package that has none native. Node marks the module experimental; the
 * surface used here — open, prepare, run, all — is the part that would be
 * hardest for it to change.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

import { RuntimeScope } from "../types";

/** Values SQLite can store, and therefore what a statement may be given. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlParams = Record<string, SqlValue> | SqlValue[];

export type SqlRow = Record<string, unknown>;

export type Database = {
  /** Statements run for their effect: DDL, PRAGMA, several at once. */
  exec(sql: string): void;
  /** The rows a statement returns. */
  query(sql: string, params?: SqlParams): SqlRow[];
  /** A statement that changes rows. */
  run(
    sql: string,
    params?: SqlParams,
  ): { changes: number; lastInsertRowid: number };
  close(): void;
};

/** A database as a list of them shows it. */
export type DatabaseInfo = { name: string; bytes: number };

export type DatabaseStore = {
  /** The database for one board, opened on first use and kept open. */
  open(scope: RuntimeScope): Database;
  /**
   * The database every board of one owner shares.
   *
   * A board's own file is what isolation is made of, and nothing belonging to
   * a board should leave it. What lives here is what is addressed to *another*
   * board — a queue, whose whole point is that the side publishing and the
   * side consuming are not the same board. Two scopes, two files, and a
   * service opens the one its job actually needs.
   */
  openShared(owner: string): Database;
  /**
   * A database of the owner's, by name.
   *
   * For a board that says which file it means rather than letting one be
   * derived from its title. The name is the board's to choose, so it is
   * checked before it reaches a path: the owner's directory is the boundary
   * and nothing a board writes may leave it.
   *
   * Throws when the name is not one a board may use.
   */
  openNamed(owner: string, name: string): Database;
  /**
   * The owner's databases a board can name, with their size on disk.
   *
   * Only those: a board's derived database is filed under a hash of its title,
   * which no board can write back as a `database`, and `shared` is the
   * runtime's own. Sorted by name.
   */
  list(owner: string): DatabaseInfo[];
  /** Closes every open database. For shutdown, and for tests. */
  closeAll(): void;
};

/**
 * Names reserved by the runtime itself, which a board may not take.
 *
 * `shared` holds the owner's queue — the one file every board of an owner
 * reads. A board naming it would be writing its own tables into the place
 * messages between boards live.
 */
const RESERVED_NAMES = new Set(["shared"]);

/**
 * A board-chosen database name, or an explanation of why it is not one.
 *
 * Deliberately narrow: this string becomes a file name, so anything that could
 * mean a directory, a parent, or a hidden file is not a name. A board that
 * gets it wrong is told, rather than quietly given the database it would have
 * had anyway — silently falling back would hide the mistake behind data that
 * looks right until the day it does not.
 */
export function checkDatabaseName(name: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return `'${name}' is not a database name: use 1-64 characters from A-Z, a-z, 0-9, - and _`;
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `'${name}' is reserved by the runtime`;
  }
  return null;
}

/**
 * Keys for the open-handle maps.
 *
 * Encoded rather than joined, because there are now two kinds of key over the
 * same map and a separator cannot be relied on to tell them apart: a board is
 * free to be called whatever the separator is. JSON encoding is injective, so
 * no board name can be made to name the owner-wide database.
 */
const boardKey = (owner: string, board: string): string =>
  JSON.stringify(["board", owner, board]);

const sharedKey = (owner: string): string => JSON.stringify(["shared", owner]);

const namedKey = (owner: string, name: string): string =>
  JSON.stringify(["named", owner, name]);

/**
 * How long a statement waits for a file another process is writing.
 *
 * Long enough to cover a write that is queued behind another process's
 * transaction, short enough that a genuinely stuck file surfaces as an error
 * rather than a pipeline that appears to hang.
 */
const BUSY_TIMEOUT_MS = 5000;

/** What `hashed` produces, which is how a derived database's file is named. */
const HASHED_NAME = /^[0-9a-f]{64}$/;

/** Whether a file's stem is a database a board can ask for by name. */
const isNameable = (stem: string): boolean =>
  checkDatabaseName(stem) === null && !HASHED_NAME.test(stem);

/** Names in a path are derived, never used: a board names neither of these. */
function hashed(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function wrap(db: DatabaseSync): Database {
  /**
   * Statements, compiled once each.
   *
   * Preparing parses and plans the statement, and a service in a pipeline runs
   * the same one on every pass — measurably about 19µs of it. The set is
   * bounded because a statement comes from a service's configuration, not from
   * its input: a board has as many as it has services.
   */
  const compiled = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    const existing = compiled.get(sql);
    if (existing) {
      return existing;
    }
    const statement = db.prepare(sql);
    compiled.set(sql, statement);
    return statement;
  };

  return {
    // Not cached: exec takes several statements and returns nothing, so there
    // is no prepared form of it to keep.
    exec: (sql) => db.exec(sql),
    query: (sql, params) => {
      const statement = prepare(sql);
      return (
        params === undefined
          ? statement.all()
          : Array.isArray(params)
            ? statement.all(...params)
            : statement.all(params)
      ) as SqlRow[];
    },
    run: (sql, params) => {
      const statement = prepare(sql);
      const result =
        params === undefined
          ? statement.run()
          : Array.isArray(params)
            ? statement.run(...params)
            : statement.run(params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    close: () => {
      // Statements hold the database open; dropping them first means close
      // means close.
      compiled.clear();
      db.close();
    },
  };
}

/**
 * Databases as files, one per board, under a directory the runtime owns:
 *
 *     <root>/<sha256(owner)>/<sha256(board)>.db
 *
 * A file per board rather than a tenant column, because isolation then holds
 * however a board writes its SQL — a generic service hands statements through
 * unread, so a board that forgets a `WHERE owner = ?` must still not be able
 * to reach another's rows. It is also what makes the file portable in the way
 * a single-file database is meant to be: copying it takes one board's data and
 * nothing else.
 */
export function createFileDatabaseStore(root: string): DatabaseStore {
  const open = new Map<string, Database>();

  /**
   * One file under the owner's directory, kept open for the next call. `name`
   * is the file's stem: a hashed board name, or a fixed name for the
   * owner-wide file. The two cannot collide — a hash is 64 hex characters,
   * and `shared` is not.
   */
  const openFile = (key: string, owner: string, name: string): Database => {
    const existing = open.get(key);
    if (existing) {
      return existing;
    }
    const dir = path.join(root, hashed(owner));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${name}.db`);
    const db = new DatabaseSync(file);
    // One file is reachable by more than one process — two runtime servers on
    // a machine, a board's units split across them — and SQLite's default
    // answer to a busy file is to fail the statement immediately. Measured on
    // two processes writing the same file: without this, 510 of 800 writes
    // were lost to "database is locked"; with it, none were.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // A crash mid-write costs the transaction rather than the database, and
    // a reader is not held up by the writer.
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Converting the journal takes a lock `busy_timeout` does not cover, so
      // two processes opening a new file at the same instant race and one
      // loses. The mode belongs to the file rather than the connection, so the
      // loser has nothing left to do: the winner has already set it.
    }
    db.exec("PRAGMA foreign_keys = ON");
    // Boards keep correspondence here; the file is the owner's to read.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // A filesystem with no modes is not a reason to fail the call.
    }
    const wrapped = wrap(db);
    open.set(key, wrapped);
    return wrapped;
  };

  return {
    open: (scope) =>
      openFile(
        boardKey(scope.owner, scope.boardName),
        scope.owner,
        hashed(scope.boardName),
      ),
    openShared: (owner) => openFile(sharedKey(owner), owner, "shared"),
    openNamed: (owner, name) => {
      const wrong = checkDatabaseName(name);
      if (wrong) {
        throw new Error(wrong);
      }
      return openFile(namedKey(owner, name), owner, name);
    },
    list: (owner) => {
      const dir = path.join(root, hashed(owner));
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const size = (file: string): number => {
        try {
          return fs.statSync(path.join(dir, file)).size;
        } catch {
          return 0;
        }
      };
      return files
        .filter((file) => file.endsWith(".db"))
        .map((file) => file.slice(0, -".db".length))
        .filter(isNameable)
        .map((name) => ({
          name,
          // A WAL file holds writes not yet folded into the database file.
          bytes: size(`${name}.db`) + size(`${name}.db-wal`),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    closeAll() {
      for (const db of open.values()) {
        db.close();
      }
      open.clear();
    },
  };
}

/**
 * Databases that live as long as the process, which is what tests and
 * throwaway runs want. Still one per board, so the isolation a test exercises
 * is the isolation that ships.
 */
export function createMemoryDatabaseStore(): DatabaseStore {
  const open = new Map<string, Database>();

  const openInMemory = (key: string): Database => {
    const existing = open.get(key);
    if (existing) {
      return existing;
    }
    const wrapped = wrap(new DatabaseSync(":memory:"));
    open.set(key, wrapped);
    return wrapped;
  };

  return {
    open: (scope) => openInMemory(boardKey(scope.owner, scope.boardName)),
    openShared: (owner) => openInMemory(sharedKey(owner)),
    openNamed: (owner, name) => {
      const wrong = checkDatabaseName(name);
      if (wrong) {
        throw new Error(wrong);
      }
      return openInMemory(namedKey(owner, name));
    },
    list: (owner) => {
      const found: DatabaseInfo[] = [];
      for (const [key, db] of open) {
        const [kind, keyOwner, name] = JSON.parse(key) as string[];
        if (kind === "named" && keyOwner === owner) {
          const [{ bytes }] = db.query(
            "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
          ) as { bytes: number }[];
          found.push({ name, bytes });
        }
      }
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },
    closeAll() {
      for (const db of open.values()) {
        db.close();
      }
      open.clear();
    },
  };
}
