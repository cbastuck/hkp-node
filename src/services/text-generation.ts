/**
 * Service Documentation
 * Service ID: text-generation
 * Service Name: Text Generation
 * Runtime: hkp-node
 * Modes: none (the backend is configuration, not a mode)
 * Key Config: backend (anthropic|server), apiKey (write-only), serverUrl
 *             (empty = the backend's own address), model, systemPrompt,
 *             temperature, topP, topK, maxTokens, timeoutSec, stream,
 *             thinking, thinkingBudgetTokens, jsonSchema
 * IO: in=String (the prompt) or JSON ({prompt} | {text} | {messages: [...]}),
 *     optionally carrying images ({meta, binary} | {images: [...]})
 *     out=null immediately; the result is pushed through the rest of the
 *     pipeline when it arrives, shaped
 *     { text, json?, thinking?, model, durationMs,
 *       usage: { promptTokens, completionTokens } }
 *
 * The node implementation of the `text-generation` concept hkp-python and
 * hkp-rt also provide, sharing their state contract and output shape so a board
 * can move the service between runtimes and keep its UI panel.
 *
 * Two backends, and which one a board wants is a question of where the model
 * is:
 *
 *   - `anthropic` calls a hosted API. The one that works on a board deployed to
 *     a coordinator with nobody watching, since there is no model to run.
 *   - `server` talks to an OpenAI-compatible server on the same machine
 *     (llama-server, Ollama, vLLM, LM Studio), the same backend hkp-python and
 *     hkp-rt spell `server` — so a board can be developed against a local model
 *     and deployed against a hosted one by changing two fields.
 *
 * Node cannot load a GGUF in-process the way those two can, which is why there
 * is no `local` here: on this runtime, local means a server next door.
 *
 * Three things `anthropic` adds, which the local backends have no equivalent
 * for — except `jsonSchema`, which `server` carries too where the server
 * implements it (llama.cpp does, by turning the schema into a grammar):
 *
 *   - `jsonSchema` constrains the answer to a shape. Sent as a single forced
 *     tool, which is the API's own mechanism for it, and the parsed object is
 *     emitted as `json` beside the `text`.
 *   - Images in the input become vision parts, so a scan that arrives from
 *     `http-client` or an attachment can be read directly.
 *   - `thinking` turns on extended reasoning, reported in the `thinking` field
 *     the shared output contract already carries.
 *
 * The API key is write-only in the same way `smtp-email` treats its password:
 * `configure` accepts it, `getState` never gives it back. It also falls back to
 * ANTHROPIC_API_KEY in the runtime's environment, which is how a deployed board
 * avoids carrying a credential at all.
 */
import { referencedSecrets } from "../secrets";
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const textGenerationDescriptor: ServiceRegistryEntry = {
  serviceId: "text-generation",
  serviceName: "Text Generation",
  version: "v1",
  capabilities: [],
};

/** Backends this runtime can talk to. */
const BACKENDS = ["anthropic", "server"];

/**
 * Where each backend goes when a board does not say.
 *
 * The address is one field, `serverUrl`, because only one is ever in use —
 * two would mean a board carrying the address of a service it is not talking
 * to, which reads like configuration and is not. Left empty it means "wherever
 * this backend lives", which is what makes switching backends work: a default
 * is resolved when the request is made rather than written into the board, so
 * nothing stale is carried across the switch.
 */
const DEFAULT_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  // Where llama-server and friends listen; the port hkp-python uses too.
  server: "http://127.0.0.1:8081",
};
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_TOP_K = 20;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_THINKING_BUDGET_TOKENS = 1024;

/** Pinned: the API is versioned by header, and an unpinned client breaks. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The tool a schema-constrained answer is asked for through.
 *
 * A forced tool call is the API's mechanism for constraining output to a shape:
 * the schema becomes the tool's parameters, and the model's arguments are the
 * answer. The name is arbitrary but reaches the model, so it reads as an
 * instruction rather than as an internal identifier.
 */
const SCHEMA_TOOL_NAME = "respond";

/** Reasoning inline in the answer, which is how some chat templates emit it. */
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Notifications are throttled to this, which is plenty for a live view. */
const STREAM_NOTIFY_INTERVAL_MS = 50;

type Message = { role: string; content: unknown };

type Result = {
  text: string;
  json?: unknown;
  thinking?: string;
  /** Only when the answer did not simply end: "length", "content_filter", … */
  finishReason?: string;
  model: string;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number };
};

type Notify = (payload: unknown, instanceId?: string) => void;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** An image part the API accepts, from bytes plus what they are. */
function imagePart(bytes: Uint8Array, mediaType: string): JsonRecord {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

export class TextGenerationService implements HostedService {
  readonly serviceId = textGenerationDescriptor.serviceId;
  readonly serviceName = textGenerationDescriptor.serviceName;
  readonly version = textGenerationDescriptor.version;
  readonly capabilities = textGenerationDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private backend = "anthropic";
  /**
   * A `{{secret.<alias>}}` reference, or a literal key for a runtime
   * configured from a file. Never a value resolved from a reference: it is
   * reported as it stands, so a board saved from this service names its
   * credential rather than carrying it.
   */
  private apiKey = "";
  /** Empty means the backend's own address; see DEFAULT_URLS. */
  private serverUrl = "";
  private model = DEFAULT_MODEL;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private temperature = DEFAULT_TEMPERATURE;
  private topP = DEFAULT_TOP_P;
  private topK = DEFAULT_TOP_K;
  private maxTokens = DEFAULT_MAX_TOKENS;
  private timeoutSec = DEFAULT_TIMEOUT_SEC;
  private stream = true;
  // null = off and unsaid, matching the local backends' three-state field.
  private thinking: boolean | null = null;
  private thinkingBudgetTokens = DEFAULT_THINKING_BUDGET_TOKENS;
  private jsonSchema: JsonRecord | null = null;
  private status = "idle";
  /**
   * Why the last attempt failed, kept rather than only notified.
   *
   * A notification is gone the moment nobody is looking, and the board this
   * runs on is meant to run with nobody looking. Keeping it in state means the
   * reason is still there when somebody comes back and opens the panel.
   */
  private lastError = "";

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState(): JsonRecord {
    const state: JsonRecord = {
      backend: this.backend,
      // Reported as configured. Where that is a reference it names a secret
      // and holds nothing, and where it is a literal key it is one the board
      // already carried; either way there is nothing here to hide.
      apiKey: this.apiKey,
      apiKeyConfigured: this.hasKey(),
      serverUrl: this.serverUrl,
      // Read-only, and the point of it: which address this configuration
      // actually reaches, without having to know how a backend spells one.
      endpoint: this.endpoint(),
      model: this.model,
      systemPrompt: this.systemPrompt,
      temperature: this.temperature,
      topP: this.topP,
      topK: this.topK,
      maxTokens: this.maxTokens,
      timeoutSec: this.timeoutSec,
      stream: this.stream,
      thinking: this.thinking,
      thinkingBudgetTokens: this.thinkingBudgetTokens,
      jsonSchema: this.jsonSchema,
      status: this.status,
      error: this.lastError,
    };

    // A setting this service overrides has to say so. The values stay whatever
    // the board set — rewriting them would lose the board author's intent, and
    // saving would then persist a value they never chose — but a field reading
    // one way over a request that says another is the UI telling a lie the
    // service is the only thing in a position to correct.
    const meta: JsonRecord = {};
    if (this.jsonSchema) {
      meta.stream = {
        type: "boolean",
        data: {
          note:
            "Off while a JSON schema is set: half a JSON object is of no use " +
            "to anything, so the answer is waited for whole.",
        },
      };
    }
    if (this.backend === "anthropic") {
      meta.topP = {
        type: "number",
        data: {
          note:
            "Not sent to this backend, which rejects a request carrying both " +
            "temperature and top_p. Temperature is the one sent.",
        },
      };
    }
    if (Object.keys(meta).length > 0) {
      state.__meta__ = meta;
    }

    return state;
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.backend === "string" && BACKENDS.includes(config.backend)) {
      this.backend = config.backend;
    }
    // Nothing masks this any more, so an empty string is not something a UI
    // round-trips back — it means what it says, and clears the key.
    if (typeof config.apiKey === "string") {
      this.apiKey = config.apiKey;
    }
    if (typeof config.serverUrl === "string") {
      // An empty string is meaningful — it hands the address back to the
      // backend — so unlike the other strings it is not ignored.
      this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    }
    if (typeof config.model === "string" && config.model) {
      this.model = config.model;
    }
    if (typeof config.systemPrompt === "string") {
      this.systemPrompt = config.systemPrompt;
    }
    if (isNumber(config.temperature)) {
      this.temperature = config.temperature;
    }
    if (isNumber(config.topP)) {
      this.topP = config.topP;
    }
    if (isNumber(config.topK)) {
      this.topK = Math.trunc(config.topK);
    }
    if (isNumber(config.maxTokens) && config.maxTokens > 0) {
      this.maxTokens = Math.trunc(config.maxTokens);
    }
    if (isNumber(config.timeoutSec) && config.timeoutSec > 0) {
      this.timeoutSec = config.timeoutSec;
    }
    if (typeof config.stream === "boolean") {
      this.stream = config.stream;
    }
    if ("thinking" in config) {
      const value = config.thinking;
      if (typeof value === "boolean" || value === null) {
        this.thinking = value;
      }
    }
    if (isNumber(config.thinkingBudgetTokens) && config.thinkingBudgetTokens > 0) {
      this.thinkingBudgetTokens = Math.trunc(config.thinkingBudgetTokens);
    }
    if ("jsonSchema" in config) {
      const value = config.jsonSchema;
      if (value === null || value === "") {
        this.jsonSchema = null;
      } else if (typeof value === "object" && !Array.isArray(value)) {
        this.jsonSchema = value as JsonRecord;
      } else if (typeof value === "string") {
        // Boards written by hand tend to carry the schema as a JSON string.
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.jsonSchema = parsed as JsonRecord;
          }
        } catch {
          // Left as it was: a schema that does not parse is a board bug worth
          // reporting when it runs, not a reason to silently drop the old one.
        }
      }
    }
    return this.getState();
  }

  /**
   * Answers with what the model said.
   *
   * The runtime awaits each service, so generation taking seconds to minutes is
   * a reason to wait rather than a reason to leave. Returning the answer is
   * what lets the services after this one be ordinary services — a `join`
   * merging the answer with the question, a `put-artifact` filing it — instead
   * of each having to be told which run it belongs to.
   */
  async process(input: unknown, notify: Notify): Promise<unknown> {
    if (input === null || input === undefined) {
      return null;
    }

    const messages = this.toMessages(input);
    if (!messages) {
      return this.fail(
        notify,
        "text-generation expects String input or JSON with 'prompt', 'text', or 'messages'",
      );
    }

    const { value: key, problem } = this.resolveKey();
    // A credential that was named and could not be produced is a failure
    // whichever backend asked for it: the request would go out unauthenticated
    // and fail somewhere far away instead.
    if (problem) {
      return this.fail(notify, problem);
    }
    // A server next door is reached by address, not by credential — only the
    // hosted API has one to be missing.
    if (!key && this.backend === "anthropic") {
      return this.fail(
        notify,
        "no API key — configure apiKey, or set ANTHROPIC_API_KEY where this runtime runs",
      );
    }

    return this.generate(messages, key, notify);
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Whether a key is available at all, without producing one.
   *
   * Answering "is this configured" must not resolve a secret: it is asked
   * every time state is reported, and a value produced to compute a boolean is
   * a value that existed for no reason.
   */
  private hasKey(): boolean {
    if (this.apiKey) {
      return true;
    }
    return this.backend !== "server" && !!process.env.ANTHROPIC_API_KEY;
  }

  /**
   * The key for one request, resolved against the endpoint it is going to.
   *
   * A reference resolves through the runtime's secrets — the runtime around
   * this one where this service sits in a nested pipeline, which is the same
   * vault by delegation. Anything else is used as written, which is what a
   * runtime configured from a file holds, and what the environment supplies.
   */
  private resolveKey(): { value: string; problem: string } {
    // The environment's key belongs to the hosted API. A `server` board names
    // its own address, so falling back here would hand that credential to
    // whatever is listening there — the key is used only if a board set one.
    const configured =
      this.backend === "server"
        ? this.apiKey
        : this.apiKey || process.env.ANTHROPIC_API_KEY || "";

    const references = referencedSecrets(configured);
    if (!references.length) {
      return { value: configured, problem: "" };
    }

    const vault = this.host?.secrets?.();
    if (!vault) {
      return {
        value: "",
        problem: `no secrets available to resolve ${references.join(", ")}`,
      };
    }

    const { value, missing, refused } = vault.resolve(configured, {
      to: this.endpoint(),
    });
    if (refused.length) {
      return {
        value: "",
        problem: `${refused[0].alias} may not be sent to ${refused[0].to}`,
      };
    }
    if (missing.length) {
      return { value: "", problem: `no value stored for ${missing.join(", ")}` };
    }
    return { value, problem: "" };
  }

  /**
   * Where the request goes.
   *
   * A local server is given as a bare origin and serves the API at its root,
   * so the version belongs in the path. A hosted provider is given the way its
   * documentation gives it — `https://…/api/v1` — and appending another `/v1`
   * to that reaches nothing. Both forms are accepted rather than one being
   * declared correct, because both are what the two kinds of server hand out.
   */
  private endpoint(): string {
    const base = this.serverUrl || DEFAULT_URLS[this.backend] || "";
    if (this.backend !== "server") {
      return `${base}/v1/messages`;
    }
    return /\/v\d+$/.test(base)
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
  }

  private headers(apiKey: string): Record<string, string> {
    if (this.backend === "server") {
      // A local server usually wants no credential at all; the ones that do
      // take a bearer token.
      return {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
    }
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  private async generate(
    messages: Message[],
    apiKey: string,
    notify: Notify,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.round(this.timeoutSec * 1000),
    );
    this.setStatus(notify, "generating");
    const started = Date.now();

    const server = this.backend === "server";

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify(
          server ? this.serverRequestBody(messages) : this.requestBody(messages),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        return this.fail(
          notify,
          `${server ? "server" : "API"} returned HTTP ${response.status}: ${detail}`,
        );
      }

      const message = this.streaming()
        ? await (server
            ? this.readServerStream(response, notify)
            : this.readStream(response, notify))
        : ((await response.json()) as JsonRecord);

      const result = server
        ? this.toServerResult(message, started)
        : this.toResult(message, started);

      // Handing an empty answer onward is worse than failing: the services
      // after this one cannot tell it from a real one, so a board that settles
      // its work at the end would mark the item done having produced nothing.
      // Stopping here leaves it exactly where a failed run should leave it.
      if (!result.text && result.json === undefined) {
        return this.fail(
          notify,
          result.finishReason === "length"
            ? `the model used all ${this.maxTokens} tokens without answering — ` +
              "raise maxTokens, or set thinking: false if it reasons first"
            : "the model returned an empty answer",
        );
      }

      this.setStatus(notify, "idle");
      notify(result);
      return result;
    } catch (err) {
      // A connection that never opened, as distinct from anything else that
      // went wrong in here: fetch reports those as a TypeError carrying the
      // socket error as its cause. Claiming a wider set would answer "the
      // server is not running" to a question that was never asked.
      if (server && err instanceof TypeError && (err as Error).cause) {
        // "fetch failed" says nothing about what to do; a board pointed at a
        // server nobody started is by far the likeliest way to get here.
        return this.fail(
          notify,
          `no OpenAI-compatible server reachable at ${this.endpoint()} — start one, e.g.: ` +
            `llama-server -m model.gguf --port ${port(this.endpoint())}`,
        );
      }
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `no answer within ${this.timeoutSec}s`
          : err instanceof Error
            ? err.message
            : String(err);
      return this.fail(notify, `generation failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether this call streams.
   *
   * A schema-constrained answer does not: half of a JSON object is of no use
   * to anything, so streaming would buy partial output nobody can render.
   */
  private streaming(): boolean {
    return this.stream && !this.jsonSchema;
  }

  private requestBody(messages: Message[]): JsonRecord {
    const thinkingOn = this.thinking === true;
    // Reasoning is drawn from the same budget as the answer, so a budget that
    // meets or exceeds it leaves nothing to answer with — the API rejects that
    // outright. Lift the ceiling rather than fail the call.
    const maxTokens = thinkingOn
      ? Math.max(this.maxTokens, this.thinkingBudgetTokens + 1)
      : this.maxTokens;

    const body: JsonRecord = {
      model: this.model,
      max_tokens: maxTokens,
      messages,
      stream: this.streaming(),
    };
    if (this.systemPrompt) {
      // A system prompt is a parameter here, not a message with a role.
      body.system = this.systemPrompt;
    }
    if (thinkingOn) {
      body.thinking = {
        type: "enabled",
        budget_tokens: this.thinkingBudgetTokens,
      };
      // Sampling is fixed while reasoning: sending any of the three is an
      // error, so they are left out rather than sent and ignored.
    } else {
      // Not `top_p` as well: this API rejects a request carrying both it and
      // `temperature`, and temperature is the one a board that touched either
      // is far more likely to have meant. `top_p` is left to the backends
      // that accept the pair.
      body.temperature = this.temperature;
      body.top_k = this.topK;
    }
    if (this.jsonSchema) {
      body.tools = [
        {
          name: SCHEMA_TOOL_NAME,
          description: "Return the answer in the required shape.",
          input_schema: this.jsonSchema,
        },
      ];
      body.tool_choice = { type: "tool", name: SCHEMA_TOOL_NAME };
    }
    return body;
  }

  /**
   * The same call, in the shape an OpenAI-compatible server expects.
   *
   * The differences from `requestBody` are all vocabulary rather than meaning:
   * the system prompt is a message rather than a parameter, sampling is
   * snake_case, and a schema is asked for as a response format rather than as
   * a forced tool. `top_k` and `chat_template_kwargs` are llama-server
   * extensions, sent the way hkp-python sends them so one board configuration
   * drives either runtime.
   */
  private serverRequestBody(messages: Message[]): JsonRecord {
    const body: JsonRecord = {
      messages: this.withSystemPrompt(messages).map(openAiMessage),
      temperature: this.temperature,
      top_p: this.topP,
      top_k: this.topK,
      max_tokens: this.maxTokens,
      stream: this.streaming(),
    };
    if (this.model) {
      body.model = this.model;
    }
    if (this.thinking !== null) {
      // Only sent when a board said something, so a server whose template does
      // not know the flag never sees it.
      body.chat_template_kwargs = { enable_thinking: this.thinking };
    }
    if (this.jsonSchema) {
      // No `strict`: under its OpenAI meaning it additionally requires every
      // property to be listed in `required` and `additionalProperties: false`,
      // which contradicts the schemas boards actually write — a shape whose
      // fields are filled in only when the source says them. The schema is
      // still enforced; `strict` governs a stricter reading of the schema
      // itself, not whether it applies.
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: SCHEMA_TOOL_NAME,
          schema: this.jsonSchema,
        },
      };
    }
    return body;
  }

  /** A system prompt travels as a message here, and only if there isn't one. */
  private withSystemPrompt(messages: Message[]): Message[] {
    if (!this.systemPrompt || messages.some((m) => m?.role === "system")) {
      return messages;
    }
    return [{ role: "system", content: this.systemPrompt }, ...messages];
  }

  /** Reduces a chat-completions response to the shared output contract. */
  private toServerResult(response: JsonRecord, started: number): Result {
    const choices = Array.isArray(response.choices)
      ? (response.choices as JsonRecord[])
      : [];
    const message = (choices[0]?.message ?? {}) as JsonRecord;
    const finishReason =
      typeof choices[0]?.finish_reason === "string"
        ? choices[0].finish_reason
        : "";
    const { text, thinking } = splitThinking(
      typeof message.content === "string" ? message.content : "",
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "",
    );

    const usage = (response.usage ?? {}) as JsonRecord;
    const result: Result = {
      text,
      model: typeof response.model === "string" ? response.model : this.model,
      durationMs: Date.now() - started,
      usage: {
        promptTokens: isNumber(usage.prompt_tokens) ? usage.prompt_tokens : 0,
        completionTokens: isNumber(usage.completion_tokens)
          ? usage.completion_tokens
          : 0,
      },
    };
    if (thinking) {
      result.thinking = thinking;
    }
    // "stop" is the answer ending because it was finished; anything else is
    // the answer ending for a reason a board should be able to see.
    if (finishReason && finishReason !== "stop") {
      result.finishReason = finishReason;
    }
    // Only worth reporting when there is an answer to hand on anyway: an
    // empty one is a failure, and `generate` says so rather than warning here
    // and passing it down as well.
    if (this.jsonSchema && text) {
      try {
        result.json = JSON.parse(text);
      } catch {
        // Two very different causes, and saying the wrong one sends whoever
        // reads this looking in the wrong place.
        this.host?.log("warn", "service.degraded", {
          message:
            finishReason === "length"
              ? `answer was cut off at maxTokens (${this.maxTokens}) before it ` +
                "was valid JSON — raise maxTokens, or set thinking: false if " +
                "the model reasons before answering"
              : "answer did not parse as JSON — this server may not implement " +
                "response_format: json_schema",
        });
      }
    }
    return result;
  }

  /**
   * Accumulates a streamed chat-completions response into the shape the
   * non-streamed path produces, notifying `{streamText}` on the way — the same
   * shape the anthropic path and hkp-python both use, so one UI renders any of
   * them.
   */
  private async readServerStream(
    response: Response,
    notify: Notify,
  ): Promise<JsonRecord> {
    let text = "";
    let thinking = "";
    let model = this.model;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason = "";
    let lastNotifiedAt = 0;

    for await (const event of readEvents(response)) {
      if (typeof event.model === "string") {
        model = event.model;
      }
      // Sent on the final chunk when the server was asked for usage, and
      // absent otherwise; either way the last one seen is the total.
      const usage = (event.usage ?? {}) as JsonRecord;
      if (isNumber(usage.prompt_tokens)) {
        promptTokens = usage.prompt_tokens;
      }
      if (isNumber(usage.completion_tokens)) {
        completionTokens = usage.completion_tokens;
      }

      const choices = Array.isArray(event.choices)
        ? (event.choices as JsonRecord[])
        : [];
      if (typeof choices[0]?.finish_reason === "string") {
        finishReason = choices[0].finish_reason;
      }
      const delta = (choices[0]?.delta ?? {}) as JsonRecord;
      if (typeof delta.reasoning_content === "string") {
        thinking += delta.reasoning_content;
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        const now = Date.now();
        if (now - lastNotifiedAt >= STREAM_NOTIFY_INTERVAL_MS) {
          lastNotifiedAt = now;
          notify({ streamText: text });
        }
      }
    }

    notify({ streamText: text, streamDone: true });

    return {
      model,
      choices: [
        {
          message: { content: text, reasoning_content: thinking },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
    };
  }

  /**
   * Accumulates a streamed response into the same shape a non-streamed one
   * has, notifying the growing text as `{streamText}` on the way — the shape
   * hkp-python's service established, so one UI renders either runtime's.
   */
  private async readStream(
    response: Response,
    notify: Notify,
  ): Promise<JsonRecord> {
    let text = "";
    let thinking = "";
    let model = this.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastNotifiedAt = 0;

    for await (const event of readEvents(response)) {
      switch (event.type) {
        case "message_start": {
          const message = (event.message ?? {}) as JsonRecord;
          if (typeof message.model === "string") {
            model = message.model;
          }
          const usage = (message.usage ?? {}) as JsonRecord;
          if (isNumber(usage.input_tokens)) {
            inputTokens = usage.input_tokens;
          }
          break;
        }
        case "content_block_delta": {
          const delta = (event.delta ?? {}) as JsonRecord;
          if (typeof delta.text === "string") {
            text += delta.text;
            const now = Date.now();
            if (now - lastNotifiedAt >= STREAM_NOTIFY_INTERVAL_MS) {
              lastNotifiedAt = now;
              notify({ streamText: text });
            }
          }
          if (typeof delta.thinking === "string") {
            thinking += delta.thinking;
          }
          break;
        }
        case "message_delta": {
          const usage = (event.usage ?? {}) as JsonRecord;
          if (isNumber(usage.output_tokens)) {
            outputTokens = usage.output_tokens;
          }
          break;
        }
        default:
          break;
      }
    }

    notify({ streamText: text, streamDone: true });

    const content: JsonRecord[] = [];
    if (thinking) {
      content.push({ type: "thinking", thinking });
    }
    content.push({ type: "text", text });
    return {
      model,
      content,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  /** Reduces a response message to the output contract shared across runtimes. */
  private toResult(message: JsonRecord, started: number): Result {
    const blocks = Array.isArray(message.content)
      ? (message.content as JsonRecord[])
      : [];
    const texts: string[] = [];
    const thoughts: string[] = [];
    let json: unknown;

    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        thoughts.push(block.thinking);
      } else if (block.type === "tool_use" && block.name === SCHEMA_TOOL_NAME) {
        json = block.input;
      }
    }

    const usage = (message.usage ?? {}) as JsonRecord;
    const result: Result = {
      // With a schema the answer *is* the object, so `text` carries it
      // serialized — a board that only knows the shared contract still has
      // something to route, log, or show.
      text: json !== undefined ? JSON.stringify(json) : texts.join("").trim(),
      model: typeof message.model === "string" ? message.model : this.model,
      durationMs: Date.now() - started,
      usage: {
        promptTokens: isNumber(usage.input_tokens) ? usage.input_tokens : 0,
        completionTokens: isNumber(usage.output_tokens) ? usage.output_tokens : 0,
      },
    };
    if (json !== undefined) {
      result.json = json;
    }
    const thinking = thoughts.join("").trim();
    if (thinking) {
      result.thinking = thinking;
    }
    return result;
  }

  /**
   * Turns pipeline input into the messages to send.
   *
   * Accepts what the local backends accept, plus the two shapes that carry
   * images: a single `{meta, binary}` as `http-client` and
   * `http-server-subservices` produce, and an explicit `images` list.
   */
  private toMessages(input: unknown): Message[] | null {
    if (typeof input === "string") {
      return input.trim() ? [{ role: "user", content: input }] : null;
    }
    if (input instanceof Uint8Array) {
      return null;
    }
    if (typeof input !== "object" || input === null) {
      return null;
    }

    const record = input as JsonRecord;
    if (Array.isArray(record.messages)) {
      return record.messages as Message[];
    }

    const prompt =
      typeof record.prompt === "string" && record.prompt
        ? record.prompt
        : typeof record.text === "string" && record.text
          ? record.text
          : "";

    const images = this.imageParts(record);
    if (!images.length) {
      return prompt.trim() ? [{ role: "user", content: prompt }] : null;
    }

    // Images first: the API reads a question about them better when it has
    // already seen them.
    const content: JsonRecord[] = [...images];
    if (prompt.trim()) {
      content.push({ type: "text", text: prompt });
    }
    return [{ role: "user", content }];
  }

  /** The image parts an input carries, in whichever of the shapes it uses. */
  private imageParts(record: JsonRecord): JsonRecord[] {
    const parts: JsonRecord[] = [];

    const meta = (record.meta ?? {}) as JsonRecord;
    const declared =
      typeof meta.contentType === "string" ? meta.contentType.split(";")[0].trim() : "";
    if (record.binary instanceof Uint8Array && declared.startsWith("image/")) {
      parts.push(imagePart(record.binary, declared));
    }

    if (Array.isArray(record.images)) {
      for (const image of record.images) {
        if (image instanceof Uint8Array) {
          // No type given; PNG is the safe assumption for a bare buffer and
          // the API sniffs the bytes anyway.
          parts.push(imagePart(image, "image/png"));
          continue;
        }
        if (!image || typeof image !== "object") {
          continue;
        }
        const entry = image as JsonRecord;
        const type =
          typeof entry.contentType === "string" ? entry.contentType : "image/png";
        if (entry.data instanceof Uint8Array) {
          parts.push(imagePart(entry.data, type));
        } else if (typeof entry.data === "string") {
          // Already base64: passed through rather than decoded and re-encoded.
          parts.push({
            type: "image",
            source: { type: "base64", media_type: type, data: entry.data },
          });
        }
      }
    }

    return parts;
  }

  private setStatus(notify: Notify, status: string, detail?: string): void {
    this.status = status;
    if (status !== "error") {
      this.lastError = "";
    }
    notify(detail === undefined ? { status } : { status, detail });
  }

  /** Reports a failure and produces nothing, so the pipeline stops here. */
  private fail(notify: Notify, error: string): null {
    this.lastError = error;
    this.setStatus(notify, "error");
    // Also to the board log, which is what a board running unattended has
    // instead of somebody watching a panel.
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
    return null;
  }
}

/**
 * One message, in OpenAI vocabulary.
 *
 * Text and role are the same on both sides; only images differ — a base64
 * source becomes a data URI, which is how that API carries the same bytes.
 */
function openAiMessage(message: Message): JsonRecord {
  if (!Array.isArray(message.content)) {
    return { role: message.role, content: message.content };
  }
  const parts = (message.content as JsonRecord[]).map((part) => {
    if (part?.type !== "image") {
      return part;
    }
    const source = (part.source ?? {}) as JsonRecord;
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  });
  return { role: message.role, content: parts };
}

/**
 * Separates reasoning from the answer.
 *
 * A server reports it either as its own field or inline in the content as
 * `<think>…</think>`, depending on how it handles the model's chat template —
 * so both are read, and a board sees the same `thinking` field either way.
 */
function splitThinking(
  content: string,
  declared: string,
): { text: string; thinking: string } {
  const close = content.indexOf(THINK_CLOSE);
  if (close === -1) {
    return { text: content.trim(), thinking: declared.trim() };
  }
  const head = content.slice(0, close);
  const inline = head.startsWith(THINK_OPEN)
    ? head.slice(THINK_OPEN.length)
    : head;
  return {
    text: content.slice(close + THINK_CLOSE.length).trim(),
    thinking: `${declared}${inline}`.trim(),
  };
}

/** The port a hint should name, so the suggestion matches the configuration. */
function port(url: string): string {
  try {
    return new URL(url).port || "8081";
  } catch {
    return "8081";
  }
}

/**
 * Reads a server-sent-event stream as the objects it carries.
 *
 * Only `data:` lines matter here; the `event:` line names the same type that
 * the payload itself carries, so the payload alone is enough.
 */
async function* readEvents(response: Response): AsyncGenerator<JsonRecord> {
  const body = response.body;
  if (!body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload) {
        continue;
      }
      try {
        yield JSON.parse(payload) as JsonRecord;
      } catch {
        // A line that is not JSON is not an event; the stream continues.
      }
    }
  }
}
