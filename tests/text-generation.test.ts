import http from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextGenerationService } from "../src/services/text-generation";
import { RuntimeHost } from "../src/types";

/**
 * What the service puts on the wire, and what it hands the rest of the board.
 *
 * Run against a stand-in for the API rather than the API itself: the parts that
 * can be wrong here are the request shape and the reduction back to the shared
 * output contract, and both are visible without spending a token.
 */

type Recorded = { url: string; headers: http.IncomingHttpHeaders; body: any };

type Endpoint = {
  url: string;
  received: Recorded[];
  close: () => Promise<void>;
};

/** Answers like the messages API, and records what it was asked. */
async function startEndpoint(
  reply: (body: any) => { status?: number; json?: unknown; sse?: string[] },
): Promise<Endpoint> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        body = {};
      }
      received.push({ url: req.url ?? "", headers: req.headers, body });

      const answer = reply(body);
      if (answer.sse) {
        res.writeHead(answer.status ?? 200, { "content-type": "text/event-stream" });
        for (const event of answer.sse) {
          res.write(`data: ${event}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const endpoints: Endpoint[] = [];

afterEach(async () => {
  while (endpoints.length) {
    await endpoints.pop()?.close();
  }
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // A key in the developer's own environment would otherwise decide what these
  // tests are testing.
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});

async function endpoint(
  reply: Parameters<typeof startEndpoint>[0],
): Promise<Endpoint> {
  const created = await startEndpoint(reply);
  endpoints.push(created);
  return created;
}

/** Captures what the service pushes through the rest of the pipeline. */
function hostSpy() {
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
    scope: () => ({ owner: "tester", boardName: "Board" }),
    emitResult: (output) => {
      emitted.push(output);
    },
  };
  return { host, pushed, emitted };
}

function serviceWith(state: Record<string, unknown>) {
  const { host, pushed, emitted } = hostSpy();
  const service = new TextGenerationService({
    uuid: "llm-1",
    serviceId: "text-generation",
    state,
  } as any);
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

const ANSWER = {
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "Blue." }],
  usage: { input_tokens: 12, output_tokens: 3 },
};

describe("text-generation request", () => {
  it("asks as the user and states the system prompt as a parameter", async () => {
    // A system prompt is not a message with a role here; sending it as one
    // would put it in the conversation rather than above it.
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({
      serverUrl: api.url,
      apiKey: "sk-test",
      systemPrompt: "Answer in one word.",
      stream: false,
    });

    t.service.process("What colour is the sky?", t.notify);
    await settled(t.pushed);

    expect(api.received[0].body.messages).toEqual([
      { role: "user", content: "What colour is the sky?" },
    ]);
    expect(api.received[0].body.system).toBe("Answer in one word.");
  });

  it("identifies itself with the key and a pinned API version", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process("hi", t.notify);
    await settled(t.pushed);

    expect(api.received[0].headers["x-api-key"]).toBe("sk-test");
    expect(api.received[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("passes a conversation through as it was given", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process(
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      },
      t.notify,
    );
    await settled(t.pushed);

    expect(api.received[0].body.messages).toHaveLength(3);
  });

  it("reads an image that arrived from elsewhere in the board", async () => {
    // The shape http-client and http-server-subservices produce, so a scan can
    // be piped straight in.
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process(
      {
        meta: { contentType: "image/png" },
        binary: new Uint8Array([1, 2, 3]),
        prompt: "What is this?",
      },
      t.notify,
    );
    await settled(t.pushed);

    const [image, text] = api.received[0].body.messages[0].content;
    expect(image.type).toBe("image");
    expect(image.source.media_type).toBe("image/png");
    expect(image.source.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    // The question comes after what it is about.
    expect(text).toEqual({ type: "text", text: "What is this?" });
  });

  it("leaves sampling alone while the model is reasoning", async () => {
    // Sampling is fixed during extended thinking and sending any of the three
    // is rejected outright, so they have to be absent rather than defaulted.
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({
      serverUrl: api.url,
      apiKey: "sk-test",
      stream: false,
      thinking: true,
      thinkingBudgetTokens: 2048,
      maxTokens: 512,
    });

    t.service.process("think about it", t.notify);
    await settled(t.pushed);

    const body = api.received[0].body;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    // Reasoning draws on the same budget as the answer, so a ceiling at or
    // below it would leave nothing to answer with.
    expect(body.max_tokens).toBeGreaterThan(2048);
  });
});

describe("text-generation output", () => {
  it("reports what the shared contract promises", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process("hi", t.notify);
    const result = await settled(t.pushed);

    expect(result.text).toBe("Blue.");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
    expect(typeof result.durationMs).toBe("number");
  });

  it("separates reasoning from the answer", async () => {
    const api = await endpoint(() => ({
      json: {
        model: "claude-sonnet-5",
        content: [
          { type: "thinking", thinking: "the sky scatters blue" },
          { type: "text", text: "Blue." },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process("why", t.notify);
    const result = await settled(t.pushed);

    expect(result.text).toBe("Blue.");
    expect(result.thinking).toBe("the sky scatters blue");
  });

  it("stops the push and hands the answer over when it arrives", async () => {
    // Generation takes seconds; the pass it started in returned long before.
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    expect(t.service.process("hi", t.notify)).toBeNull();

    await settled(t.pushed);
    expect(await settled(t.emitted)).toMatchObject({ text: "Blue." });
  });
});

describe("text-generation streaming", () => {
  it("notifies the answer as it is written, then says it is done", async () => {
    const api = await endpoint(() => ({
      sse: [
        JSON.stringify({
          type: "message_start",
          message: { model: "claude-sonnet-5", usage: { input_tokens: 5 } },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Bl" },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ue." },
        }),
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } }),
        JSON.stringify({ type: "message_stop" }),
      ],
    }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: true });

    t.service.process("hi", t.notify);
    const result = await settled(t.pushed);

    expect(api.received[0].body.stream).toBe(true);
    expect(result.text).toBe("Blue.");
    // Usage is reported across two events, so it only adds up if both are read.
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
    expect(t.notifications).toContainEqual({
      streamText: "Blue.",
      streamDone: true,
    });
  });
});

describe("text-generation schema", () => {
  it("asks for the shape as a tool it must use", async () => {
    const schema = {
      type: "object",
      properties: { hotel: { type: "string" } },
      required: ["hotel"],
    };
    const api = await endpoint(() => ({
      json: {
        model: "claude-sonnet-5",
        content: [
          { type: "tool_use", name: "respond", input: { hotel: "Adlon" } },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      },
    }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", jsonSchema: schema });

    t.service.process("extract it", t.notify);
    const result = await settled(t.pushed);

    const body = api.received[0].body;
    expect(body.tools[0].input_schema).toEqual(schema);
    expect(body.tool_choice).toEqual({ type: "tool", name: "respond" });
    // Partial arguments are of no use to anyone, so a constrained answer does
    // not stream even with streaming on.
    expect(body.stream).toBe(false);

    expect(result.json).toEqual({ hotel: "Adlon" });
    // And still readable by a board that only knows the shared contract.
    expect(JSON.parse(result.text)).toEqual({ hotel: "Adlon" });
  });

  it("takes a schema a hand-written board carries as text", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({
      serverUrl: api.url,
      apiKey: "sk-test",
      jsonSchema: '{"type":"object"}',
    });

    t.service.process("go", t.notify);
    await settled(t.pushed);

    expect(api.received[0].body.tools[0].input_schema).toEqual({ type: "object" });
  });

  it("drops the constraint when a board clears it", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({
      serverUrl: api.url,
      apiKey: "sk-test",
      stream: false,
      jsonSchema: { type: "object" },
    });

    t.service.configure({ jsonSchema: null });
    t.service.process("go", t.notify);
    await settled(t.pushed);

    expect(api.received[0].body.tools).toBeUndefined();
  });
});

describe("text-generation credentials", () => {
  it("never gives the key back", async () => {
    const t = serviceWith({ apiKey: "sk-secret" });

    const state = t.service.getState();
    expect(state.apiKey).toBe("");
    expect(state.apiKeyConfigured).toBe(true);
  });

  it("keeps the key when a UI sends the masked field back", async () => {
    // The state a client holds has apiKey: "", and it configures with what it
    // holds. Reading that as "clear it" would log the board out on any edit.
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.configure({ apiKey: "", temperature: 0.1 });
    t.service.process("hi", t.notify);
    await settled(t.pushed);

    expect(api.received[0].headers["x-api-key"]).toBe("sk-test");
  });

  it("takes the key from the environment when the board carries none", async () => {
    // What a deployed board does, so the credential never enters the board.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-env");
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, stream: false });

    t.service.process("hi", t.notify);
    await settled(t.pushed);

    expect(api.received[0].headers["x-api-key"]).toBe("sk-from-env");
  });

  it("says so rather than calling without one", async () => {
    const t = serviceWith({ serverUrl: "http://127.0.0.1:1" });

    expect(t.service.process("hi", t.notify)).toBeNull();
    expect(t.notifications).toContainEqual({ status: "error" });
    expect(
      t.notifications.some(
        (n: any) => typeof n?.error === "string" && n.error.includes("ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });

  it("keeps the reason where somebody can still read it", async () => {
    // A notification is gone the moment nobody is looking, and this board is
    // meant to run with nobody looking.
    const t = serviceWith({ serverUrl: "http://127.0.0.1:1" });

    t.service.process("hi", t.notify);

    const state = t.service.getState();
    expect(state.status).toBe("error");
    expect(String(state.error)).toContain("ANTHROPIC_API_KEY");
  });

  it("stops complaining once it works", async () => {
    const api = await endpoint(() => ({ json: ANSWER }));
    const t = serviceWith({ serverUrl: api.url, stream: false });

    t.service.process("hi", t.notify);
    expect(String(t.service.getState().error)).toContain("ANTHROPIC_API_KEY");

    t.service.configure({ apiKey: "sk-test" });
    t.service.process("hi", t.notify);
    await settled(t.pushed);

    expect(t.service.getState().error).toBe("");
    expect(t.service.getState().status).toBe("idle");
  });
});

describe("text-generation failure", () => {
  it("reports what the API refused and passes nothing on", async () => {
    // A fabricated result would be worse than none: the board behind this would
    // process it as though the model had answered.
    const api = await endpoint(() => ({
      status: 429,
      json: { error: { type: "rate_limit_error", message: "slow down" } },
    }));
    const t = serviceWith({ serverUrl: api.url, apiKey: "sk-test", stream: false });

    t.service.process("hi", t.notify);
    await settled(t.notifications);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(t.pushed).toEqual([]);
    expect(
      t.notifications.some(
        (n: any) => typeof n?.error === "string" && n.error.includes("429"),
      ),
    ).toBe(true);
  });

  it("refuses input it cannot read as a prompt", async () => {
    const t = serviceWith({ apiKey: "sk-test" });

    expect(t.service.process({ unrelated: true }, t.notify)).toBeNull();
    expect(
      t.notifications.some(
        (n: any) => typeof n?.error === "string" && n.error.includes("messages"),
      ),
    ).toBe(true);
  });

  it("passes on nothing at all rather than an empty answer", async () => {
    const t = serviceWith({ apiKey: "sk-test" });

    expect(t.service.process(null, t.notify)).toBeNull();
    expect(t.notifications).toEqual([]);
  });
});

/**
 * The other backend: an OpenAI-compatible server on the same machine.
 *
 * Everything a board configures means the same thing on both, so what these
 * check is the translation — and the one place the two must *not* behave
 * alike, which is the credential.
 */

const CHAT_ANSWER = {
  model: "qwen3-0.6b",
  choices: [{ message: { content: "Blue." } }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
};

describe("text-generation server backend", () => {
  it("asks a chat-completions server, in its own vocabulary", async () => {
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      model: "qwen3-0.6b",
      systemPrompt: "Answer in one word.",
      stream: false,
      maxTokens: 64,
    });

    t.service.process("What colour is the sky?", t.notify);
    const result = await settled(t.pushed);

    expect(server.received[0].url).toBe("/v1/chat/completions");
    expect(server.received[0].body).toMatchObject({
      model: "qwen3-0.6b",
      max_tokens: 64,
      // A system prompt is a message here, not a parameter.
      messages: [
        { role: "system", content: "Answer in one word." },
        { role: "user", content: "What colour is the sky?" },
      ],
    });
    expect(result).toMatchObject({
      text: "Blue.",
      model: "qwen3-0.6b",
      usage: { promptTokens: 12, completionTokens: 3 },
    });
  });

  it("never sends the hosted API's key to an address a board named", async () => {
    // The env key exists for the anthropic backend. A board pointing `server`
    // at any URL it likes would otherwise hand that credential to whatever is
    // listening there.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    t.service.process("hello", t.notify);
    await settled(t.pushed);

    expect(server.received[0].headers.authorization).toBeUndefined();
    expect(JSON.stringify(server.received[0])).not.toContain("sk-ant-secret");
  });

  it("runs without any key at all", async () => {
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    // The anthropic backend refuses here; a local server is reached by
    // address, so there is nothing to be missing.
    expect(t.service.process("hello", t.notify)).toBeNull();
    await settled(t.pushed);
    expect(server.received).toHaveLength(1);
  });

  it("asks for a schema as a response format, and parses what comes back", async () => {
    const schema = {
      type: "object",
      properties: { hotel: { type: "string" }, rooms: { type: "integer" } },
      required: ["hotel", "rooms"],
    };
    const server = await endpoint(() => ({
      json: {
        model: "qwen3-0.6b",
        choices: [
          {
            message: { content: '{"hotel":"Mercure","rooms":3}' },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      jsonSchema: schema,
    });

    t.service.process("Two rooms at the Mercure", t.notify);
    const result = await settled(t.pushed);

    expect(server.received[0].body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "respond", schema },
    });
    // Not `strict`: that reading also demands every property be required and
    // additionalProperties be false, which this schema — two required fields
    // out of several — is not, and boards write schemas like this one.
    expect(server.received[0].body.response_format.json_schema.strict).toBeUndefined();
    // Same output contract as the forced-tool path on the anthropic backend.
    expect(result.json).toEqual({ hotel: "Mercure", rooms: 3 });
    expect(result.text).toBe('{"hotel":"Mercure","rooms":3}');
  });

  it("still hands over the answer when a server ignores the schema", async () => {
    // Not every OpenAI-compatible server implements response_format, and one
    // that does not answers in prose while reporting nothing unusual.
    const warnings: unknown[] = [];
    const server = await endpoint(() => ({
      json: {
        model: "qwen3-0.6b",
        choices: [{ message: { content: "Three rooms, at the Mercure." } }],
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      jsonSchema: { type: "object" },
    });
    (t.service as any).host.log = (level: string, event: string, data: unknown) => {
      warnings.push({ level, event, data });
    };

    t.service.process("Two rooms at the Mercure", t.notify);
    const result = await settled(t.pushed);

    expect(result.json).toBeUndefined();
    expect(result.text).toBe("Three rooms, at the Mercure.");
    expect(warnings).toHaveLength(1);
  });

  it("streams token by token, reporting the growing text", async () => {
    const server = await endpoint(() => ({
      sse: [
        JSON.stringify({ model: "qwen3-0.6b", choices: [{ delta: { content: "Bl" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "ue." } }] }),
        JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        "[DONE]",
      ],
    }));
    const t = serviceWith({ backend: "server", serverUrl: server.url });

    t.service.process("What colour is the sky?", t.notify);
    const result = await settled(t.pushed);

    expect(server.received[0].body.stream).toBe(true);
    expect(result).toMatchObject({
      text: "Blue.",
      usage: { promptTokens: 5, completionTokens: 2 },
    });
    expect(t.notifications).toContainEqual({ streamText: "Blue.", streamDone: true });
  });

  it("separates reasoning from the answer, however the server reports it", async () => {
    const server = await endpoint(() => ({
      json: {
        model: "qwen3-0.6b",
        choices: [
          {
            message: { content: "<think>Sky is blue.</think>Blue." },
          },
        ],
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    t.service.process("What colour is the sky?", t.notify);
    const result = await settled(t.pushed);

    expect(result.text).toBe("Blue.");
    expect(result.thinking).toBe("Sky is blue.");
  });

  it("says what to do when nothing is listening", async () => {
    const t = serviceWith({
      backend: "server",
      serverUrl: "http://127.0.0.1:1",
      stream: false,
      timeoutSec: 5,
    });

    const failures: any[] = [];
    t.service.process("hello", (payload: any) => {
      t.notifications.push(payload);
      if (typeof payload?.error === "string") {
        failures.push(payload);
      }
    });

    const reported = await settled(failures);
    expect(reported.error).toContain("no OpenAI-compatible server reachable");
    // The suggestion names the port the board actually configured.
    expect(reported.error).toContain("--port 1");
    expect(t.service.getState().status).toBe("error");
  });
});

describe("text-generation server address", () => {
  it("adds the API version to a bare origin", async () => {
    // What a local server hands out: an origin, serving the API at its root.
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    t.service.process("hello", t.notify);
    await settled(t.pushed);

    expect(server.received[0].url).toBe("/v1/chat/completions");
  });

  it("does not add it twice to a base URL that already carries one", async () => {
    // What a hosted provider hands out, e.g. https://…/api/v1 — appending
    // another /v1 reaches nothing, and the 404 says nothing about why.
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: `${server.url}/api/v1`,
      stream: false,
    });

    t.service.process("hello", t.notify);
    await settled(t.pushed);

    expect(server.received[0].url).toBe("/api/v1/chat/completions");
  });

  it("sends a configured key as a bearer token", async () => {
    const server = await endpoint(() => ({ json: CHAT_ANSWER }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      apiKey: "hosted-token",
      stream: false,
    });

    t.service.process("hello", t.notify);
    await settled(t.pushed);

    expect(server.received[0].headers.authorization).toBe("Bearer hosted-token");
    // Still write-only: what a board configured never comes back out.
    expect(t.service.getState().apiKey).toBe("");
    expect(t.service.getState().apiKeyConfigured).toBe(true);
  });
});

describe("text-generation empty answers", () => {
  it("fails rather than passing on an answer that is nothing", async () => {
    // A model that reasons before answering can spend its whole budget doing
    // so. What comes back is a well-formed response carrying no answer, and
    // passing it on lets a board settle work it never did.
    const server = await endpoint(() => ({
      json: {
        model: "Qwen3",
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 101, completion_tokens: 1024 },
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      maxTokens: 1024,
      stream: false,
    });

    const failures: any[] = [];
    t.service.process("Two rooms at the Mercure", (payload: any) => {
      if (typeof payload?.error === "string") {
        failures.push(payload);
      }
    });

    const failure = await settled(failures);
    expect(failure.error).toContain("used all 1024 tokens without answering");
    // Nothing reached the rest of the pipeline, so nothing downstream can
    // mistake this for a completed job.
    expect(t.pushed).toEqual([]);
    expect(t.service.getState().status).toBe("error");
  });

  it("reports why an answer stopped when it did produce something", async () => {
    const server = await endpoint(() => ({
      json: {
        model: "Qwen3",
        choices: [
          { message: { content: "Two rooms at the" }, finish_reason: "length" },
        ],
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    t.service.process("hello", t.notify);
    const result = await settled(t.pushed);

    expect(result.text).toBe("Two rooms at the");
    expect(result.finishReason).toBe("length");
  });

  it("says nothing about the finish reason when the answer simply ended", async () => {
    const server = await endpoint(() => ({
      json: {
        model: "Qwen3",
        choices: [{ message: { content: "Blue." }, finish_reason: "stop" }],
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      stream: false,
    });

    t.service.process("hello", t.notify);
    const result = await settled(t.pushed);

    expect(result.finishReason).toBeUndefined();
  });
});

/**
 * One address, resolved against the backend in use.
 *
 * One field, because only one address is ever in use — a second would mean a
 * board carrying the address of a service it is not talking to. `endpoint` is
 * read-only and says where a configuration actually reaches, including the API
 * version, which the address alone does not answer.
 */
describe("text-generation address", () => {
  it("goes to the backend's own address when a board says nothing", () => {
    expect(serviceWith({ backend: "anthropic" }).service.getState().endpoint).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(serviceWith({ backend: "server" }).service.getState().endpoint).toBe(
      "http://127.0.0.1:8081/v1/chat/completions",
    );
  });

  it("follows the backend when one is switched, carrying nothing across", () => {
    // The reason the default is resolved at use rather than stored: a board
    // that never chose an address must not inherit the other backend's.
    const t = serviceWith({ backend: "anthropic" });

    t.service.configure({ backend: "server" });
    expect(t.service.getState().endpoint).toBe(
      "http://127.0.0.1:8081/v1/chat/completions",
    );

    t.service.configure({ backend: "anthropic" });
    expect(t.service.getState().endpoint).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("keeps an address a board did choose", () => {
    const t = serviceWith({
      backend: "server",
      serverUrl: "https://inference.example.com/api/v1",
    });

    expect(t.service.getState().endpoint).toBe(
      "https://inference.example.com/api/v1/chat/completions",
    );
  });

  it("hands the address back to the backend when cleared", () => {
    const t = serviceWith({ backend: "server", serverUrl: "http://elsewhere:9000" });

    // Empty is a value here, not an omission — unlike every other string.
    t.service.configure({ serverUrl: "" });

    expect(t.service.getState().serverUrl).toBe("");
    expect(t.service.getState().endpoint).toBe(
      "http://127.0.0.1:8081/v1/chat/completions",
    );
  });


});

describe("text-generation reporting", () => {
  it("reports an empty schema answer once, as a failure", async () => {
    // The parse of "" fails too. Warning about that *and* failing would say
    // the same thing twice, in two places, with two different wordings.
    const logged: unknown[] = [];
    const server = await endpoint(() => ({
      json: {
        model: "Qwen3",
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      },
    }));
    const t = serviceWith({
      backend: "server",
      serverUrl: server.url,
      jsonSchema: { type: "object" },
      stream: false,
    });
    (t.service as any).host.log = (_l: string, event: string) => {
      logged.push(event);
    };

    const failures: any[] = [];
    t.service.process("hello", (payload: any) => {
      if (typeof payload?.error === "string") {
        failures.push(payload);
      }
    });
    await settled(failures);

    expect(logged).toEqual(["service.failed"]);
    expect(logged).not.toContain("service.degraded");
  });
});
