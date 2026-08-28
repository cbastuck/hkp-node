import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileDatabaseStore,
  createMemoryDatabaseStore,
} from "../src/services/database";

/**
 * Which rows a board can reach.
 *
 * The generic SQL service hands statements through unread, so a board writes
 * its own `WHERE`. That makes isolation a property of where the data lives
 * rather than of what a board remembered to type — which is what these check.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-db-"));
  roots.push(root);
  return root;
}

const alice = { owner: "alice", boardName: "SYN" };
const bob = { owner: "bob", boardName: "SYN" };
const other = { owner: "alice", boardName: "Other" };

describe("a database per board", () => {
  it("keeps two owners' rows apart, board name notwithstanding", () => {
    // Same board name, different people: the name is not the identity.
    const store = createMemoryDatabaseStore();
    const setup = "CREATE TABLE note (text TEXT)";

    store.open(alice).exec(setup);
    store.open(alice).run("INSERT INTO note VALUES (?)", ["alice's"]);
    store.open(bob).exec(setup);

    expect(store.open(bob).query("SELECT * FROM note")).toEqual([]);
    expect(store.open(alice).query("SELECT * FROM note")).toEqual([
      { text: "alice's" },
    ]);
  });

  it("keeps one person's two boards apart", () => {
    const store = createMemoryDatabaseStore();
    store.open(alice).exec("CREATE TABLE note (text TEXT)");

    // The other board has no such table at all — not an empty one.
    expect(() => store.open(other).query("SELECT * FROM note")).toThrow();
  });

  it("hands back the same database rather than reopening it", () => {
    const store = createMemoryDatabaseStore();
    store.open(alice).exec("CREATE TABLE note (text TEXT)");
    store.open(alice).run("INSERT INTO note VALUES ('x')");

    // An in-memory database that were reopened would be a fresh, empty one,
    // so this is also what makes the memory store usable at all.
    expect(store.open(alice).query("SELECT count(*) AS n FROM note")).toEqual([
      { n: 1 },
    ]);
  });
});

describe("statements", () => {
  it("binds parameters by position and by name", () => {
    const store = createMemoryDatabaseStore();
    const db = store.open(alice);
    db.exec("CREATE TABLE mail (id TEXT, subject TEXT)");

    db.run("INSERT INTO mail VALUES (?, ?)", ["a@x", "Anfrage"]);
    db.run("INSERT INTO mail VALUES ($id, $subject)", {
      id: "b@y",
      subject: "Rückfrage",
    });

    expect(db.query("SELECT id FROM mail ORDER BY id")).toEqual([
      { id: "a@x" },
      { id: "b@y" },
    ]);
  });

  it("reports what a write changed", () => {
    const store = createMemoryDatabaseStore();
    const db = store.open(alice);
    db.exec("CREATE TABLE mail (id TEXT)");

    expect(db.run("INSERT INTO mail VALUES ('a')").changes).toBe(1);
    expect(db.run("DELETE FROM mail WHERE id = 'nope'").changes).toBe(0);
  });
});

describe("databases as files", () => {
  it("survives the store being closed and opened again", () => {
    const root = tempRoot();

    const first = createFileDatabaseStore(root);
    first.open(alice).exec("CREATE TABLE note (text TEXT)");
    first.open(alice).run("INSERT INTO note VALUES ('kept')");
    first.closeAll();

    const second = createFileDatabaseStore(root);
    expect(second.open(alice).query("SELECT * FROM note")).toEqual([
      { text: "kept" },
    ]);
    second.closeAll();
  });

  it("names nothing in the path that a board chose", () => {
    // A board name is arbitrary text; a key called "../../etc" must not
    // become a path, and two names differing only in case must not collide
    // on a filesystem that ignores case.
    const root = tempRoot();
    const store = createFileDatabaseStore(root);
    store.open({ owner: "alice", boardName: "../../escape" }).exec("SELECT 1");
    store.closeAll();

    const files = fs
      .readdirSync(root, { recursive: true, encoding: "utf-8" })
      .filter((entry) => entry.endsWith(".db"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("escape");
    expect(files[0]).toMatch(/^[0-9a-f]{64}[/\\][0-9a-f]{64}\.db$/);
  });

  it("gives one board's data its own file, so copying takes only that", () => {
    const root = tempRoot();
    const store = createFileDatabaseStore(root);
    store.open(alice).exec("CREATE TABLE a (x TEXT)");
    store.open(other).exec("CREATE TABLE b (x TEXT)");
    store.closeAll();

    const files = fs
      .readdirSync(root, { recursive: true, encoding: "utf-8" })
      .filter((entry) => entry.endsWith(".db"));
    expect(files).toHaveLength(2);
  });
});
