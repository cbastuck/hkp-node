import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";

import request from "supertest";
import WebSocket from "ws";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";

/**
 * The board, run.
 *
 * `syn-conversations-demo-board.json` is the thing being tested here — not the
 * services it happens to use, which have their own tests. A board is a claim
 * that a particular set of services wired in a particular order does something,
 * and the only way to know whether the claim holds is to load the file the
 * playground loads and drive it.
 *
 * The one substitution is the model: `extract` is pointed at a local stub
 * answering in the OpenAI shape, because a test that needed Hetzner and a token
 * would not be run.
 */

const BOARD = path.join(
  __dirname,
  "../../hkp-frontend/boards/syn-conversations-demo-board.json",
);

type Board = {
  runtimes: Array<{ id: string; name: string }>;
  services: Record<string, Array<Record<string, unknown>>>;
  facade: unknown;
};

let board: Board;

beforeAll(() => {
  board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as Board;
});

/**
 * A model that answers whichever turn is asking, so the board can be driven
 * offline. The board makes three kinds of model call — the manager choosing
 * what to do, an extraction, and a drafted reply — and the schema is what
 * tells them apart, since the manager's schema is written by the dispatcher
 * out of the actions it holds.
 */
async function startModel(answer: Record<string, unknown>) {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const asked = JSON.parse(body || "{}");
      seen.push(asked);
      const shape =
        asked.response_format?.json_schema?.schema?.properties ?? {};
      const prompt = String(
        asked.messages?.[asked.messages.length - 1]?.content ?? "",
      );
      let said: Record<string, unknown>;
      if (shape.action) {
        // The manager's turn. It is choosing from a menu the dispatcher wrote,
        // so the answer here is one of the names on it — and it reads the
        // thread the way a person would: a manager can see for itself whether
        // the enquiry says everything, before anything has been extracted.
        const complete = (answer.missing as string[]).length === 0;
        const current = /CURRENT STATE: (\S+)/.exec(prompt)?.[1] ?? "";
        if (current === "init") {
          said = {
            action: "extract",
            reason: "nothing has been read out of this enquiry yet",
            next: complete ? "ready" : "needs-follow-up",
          };
        } else if (current === "needs-follow-up") {
          said = {
            action: "follow-up",
            reason: "a required detail is missing",
            next: "waiting-approval",
            params: { missing: answer.missing },
          };
        } else if (prompt.includes("- send:")) {
          said = {
            action: "send",
            reason: "a colleague approved the draft",
            next: "waiting-reply",
          };
        } else {
          // Nothing to do, and nothing to change.
          said = { action: "wait", reason: "waiting on someone else", next: current };
        }
      } else if (shape.subject) {
        said = DRAFT;
      } else {
        said = answer;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "stub",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(said) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Stands a delivered message in for an actual one.
 *
 * Replaces `send-mail` with a Map that answers the way `smtp-email` answers,
 * leaving everything around it real: the envelope is still built by the
 * board's own expressions out of the thread and the approved draft, and what
 * comes back is still filed, marked and transitioned by the board's own
 * services. Only the socket is missing.
 */
function delivered(services: unknown): unknown {
  const board = JSON.parse(JSON.stringify(services));
  const swap = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(swap);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.uuid === "send-mail") {
      node.serviceId = "map";
      node.serviceName = "Map";
      node.state = {
        mode: "overwrite",
        arrayMode: "single",
        sensingMode: false,
        template: {
          "messageId=": "'reply-1@test.local'",
          "from=": "'buchung@test.local'",
          "direction=": "'outbound'",
        },
      };
      return;
    }
    Object.values(node).forEach(swap);
  };
  swap(board);
  return board;
}

/** Rewrites the one service that would otherwise need the internet. */
function pointedAt(services: unknown, url: string): unknown {
  return JSON.parse(
    JSON.stringify(services).replaceAll(
      "https://inference.hetzner.com/api/v1",
      url,
    ),
  );
}

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
const models: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (models.length) {
    await models.pop()?.close();
  }
});

async function loadBoard(
  answer: Record<string, unknown>,
  options: { canSend?: boolean } = {},
) {
  const model = await startModel(answer);
  models.push(model);

  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  const wsUrl = baseUrl.replace("http", "ws");

  // Every runtime the board declares, created the way a browser creates them.
  for (const runtime of board.runtimes) {
    const services = options.canSend
      ? delivered(pointedAt(board.services[runtime.id], model.url))
      : pointedAt(board.services[runtime.id], model.url);
    const response = await request(server.httpServer)
      .post("/runtimes")
      .send({ id: runtime.id, name: runtime.name, services });
    expect(
      response.status,
      `creating runtime '${runtime.id}': ${JSON.stringify(response.body)}`,
    ).toBe(200);
  }

  /**
   * Drives one service and reports what the board's services said while it ran.
   *
   * Not the HTTP response: every runtime here ends in a stopper, so the call
   * returns `null` by design. What a service produced reaches an attached board
   * as a notification, and that is the channel the facade reads — so it is the
   * channel to assert on. Nested services report through their host, so what
   * happens inside an Iterator or a Join shows up here too.
   */
  const at = async (runtimeId: string, uuid: string, payload: unknown) => {
    const sockets = await Promise.all(
      board.runtimes.map(
        (runtime) =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(`${wsUrl}/${runtime.id}`);
            socket.on("open", () => resolve(socket));
            socket.on("error", reject);
          }),
      ),
    );

    const said = new Map<string, unknown>();
    for (const socket of sockets) {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "notification") {
          return;
        }
        try {
          const payload = JSON.parse(message.value);
          if (payload?.__internal === undefined) {
            said.set(message.instanceId, payload);
          }
        } catch {
          /* not JSON: nothing here asserts on it */
        }
      });
    }

    const response = await request(server.httpServer)
      .post(`/runtimes/${runtimeId}/services/${uuid}/process`)
      .send(payload as object);
    // The trip to the socket outlives the call that drove it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const socket of sockets) {
      socket.close();
    }

    return { status: response.status, said: (id: string) => said.get(id) as any };
  };

  return { server, model, at };
}

const ANSWER = {
  dateOfArrival: "2026-10-17",
  dateOfDeparture: "2026-10-19",
  maximumPrice: 200,
  searchDistrict: "Ost Berlin",
  breakfast: true,
  missing: ["numberOfRooms"],
  language: "de",
};

const DRAFT = {
  subject: "Rückfrage zu Ihrer Anfrage",
  body: "Guten Tag,\n\nwie viele Zimmer benötigen Sie?\n\nIhr Buchungsteam",
  language: "de",
};

const ENQUIRY =
  "Ich benötige Zimmer in Ost Berlin für zwei Nächte. Ich würde am " +
  "17.10.2026 anreisen. Es soll ein ruhiges Zimmer für maximal 200€ sein, " +
  "mit Frühstück.";

describe("the board as a whole", () => {
  it("carries an enquiry from typed text to a follow-up email awaiting approval", async () => {
    const { model, at } = await loadBoard(ANSWER);

    // 1. What the facade's "File a test enquiry" button does.
    const filed = await at("test", "compose", { text: ENQUIRY });
    expect(filed.status).toBe(200);
    const filedConversation = filed.said("file-test-mail");
    expect(filedConversation).toMatchObject({ state: "init", isNew: true });
    const conversationId = filedConversation.conversationId;
    expect(conversationId).toContain("@test.local");
    expect(filedConversation.email.body).toBe(ENQUIRY);

    // 2. What "Run a step" does: find it, read the thread, ask the manager what
    //    to do, do it. Two model calls — the decision, then the action's own.
    const polled = await at("dispatch", "poll", {});
    expect(polled.status).toBe(200);

    expect(model.seen).toHaveLength(2);

    // The manager was given the goal, the menu, and the exchange so far — and
    // could only answer with an action that exists.
    const decision = model.seen[0] as any;
    const decisionPrompt = String(
      decision.messages[decision.messages.length - 1].content,
    );
    expect(decisionPrompt).toContain("Book a hotel room for the guest");
    expect(decisionPrompt).toContain("- extract:");
    expect(decisionPrompt).toContain("CURRENT STATE: init");
    expect(decisionPrompt).toContain("Ost Berlin");
    // `follow-up` needs something recorded to ask about, and nothing has been
    // read yet — so it is not on the menu, whatever the model might prefer.
    expect(decisionPrompt).not.toContain("- follow-up:");
    expect(decision.response_format.json_schema.schema.properties.action.enum)
      .toEqual(["extract", "follow-up", "send", "wait"]);
    // Nor is `send`: there is nothing approved to send.
    expect(decisionPrompt).not.toContain("- send:");

    // Then the action ran, and it was asked about this conversation.
    const asked = model.seen[1] as any;
    expect(JSON.stringify(asked.messages)).toContain(conversationId);
    expect(JSON.stringify(asked.messages)).toContain("Ost Berlin");
    // The schema went with it, so the answer is guided rather than hoped for.
    expect(asked.response_format?.json_schema?.schema?.properties).toHaveProperty(
      "numberOfRooms",
    );

    // 3. The extraction is data, not a request for anyone's attention.
    const recorded = (await at("review", "extractions", {})).said("extractions");
    expect(recorded.count).toBe(1);
    expect(recorded.artifacts[0]).toMatchObject({
      conversationId,
      kind: "extraction",
      status: "recorded",
      // The extraction survived the trip past a service that replaces its
      // input — which is what `join` is in the board for.
      payload: {
        searchDistrict: "Ost Berlin",
        maximumPrice: 200,
        missing: ["numberOfRooms"],
        language: "de",
      },
    });

    // Something required is missing, so the conversation says what it needs
    // rather than sitting in a state that means "a person must look".
    const afterExtract = (
      await at("review", "all-conversations", {})
    ).said("all-conversations");
    expect(afterExtract.conversations[0]).toMatchObject({
      conversationId,
      state: "needs-follow-up",
    });
    // Nothing is waiting on a person yet.
    expect((await at("review", "drafts", {})).said("drafts").count).toBe(0);

    // 4. The same button again. Nothing about the board says "now draft" — the
    //    manager is asked afresh, sees an extraction on file and a required
    //    detail missing, and picks the other action.
    await at("dispatch", "poll", {});

    expect(model.seen).toHaveLength(4);
    const secondDecision = model.seen[2] as any;
    const secondPrompt = String(
      secondDecision.messages[secondDecision.messages.length - 1].content,
    );
    expect(secondPrompt).toContain("CURRENT STATE: needs-follow-up");
    // Now that there is something on file, drafting is on the menu — and what
    // is on file is in front of the manager. That read-back runs two levels
    // down, and silently found nothing until the runtime handed the board's
    // scope all the way there.
    expect(secondPrompt).toContain("- follow-up:");
    expect(secondPrompt).toContain("numberOfRooms");

    const drafting = model.seen[3] as any;
    expect(
      drafting.response_format?.json_schema?.schema?.properties,
    ).toHaveProperty("subject");

    // It was told what to ask for by the manager, which is what makes the
    // action reusable: one drafting action, parameterised, rather than one per
    // question a business might need to ask.
    const prompt = String(
      drafting.messages[drafting.messages.length - 1].content,
    );
    expect(prompt).toContain('Still missing: ["numberOfRooms"]');
    expect(prompt).not.toContain("(unknown)");

    // 5. *This* one waits for a person, and says so.
    const awaiting = (await at("review", "drafts", {})).said("drafts");
    expect(awaiting.count).toBe(1);
    expect(awaiting.artifacts[0]).toMatchObject({
      conversationId,
      kind: "follow-up",
      status: "pending",
      payload: { subject: DRAFT.subject, language: "de" },
    });

    const afterDraft = (
      await at("review", "all-conversations", {})
    ).said("all-conversations");
    expect(afterDraft.conversations[0]).toMatchObject({
      conversationId,
      state: "waiting-approval",
    });

    // 6. What "Approve selected" does.
    const artifactId = awaiting.artifacts[0].id;
    const approved = await at("approve", "approve-each", { ids: [artifactId] });
    expect(approved.said("mark-approved")).toMatchObject({
      id: artifactId,
      status: "approved",
    });
    expect(approved.said("approve-each")).toMatchObject({
      items: 1,
      results: 1,
      failed: 0,
    });
  });

  it("asks for nothing when the enquiry already said everything", async () => {
    // The other branch of the same decision: a complete enquiry needs no
    // follow-up, so no draft is written and nobody is asked to approve one.
    const { model, at } = await loadBoard({
      numberOfRooms: 2,
      dateOfArrival: "2026-10-17",
      dateOfDeparture: "2026-10-19",
      missing: [],
      language: "de",
    });

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});

    const overview = (
      await at("review", "all-conversations", {})
    ).said("all-conversations");
    expect(overview.conversations[0]).toMatchObject({ state: "ready" });

    // Asked again, the manager declines to act: it is offered the drafting
    // action and does not take it, and nothing is written for anyone to
    // approve. Choosing to do nothing is a decision the menu allows.
    const before = model.seen.length;
    await at("dispatch", "poll", {});
    expect(model.seen).toHaveLength(before + 1);
    expect((await at("review", "drafts", {})).said("drafts").count).toBe(0);
    expect(
      (await at("review", "all-conversations", {})).said("all-conversations")
        .conversations[0],
    ).toMatchObject({ state: "ready" });
  });

  it("offers sending only once a colleague has approved the draft", async () => {
    // `available` is not routing — it is which moves are legal this turn.
    // There is no judgement to exercise about sending a draft that nobody has
    // approved, so the action is not put in front of the model at all.
    const { model, at } = await loadBoard(ANSWER);

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});   // extract
    await at("dispatch", "poll", {});   // draft the follow-up

    const draft = (await at("review", "drafts", {})).said("drafts").artifacts[0];
    const decisionsBefore = model.seen.filter(
      (call: any) => call.response_format?.json_schema?.schema?.properties?.action,
    );
    const promptBefore = String(
      decisionsBefore.at(-1).messages.at(-1).content,
    );
    expect(promptBefore).not.toContain("- send:");

    // What the facade's "Approve selected" button does.
    await at("approve", "approve-each", { ids: [draft.id] });
    await at("dispatch", "poll", {});

    const decisionsAfter = model.seen.filter(
      (call: any) => call.response_format?.json_schema?.schema?.properties?.action,
    );
    const promptAfter = String(decisionsAfter.at(-1).messages.at(-1).content);
    expect(promptAfter).toContain("- send:");
  });

  it("does not record a send that did not happen", async () => {
    // The board ships with no SMTP credentials, deliberately: sending is the
    // one thing here that cannot be undone. The manager chooses to send, the
    // send fails, and nothing downstream gets to pretend otherwise — the draft
    // is not marked sent and the conversation does not move on.
    const { at } = await loadBoard(ANSWER);

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});
    await at("dispatch", "poll", {});
    const draft = (await at("review", "drafts", {})).said("drafts").artifacts[0];
    await at("approve", "approve-each", { ids: [draft.id] });

    const attempt = await at("dispatch", "poll", {});

    // It was tried, and it said why it could not.
    expect(attempt.said("send-mail").error).toContain("required");

    // And nothing after the failed send ran: the conversation is where it was.
    const conversation = (
      await at("review", "all-conversations", {})
    ).said("all-conversations").conversations[0];
    expect(conversation.state).toBe("waiting-approval");
  });

  it("sends the approved draft, files it, and waits for the answer", async () => {
    // The whole last leg, with only the socket stood in for: the envelope is
    // built by the board out of the thread and the approved draft, what comes
    // back is filed into the same conversation, the draft is marked sent, and
    // the exchange moves to waiting on the guest.
    const { at } = await loadBoard(ANSWER, { canSend: true });

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});   // extract
    await at("dispatch", "poll", {});   // draft
    const draft = (await at("review", "drafts", {})).said("drafts").artifacts[0];
    await at("approve", "approve-each", { ids: [draft.id] });

    const sending = await at("dispatch", "poll", {});

    // Filed into the conversation it belongs to, not a new one — and that is
    // the assertion about threading: `threadOf` matches on In-Reply-To and
    // References, so without them this would have opened a conversation of
    // its own under the outbound message's own id.
    const outbound = sending.said("file-outbound");
    expect(outbound).toMatchObject({
      conversationId: draft.conversationId,
      isNew: false,
    });
    // Addressed to whoever wrote in, carrying what was approved.
    expect(outbound.email).toMatchObject({
      to: "tester@example.com",
      subject: DRAFT.subject,
      body: DRAFT.body,
      direction: "outbound",
    });

    // That draft, not some other artifact.
    expect(sending.said("mark-sent")).toMatchObject({
      id: draft.id,
      status: "sent",
    });

    const conversation = (
      await at("review", "all-conversations", {})
    ).said("all-conversations").conversations[0];
    expect(conversation.state).toBe("waiting-reply");
  });

  it("files the demo enquiry the Injector holds", async () => {
    // What the facade's "File demo enquiry" button does: the text lives in the
    // board, so the loop can be driven with one press and no typing.
    const { at } = await loadBoard(ANSWER);

    const filed = await at("test", "demo-enquiry", {});
    const conversation = filed.said("file-test-mail");

    expect(conversation).toMatchObject({ state: "init", isNew: true });
    expect(conversation.email.body).toContain("Ost Berlin");
    expect(conversation.email.body).toContain("Christoph");
  });

  it("does not repeat an action it has already taken", async () => {
    // The poll now selects every working state, so the manager is asked again
    // on every tick. What stops the work being redone is the manager seeing
    // what is already on file and choosing the next thing instead.
    const { model, at } = await loadBoard(ANSWER);

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});
    await at("dispatch", "poll", {});

    // Two decisions, and two different actions followed them.
    const decisions = model.seen.filter(
      (call: any) => call.response_format?.json_schema?.schema?.properties?.action,
    );
    expect(decisions).toHaveLength(2);
    // One extraction, from the first pass; the second pass drafted instead.
    expect((await at("review", "extractions", {})).said("extractions").count).toBe(1);
    expect((await at("review", "drafts", {})).said("drafts").count).toBe(1);
  });

  it("ignores a message it has already filed", async () => {
    const { at } = await loadBoard(ANSWER);

    const envelope = {
      messageId: "a@example.com",
      from: "anna@example.com",
      to: "buchung@syn.example",
      subject: "Anfrage",
      text: ENQUIRY,
      references: [],
      inReplyTo: "",
    };

    const first = await at("intake", "file-mail", envelope);
    expect(first.said("file-mail").isNew).toBe(true);

    // What an IMAP re-delivery looks like: nothing to pass on.
    const again = await at("intake", "file-mail", envelope);
    expect(again.said("file-mail")).toMatchObject({ stored: false });
  });

  it("puts a reply in the conversation it answers", async () => {
    const { at } = await loadBoard(ANSWER);

    const first = await at("intake", "file-mail", {
      messageId: "a@example.com",
      from: "anna@example.com",
      subject: "Anfrage",
      text: ENQUIRY,
      references: [],
      inReplyTo: "",
    });

    const reply = await at("intake", "file-mail", {
      messageId: "b@example.com",
      from: "anna@example.com",
      subject: "Re: Anfrage",
      text: "Zwei Zimmer bitte.",
      references: ["a@example.com"],
      inReplyTo: "a@example.com",
    });

    expect(reply.said("file-mail").conversationId).toBe(
      first.said("file-mail").conversationId,
    );
    expect(reply.said("file-mail").isNew).toBe(false);

    // And the thread the model would be shown has both, oldest first.
    await at("dispatch", "poll", {});
    const conversations = await at("review", "all-conversations", {});
    expect(conversations.said("all-conversations").count).toBe(1);
  });

  it("processes every waiting conversation on one poll", async () => {
    // What the Iterator is in the board for: one tick, several conversations.
    const { model, at } = await loadBoard(ANSWER);

    await at("test", "compose", { text: ENQUIRY });
    await at("test", "compose", { text: "Ein Doppelzimmer am 1.12.2026." });
    await at("test", "compose", { text: "Drei Zimmer, Anreise 2027-01-05." });

    await at("dispatch", "poll", {});

    // Two calls per conversation: the decision, then the action it chose.
    expect(model.seen).toHaveLength(6);
    const listed = (await at("review", "extractions", {})).said("extractions");
    expect(listed.count).toBe(3);
    // Three conversations, three separate extractions, all of them filed.
    expect(
      new Set(listed.artifacts.map((a: any) => a.conversationId)).size,
    ).toBe(3);
  });
});

describe("the board file itself", () => {
  it("stops every runtime that would otherwise feed the next one", () => {
    // Runtimes chain: what one produces becomes the next one's input. Each
    // stage here is triggered on its own, so each must end deliberately.
    for (const runtime of board.runtimes) {
      const services = board.services[runtime.id];
      expect(services.length, `runtime '${runtime.id}' is empty`).toBeGreaterThan(0);
      expect(
        services[services.length - 1].serviceId,
        `runtime '${runtime.id}' does not end with a stopper`,
      ).toBe("stopper");
    }
  });

  it("names only services this runtime actually has", async () => {
    const server = createRuntimeServer({
      externalHost: "127.0.0.1",
      auth: { mode: "none" },
    });
    servers.push(server);
    await server.start();

    const registry = (await request(server.httpServer).get("/runtimes")).body
      .registry as Array<{ serviceId: string }>;
    const known = new Set(registry.map((entry) => entry.serviceId));

    const walk = (services: Array<Record<string, any>>, where: string) => {
      for (const service of services) {
        expect(known, `${where}/${service.uuid} → ${service.serviceId}`).toContain(
          service.serviceId,
        );
        const nested = service.state?.pipeline;
        if (Array.isArray(nested)) {
          walk(nested, `${where}/${service.uuid}`);
        }
      }
    };

    for (const runtime of board.runtimes) {
      walk(board.services[runtime.id], runtime.id);
    }
  });
});
