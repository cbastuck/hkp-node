import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileRecordStore,
  createMemoryRecordStore,
  RecordStore,
} from "../src/services/recordStore";
import { StoreService } from "../src/services/store";
import { RuntimeHost, RuntimeScope } from "../src/types";

/**
 * What a board remembers, and whose it is.
 *
 * The service half and the disk half are tested against the same expectations,
 * because a board should not be able to tell which one it is talking to.
 */

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function fileStore(): Promise<{ root: string; store: RecordStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-store-"));
  roots.push(root);
  return { root, store: createFileRecordStore(root) };
}

const BOARD: RuntimeScope = { owner: "auth0|alice", boardName: "Offers" };

/** A host that answers for one board, the way a runtime does. */
function hostFor(scope: RuntimeScope) {
  const pushed: unknown[] = [];
  const emitted: unknown[] = [];
  const host: RuntimeHost = {
    processFrom: (_uuid, data) => {
      pushed.push(data);
      return data;
    },
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => scope,
    emitResult: (output) => {
      emitted.push(output);
    },
  };
  return { host, pushed, emitted };
}

function serviceOn(
  store: RecordStore,
  state: Record<string, unknown>,
  scope: RuntimeScope = BOARD,
) {
  const { host, pushed, emitted } = hostFor(scope);
  const service = new StoreService(
    { uuid: "store-1", serviceId: "store", state } as any,
    store,
  );
  service.setHost(host);
  const notifications: unknown[] = [];
  return {
    service,
    pushed,
    emitted,
    notifications,
    notify: (payload: unknown) => notifications.push(payload),
  };
}

/** Resolves once something lands in `sink`, or throws. */
async function settled(sink: unknown[]): Promise<any> {
  const deadline = Date.now() + 2000;
  while (sink.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("nothing arrived");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sink[0];
}

/** Runs one pass and hands back what it pushed on, waiting for the disk. */
async function pass(
  t: ReturnType<typeof serviceOn>,
  input: unknown,
): Promise<any> {
  t.service.process(input, t.notify);
  return settled(t.pushed);
}

/** Runs a pass expected to pass nothing on, and confirms nothing did. */
async function quietPass(
  t: ReturnType<typeof serviceOn>,
  input: unknown,
): Promise<void> {
  t.service.process(input, t.notify);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(t.pushed).toEqual([]);
}

describe("store keeping", () => {
  it("hands back the record it wrote", async () => {
    const { store } = await fileStore();
    const t = serviceOn(store, { mode: "put", key: "enquiry-1" });

    const record = await pass(t, { hotel: "Adlon", rooms: 25 });

    expect(record.key).toBe("enquiry-1");
    expect(record.value).toEqual({ hotel: "Adlon", rooms: 25 });
    expect(record.createdAt).toBeTruthy();
  });

  it("survives the process that wrote it", async () => {
    // The whole point: a board that is restarted still knows what it knew.
    const { root, store } = await fileStore();
    await pass(serviceOn(store, { mode: "put", key: "k" }), { kept: true });

    const reopened = createFileRecordStore(root);
    const found = await pass(
      serviceOn(reopened, { mode: "get", key: "k" }),
      undefined,
    );

    expect(found.value).toEqual({ kept: true });
  });

  it("keeps when a record first arrived across an overwrite", async () => {
    // A queue is ordered by arrival, so re-reading or annotating a record must
    // not move it to the back of one.
    const { store } = await fileStore();
    await store.put(BOARD, "k", { status: "new" });
    const first = await store.get(BOARD, "k");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.put(BOARD, "k", { status: "processed" });
    const second = await store.get(BOARD, "k");

    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt).not.toBe(first!.updatedAt);
  });

  it("names a record itself when the board does not", async () => {
    // The cheap-dump case: things arrive, nobody has a name for them, and the
    // order they arrived in is what matters.
    const { store } = await fileStore();
    const t = serviceOn(store, { mode: "put" });

    await pass(t, { first: true });
    const listed = await pass(serviceOn(store, { mode: "list" }), undefined);

    expect(listed.count).toBe(1);
    expect(listed.records[0].key).toBeTruthy();
  });

  it("takes the key out of the record being stored", async () => {
    const { store } = await fileStore();
    const t = serviceOn(store, { mode: "put", keyFrom: "meta.messageId" });

    const record = await pass(t, {
      meta: { messageId: "<abc@mail>" },
      body: "hello",
    });

    expect(record.key).toBe("<abc@mail>");
    expect(record.value).toEqual({
      meta: { messageId: "<abc@mail>" },
      body: "hello",
    });
  });

  it("stores the part it was pointed at", async () => {
    const { store } = await fileStore();
    const t = serviceOn(store, {
      mode: "put",
      key: "k",
      valueFrom: "body",
    });

    const record = await pass(t, { meta: { status: 200 }, body: { rooms: 3 } });

    expect(record.value).toEqual({ rooms: 3 });
  });

  it("unwraps a record handed over as one", async () => {
    const { store } = await fileStore();
    const t = serviceOn(store, { mode: "put" });

    const record = await pass(t, { key: "k", value: { rooms: 3 } });

    expect(record.key).toBe("k");
    // The wrapper was how it was handed over, not what was meant to be kept.
    expect(record.value).toEqual({ rooms: 3 });
  });
});

describe("store reading", () => {
  it("stops the pipeline when the key is unknown", async () => {
    // The cache-miss signal: whatever follows is the "go and fetch it" path,
    // so it must not run with an empty answer.
    const { store } = await fileStore();
    const t = serviceOn(store, { mode: "get", key: "never-written" });

    await quietPass(t, undefined);
  });

  it("reads the key an upstream service produced", async () => {
    const { store } = await fileStore();
    await store.put(BOARD, "enquiry-7", { rooms: 3 });
    const t = serviceOn(store, { mode: "get" });

    const found = await pass(t, "enquiry-7");

    expect(found.value).toEqual({ rooms: 3 });
  });

  it("lists in the order records arrived", async () => {
    const { store } = await fileStore();
    for (const name of ["a", "b", "c"]) {
      await store.put(BOARD, name, { name });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const listed = await pass(serviceOn(store, { mode: "list" }), undefined);

    expect(listed.records.map((r: any) => r.key)).toEqual(["a", "b", "c"]);
    expect(listed.count).toBe(3);
  });

  it("takes the oldest first when a batch is limited", async () => {
    // A batch pass works through the queue from the front.
    const { store } = await fileStore();
    for (const name of ["a", "b", "c"]) {
      await store.put(BOARD, name, { name });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const listed = await pass(
      serviceOn(store, { mode: "list", limit: 2 }),
      undefined,
    );

    expect(listed.records.map((r: any) => r.key)).toEqual(["a", "b"]);
  });

  it("reads a board that has kept nothing as an empty table", async () => {
    const { store } = await fileStore();

    const listed = await pass(serviceOn(store, { mode: "list" }), undefined);

    expect(listed).toEqual({ records: [], count: 0 });
  });
});

describe("store removing", () => {
  it("says whether there was anything to delete", async () => {
    const { store } = await fileStore();
    await store.put(BOARD, "k", { v: 1 });
    const t = serviceOn(store, { mode: "delete", key: "k" });

    expect(await pass(t, undefined)).toEqual({ key: "k", deleted: true });

    const again = serviceOn(store, { mode: "delete", key: "k" });
    expect(await pass(again, undefined)).toEqual({ key: "k", deleted: false });
  });

  it("empties the board it belongs to", async () => {
    const { store } = await fileStore();
    await store.put(BOARD, "a", {});
    await store.put(BOARD, "b", {});

    const cleared = await pass(serviceOn(store, { mode: "clear" }), undefined);

    expect(cleared).toEqual({ cleared: 2 });
    expect(await store.list(BOARD)).toEqual([]);
  });
});

describe("store release", () => {
  /** Waits for the pushes a release produces, or gives up. */
  async function pushes(sink: unknown[], count: number): Promise<any[]> {
    const deadline = Date.now() + 2000;
    while (sink.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} pushes, saw ${sink.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return sink as any[];
  }

  it("lets the picked records through and leaves the rest", async () => {
    // The human checkpoint: the queue is what has *not* been dealt with.
    const { store } = await fileStore();
    for (const name of ["a", "b", "c"]) {
      await store.put(BOARD, name, { name });
    }
    const t = serviceOn(store, { mode: "release" });

    t.service.configure({ keys: ["a", "c"] });
    const pushed = await pushes(t.pushed, 2);

    expect(pushed.map((r) => r.key).sort()).toEqual(["a", "c"]);
    expect((await store.list(BOARD)).map((r) => r.key)).toEqual(["b"]);
  });

  it("hands over one record per pass, not a batch of them", async () => {
    // What follows an approval is per-item work — read this document, write
    // this row — and a board should not have to unpack a batch to do it.
    const { store } = await fileStore();
    await store.put(BOARD, "a", { rooms: 1 });
    await store.put(BOARD, "b", { rooms: 2 });
    const t = serviceOn(store, { mode: "release" });

    t.service.configure({ keys: ["a", "b"] });
    const pushed = await pushes(t.pushed, 2);

    expect(pushed).toHaveLength(2);
    expect(pushed[0].value).toEqual({ rooms: 1 });
    expect(pushed[1].value).toEqual({ rooms: 2 });
  });

  it("acts on configure, because that is all a facade can do", async () => {
    // A facade button sends a payload; it does not start a pipeline pass.
    const { store } = await fileStore();
    await store.put(BOARD, "a", {});
    const t = serviceOn(store, { mode: "release" });

    const state = t.service.configure({ keys: ["a"] });
    await pushes(t.pushed, 1);

    // And the key does not survive into the board's saved state, or opening
    // that board again would release it a second time.
    expect(state.keys).toBeUndefined();
    expect(t.service.getState().keys).toBeUndefined();
  });

  it("takes records as readily as keys", async () => {
    // A facade sends keys; a service upstream tends to send whole records.
    const { store } = await fileStore();
    await store.put(BOARD, "a", { v: 1 });
    const t = serviceOn(store, { mode: "release" });

    t.service.process({ keys: [{ key: "a" }] }, t.notify);
    const pushed = await pushes(t.pushed, 1);

    expect(pushed[0].key).toBe("a");
  });

  it("passes over what somebody else already dealt with", async () => {
    // Two people looking at the same queue is the normal case, not an error.
    const { store } = await fileStore();
    await store.put(BOARD, "a", {});
    const t = serviceOn(store, { mode: "release" });

    t.service.configure({ keys: ["a", "gone"] });
    await pushes(t.pushed, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(t.pushed).toHaveLength(1);
  });

  it("does nothing when nothing was picked", async () => {
    const { store } = await fileStore();
    await store.put(BOARD, "a", {});
    const t = serviceOn(store, { mode: "release" });

    t.service.configure({ keys: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(t.pushed).toEqual([]);
    expect(await store.list(BOARD)).toHaveLength(1);
  });
});

describe("store namespace", () => {
  it("puts every store on a board on the same table without being told", async () => {
    // `key` names a record within a table, never the table — so two instances
    // in different modes find each other's records by construction.
    const { store } = await fileStore();

    await pass(serviceOn(store, { mode: "put", key: "k" }), { v: 1 });
    const found = await pass(serviceOn(store, { mode: "get", key: "k" }), undefined);

    expect(found.value).toEqual({ v: 1 });
  });

  it("keeps two sets of things on one board apart", async () => {
    // Without this they would share one list, and `list` would hand back both
    // mixed together.
    const { store } = await fileStore();

    await pass(
      serviceOn(store, { mode: "put", namespace: "enquiries", key: "k" }),
      "an enquiry",
    );
    await pass(
      serviceOn(store, { mode: "put", namespace: "invoices", key: "k" }),
      "an invoice",
    );

    const enquiries = await pass(
      serviceOn(store, { mode: "list", namespace: "enquiries" }),
      undefined,
    );
    expect(enquiries.records.map((r: any) => r.value)).toEqual(["an enquiry"]);

    const invoices = await pass(
      serviceOn(store, { mode: "list", namespace: "invoices" }),
      undefined,
    );
    expect(invoices.records.map((r: any) => r.value)).toEqual(["an invoice"]);
  });

  it("leaves the board's own table where it always was", async () => {
    // Saying nothing must mean what it meant before namespaces existed.
    const { store } = await fileStore();

    await store.put(BOARD, "k", "unnamespaced");

    expect((await store.get(BOARD, "k"))!.value).toBe("unnamespaced");
    expect(await store.get({ ...BOARD, namespace: "" }, "k")).not.toBeNull();
    expect(await store.get({ ...BOARD, namespace: "other" }, "k")).toBeNull();
  });

  it("does not list a namespace as though it were a record", async () => {
    // A namespace is a directory inside the board's own; listing the board must
    // not trip over it.
    const { store } = await fileStore();

    await store.put(BOARD, "own", "mine");
    await store.put({ ...BOARD, namespace: "nested" }, "theirs", "not mine");

    expect((await store.list(BOARD)).map((r) => r.key)).toEqual(["own"]);
  });

  it("empties one table without touching another", async () => {
    // Clearing by removing the directory would take the namespaces inside it.
    const { store } = await fileStore();

    await store.put(BOARD, "own", "mine");
    await store.put({ ...BOARD, namespace: "nested" }, "theirs", "kept");

    expect(await store.clear(BOARD)).toBe(1);
    expect(await store.list(BOARD)).toEqual([]);
    expect((await store.list({ ...BOARD, namespace: "nested" }))[0].value).toBe(
      "kept",
    );
  });

  it("cannot be named out of its board", async () => {
    // A namespace comes from board state, so it is as untrusted as a key.
    const { root, store } = await fileStore();

    await store.put({ ...BOARD, namespace: "../../.." }, "k", "escaped");

    const owners = await fs.readdir(root);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps namespaces apart in memory too", async () => {
    const store = createMemoryRecordStore();

    await store.put({ ...BOARD, namespace: "a" }, "k", "first");
    await store.put({ ...BOARD, namespace: "b" }, "k", "second");

    expect((await store.get({ ...BOARD, namespace: "a" }, "k"))!.value).toBe(
      "first",
    );
    expect(await store.get(BOARD, "k")).toBeNull();
  });
});

describe("store scope", () => {
  it("keeps one tenant's records out of another's", async () => {
    // The isolation the whole server depends on: runtimes are namespaced by the
    // authenticated sub, and anything durable has to be namespaced the same.
    const { store } = await fileStore();
    const mine = { owner: "auth0|alice", boardName: "Offers" };
    const theirs = { owner: "auth0|bob", boardName: "Offers" };

    await pass(serviceOn(store, { mode: "put", key: "k" }, mine), "mine");
    await pass(serviceOn(store, { mode: "put", key: "k" }, theirs), "theirs");

    const found = await pass(serviceOn(store, { mode: "get", key: "k" }, mine), undefined);
    expect(found.value).toBe("mine");
    expect((await store.list(theirs)).map((r) => r.value)).toEqual(["theirs"]);
  });

  it("keeps one board's records out of another's", async () => {
    const { store } = await fileStore();
    const offers = { owner: "auth0|alice", boardName: "Offers" };
    const invoices = { owner: "auth0|alice", boardName: "Invoices" };

    await pass(serviceOn(store, { mode: "put", key: "k" }, offers), "offer");

    await quietPass(serviceOn(store, { mode: "get", key: "k" }, invoices), undefined);
  });

  it("cannot be talked out of its own directory", async () => {
    // Every part of the path comes from outside — a sub, a board name, a key —
    // so none of them is used as a path.
    const { root, store } = await fileStore();

    await store.put(
      { owner: "../../etc", boardName: "../.." },
      "../../../passwd",
      "escaped",
    );

    const inside = await fs.readdir(root);
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps two keys that differ only in case apart", async () => {
    // Two keys here, and they would be one file on a case-insensitive volume.
    const { store } = await fileStore();

    await store.put(BOARD, "Key", "upper");
    await store.put(BOARD, "key", "lower");

    expect((await store.get(BOARD, "Key"))!.value).toBe("upper");
    expect((await store.get(BOARD, "key"))!.value).toBe("lower");
  });

  it("refuses to store anything when it has no board to store it under", async () => {
    const { store } = await fileStore();
    const service = new StoreService(
      { uuid: "store-1", serviceId: "store", state: { mode: "put" } } as any,
      store,
    );
    const notifications: unknown[] = [];

    // No setHost: nothing has told it whose records these would be.
    expect(service.process({ v: 1 }, (n) => notifications.push(n))).toBeNull();
    expect(
      notifications.some(
        (n: any) => typeof n?.error === "string" && n.error.includes("scope"),
      ),
    ).toBe(true);
  });
});

describe("store on disk", () => {
  it("writes where only the owner can read", async () => {
    // Records carry whatever a board put in them, which is correspondence.
    const { root, store } = await fileStore();

    await store.put(BOARD, "k", { private: true });

    const owner = (await fs.readdir(root))[0];
    const board = (await fs.readdir(path.join(root, owner)))[0];
    const dir = await fs.stat(path.join(root, owner, board));
    const file = (await fs.readdir(path.join(root, owner, board)))[0];
    const stat = await fs.stat(path.join(root, owner, board, file));

    expect(dir.mode & 0o777).toBe(0o700);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("ignores a half-written record rather than reading it", async () => {
    // A crash mid-write leaves a file under a temporary name; only finished
    // ones end in .json.
    const { root, store } = await fileStore();
    await store.put(BOARD, "good", { v: 1 });

    const owner = (await fs.readdir(root))[0];
    const board = (await fs.readdir(path.join(root, owner)))[0];
    await fs.writeFile(
      path.join(root, owner, board, "abc.json.deadbeef.tmp"),
      "{ half",
    );

    expect((await store.list(BOARD)).map((r) => r.key)).toEqual(["good"]);
  });

  it("ignores a record it cannot read rather than losing the table", async () => {
    const { root, store } = await fileStore();
    await store.put(BOARD, "good", { v: 1 });

    const owner = (await fs.readdir(root))[0];
    const board = (await fs.readdir(path.join(root, owner)))[0];
    await fs.writeFile(path.join(root, owner, board, "corrupt.json"), "not json");

    expect((await store.list(BOARD)).map((r) => r.key)).toEqual(["good"]);
  });
});

describe("store in memory", () => {
  it("behaves the same as the one on disk", async () => {
    // A board should not be able to tell which it is talking to, so the same
    // expectations run against both.
    const store = createMemoryRecordStore();

    const written = await pass(
      serviceOn(store, { mode: "put", key: "k" }),
      { rooms: 3 },
    );
    expect(written.value).toEqual({ rooms: 3 });

    const found = await pass(serviceOn(store, { mode: "get", key: "k" }), undefined);
    expect(found.value).toEqual({ rooms: 3 });

    await quietPass(
      serviceOn(store, { mode: "get", key: "k" }, { owner: "someone-else", boardName: "Offers" }),
      undefined,
    );
  });
});
