import { ChildProcess, spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InstanceError,
  acquireInstanceLock,
  legacyState,
  resolveInstance,
} from "../src/instance";

/**
 * Every hkp-node is a named instance with a folder of its own.
 *
 * Two servers on one machine used to be one folder: each restored the other's
 * coordinator tickets and deployed boards, and neither said so. A name puts
 * each in its own, and a lock keeps a second server out of one already in use.
 */

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hkp-instance-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("an instance's name", () => {
  it("names the folder its state is kept in", () => {
    const home = tempHome();
    expect(resolveInstance("public", home)).toEqual({
      name: "public",
      dir: path.join(home, ".hkp", "node-public"),
    });
  });

  it("is required", () => {
    expect(() => resolveInstance(undefined)).toThrow(InstanceError);
    expect(() => resolveInstance("  ")).toThrow(/HKP_INSTANCE is not set/);
  });

  it("takes letters, digits, dot, dash and underscore", () => {
    for (const name of ["dev", "Club_2", "laptop.local", "-x", "a.b-c_d"]) {
      expect(resolveInstance(name, tempHome()).name).toBe(name);
    }
  });

  it("refuses anything that could name another folder", () => {
    for (const name of ["../x", "a/b", ".hidden", "..", "a b", "ä"]) {
      expect(() => resolveInstance(name)).toThrow(/not a name/);
    }
  });
});

describe("an instance's lock", () => {
  it("is taken for this process and given back", () => {
    const instance = resolveInstance("dev", tempHome());
    const release = acquireInstanceLock(instance, { port: 8080 });
    const file = path.join(instance.dir, "instance.lock");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      pid: process.pid,
      port: 8080,
    });
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps a second server out while the first runs", () => {
    const instance = resolveInstance("dev", tempHome());
    fs.mkdirSync(instance.dir, { recursive: true });
    // The process that started this one is certainly running, and is not it.
    fs.writeFileSync(
      path.join(instance.dir, "instance.lock"),
      JSON.stringify({ pid: process.ppid, port: 8080 }),
    );
    expect(() => acquireInstanceLock(instance)).toThrow(
      new RegExp(`already running \\(pid ${process.ppid} on port 8080\\)`),
    );
  });

  it("is taken over from a server that is gone", () => {
    const instance = resolveInstance("dev", tempHome());
    fs.mkdirSync(instance.dir, { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(
      path.join(instance.dir, "instance.lock"),
      JSON.stringify({ pid: gone }),
    );
    const release = acquireInstanceLock(instance);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(instance.dir, "instance.lock"), "utf8"),
      ).pid,
    ).toBe(process.pid);
    release();
  });
});

describe("state from before instances", () => {
  it("is found where every server used to keep it", () => {
    const home = tempHome();
    expect(legacyState(home)).toEqual([]);
    fs.mkdirSync(path.join(home, ".hkp", "node", "db"), { recursive: true });
    fs.mkdirSync(path.join(home, ".hkp", "coordinator", "boards"), {
      recursive: true,
    });
    expect(legacyState(home)).toEqual([
      path.join(home, ".hkp", "node", "db"),
      path.join(home, ".hkp", "coordinator"),
    ]);
  });
});

describe("starting a server", () => {
  const servers: ChildProcess[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.kill("SIGTERM");
    }
  });

  const TSX = path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const ENTRY = path.join(__dirname, "..", "src", "index.ts");

  function environment(home: string, instance?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      SKIP_LOADING_ENV: "true",
      HOST: "127.0.0.1",
      PORT: "0",
      AUTH0_DOMAIN: "",
      AUTH0_AUDIENCE: "",
      ALLOWED_EMAILS: "",
      HKP_MOUNT_SECRET: "test",
    };
    delete env.HKP_INSTANCE;
    if (instance) {
      env.HKP_INSTANCE = instance;
    }
    return env;
  }

  function start(home: string, instance?: string) {
    const child = spawn(process.execPath, [TSX, ENTRY], {
      env: environment(home, instance),
    });
    servers.push(child);
    let output = "";
    child.stdout.on("data", (bytes) => (output += bytes));
    child.stderr.on("data", (bytes) => (output += bytes));
    const listening = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => {
        if (output.includes("listening on")) {
          resolve();
        }
      });
      child.on("exit", () => reject(new Error(output)));
    });
    // Awaited only by the tests that expect it to come up.
    listening.catch(() => {});
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return { listening, exited, output: () => output };
  }

  it("refuses without a name", async () => {
    const server = start(tempHome());
    expect(await server.exited).toBe(1);
    expect(server.output()).toMatch(/HKP_INSTANCE is not set/);
  }, 30_000);

  it("keeps its state in its instance's folder", async () => {
    const home = tempHome();
    const server = start(home, "dev");
    await server.listening;
    expect(server.output()).toContain(path.join(home, ".hkp", "node-dev"));
    expect(
      fs.existsSync(path.join(home, ".hkp", "node-dev", "instance.lock")),
    ).toBe(true);
    expect(fs.existsSync(path.join(home, ".hkp", "node"))).toBe(false);
  }, 30_000);

  it("refuses to be an instance another server already is", async () => {
    const home = tempHome();
    const first = start(home, "dev");
    await first.listening;
    const second = start(home, "dev");
    expect(await second.exited).toBe(1);
    expect(second.output()).toMatch(/instance "dev" is already running/);
  }, 30_000);
});
