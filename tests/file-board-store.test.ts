import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileBoardStore } from "../src/coordinator/fileBoardStore";
import { PersistedBoard } from "../src/coordinator/boardStore";
import { CloudBoardConfig } from "../src/coordinator/types";

/**
 * Boards on disk.
 *
 * The paths are derived from hashes rather than from the names themselves,
 * because both names arrive from the wire. The tests that matter here are the
 * ones about what a hostile or merely awkward name cannot do.
 */

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function freshRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-boards-"));
  roots.push(root);
  return root;
}

function board(
  boardName: string,
  overrides: Partial<PersistedBoard> = {},
): PersistedBoard {
  return {
    userId: "auth0|user-1",
    boardName,
    createdAt: "2026-01-01T00:00:00.000Z",
    config: {
      boardName,
      runtimes: [{ id: "node", name: "Node", type: "rest", url: "http://x" }],
      services: { node: [{ uuid: "mon-1", serviceId: "monitor" }] },
    } as CloudBoardConfig,
    ...overrides,
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of await fs.readdir(root)) {
    for (const entry of await fs.readdir(path.join(root, dir))) {
      found.push(path.join(dir, entry));
    }
  }
  return found;
}

describe("keeping a board", () => {
  it("reads back what was written", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("doorbell"));

    expect(await store.load()).toEqual([board("doorbell")]);
  });

  it("replaces the board of the same name rather than adding another", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("doorbell"));
    await store.save(board("doorbell", { createdAt: "2026-02-02T00:00:00.000Z" }));

    const held = await store.load();
    expect(held).toHaveLength(1);
    expect(held[0].createdAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("keeps one user's boards apart from another's", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("doorbell"));
    await store.save(board("doorbell", { userId: "auth0|user-2" }));

    const owners = (await store.load()).map((b) => b.userId).sort();
    expect(owners).toEqual(["auth0|user-1", "auth0|user-2"]);
  });

  it("leaves nothing half-written behind", async () => {
    // Every file that survives a save is a finished one; the temporary is
    // renamed into place, not left for the next load to trip over.
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("doorbell"));

    const files = await filesUnder(root);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(".json")).toBe(true);
  });

  it("keeps the files to the owner", async () => {
    // A board config carries service state, which can carry credentials.
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("doorbell"));

    const [relative] = await filesUnder(root);
    const file = await fs.stat(path.join(root, relative));
    const dir = await fs.stat(path.dirname(path.join(root, relative)));
    expect(file.mode & 0o777).toBe(0o600);
    expect(dir.mode & 0o777).toBe(0o700);
  });
});

describe("a board name that is not a name", () => {
  it("cannot write outside the root", async () => {
    // The name comes straight off the wire. Used as a path it would climb out;
    // hashed, it is just another file.
    const root = await freshRoot();
    const outside = path.join(root, "..", "escaped.json");
    const store = createFileBoardStore(root);

    await store.save(board("../escaped"));

    await expect(fs.stat(outside)).rejects.toThrow();
    expect(await filesUnder(root)).toHaveLength(1);
    expect((await store.load())[0].boardName).toBe("../escaped");
  });

  it("survives separators and dots intact", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("a/b/../c"));

    expect((await store.load())[0].boardName).toBe("a/b/../c");
  });

  it("keeps names that differ only in case as different boards", async () => {
    // macOS is case-insensitive: two boards the coordinator holds apart would
    // otherwise share one file, and the second would silently eat the first.
    const root = await freshRoot();
    const store = createFileBoardStore(root);

    await store.save(board("Doorbell"));
    await store.save(board("doorbell"));

    const names = (await store.load()).map((b) => b.boardName).sort();
    expect(names).toEqual(["Doorbell", "doorbell"]);
  });
});

describe("what a load can survive", () => {
  it("returns nothing at all when the directory has never been written", async () => {
    const store = createFileBoardStore(path.join(await freshRoot(), "nope"));
    expect(await store.load()).toEqual([]);
  });

  it("skips a corrupt file and still returns the good ones", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);
    await store.save(board("doorbell"));
    const [dir] = await fs.readdir(root);
    await fs.writeFile(path.join(root, dir, "broken.json"), "{not json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const held = await store.load();

    expect(held.map((b) => b.boardName)).toEqual(["doorbell"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("skips a file written by a newer coordinator", async () => {
    // Reading it as if it were this version could hand a board back in a shape
    // it never had. Leaving it be keeps it whole for whoever wrote it.
    const root = await freshRoot();
    const store = createFileBoardStore(root);
    await store.save(board("doorbell"));
    const [dir] = await fs.readdir(root);
    const [file] = await fs.readdir(path.join(root, dir));
    const written = JSON.parse(
      await fs.readFile(path.join(root, dir, file), "utf8"),
    );
    await fs.writeFile(
      path.join(root, dir, file),
      JSON.stringify({ ...written, version: 99 }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await store.load()).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("ignores anything that is not a finished board file", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);
    await store.save(board("doorbell"));
    const [dir] = await fs.readdir(root);
    await fs.writeFile(path.join(root, dir, "half-written.tmp"), "{");

    expect((await store.load()).map((b) => b.boardName)).toEqual(["doorbell"]);
  });
});

describe("deleting a board", () => {
  it("removes its file", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);
    await store.save(board("doorbell"));

    await store.remove("auth0|user-1", "doorbell");

    expect(await store.load()).toEqual([]);
  });

  it("is content when there was nothing to remove", async () => {
    const store = createFileBoardStore(await freshRoot());
    await expect(
      store.remove("auth0|user-1", "never-existed"),
    ).resolves.toBeUndefined();
  });

  it("leaves the owner's other boards alone", async () => {
    const root = await freshRoot();
    const store = createFileBoardStore(root);
    await store.save(board("doorbell"));
    await store.save(board("chime"));

    await store.remove("auth0|user-1", "doorbell");

    expect((await store.load()).map((b) => b.boardName)).toEqual(["chime"]);
  });
});
