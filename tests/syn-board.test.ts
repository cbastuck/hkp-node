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
 * offline. The board makes two model calls with different schemas — an
 * extraction and a drafted reply — and the schema is what tells them apart.
 */
async function startModel(answer: Record<string, unknown>) {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const asked = JSON.parse(body || "{}");
      seen.push(asked);
      const drafting =
        asked.response_format?.json_schema?.schema?.properties?.subject !==
        undefined;
      const said = drafting ? DRAFT : answer;
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

async function loadBoard(answer: Record<string, unknown>) {
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
    const services = pointedAt(board.services[runtime.id], model.url);
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

    // 2. What "Poll now" does: find it, read the thread, extract, file, advance.
    const polled = await at("dispatch", "poll", {});
    expect(polled.status).toBe(200);

    // The model was actually asked, and asked about this conversation.
    expect(model.seen).toHaveLength(1);
    const asked = model.seen[0] as any;
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

    // 4. What "2 · Draft follow-up" does: a second model turn writes the reply.
    await at("followup", "poll-followup", {});

    expect(model.seen).toHaveLength(2);
    const drafting = model.seen[1] as any;
    expect(
      drafting.response_format?.json_schema?.schema?.properties,
    ).toHaveProperty("subject");

    // It was told what is missing — read back out of the extraction that the
    // first turn recorded, by a `list-artifacts` nested two levels deep. That
    // lookup silently found nothing until the runtime handed the board's scope
    // all the way down, and the prompt then said "(unknown)".
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

    // The drafting poll selects `needs-follow-up`, so this one is not its work.
    await at("followup", "poll-followup", {});
    expect(model.seen).toHaveLength(1);
    expect((await at("review", "drafts", {})).said("drafts").count).toBe(0);
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

  it("does not extract the same conversation twice", async () => {
    // `poll` selects `init`, and the first pass moved this one on. Without that
    // the board would re-ask the model on every tick of a 30-second timer.
    const { model, at } = await loadBoard(ANSWER);

    await at("test", "compose", { text: ENQUIRY });
    await at("dispatch", "poll", {});
    await at("dispatch", "poll", {});

    expect(model.seen).toHaveLength(1);
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

    expect(model.seen).toHaveLength(3);
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
