import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { BoardStore, PersistedBoard } from "./boardStore";
import { CloudBoardConfig } from "./types";

/**
 * Boards kept as one JSON file each, under a directory this coordinator owns.
 *
 * ```
 * <root>/<sha256(userId)>/<sha256(boardName)>.json
 * ```
 *
 * The names in those paths are **derived, never used directly**. Both come from
 * the wire: a board name is whatever the client sent, and an Auth0 `sub`
 * contains characters (`|`) that have no business in a path. Hashing settles
 * two problems at once — a board called `../../etc/passwd` cannot escape the
 * root, and `Foo` and `foo`, which are two boards to the coordinator, cannot
 * become one file on a case-insensitive filesystem. The real names are inside.
 */

/** Bumped only when the shape on disk changes; an unknown one is left alone. */
const FORMAT_VERSION = 1;

type BoardFile = PersistedBoard & { version: number };

function fileNameFor(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isBoardFile(value: unknown): value is BoardFile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const board = value as Record<string, unknown>;
  return (
    typeof board.userId === "string" &&
    typeof board.boardName === "string" &&
    typeof board.createdAt === "string" &&
    !!board.config &&
    typeof board.config === "object"
  );
}

export function createFileBoardStore(root: string): BoardStore {
  const userDir = (userId: string) => path.join(root, fileNameFor(userId));
  const boardPath = (userId: string, boardName: string) =>
    path.join(userDir(userId), `${fileNameFor(boardName)}.json`);

  async function readBoard(file: string): Promise<PersistedBoard | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      // One unreadable board must not stop a coordinator from starting: the
      // others are still good, and the operator can see which one is not.
      console.error(
        `[coordinator] Ignoring unreadable board file ${file}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    if (!isBoardFile(parsed)) {
      console.error(`[coordinator] Ignoring malformed board file ${file}`);
      return null;
    }
    if (parsed.version !== FORMAT_VERSION) {
      // Written by a newer coordinator. Guessing at it could hand a board back
      // in a shape it never had; leaving it be keeps it intact for that one.
      console.error(
        `[coordinator] Ignoring board file ${file}: format version ${parsed.version}`,
      );
      return null;
    }
    const { userId, boardName, createdAt, config } = parsed;
    return {
      userId,
      boardName,
      createdAt,
      config: config as CloudBoardConfig,
    };
  }

  return {
    async load(): Promise<PersistedBoard[]> {
      let userDirs: string[];
      try {
        userDirs = await fs.readdir(root);
      } catch {
        // Nothing has been deployed yet — the directory appears on first save.
        return [];
      }
      const boards: PersistedBoard[] = [];
      for (const dir of userDirs) {
        let entries: string[];
        try {
          entries = await fs.readdir(path.join(root, dir));
        } catch {
          continue;
        }
        for (const entry of entries) {
          // Only finished files: a half-written one is still under its
          // temporary name, which does not end in .json.
          if (!entry.endsWith(".json")) {
            continue;
          }
          const board = await readBoard(path.join(root, dir, entry));
          if (board) {
            boards.push(board);
          }
        }
      }
      return boards;
    },

    async save(board: PersistedBoard): Promise<void> {
      const dir = userDir(board.userId);
      // A board config carries service state, which can carry credentials —
      // so this is the owner's to read, and nobody else's.
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = boardPath(board.userId, board.boardName);
      const contents: BoardFile = { version: FORMAT_VERSION, ...board };
      // Write beside the target, then rename: a rename within one directory is
      // atomic, so a crash mid-write leaves the previous board intact rather
      // than half of the new one.
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(contents, null, 2), {
        mode: 0o600,
      });
      try {
        await fs.rename(temporary, file);
      } catch (err) {
        await fs.rm(temporary, { force: true });
        throw err;
      }
    },

    async remove(userId: string, boardName: string): Promise<void> {
      // Already gone is the outcome asked for.
      await fs.rm(boardPath(userId, boardName), { force: true });
    },
  };
}
