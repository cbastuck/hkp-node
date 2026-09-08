import { describe, expect, it } from "vitest";

import { ConversationsService } from "../src/services/conversations";
import { createMemoryDatabaseStore, DatabaseStore } from "../src/services/database";
import { RuntimeHost } from "../src/types";

/**
 * The domain half. What is worth pinning is what this service decides that no
 * board told it: which conversation a message belongs to, that a message seen
 * twice is not an event, and that a state nobody declared is not written.
 */

type Pushed = { data: unknown; runId: string | undefined };

function hostFor(pushed: Pushed[], scope = { owner: "tester", boardName: "SYN" }) {
  return {
    processFrom: (_uuid: string, data: unknown, _n: unknown, context: any) => {
      pushed.push({ data, runId: context?.runId });
      return null;
    },
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => scope,
    emitResult: () => {},
  } as unknown as RuntimeHost;
}

function serviceWith(
  state: Record<string, unknown>,
  databases: DatabaseStore = createMemoryDatabaseStore(),
  scope?: { owner: string; boardName: string },
) {
  const pushed: Pushed[] = [];
  const notifications: unknown[] = [];
  const service = new ConversationsService(
    { uuid: "conv-1", serviceId: "conversations", state } as never,
    databases,
  );
  service.setHost(hostFor(pushed, scope));
  const run = (input: unknown) =>
    service.process(input, (payload: unknown) => notifications.push(payload));
  return { service, databases, pushed, notifications, run };
}

/** An envelope shaped the way `imap-email` reports one. */
function mail(over: Record<string, unknown> = {}) {
  return {
    messageId: "<a@example.com>",
    subject: "Zimmeranfrage",
    from: "anna@example.com",
    to: ["buchung@syn.example"],
    date: "2026-08-20T09:00:00.000Z",
    references: [],
    inReplyTo: "",
    text: "Zwei Zimmer bitte",
    ...over,
  };
}

describe("threading", () => {
  it("files a first message under a conversation named by that message", () => {
    const t = serviceWith({ mode: "ingest" });

    const result = t.run(mail()) as any;

    // The angle brackets are header syntax, not identity.
    expect(result.conversationId).toBe("a@example.com");
    expect(result.isNew).toBe(true);
    expect(result.state).toBe("init");
    expect(result.email.from).toBe("anna@example.com");
    expect(result.email.to).toBe("buchung@syn.example");
    expect(result.email.direction).toBe("inbound");
  });

  it("puts a reply in the thread it answers", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const reply = serviceWith({ mode: "ingest" }, databases).run(
      mail({
        messageId: "<b@example.com>",
        inReplyTo: "<a@example.com>",
        references: ["<a@example.com>"],
      }),
    ) as any;

    expect(reply.conversationId).toBe("a@example.com");
    expect(reply.isNew).toBe(false);
  });

  it("meets two replies to a root it never saw", () => {
    // The root is named by the chain, so messages that reference it agree on a
    // conversation without either of them being it.
    const databases = createMemoryDatabaseStore();
    const first = serviceWith({ mode: "ingest" }, databases).run(
      mail({ messageId: "<b@x>", references: ["<root@x>", "<a@x>"] }),
    ) as any;
    const second = serviceWith({ mode: "ingest" }, databases).run(
      mail({ messageId: "<c@x>", references: ["<root@x>"] }),
    ) as any;

    expect(first.conversationId).toBe("root@x");
    expect(second.conversationId).toBe("root@x");
  });

  it("keeps unrelated mail apart", () => {
    const databases = createMemoryDatabaseStore();
    const a = serviceWith({ mode: "ingest" }, databases).run(mail()) as any;
    const b = serviceWith({ mode: "ingest" }, databases).run(
      mail({ messageId: "<z@other.com>", from: "bob@other.com" }),
    ) as any;

    expect(a.conversationId).not.toBe(b.conversationId);
  });

  it("does not disturb a state something already decided", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());
    serviceWith(
      { mode: "transition", state: "waiting-reply" },
      databases,
    ).run({ conversationId: "a@example.com" });

    const reply = serviceWith({ mode: "ingest" }, databases).run(
      mail({ messageId: "<b@example.com>", inReplyTo: "<a@example.com>" }),
    ) as any;

    // An arriving reply is not a decision about what happens next.
    expect(reply.state).toBe("waiting-reply");
  });

  it("collects who has been in the thread", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());
    const reply = serviceWith({ mode: "ingest", direction: "outbound" }, databases).run(
      mail({
        messageId: "<b@example.com>",
        inReplyTo: "<a@example.com>",
        from: "buchung@syn.example",
        to: "anna@example.com",
      }),
    ) as any;

    expect(reply.participants.sort()).toEqual([
      "anna@example.com",
      "buchung@syn.example",
    ]);
  });
});

describe("a message seen twice", () => {
  it("stops the pipeline rather than answering it again", () => {
    // A mailbox poll re-delivers. Nothing to pass on is not a failure.
    const databases = createMemoryDatabaseStore();
    const t = serviceWith({ mode: "ingest" }, databases);

    expect(t.run(mail())).not.toBeNull();
    expect(t.run(mail())).toBeNull();
    expect(t.service.getState().error).toBe("");
    expect(t.notifications.at(-1)).toMatchObject({ stored: false });

    const thread = serviceWith({ mode: "thread" }, databases).run(
      "a@example.com",
    ) as any;
    expect(thread.count).toBe(1);
  });
});

describe("the thread", () => {
  it("reads oldest first, whichever order it arrived in", () => {
    const databases = createMemoryDatabaseStore();
    const ingest = serviceWith({ mode: "ingest" }, databases);
    ingest.run(mail({ messageId: "<b@x>", date: "2026-08-20T12:00:00.000Z" }));
    ingest.run(
      mail({
        messageId: "<a@x>",
        date: "2026-08-20T09:00:00.000Z",
        inReplyTo: "<b@x>",
      }),
    );

    const thread = serviceWith({ mode: "thread" }, databases).run("b@x") as any;
    expect(thread.emails.map((e: any) => e.messageId)).toEqual(["a@x", "b@x"]);
  });
});

describe("transitions", () => {
  it("refuses a state the board never declared", () => {
    // What writes a transition is often a model, and a state nothing selects on
    // looks exactly like a conversation nobody is working on any more.
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const t = serviceWith(
      { mode: "transition", states: ["init", "waiting-approval", "done"] },
      databases,
    );

    // An underscore where the board wrote a hyphen: accepted, it would strand
    // the conversation where no poll selects it again.
    expect(t.run({ conversationId: "a@example.com", state: "waiting_approval" }))
      .toBeNull();
    expect(t.service.getState().error).toContain("not one of this board's states");

    // Refused, not written: the conversation is where it was.
    const declared = t.run({
      conversationId: "a@example.com",
      state: "waiting-approval",
    }) as any;
    expect(declared).toMatchObject({ previous: "init", state: "waiting-approval" });
  });

  it("takes the state from the input when the board fixed none", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const moved = serviceWith({ mode: "transition" }, databases).run({
      conversationId: "a@example.com",
      state: "waiting-approval",
    }) as any;

    expect(moved).toMatchObject({ previous: "init", state: "waiting-approval" });
  });

  it("says so when there is no such conversation", () => {
    const t = serviceWith({ mode: "transition", state: "done" });
    expect(t.run({ conversationId: "nope" })).toBeNull();
    expect(t.service.getState().error).toContain("no conversation");
  });
});

describe("polling for work", () => {
  it("says what it found, and leaves iterating to an iterator", () => {
    const databases = createMemoryDatabaseStore();
    const ingest = serviceWith({ mode: "ingest" }, databases);
    ingest.run(mail({ messageId: "<a@x>" }));
    ingest.run(mail({ messageId: "<b@x>" }));

    const poll = serviceWith(
      { mode: "actionable", inState: ["init"] },
      databases,
    );
    const found = poll.run(null) as any;

    expect(found.count).toBe(2);
    expect(found.conversations.map((c: any) => c.conversationId).sort()).toEqual(
      ["a@x", "b@x"],
    );
    // Nothing is called on its own behalf: the pipeline simply continues.
    expect(poll.pushed).toHaveLength(0);
  });

  it("selects only the states it was told to", () => {
    const databases = createMemoryDatabaseStore();
    const ingest = serviceWith({ mode: "ingest" }, databases);
    ingest.run(mail({ messageId: "<a@x>" }));
    ingest.run(mail({ messageId: "<b@x>" }));
    serviceWith({ mode: "transition", state: "done" }, databases).run("b@x");

    const poll = serviceWith(
      { mode: "actionable", inState: "init, waiting-reply" },
      databases,
    );
    const found = poll.run(null) as any;

    expect(found.conversations.map((c: any) => c.conversationId)).toEqual(["a@x"]);
  });

  it("waits out the idle window before picking a conversation up again", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const poll = serviceWith(
      { mode: "actionable", inState: ["init"], idleSeconds: 3600 },
      databases,
    );

    // Just ingested: whatever acted on it last may still be acting on it.
    expect((poll.run(null) as any).count).toBe(0);

    // The same conversation, an hour and a half of stillness later.
    databases.open({ owner: "tester", boardName: "SYN" }).run(
      "UPDATE conversation SET updatedAt = $then",
      { $then: new Date(Date.now() - 5400 * 1000).toISOString() },
    );
    expect(
      (poll.run(null) as any).conversations.map((c: any) => c.conversationId),
    ).toEqual(["a@example.com"]);
  });

  it("refuses to poll without being told which states are work", () => {
    const t = serviceWith({ mode: "actionable" });
    expect(t.run(null)).toBeNull();
    expect(t.service.getState().error).toContain("inState");
  });
});

describe("artifacts", () => {
  it("keeps what the workflow produced and finds it again", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const draft = serviceWith(
      { mode: "put-artifact", kind: "follow-up", payloadFrom: "followUp" },
      databases,
    ).run({
      conversationId: "a@example.com",
      followUp: { subject: "Rückfrage", body: "Wie viele Zimmer?" },
    }) as any;

    expect(draft).toMatchObject({
      conversationId: "a@example.com",
      kind: "follow-up",
      status: "pending",
      payload: { subject: "Rückfrage", body: "Wie viele Zimmer?" },
    });

    const listed = serviceWith(
      { mode: "list-artifacts", kind: "follow-up", status: "pending" },
      databases,
    ).run(null) as any;
    expect(listed.count).toBe(1);
    expect(listed.artifacts[0].id).toBe(draft.id);
  });

  it("records what a person decided about one", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());
    const draft = serviceWith(
      { mode: "put-artifact", kind: "follow-up" },
      databases,
    ).run({ conversationId: "a@example.com", body: "…" }) as any;

    const approved = serviceWith(
      { mode: "set-artifact-status", status: "approved" },
      databases,
    ).run({ id: draft.id }) as any;

    expect(approved.status).toBe("approved");
    expect(approved.updatedAt >= draft.createdAt).toBe(true);

    const pending = serviceWith(
      { mode: "list-artifacts", status: "pending" },
      databases,
    ).run(null) as any;
    expect(pending.count).toBe(0);
  });

  it("will not hold an artifact for a conversation that does not exist", () => {
    // Otherwise a typo produces a draft nothing will ever list.
    const t = serviceWith({ mode: "put-artifact", kind: "follow-up" });
    expect(t.run({ conversationId: "made-up", body: "…" })).toBeNull();
    expect(t.service.getState().error).toContain("no conversation");
  });
});

describe("what a board can reach", () => {
  it("cannot see another board's conversations", () => {
    const databases = createMemoryDatabaseStore();
    serviceWith({ mode: "ingest" }, databases).run(mail());

    const theirs = serviceWith({ mode: "thread" }, databases, {
      owner: "someone-else",
      boardName: "SYN",
    }).run("a@example.com") as any;

    expect(theirs.count).toBe(0);
  });
});
