import { describe, expect, it } from "vitest";

import { QueueService } from "../src/services/queue";
import { createMemoryDatabaseStore, DatabaseStore } from "../src/services/database";
import { JsonRecord, RuntimeHost } from "../src/types";

/**
 * What one board says to another.
 *
 * The property the whole thing exists for is the first test: two boards, one
 * queue. Everything after it is about the guarantee — a message handed out is
 * not a message finished, and the queue must say which it is at every point a
 * runtime could stop.
 */

function hostFor(scope: { owner: string; boardName: string }) {
  return {
    processFrom: () => null,
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => scope,
    emitResult: () => {},
  } as unknown as RuntimeHost;
}

/** A queue service as one board holds it. */
function queue(
  state: Record<string, unknown>,
  databases: DatabaseStore,
  scope = { owner: "tester", boardName: "booking" },
) {
  const notifications: unknown[] = [];
  const service = new QueueService(
    { uuid: `queue-${state.mode}`, serviceId: "queue", state } as never,
    databases,
  );
  service.setHost(hostFor(scope));
  return {
    service,
    notifications,
    run: (input?: unknown) =>
      service.process(input, (payload: unknown) => notifications.push(payload)),
  };
}

const REQUEST = { conversationId: "c1", district: "Ost Berlin", beds: 1 };

describe("one board speaking to another", async () => {
  it("carries a message from the board that published it to the board that consumes it", async () => {
    // One store, two boards: the property a per-board database cannot give.
    const databases = createMemoryDatabaseStore();
    const booking = queue({ mode: "publish", topic: "booking.ready" }, databases, {
      owner: "tester",
      boardName: "booking",
    });
    const hotels = queue({ mode: "consume", topic: "booking.ready" }, databases, {
      owner: "tester",
      boardName: "hotels",
    });

    await booking.run(REQUEST);
    const claimed = await hotels.run() as { messages: JsonRecord[]; count: number };

    expect(claimed.count).toBe(1);
    expect(claimed.messages[0].payload).toEqual(REQUEST);
    // Which board sent it, for whoever has to work out where a message came from.
    expect(claimed.messages[0].publishedBy).toBe("booking");
  });

  it("keeps one owner's messages away from another's", async () => {
    const databases = createMemoryDatabaseStore();
    const mine = queue({ mode: "publish", topic: "booking.ready" }, databases, {
      owner: "tester",
      boardName: "booking",
    });
    const theirs = queue({ mode: "consume", topic: "booking.ready" }, databases, {
      owner: "somebody-else",
      boardName: "booking",
    });

    await mine.run(REQUEST);

    expect(await theirs.run()).toMatchObject({ count: 0 });
  });

  it("hands out nothing for a topic nobody published to", async () => {
    const databases = createMemoryDatabaseStore();
    const consumer = queue({ mode: "consume", topic: "booking.quotes" }, databases);

    // A unit under test on its own: no producer, no messages, no error.
    expect(await consumer.run()).toMatchObject({ count: 0 });
    expect(consumer.service.getState().error).toBe("");
  });

  it("publishes the part of the input the board pointed at", async () => {
    const databases = createMemoryDatabaseStore();
    const publisher = queue(
      { mode: "publish", topic: "booking.ready", payloadFrom: "extraction" },
      databases,
    );
    const consumer = queue({ mode: "consume", topic: "booking.ready" }, databases);

    await publisher.run({ conversationId: "c1", extraction: { beds: 2 } });
    const claimed = await consumer.run() as { messages: JsonRecord[] };

    expect(claimed.messages[0].payload).toEqual({ beds: 2 });
  });

  it("treats an array as one message rather than many", async () => {
    const databases = createMemoryDatabaseStore();
    const publisher = queue({ mode: "publish", topic: "t" }, databases);
    const consumer = queue({ mode: "consume", topic: "t" }, databases);

    await publisher.run([{ a: 1 }, { a: 2 }]);
    const claimed = await consumer.run() as { messages: JsonRecord[]; count: number };

    expect(claimed.count).toBe(1);
    expect(claimed.messages[0].payload).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("refuses to publish nothing", async () => {
    const databases = createMemoryDatabaseStore();
    const publisher = queue(
      { mode: "publish", topic: "t", payloadFrom: "missing" },
      databases,
    );

    expect(await publisher.run({ conversationId: "c1" })).toBeNull();
    expect(String(publisher.service.getState().error)).toContain("missing");
  });
});

describe("a message handed out is not a message finished", async () => {
  it("does not hand the same message to a second consume while the claim holds", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue({ mode: "consume", topic: "t" }, databases);

    expect(await consumer.run()).toMatchObject({ count: 1 });
    expect(await consumer.run()).toMatchObject({ count: 0 });
  });

  it("hands it out again once the claim has run out", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    // A claim is a deadline, not a lock: a runtime that died holds nothing.
    const consumer = queue(
      { mode: "consume", topic: "t", visibilitySeconds: 1 },
      databases,
    );

    const first = await consumer.run() as { messages: JsonRecord[] };
    expect(first.messages[0].attempts).toBe(1);

    const store = databases.openShared("tester");
    store.run("UPDATE message SET availableAt = $past", {
      $past: new Date(Date.now() - 60_000).toISOString(),
    });

    const second = await consumer.run() as { messages: JsonRecord[]; count: number };
    expect(second.count).toBe(1);
    expect(second.messages[0].attempts).toBe(2);
  });

  it("stops handing it out once acknowledged", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue({ mode: "consume", topic: "t" }, databases);
    const ack = queue({ mode: "ack", topic: "t" }, databases);

    const claimed = await consumer.run() as { messages: JsonRecord[] };
    expect(await ack.run(claimed.messages[0])).toMatchObject({ status: "done" });

    const store = databases.openShared("tester");
    store.run("UPDATE message SET availableAt = $past", {
      $past: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await consumer.run()).toMatchObject({ count: 0 });
  });

  it("hands a failed message back at once rather than waiting out the claim", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue({ mode: "consume", topic: "t" }, databases);
    const failed = queue({ mode: "fail", topic: "t" }, databases);

    const claimed = await consumer.run() as { messages: JsonRecord[] };
    expect(
      await failed.run({ ...claimed.messages[0], error: "smtp refused it" }),
    ).toMatchObject({ status: "pending" });

    expect(await consumer.run()).toMatchObject({ count: 1 });
  });

  it("buries a message no run could finish, and says why", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue(
      { mode: "consume", topic: "t", maxAttempts: 2, visibilitySeconds: 1 },
      databases,
    );
    const store = databases.openShared("tester");
    const expire = () =>
      store.run("UPDATE message SET availableAt = $past", {
        $past: new Date(Date.now() - 60_000).toISOString(),
      });

    expect(await consumer.run()).toMatchObject({ count: 1 });
    expire();
    expect(await consumer.run()).toMatchObject({ count: 1 });
    expire();
    // The third pass does not deliver it; it closes it.
    expect(await consumer.run()).toMatchObject({ count: 0 });

    const listing = (await queue(
      { mode: "list", topic: "t", status: "dead" },
      databases,
    ).run()) as { messages: JsonRecord[]; count: number };
    expect(listing.count).toBe(1);
    expect(String(listing.messages[0].error)).toContain("2 attempts");
  });

  it("does not return a message to the queue it has already exhausted", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue(
      { mode: "consume", topic: "t", maxAttempts: 1 },
      databases,
    );
    const failed = queue({ mode: "fail", topic: "t", maxAttempts: 1 }, databases);

    const claimed = await consumer.run() as { messages: JsonRecord[] };
    // Handing it back would only bury it on the next consume; bury it now.
    expect(await failed.run(claimed.messages[0])).toMatchObject({ status: "dead" });
    expect(await consumer.run()).toMatchObject({ count: 0 });
  });

  it("says so when asked to close a message it does not have", async () => {
    const databases = createMemoryDatabaseStore();
    const ack = queue({ mode: "ack", topic: "t" }, databases);

    expect(await ack.run({ id: "nope" })).toBeNull();
    expect(String(ack.service.getState().error)).toContain("no message 'nope'");
  });
});

describe("two consumers over one store", async () => {
  it("does not hand the same message to both", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);

    // A second consumer claims the row after this one has selected it and
    // before it has claimed it — what two processes over one file do, and
    // what no amount of care inside a single process can prevent.
    const store = databases.openShared("tester");
    const query = store.query.bind(store);
    let raced = false;
    store.query = (sql: string, params?: never) => {
      const rows = query(sql, params);
      if (!raced && sql.includes("status IN ('pending', 'claimed')")) {
        raced = true;
        store.run(
          `UPDATE message SET status = 'claimed', attempts = 1,
                  availableAt = $later, updatedAt = $now`,
          {
            $later: new Date(Date.now() + 60_000).toISOString(),
            $now: new Date().toISOString(),
          },
        );
      }
      return rows;
    };

    const consumer = queue({ mode: "consume", topic: "t" }, databases);

    // The loser of the race delivers nothing rather than a second copy.
    expect(await consumer.run()).toMatchObject({ count: 0 });
  });
});

describe("what a board can see", async () => {
  it("keeps acknowledged messages readable, with what happened to them", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);
    const consumer = queue({ mode: "consume", topic: "t" }, databases);
    const claimed = await consumer.run() as { messages: JsonRecord[] };
    await queue({ mode: "ack", topic: "t" }, databases).run(claimed.messages[0]);

    const listing = await queue({ mode: "list", topic: "t" }, databases).run() as {
      messages: JsonRecord[];
      count: number;
    };

    expect(listing.count).toBe(1);
    expect(listing.messages[0]).toMatchObject({
      status: "done",
      attempts: 1,
      publishedBy: "booking",
    });
  });

  it("reads one topic without touching another", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "booking.ready" }, databases).run(REQUEST);
    await queue({ mode: "publish", topic: "booking.quotes" }, databases).run(REQUEST);

    const listing = (await queue(
      { mode: "list", topic: "booking.quotes" },
      databases,
    ).run()) as { messages: JsonRecord[]; count: number };

    expect(listing.count).toBe(1);
    expect(listing.messages[0].topic).toBe("booking.quotes");
  });

  it("listing does not claim what it reads", async () => {
    const databases = createMemoryDatabaseStore();
    await queue({ mode: "publish", topic: "t" }, databases).run(REQUEST);

    await queue({ mode: "list", topic: "t" }, databases).run();

    expect(await queue({ mode: "consume", topic: "t" }, databases).run()).toMatchObject({
      count: 1,
    });
  });
});

describe("what it refuses to guess", async () => {
  it("needs a topic to publish to", async () => {
    const databases = createMemoryDatabaseStore();
    const publisher = queue({ mode: "publish" }, databases);

    expect(await publisher.run(REQUEST)).toBeNull();
    expect(String(publisher.service.getState().error)).toContain("needs a topic");
  });

  it("needs a topic to consume from", async () => {
    const databases = createMemoryDatabaseStore();
    const consumer = queue({ mode: "consume" }, databases);

    expect(await consumer.run()).toBeNull();
    expect(String(consumer.service.getState().error)).toContain("needs a topic");
  });

  it("needs a runtime that knows whose queue this is", async () => {
    const databases = createMemoryDatabaseStore();
    const service = new QueueService(
      { uuid: "q", serviceId: "queue", state: { mode: "consume", topic: "t" } } as never,
      databases,
    );
    const notifications: unknown[] = [];

    expect(await service.process(null, (p) => notifications.push(p))).toBeNull();
    expect(String(service.getState().error)).toContain("no runtime");
  });
});
