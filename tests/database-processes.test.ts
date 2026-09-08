import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileDatabaseStore } from "../src/services/database";

/**
 * Two runtime servers, one file.
 *
 * A board split into units may put them on two hkp-node instances, and on one
 * machine those share a filesystem — so a database both units name is a
 * database both processes open. That cannot be observed from inside one
 * process, so this spawns real ones.
 *
 * The pragmas are what make it work rather than merely appear to: without
 * `busy_timeout`, concurrent writers lose most of their statements to
 * "database is locked", and the loss is silent unless something checks.
 */

const run = promisify(execFile);
const WORKER = path.join(__dirname, "database-processes.ts");
const TSX = path.join(__dirname, "..", "node_modules", ".bin", "tsx");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-db-procs-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writer(tag: string, writes: number) {
  return run(TSX, [WORKER, root, "tester", "shared-by-two", tag, String(writes)]);
}

describe("two processes over one named database", () => {
  it("loses nothing when both write at once", async () => {
    const [a, b] = await Promise.all([writer("a", 200), writer("b", 200)]);

    expect(JSON.parse(a.stdout)).toEqual({ tag: "a", written: 200, failed: 0 });
    expect(JSON.parse(b.stdout)).toEqual({ tag: "b", written: 200, failed: 0 });

    // And a third process sees every row both of them wrote.
    const store = createFileDatabaseStore(root);
    const rows = store.openNamed("tester", "shared-by-two").query(
      "SELECT who, count(*) AS n FROM message GROUP BY who ORDER BY who",
    );
    store.closeAll();
    expect(rows).toEqual([
      { who: "a", n: 200 },
      { who: "b", n: 200 },
    ]);
  }, 30_000);

  it("survives both processes creating the file at the same instant", async () => {
    // Converting a new database to WAL takes a lock no timeout covers, so one
    // of the two loses that race. Losing it is not a failure: the mode belongs
    // to the file, and the winner has already set it.
    const [a, b] = await Promise.all([writer("a", 20), writer("b", 20)]);

    expect(JSON.parse(a.stdout).failed).toBe(0);
    expect(JSON.parse(b.stdout).failed).toBe(0);
  }, 30_000);

  it("still keeps a database one process names out of another name", async () => {
    await writer("a", 10);

    const store = createFileDatabaseStore(root);
    const elsewhere = store.openNamed("tester", "somewhere-else");
    // Nothing shared but the directory: naming is what decides, not proximity.
    expect(() => elsewhere.query("SELECT * FROM message")).toThrow();
    store.closeAll();
  }, 30_000);
});
