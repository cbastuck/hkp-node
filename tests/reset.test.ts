import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { Instance, resolveInstance } from "../src/instance";
import { describeReset, resetInstance, resetStamp } from "../src/reset";

/**
 * Resetting an instance: its folder moved aside, so the next start is empty.
 *
 * Moved rather than deleted, and named for when — the stale state is what is
 * worth looking at afterwards. The mount secret comes back unless asked not
 * to, and a running server is never reset from under.
 */

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-reset-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const NOW = new Date(2026, 9, 17, 9, 12);

/** An instance that has run: data, a deployed board, a ticket, a secret. */
function usedInstance(): Instance {
  const instance = resolveInstance("dev", tempHome());
  const write = (relative: string, content: string) => {
    const file = path.join(instance.dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("db/owner/meetings.db", "tables");
  write("db/owner/shared.db", "tables");
  write("coordinator/boards/owner/poll.json", "{}");
  write("coordinator-links.json", "[]");
  write("mount-secret", "secret\n");
  return instance;
}

describe("a reset", () => {
  it("only says what it would move, unless told to", () => {
    const instance = usedInstance();
    const outcome = resetInstance(instance, { now: NOW });

    expect(outcome.applied).toBe(false);
    expect(outcome.entries).toEqual([
      { name: "coordinator", files: 1 },
      { name: "coordinator-links.json", files: 1 },
      { name: "db", files: 2 },
      { name: "mount-secret", files: 1 },
    ]);
    expect(outcome.movedTo).toBe(`${instance.dir}.reset-2026-10-17T09-12`);
    expect(fs.existsSync(path.join(instance.dir, "db"))).toBe(true);
    expect(fs.existsSync(outcome.movedTo)).toBe(false);
    expect(fs.existsSync(path.join(instance.dir, "instance.lock"))).toBe(false);
    expect(describeReset(instance, outcome)).toMatch(/Run again with --yes/);
  });

  it("moves the folder aside, named for when, and keeps the mount secret", () => {
    const instance = usedInstance();
    const outcome = resetInstance(instance, { apply: true, now: NOW });

    expect(outcome.applied).toBe(true);
    const moved = `${instance.dir}.reset-2026-10-17T09-12`;
    expect(fs.readFileSync(path.join(moved, "db/owner/meetings.db"), "utf8")).toBe(
      "tables",
    );
    expect(fs.existsSync(path.join(moved, "instance.lock"))).toBe(false);
    // What is left is a fresh instance that keeps its endpoint addresses.
    expect(fs.readdirSync(instance.dir)).toEqual(["mount-secret"]);
    expect(fs.readFileSync(path.join(instance.dir, "mount-secret"), "utf8")).toBe(
      "secret\n",
    );
  });

  it("leaves the mount secret behind too, when asked", () => {
    const instance = usedInstance();
    resetInstance(instance, { apply: true, includeMountSecret: true, now: NOW });
    expect(fs.existsSync(instance.dir)).toBe(false);
    expect(
      fs.existsSync(
        path.join(`${instance.dir}.reset-2026-10-17T09-12`, "mount-secret"),
      ),
    ).toBe(true);
  });

  it("does not overwrite an earlier reset from the same minute", () => {
    const instance = usedInstance();
    resetInstance(instance, { apply: true, includeMountSecret: true, now: NOW });
    fs.mkdirSync(path.join(instance.dir, "db"), { recursive: true });
    fs.writeFileSync(path.join(instance.dir, "db", "x.db"), "again");

    const second = resetInstance(instance, { apply: true, now: NOW });
    expect(second.movedTo).toBe(`${instance.dir}.reset-2026-10-17T09-12-2`);
    expect(
      fs.existsSync(path.join(`${instance.dir}.reset-2026-10-17T09-12`, "db/owner")),
    ).toBe(true);
  });

  it("finds nothing to do for an instance that has kept nothing", () => {
    const instance = resolveInstance("never-ran", tempHome());
    const outcome = resetInstance(instance, { apply: true, now: NOW });
    expect(outcome.empty).toBe(true);
    expect(fs.existsSync(instance.dir)).toBe(false);
    expect(describeReset(instance, outcome)).toMatch(/Nothing to reset/);
  });

  it("refuses while a server runs as the instance", () => {
    const instance = usedInstance();
    // The process that started this one is certainly running, and is not it.
    fs.writeFileSync(
      path.join(instance.dir, "instance.lock"),
      JSON.stringify({ pid: process.ppid, port: 8080 }),
    );
    expect(() => resetInstance(instance, { apply: true, now: NOW })).toThrow(
      /instance "dev" is running \(pid \d+ on port 8080\)\. Stop it before resetting it/,
    );
    expect(fs.existsSync(path.join(instance.dir, "db"))).toBe(true);
  });

  it("names the moved folder in local time, to the minute", () => {
    expect(resetStamp(new Date(2026, 0, 5, 7, 3))).toBe("2026-01-05T07-03");
  });
});

describe("hkp-node reset", () => {
  const TSX = path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const ENTRY = path.join(__dirname, "..", "src", "index.ts");

  function run(home: string, args: string[], instance?: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      SKIP_LOADING_ENV: "true",
    };
    delete env.HKP_INSTANCE;
    if (instance) {
      env.HKP_INSTANCE = instance;
    }
    const result = spawnSync(process.execPath, [TSX, ENTRY, "reset", ...args], {
      env,
      encoding: "utf8",
    });
    return { code: result.status, output: result.stdout + result.stderr };
  }

  it("resets the instance the environment names, and only on --yes", () => {
    const home = tempHome();
    const dir = path.join(home, ".hkp", "node-dev");
    fs.mkdirSync(path.join(dir, "db"), { recursive: true });
    fs.writeFileSync(path.join(dir, "db", "x.db"), "tables");
    const other = path.join(home, ".hkp", "node-public", "db");
    fs.mkdirSync(other, { recursive: true });

    const dry = run(home, [], "dev");
    expect(dry.code).toBe(0);
    expect(dry.output).toMatch(/would move/);
    expect(fs.existsSync(path.join(dir, "db"))).toBe(true);

    const applied = run(home, ["--yes"], "dev");
    expect(applied.code).toBe(0);
    expect(applied.output).toMatch(/Reset instance "dev"/);
    expect(fs.existsSync(path.join(dir, "db"))).toBe(false);
    // Another instance is another server's, and untouched.
    expect(fs.existsSync(other)).toBe(true);
  }, 30_000);

  it("refuses without an instance, and on what it does not know", () => {
    const home = tempHome();
    expect(run(home, ["--yes"]).output).toMatch(/HKP_INSTANCE is not set/);
    const unknown = run(home, ["--force"], "dev");
    expect(unknown.code).toBe(1);
    expect(unknown.output).toMatch(/does not know --force/);
  }, 30_000);
});
