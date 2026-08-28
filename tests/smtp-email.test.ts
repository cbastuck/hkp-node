import { describe, expect, it } from "vitest";
import type { Transporter } from "nodemailer";

import { SmtpEmailService } from "../src/services/smtp-email";
import { JsonRecord, RuntimeHost, ServiceConfiguration } from "../src/types";

/**
 * Sending mail is the one thing on these boards that cannot be undone, so what
 * is pinned here is mostly about restraint: what goes out, to whom, and what
 * the pipeline is allowed to believe happened.
 */

const CREDENTIALS = {
  host: "smtp.example.com",
  username: "desk",
  password: "hunter2",
  from: "desk@hotel.example",
};

function smtp(state: JsonRecord, failWith?: string) {
  const sent: any[] = [];
  const logged: JsonRecord[] = [];
  const service = new SmtpEmailService(
    { uuid: "mailer", serviceId: "smtp-email", state } as never,
    () =>
      ({
        sendMail: async (options: any) => {
          if (failWith) {
            throw new Error(failWith);
          }
          sent.push(options);
          return { messageId: "<out-1@hotel.example>" };
        },
      }) as unknown as Transporter,
  );
  service.setHost({
    notify: () => {},
    log: (_l: string, _e: string, data: JsonRecord) => logged.push(data),
  } as unknown as RuntimeHost);

  const notifications: JsonRecord[] = [];
  return {
    service,
    sent,
    logged,
    notifications,
    run: (input: unknown) =>
      service.process(input, (payload) =>
        notifications.push(payload as JsonRecord),
      ),
  };
}

describe("a fixed destination", () => {
  it("is what an unconfigured board still gets", () => {
    // The mode that existed before there was a mode has to stay the default,
    // or every board already sending mail changes behaviour on upgrade.
    const t = smtp({});

    expect(t.service.getState().mode).toBe("configured");
  });

  it("sends the input as the body, and hands the input on", async () => {
    const t = smtp({
      ...CREDENTIALS,
      to: "ops@hotel.example",
      subject: "Nightly",
    });

    const out = await t.run("all quiet");

    expect(t.sent[0]).toMatchObject({
      from: "desk@hotel.example",
      to: "ops@hotel.example",
      subject: "Nightly",
      text: "all quiet",
    });
    // A step in a pipeline that is about something else passes it along.
    expect(out).toBe("all quiet");
  });

  it("ignores a recipient that happens to be in the input", async () => {
    // The whole reason addressing is behind a mode: a `to` drifting down a
    // pipeline must not redirect mail that was addressed by configuration.
    const t = smtp({ ...CREDENTIALS, to: "ops@hotel.example" });

    await t.run({ to: "somewhere@else.example", body: "…" });

    expect(t.sent[0].to).toBe("ops@hotel.example");
  });
});

describe("a message the pass is carrying", () => {
  const envelope = (state: JsonRecord = {}, failWith?: string) =>
    smtp({ ...CREDENTIALS, mode: "envelope", ...state }, failWith);

  it("takes the recipient, subject and body from its input", async () => {
    const t = envelope();

    await t.run({
      to: "guest@example.com",
      subject: "Rückfrage",
      body: "Wie viele Zimmer?",
    });

    expect(t.sent[0]).toMatchObject({
      from: "desk@hotel.example",
      to: "guest@example.com",
      subject: "Rückfrage",
      text: "Wie viele Zimmer?",
    });
  });

  it("answers with the message, in the shape the store ingests", async () => {
    // So that filing what was just sent needs nothing in between.
    const t = envelope();

    const out = await t.run({ to: "guest@example.com", subject: "Re: x", body: "…" });

    expect(out).toMatchObject({
      messageId: "out-1@hotel.example",
      from: "desk@hotel.example",
      to: "guest@example.com",
      subject: "Re: x",
      body: "…",
      direction: "outbound",
    });
    expect(typeof (out as JsonRecord).date).toBe("string");
  });

  it("carries the threading headers out, and reports them back unbracketed", async () => {
    // A reply without these starts a new thread in the guest's client — and
    // when they answer it, the store has no message to match their
    // In-Reply-To against, so one exchange becomes two conversations.
    const t = envelope();

    const out = await t.run({
      to: "guest@example.com",
      body: "…",
      inReplyTo: "in-1@example.com",
      references: "root@example.com in-1@example.com",
    });

    expect(t.sent[0].inReplyTo).toBe("<in-1@example.com>");
    expect(t.sent[0].references).toEqual([
      "<root@example.com>",
      "<in-1@example.com>",
    ]);
    // Bare on the way back: that is how the store compares them.
    expect(out).toMatchObject({
      inReplyTo: "in-1@example.com",
      references: ["root@example.com", "in-1@example.com"],
    });
  });

  it("joins several recipients the way a header carries them", async () => {
    const t = envelope();

    await t.run({ to: ["a@example.com", "b@example.com"], body: "…" });

    expect(t.sent[0].to).toBe("a@example.com, b@example.com");
  });

  it("sends nothing when its input names nobody", async () => {
    const t = envelope();

    expect(await t.run({ subject: "Re: x", body: "…" })).toBeNull();
    expect(t.sent).toHaveLength(0);
    expect(t.service.getState().error).toContain("recipient");
  });
});

describe("what the pipeline is allowed to believe", () => {
  it("stops when the send failed", async () => {
    // Whatever follows would file the message, mark a draft sent, or move a
    // conversation on — all of them recording something that did not happen.
    const t = smtp(
      { ...CREDENTIALS, mode: "envelope" },
      "451 temporarily unavailable",
    );

    expect(await t.run({ to: "guest@example.com", body: "…" })).toBeNull();
    expect(t.service.getState().error).toContain("451");
  });

  it("stops a configured send that failed too", async () => {
    const t = smtp({ ...CREDENTIALS, to: "ops@hotel.example" }, "no route");

    expect(await t.run("all quiet")).toBeNull();
  });

  it("stops when it has not been given enough to send with", async () => {
    const t = smtp({ host: "smtp.example.com", mode: "envelope" });

    expect(await t.run({ to: "guest@example.com", body: "…" })).toBeNull();
    expect(t.service.getState().error).toContain("required");
  });
});

describe("who it may write to", () => {
  const restricted = (allowedRecipients: string[]) =>
    smtp({ ...CREDENTIALS, mode: "envelope", allowedRecipients });

  it("refuses an address that is not on the list", async () => {
    // The address is data: it came out of a thread, and the action that sends
    // was chosen by a model. A person approved the text, not the destination.
    const t = restricted(["known@example.com"]);

    expect(await t.run({ to: "stranger@example.com", body: "…" })).toBeNull();
    expect(t.sent).toHaveLength(0);
    expect(t.service.getState().error).toContain("allowedRecipients");
  });

  it("allows one that is, and ignores the label on it", async () => {
    const t = restricted(["known@example.com"]);

    await t.run({ to: "A Guest <known@example.com>", body: "…" });

    expect(t.sent).toHaveLength(1);
  });

  it("takes a whole domain", async () => {
    const t = restricted(["@hotel.example"]);

    await t.run({ to: "colleague@hotel.example", body: "…" });
    expect(t.sent).toHaveLength(1);

    expect(await t.run({ to: "guest@elsewhere.example", body: "…" })).toBeNull();
    expect(t.sent).toHaveLength(1);
  });

  it("refuses the whole message when one of several is not allowed", async () => {
    const t = restricted(["known@example.com"]);

    expect(
      await t.run({ to: ["known@example.com", "stranger@example.com"], body: "…" }),
    ).toBeNull();
    expect(t.sent).toHaveLength(0);
  });

  it("allows anything when the board has not said otherwise", async () => {
    const t = restricted([]);

    await t.run({ to: "anyone@anywhere.example", body: "…" });

    expect(t.sent).toHaveLength(1);
  });
});

describe("the password", () => {
  it("is never echoed back, and survives a round-trip through the UI", () => {
    const t = smtp({ ...CREDENTIALS, to: "ops@hotel.example" });

    const state = t.service.getState();
    expect(state.password).toBe("");
    expect(state.passwordConfigured).toBe(true);

    // What a client sends back is the masked state; that must not erase it.
    t.service.configure(state);
    expect(t.service.getState().passwordConfigured).toBe(true);
  });
});
