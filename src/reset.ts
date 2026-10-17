/**
 * Forgetting everything one instance kept, for a fresh start.
 *
 * What a server restores on starting is easy to forget is there: a deployed
 * board, a ticket to a coordinator, a table with last month's schema. When it
 * is the cause of something, it is the last place anybody looks. Resetting
 * moves the instance's folder aside and lets the next start begin empty.
 *
 * Moved, not deleted. The stale file is often exactly what is worth looking at
 * once the problem is gone, so it is kept where it can be found:
 *
 *     ~/.hkp/node-<instance>.reset-2026-10-17T09-12/
 *
 * The name says how old it is and that nothing depends on it; deleting it is
 * whoever reset's to do.
 *
 * The mount secret is carried over unless asked otherwise: it is what keeps a
 * public endpoint's address the same, and a reset for debugging should not
 * break a webhook somebody configured elsewhere.
 */
import fs from "fs";
import path from "path";

import {
  Instance,
  InstanceInUseError,
  acquireInstanceLock,
} from "./instance";

const LOCK = "instance.lock";
const MOUNT_SECRET = "mount-secret";

export type ResetOptions = {
  /** Move the folder; without it, only say what would be moved. */
  apply?: boolean;
  /** Leave the mount secret behind as well, which changes every mount address. */
  includeMountSecret?: boolean;
  /** When the reset happens; what the moved folder is named after. */
  now?: Date;
};

export type ResetOutcome = {
  /** Nothing there: the instance has never run, or was reset already. */
  empty: boolean;
  /** What is in the folder: each top-level entry and how many files it holds. */
  entries: Array<{ name: string; files: number }>;
  /** Where the folder goes, or went. */
  movedTo: string;
  /** Whether the mount secret is carried over into the fresh folder. */
  keepsMountSecret: boolean;
  applied: boolean;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-17T09-12`, in local time: when a person reset it, as they'd say it. */
export function resetStamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}`
  );
}

/** Where the folder goes: a name not yet taken, should two resets share a minute. */
function destination(instance: Instance, now: Date): string {
  const base = `${instance.dir}.reset-${resetStamp(now)}`;
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function countFiles(location: string): number {
  const stat = fs.statSync(location);
  if (!stat.isDirectory()) {
    return 1;
  }
  return fs
    .readdirSync(location)
    .reduce((sum, entry) => sum + countFiles(path.join(location, entry)), 0);
}

/**
 * Resets `instance`, or with `apply` unset, says what resetting it would do.
 *
 * Refuses — with the lock's own message — while a server runs as the
 * instance: it holds the same state in memory and would write it back. And
 * holds the lock itself while it works, so no server starts halfway through.
 */
export function resetInstance(
  instance: Instance,
  options: ResetOptions = {},
): ResetOutcome {
  const now = options.now ?? new Date();
  const keepsMountSecret = !options.includeMountSecret;
  const movedTo = destination(instance, now);

  const names = fs.existsSync(instance.dir)
    ? fs.readdirSync(instance.dir).filter((name) => name !== LOCK)
    : [];
  const entries = names.sort().map((name) => ({
    name,
    files: countFiles(path.join(instance.dir, name)),
  }));
  const outcome: ResetOutcome = {
    empty: entries.length === 0,
    entries,
    movedTo,
    keepsMountSecret,
    applied: false,
  };
  if (outcome.empty) {
    return outcome;
  }

  // Taken in a dry run too: being told what would be moved from under a
  // running server is being told something that would not happen.
  let release: () => void;
  try {
    release = acquireInstanceLock(instance);
  } catch (error) {
    if (error instanceof InstanceInUseError) {
      const where = error.port ? ` on port ${error.port}` : "";
      throw new InstanceInUseError(
        `hkp-node instance "${instance.name}" is running (pid ${error.pid}` +
          `${where}). Stop it before resetting it: it holds the same state ` +
          "and would write it back.",
        error.pid,
        error.port,
      );
    }
    throw error;
  }
  if (!options.apply) {
    release();
    return outcome;
  }

  fs.renameSync(instance.dir, movedTo);
  // The lock went along with the folder; it was this process's and is done.
  fs.rmSync(path.join(movedTo, LOCK), { force: true });

  const secret = path.join(movedTo, MOUNT_SECRET);
  if (keepsMountSecret && fs.existsSync(secret)) {
    fs.mkdirSync(instance.dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(secret, path.join(instance.dir, MOUNT_SECRET));
    fs.chmodSync(path.join(instance.dir, MOUNT_SECRET), 0o600);
  }
  return { ...outcome, applied: true };
}

/** What a reset run from the command line prints, from what it did. */
export function describeReset(
  instance: Instance,
  outcome: ResetOutcome,
): string {
  if (outcome.empty) {
    return `Nothing to reset: ${instance.dir} holds nothing.`;
  }
  const lines = outcome.entries.map(
    ({ name, files }) =>
      `  ${name}${name === MOUNT_SECRET && outcome.keepsMountSecret ? " (copied back)" : ""}` +
      `  — ${files} file${files === 1 ? "" : "s"}`,
  );
  const secret = outcome.keepsMountSecret
    ? "The mount secret is copied back, so public endpoint addresses stay the same."
    : "The mount secret goes too: every public endpoint address will change.";
  if (!outcome.applied) {
    return [
      `Resetting instance "${instance.name}" would move ${instance.dir}`,
      ...lines,
      `to ${outcome.movedTo}.`,
      secret,
      "Nothing has been changed. Run again with --yes to reset.",
    ].join("\n");
  }
  return [
    `Reset instance "${instance.name}": moved ${instance.dir}`,
    ...lines,
    `to ${outcome.movedTo}.`,
    secret,
    "Nothing depends on the moved folder; delete it once it is of no more use.",
  ].join("\n");
}
