/**
 * Files a board keeps, as files.
 *
 * The third of the runtime's stores, beside `recordStore` (a record is JSON a
 * board wrote) and `database` (a row is JSON a board queries). What neither can
 * hold is a **byte stream that something outside the board will read**: an
 * audio file a podcast client streams, an image a page loads, an export
 * somebody downloads. Base64 inside a JSON record would keep those bytes, but
 * a third larger, unservable without decoding, and invisible to every tool a
 * person already has for files.
 *
 *     <root>/<sha256(owner)>/<volume>/<path>
 *
 * The owner is hashed and the rest is not, and the asymmetry is deliberate.
 * An owner comes from a token and may contain anything, so it is derived into
 * a path rather than used as one — the same reasoning as `recordStore`. A
 * volume and a path are written by a board, can therefore be *checked*, and are
 * worth keeping legible: the point of putting files on a disk rather than in a
 * record is that they can be found, copied, played and backed up by somebody
 * who is not this runtime.
 *
 * What is checked is narrow, because these names become a real path: a segment
 * is letters, digits, dot, dash and underscore, a leading dot is not a name,
 * and nothing resolves outside the volume it named. A board that gets it wrong
 * is told; nothing is silently rewritten into a path it did not ask for.
 *
 * A volume rather than one folder per board, for the reason `sql` grew a
 * `database` field: a board that renders audio and a board that publishes it
 * are two boards over one library, and coupling them through a coincidence of
 * titles is not a contract. Unnamed, the volume is the board's own title, which
 * is what a board that never mentions one wants.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { RuntimeScope } from "../types";

/** What a listing says about one file, and what a read says about the one read. */
export type FileInfo = {
  /** Path within the volume, always with "/" separators. */
  path: string;
  size: number;
  /** Last written, ISO 8601. */
  modified: string;
  /** Guessed from the extension; what an HTTP answer would declare. */
  contentType: string;
};

export type FileStore = {
  /** The bytes and what is known about them, or null when there is no such file. */
  read(scope: FileScope, filePath: string): Promise<{ info: FileInfo; bytes: Uint8Array } | null>;
  write(scope: FileScope, filePath: string, bytes: Uint8Array): Promise<FileInfo>;
  /** Every file under a prefix, by path. */
  list(scope: FileScope, prefix?: string): Promise<FileInfo[]>;
  /** What a listing would say about one file, without reading it. */
  stat(scope: FileScope, filePath: string): Promise<FileInfo | null>;
  /** True when there was something to delete. */
  remove(scope: FileScope, filePath: string): Promise<boolean>;
};

/**
 * Which library a call means: the tenant, which comes from the runtime, and the
 * volume, which is the one part a board chooses.
 */
export type FileScope = RuntimeScope & { volume?: string };

/** Extensions worth naming; anything else is bytes nobody claimed to understand. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".rss": "application/rss+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** One path segment a board may write, or nothing. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A board-chosen volume name, or an explanation of why it is not one.
 *
 * The same shape `checkDatabaseName` accepts, and for the same reason: it
 * becomes a directory, so anything that could mean a parent, a root or a hidden
 * name is not a name.
 */
export function checkVolumeName(name: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
    ? null
    : `'${name}' is not a volume name: use 1-64 characters from A-Z, a-z, 0-9, - and _`;
}

/**
 * A path within a volume, normalised, or an explanation of why it is not one.
 *
 * Returned with "/" separators whatever the platform writes, because this
 * string is what a board stores and what a URL repeats: it must mean the same
 * file on the machine that wrote it and the one that later serves it.
 */
export function checkFilePath(filePath: string): { path: string } | { error: string } {
  const raw = String(filePath ?? "").trim();
  if (!raw) {
    return { error: "a file path is required" };
  }
  if (raw.length > 512) {
    return { error: "a file path may be at most 512 characters" };
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (!segments.length) {
    return { error: `'${raw}' names no file` };
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      return {
        error: `'${segment}' is not a path segment: use letters, digits, '.', '-' and '_', and do not begin with '.'`,
      };
    }
  }
  return { path: segments.join("/") };
}

function hashed(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The volume a scope names, checked. Throws, because a bad name is a board bug. */
function volumeOf(scope: FileScope): string {
  const named = scope.volume?.trim();
  if (named) {
    const problem = checkVolumeName(named);
    if (problem) {
      throw new Error(problem);
    }
    return named;
  }
  // Unnamed volumes are the board's own, and a board title is not a directory
  // name — so this one is derived, the way an unnamed database's file is.
  return hashed(scope.boardName).slice(0, 32);
}

function infoOf(filePath: string, size: number, modifiedMs: number): FileInfo {
  return {
    path: filePath,
    size,
    modified: new Date(modifiedMs).toISOString(),
    contentType: contentTypeFor(filePath),
  };
}

/**
 * Files under a directory the runtime owns.
 *
 * Directories are `0o700` and files `0o600`: what a board keeps is the owner's
 * to read. Serving one to the world is a decision a board makes by putting an
 * endpoint in front of it, not something the file mode grants in advance.
 */
export function createDiskFileStore(root: string): FileStore {
  const volumeDir = (scope: FileScope) =>
    path.join(root, hashed(scope.owner), volumeOf(scope));

  /**
   * The absolute path a request names.
   *
   * Checked twice — the segments by hand, then the resolved path against the
   * volume it must stay inside — because the check that matters is the one made
   * against what the filesystem will actually open. A symlink inside the volume
   * is the case the first check cannot see.
   */
  const resolve = (scope: FileScope, filePath: string): string => {
    const checked = checkFilePath(filePath);
    if ("error" in checked) {
      throw new Error(checked.error);
    }
    const dir = volumeDir(scope);
    const full = path.resolve(dir, checked.path);
    if (full !== dir && !full.startsWith(dir + path.sep)) {
      throw new Error(`'${filePath}' resolves outside its volume`);
    }
    return full;
  };

  const walk = async (dir: string, prefix: string): Promise<FileInfo[]> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // A volume nothing has written to yet is empty, not broken.
      return [];
    }
    const found: FileInfo[] = [];
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        found.push(...(await walk(path.join(dir, entry.name), relative)));
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".tmp")) {
        continue;
      }
      const stats = await fs.stat(path.join(dir, entry.name));
      found.push(infoOf(relative, stats.size, stats.mtimeMs));
    }
    return found;
  };

  return {
    async read(scope, filePath) {
      const full = resolve(scope, filePath);
      try {
        const [bytes, stats] = await Promise.all([fs.readFile(full), fs.stat(full)]);
        const checked = checkFilePath(filePath) as { path: string };
        return {
          info: infoOf(checked.path, stats.size, stats.mtimeMs),
          bytes: new Uint8Array(bytes),
        };
      } catch {
        return null;
      }
    },

    async write(scope, filePath, bytes) {
      const full = resolve(scope, filePath);
      await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      // Written beside the target and renamed into place: a rename within one
      // directory is atomic, so a reader mid-write sees the old file whole
      // rather than the new one in part. Something is streaming these.
      const temporary = `${full}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      try {
        await fs.rename(temporary, full);
      } catch (err) {
        await fs.rm(temporary, { force: true });
        throw err;
      }
      const stats = await fs.stat(full);
      const checked = checkFilePath(filePath) as { path: string };
      return infoOf(checked.path, stats.size, stats.mtimeMs);
    },

    async list(scope, prefix) {
      const dir = volumeDir(scope);
      const files = await walk(dir, "");
      const wanted = prefix?.replace(/^\/+|\/+$/g, "");
      const matching = wanted
        ? files.filter(
            (file) => file.path === wanted || file.path.startsWith(`${wanted}/`),
          )
        : files;
      return matching.sort((a, b) => a.path.localeCompare(b.path));
    },

    async stat(scope, filePath) {
      const full = resolve(scope, filePath);
      try {
        const stats = await fs.stat(full);
        if (!stats.isFile()) {
          return null;
        }
        const checked = checkFilePath(filePath) as { path: string };
        return infoOf(checked.path, stats.size, stats.mtimeMs);
      } catch {
        return null;
      }
    },

    async remove(scope, filePath) {
      const full = resolve(scope, filePath);
      try {
        await fs.unlink(full);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The same library, kept in memory.
 *
 * What a server started without a files directory gets, and what tests use. A
 * board behaves the same against it; nothing survives a restart.
 */
export function createMemoryFileStore(): FileStore {
  const volumes = new Map<string, Map<string, { bytes: Uint8Array; modified: number }>>();

  const volumeKey = (scope: FileScope) =>
    JSON.stringify([scope.owner, volumeOf(scope)]);

  const filesOf = (scope: FileScope) => {
    const key = volumeKey(scope);
    const existing = volumes.get(key);
    if (existing) {
      return existing;
    }
    const created = new Map<string, { bytes: Uint8Array; modified: number }>();
    volumes.set(key, created);
    return created;
  };

  const normalise = (filePath: string): string => {
    const checked = checkFilePath(filePath);
    if ("error" in checked) {
      throw new Error(checked.error);
    }
    return checked.path;
  };

  return {
    async read(scope, filePath) {
      const key = normalise(filePath);
      const held = filesOf(scope).get(key);
      return held
        ? { info: infoOf(key, held.bytes.length, held.modified), bytes: held.bytes }
        : null;
    },

    async write(scope, filePath, bytes) {
      const key = normalise(filePath);
      const modified = Date.now();
      filesOf(scope).set(key, { bytes, modified });
      return infoOf(key, bytes.length, modified);
    },

    async list(scope, prefix) {
      const wanted = prefix?.replace(/^\/+|\/+$/g, "");
      return [...filesOf(scope).entries()]
        .filter(
          ([key]) =>
            !wanted || key === wanted || key.startsWith(`${wanted}/`),
        )
        .map(([key, held]) => infoOf(key, held.bytes.length, held.modified))
        .sort((a, b) => a.path.localeCompare(b.path));
    },

    async stat(scope, filePath) {
      const key = normalise(filePath);
      const held = filesOf(scope).get(key);
      return held ? infoOf(key, held.bytes.length, held.modified) : null;
    },

    async remove(scope, filePath) {
      return filesOf(scope).delete(normalise(filePath));
    },
  };
}
