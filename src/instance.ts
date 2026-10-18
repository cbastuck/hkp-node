/**
 * Which hkp-node this is, and the folder it keeps its state in.
 *
 * Every server is an **instance** with a name, and everything it keeps between
 * runs lives in one folder named after it:
 *
 *     ~/.hkp/node-<instance>/
 *
 * Named rather than derived — from the port, say — because a port changes and
 * the state does not: today's `npm run dev` and tomorrow's are the same server
 * when they say the same name. And named by whoever runs it, because two
 * servers on one machine are otherwise one folder: each restores the other's
 * coordinator tickets and deployed boards, and neither says so.
 *
 * Two servers may not be one instance at the same time. Their state is not
 * shareable — tickets, deployed boards — so the second is refused while the
 * first holds the folder's lock, rather than left to overwrite it.
 */
import fs from "fs";
import os from "os";
import path from "path";

/**
 * What an instance may be called: letters, digits, dot, dash and underscore,
 * not starting with a dot. The name becomes a folder, so anything that could
 * address another one — a slash, `..` — is refused rather than rewritten.
 */
const INSTANCE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export type Instance = {
  name: string;
  /** The folder this instance keeps everything in. */
  dir: string;
};

/** Why a server cannot start as the instance it was given. */
export class InstanceError extends Error {}

/** The instance is held by a server that is running: which, and where. */
export class InstanceInUseError extends InstanceError {
  constructor(
    message: string,
    readonly pid: number,
    readonly port?: number,
  ) {
    super(message);
  }
}

/** The instance `name` names, under `home`; throws why it cannot be one. */
export function resolveInstance(
  name: string | undefined,
  home: string = os.homedir(),
): Instance {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new InstanceError(
      "HKP_INSTANCE is not set. Every hkp-node is a named instance and keeps " +
        "its state in ~/.hkp/node-<instance>/, so two servers on one machine " +
        "do not share it. Set HKP_INSTANCE — in .env, or the environment — to " +
        "a name of letters, digits, '.', '-' or '_', e.g. HKP_INSTANCE=dev.",
    );
  }
  if (!INSTANCE_NAME.test(trimmed)) {
    throw new InstanceError(
      `HKP_INSTANCE "${trimmed}" is not a name this server can use: it may ` +
        "contain only letters, digits, '.', '-' and '_', and may not start " +
        "with a dot.",
    );
  }
  return {
    name: trimmed,
    dir: path.join(home, ".hkp", `node-${trimmed}`),
  };
}

/** What the lock says about the process holding it. */
type LockHolder = {
  pid: number;
  port?: number;
  startedAt?: string;
};

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is somebody else's.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof holder?.pid === "number" ? holder : null;
  } catch {
    return null;
  }
}

/**
 * Takes the instance's folder for this process, and returns how to give it
 * back.
 *
 * A lock left by a process that is gone — killed, crashed — is taken over:
 * holding a folder is not something a dead server should go on doing.
 */
export function acquireInstanceLock(
  instance: Instance,
  details: { port?: number } = {},
): () => void {
  fs.mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
  const file = path.join(instance.dir, "instance.lock");
  const holder: LockHolder = {
    pid: process.pid,
    port: details.port,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(holder)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return () => {
        // Only this process's own lock: one taken over after this process was
        // thought gone is not this process's to remove.
        if (readHolder(file)?.pid === process.pid) {
          fs.rmSync(file, { force: true });
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const existing = readHolder(file);
    if (existing && existing.pid !== process.pid && isRunning(existing.pid)) {
      const where = existing.port ? ` on port ${existing.port}` : "";
      throw new InstanceInUseError(
        `hkp-node instance "${instance.name}" is already running ` +
          `(pid ${existing.pid}${where}). Two servers cannot be one instance — ` +
          "give this one another HKP_INSTANCE. If no such server is running, " +
          `remove ${file}.`,
        existing.pid,
        existing.port,
      );
    }
    fs.rmSync(file, { force: true });
  }
  throw new InstanceError(`Could not take ${file}.`);
}

/**
 * What servers from before instances left in the folders every hkp-node
 * shared. None of it is read any more; it is listed so that it is not
 * mistaken for gone, nor left lying around unnoticed.
 */
export function legacyState(home: string = os.homedir()): string[] {
  const shared = path.join(home, ".hkp", "node");
  return [
    path.join(shared, "store"),
    path.join(shared, "db"),
    path.join(shared, "files"),
    path.join(shared, "coordinator-links.json"),
    path.join(shared, "mount-secret"),
    path.join(home, ".hkp", "coordinator"),
  ].filter((location) => fs.existsSync(location));
}
