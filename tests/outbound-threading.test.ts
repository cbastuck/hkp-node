import { describe, expect, it } from "vitest";
import type { Transporter } from "nodemailer";

import { ConversationsService } from "../src/services/conversations";
import { createMemoryDatabaseStore, DatabaseStore } from "../src/services/database";
import { SmtpEmailService } from "../src/services/smtp-email";
import { JsonRecord, RuntimeHost } from "../src/types";

/**
 * The seam between sending a reply and filing it.
 *
 * Both halves are tested on their own; this is about them meeting. It is the
 * expensive thing to get wrong: a reply sent without threading headers, or
 * sent and not filed, opens a *second* conversation when the guest answers —
 * days later, and nowhere near the mistake that caused it. So the message that
 * actually comes out of `smtp-email` is the message that goes into `ingest`,
 * with nothing in between rewriting it into the shape the test wants.
 */

const host = {
  processFrom: () => null,
  notify: () => {},
  currentContext: () => null,
  log: () => {},
  forwardLog: () => {},
  logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
  scope: () => ({ owner: "tester", boardName: "SYN" }),
  emitResult: () => {},
} as unknown as RuntimeHost;

function conversations(state: Record<string, unknown>, databases: DatabaseStore) {
  const service = new ConversationsService(
    { uuid: `conv-${state.mode}-${state.direction ?? ""}`, serviceId: "conversations", state } as never,
    databases,
  );
  service.setHost(host);
  return (input: unknown) => service.process(input, () => {});
}

function mailer() {
  const service = new SmtpEmailService(
    {
      uuid: "mailer",
      serviceId: "smtp-email",
      state: {
        mode: "envelope",
        host: "smtp.example.com",
        username: "desk",
        password: "hunter2",
        from: "buchung@syn.example",
      },
    } as never,
    () =>
      ({
        sendMail: async () => ({ messageId: "<reply-1@syn.example>" }),
      }) as unknown as Transporter,
  );
  service.setHost(host);
  return (input: unknown) => service.process(input, () => {});
}

describe("sending a reply and filing it", () => {
  it("keeps the guest's answer in the same conversation", async () => {
    const databases = createMemoryDatabaseStore();
    const ingest = conversations({ mode: "ingest", initialState: "init" }, databases);
    const fileOutbound = conversations(
      { mode: "ingest", direction: "outbound" },
      databases,
    );
    const thread = conversations({ mode: "thread", limit: 50 }, databases);
    const send = mailer();

    // 1. The guest writes in.
    const first = (await ingest({
      messageId: "<a@example.com>",
      subject: "Zimmeranfrage",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      text: "Zwei Zimmer bitte",
    })) as JsonRecord;
    const conversationId = String(first.conversationId);

    // 2. We reply, addressed the way the board addresses it: to whoever wrote
    //    in last, in reply to what they wrote.
    const read = (await thread({ conversationId })) as JsonRecord;
    const lastInbound = read.lastInbound as JsonRecord;
    const sent = await send({
      to: lastInbound.from,
      subject: "Re: Zimmeranfrage",
      body: "Für wann denn?",
      inReplyTo: lastInbound.messageId,
      references: lastInbound.messageId,
    });

    // 3. What was sent is filed, unaltered.
    const filed = (await fileOutbound(sent)) as JsonRecord;
    expect(filed.conversationId).toBe(conversationId);
    expect(filed.isNew).toBe(false);

    // 4. The guest answers our reply. Their client names our message, which
    //    the store has only because step 3 happened.
    const answer = (await ingest({
      messageId: "<b@example.com>",
      subject: "Re: Zimmeranfrage",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      inReplyTo: "reply-1@syn.example",
      references: ["a@example.com", "reply-1@syn.example"],
      text: "Vom 17. bis 19.10.",
    })) as JsonRecord;

    expect(answer.conversationId).toBe(conversationId);

    const whole = (await thread({ conversationId })) as JsonRecord;
    expect((whole.emails as JsonRecord[]).map((e) => e.direction)).toEqual([
      "inbound",
      "outbound",
      "inbound",
    ]);
    // And "who wrote in last" is the guest, not us.
    expect((whole.lastInbound as JsonRecord).messageId).toBe("b@example.com");
  });

  it("opens a second conversation when the reply is not filed", async () => {
    // The failure this is all guarding against, shown deliberately: skip the
    // filing step and the guest's answer refers to a message nothing knows.
    const databases = createMemoryDatabaseStore();
    const ingest = conversations({ mode: "ingest", initialState: "init" }, databases);

    const first = (await ingest({
      messageId: "<a@example.com>",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      text: "Zwei Zimmer bitte",
    })) as JsonRecord;

    const answer = (await ingest({
      messageId: "<b@example.com>",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      inReplyTo: "reply-1@syn.example",
      references: ["reply-1@syn.example"],
      text: "Vom 17. bis 19.10.",
    })) as JsonRecord;

    expect(answer.conversationId).not.toBe(first.conversationId);
  });

  it("answers whoever wrote in last, not whoever spoke last", async () => {
    // Taking the last email in the thread would address our next reply to our
    // own sending address, because the last email is the one we just sent.
    const databases = createMemoryDatabaseStore();
    const ingest = conversations({ mode: "ingest", initialState: "init" }, databases);
    const fileOutbound = conversations(
      { mode: "ingest", direction: "outbound" },
      databases,
    );
    const thread = conversations({ mode: "thread", limit: 50 }, databases);

    const first = (await ingest({
      messageId: "<a@example.com>",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      text: "Zwei Zimmer bitte",
    })) as JsonRecord;
    await fileOutbound({
      messageId: "reply-1@syn.example",
      from: "buchung@syn.example",
      to: "anna@example.com",
      inReplyTo: "a@example.com",
      body: "Für wann denn?",
    });

    const read = (await thread({
      conversationId: first.conversationId,
    })) as JsonRecord;
    const emails = read.emails as JsonRecord[];

    expect(emails[emails.length - 1].from).toBe("buchung@syn.example");
    expect((read.lastInbound as JsonRecord).from).toBe("anna@example.com");
  });
});

describe("marking the right artifact", () => {
  it("finds the artifact id where the board says it is", async () => {
    // After sending, the pass carries what was sent — not the draft it was
    // sent from. `idFrom` is how the board points back at it.
    const databases = createMemoryDatabaseStore();
    const ingest = conversations({ mode: "ingest", initialState: "init" }, databases);
    const put = conversations(
      { mode: "put-artifact", kind: "follow-up", status: "approved" },
      databases,
    );
    const mark = conversations(
      { mode: "set-artifact-status", status: "sent", idFrom: "approved.artifacts.0.id" },
      databases,
    );

    const conversation = (await ingest({
      messageId: "<a@example.com>",
      from: "anna@example.com",
      to: ["buchung@syn.example"],
      text: "Zwei Zimmer bitte",
    })) as JsonRecord;
    const artifact = (await put({
      conversationId: conversation.conversationId,
      subject: "Re: x",
      body: "…",
    })) as JsonRecord;

    const marked = (await mark({
      conversationId: conversation.conversationId,
      approved: { artifacts: [{ id: artifact.id }], count: 1 },
      sent: { messageId: "reply-1@syn.example" },
    })) as JsonRecord;

    expect(marked.id).toBe(artifact.id);
    expect(marked.status).toBe("sent");
  });
});
