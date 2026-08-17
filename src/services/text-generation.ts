/**
 * Service Documentation
 * Service ID: text-generation
 * Service Name: Text Generation
 * Runtime: hkp-node
 * Modes: none (the backend is configuration, not a mode)
 * Key Config: backend (anthropic), apiKey (write-only), baseUrl, model,
 *             systemPrompt, temperature, topP, topK, maxTokens, timeoutSec,
 *             stream, thinking, thinkingBudgetTokens, jsonSchema
 * IO: in=String (the prompt) or JSON ({prompt} | {text} | {messages: [...]}),
 *     optionally carrying images ({meta, binary} | {images: [...]})
 *     out=null immediately; the result is pushed through the rest of the
 *     pipeline when it arrives, shaped
 *     { text, json?, thinking?, model, durationMs,
 *       usage: { promptTokens, completionTokens } }
 *
 * The node implementation of the `text-generation` concept hkp-python and
 * hkp-rt also provide, sharing their state contract and output shape so a board
 * can move the service between runtimes and keep its UI panel. Those two run
 * models locally; this one calls a hosted API, which is what makes it the one
 * that works on a board deployed to a coordinator with nobody watching.
 *
 * Three things this adds, all of which the local backends have no equivalent
 * for:
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

/** Backends this runtime can talk to. A list of one, so adding is one entry. */
const BACKENDS = ["anthropic"];

const DEFAULT_BASE_URL = "https://api.anthropic.com";
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

/** Notifications are throttled to this, which is plenty for a live view. */
const STREAM_NOTIFY_INTERVAL_MS = 50;

type Message = { role: string; content: unknown };

type Result = {
  text: string;
  json?: unknown;
  thinking?: string;
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
  private apiKey = "";
  private baseUrl = DEFAULT_BASE_URL;
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
    return {
      backend: this.backend,
      // Write-only: what was configured never comes back out.
      apiKey: "",
      apiKeyConfigured: this.resolveKey().length > 0,
      baseUrl: this.baseUrl,
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
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.backend === "string" && BACKENDS.includes(config.backend)) {
      this.backend = config.backend;
    }
    // An empty string is how a UI sends back the masked field it was given, so
    // it must not be read as "clear the key".
    if (typeof config.apiKey === "string" && config.apiKey) {
      this.apiKey = config.apiKey;
    }
    if (typeof config.baseUrl === "string" && config.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/+$/, "");
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
   * Starts the request and stops the synchronous push.
   *
   * Generation takes seconds to minutes, and the runtime calls services one
   * after another without awaiting — so the answer cannot be returned from
   * here. Returning null stops the push; the rest of the pipeline is called
   * with the result once it arrives, the same inversion-of-control path
   * `http-client` takes.
   */
  process(input: unknown, notify: Notify): unknown {
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

    const key = this.resolveKey();
    if (!key) {
      return this.fail(
        notify,
        "no API key — configure apiKey, or set ANTHROPIC_API_KEY where this runtime runs",
      );
    }

    // Captured while still inside the call this generation belongs to; by the
    // time the answer arrives the pass has long returned.
    void this.generate(
      messages,
      key,
      notify,
      this.host?.currentContext() ?? undefined,
    );
    return null;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** The configured key, or the environment's when none was configured. */
  private resolveKey(): string {
    return this.apiKey || process.env.ANTHROPIC_API_KEY || "";
  }

  private async generate(
    messages: Message[],
    apiKey: string,
    notify: Notify,
    context?: ProcessContext,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.round(this.timeoutSec * 1000),
    );
    this.setStatus(notify, "generating");
    const started = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(this.requestBody(messages)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        this.fail(notify, `API returned HTTP ${response.status}: ${detail}`);
        return;
      }

      const message = this.streaming()
        ? await this.readStream(response, notify)
        : ((await response.json()) as JsonRecord);

      const result = this.toResult(message, started);
      this.setStatus(notify, "idle");
      notify(result);
      this.push(result, notify, context);
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `no answer within ${this.timeoutSec}s`
          : err instanceof Error
            ? err.message
            : String(err);
      this.fail(notify, `generation failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether this call streams.
   *
   * A schema-constrained answer does not: it arrives as tool arguments, which
   * are only useful once complete, so streaming would buy partial JSON nobody
   * can render.
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
      body.temperature = this.temperature;
      body.top_p = this.topP;
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

  /**
   * Runs the rest of the pipeline with the result, then emits the runtime's
   * output. A service that produces data outside the push has to emit it
   * itself; nothing else will.
   */
  private push(result: Result, notify: Notify, context?: ProcessContext): void {
    if (!this.host) {
      return;
    }
    const output = this.host.processFrom(
      this.uuid,
      result,
      (n: RuntimeNotification) => notify(n.payload, n.instanceId),
      context,
    );
    if (output !== null && output !== undefined) {
      this.host.emitResult(output);
    }
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
