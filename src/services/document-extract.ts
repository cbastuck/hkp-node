/**
 * Service Documentation
 * Service ID: document-extract
 * Service Name: Document Extract
 * Runtime: hkp-node
 * Modes: none (the backend is configuration, not a mode)
 * Key Config: backend (xberg|builtin), ocr (auto|off|force), ocrBackend,
 *             ocrLanguage, tables, metadata, maxChars, minCharsPerPage,
 *             minTextCoverage
 * IO: in=bytes to read ({meta, binary} | Uint8Array | {meta, body} | String)
 *     out=null immediately; the text is pushed through the rest of the
 *     pipeline when extraction finishes, shaped
 *     { text, chars, pages, charsPerPage, sparse, method, format, backend,
 *       durationMs, textCoverage?, confidence?, metadata?, tables? }
 *
 * Turns a document into text a model can read. The natural producer is
 * anything that yields bytes — `http-client`, an email attachment, a
 * `file-pick` widget — and the natural consumer is `text-generation`.
 *
 * **OCR runs when it is needed, because it is local.** A scanned page is read
 * by an OCR engine in this process — no network, no per-page charge — so
 * leaving it off would mean handing back an empty document rather than saving
 * anything. Images are always read that way, a scanned PDF page by page, and a
 * PDF that already has a text layer not at all. `ocr: "off"` reads only the
 * text layer, and `ocr: "force"` reads every page even where there is one.
 *
 * What stays off is the **paid** tier: a vision model reading pages an OCR
 * engine could not (`vlmFallback` in the library). That one costs per page, so
 * it is a board's decision rather than a default, and `sparse` is the signal to
 * make it on — it says the text that came back is too thin to trust, whatever
 * was tried to get it.
 *
 * Two backends, selected by the `backend` state:
 *
 *   - **`xberg`** (default) — the real one: PDF, DOCX, XLSX, archives, email
 *     and a hundred other formats, with page counts, tables and a confidence
 *     model. Not a dependency of this package: its platform binaries are large
 *     and most boards never read a document, so it is installed separately
 *     (`npm install @xberg-io/xberg`) and reported as missing rather than
 *     assumed.
 *   - **`builtin`** — no dependencies, and only what can be read without any:
 *     text, HTML, JSON, CSV, Markdown. Enough for a board that only ever sees
 *     what `http-client` brings back.
 *
 * The `backend` field exists from the first version because the library is
 * young; swapping it must not mean touching a board.
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

export const documentExtractDescriptor: ServiceRegistryEntry = {
  serviceId: "document-extract",
  serviceName: "Document Extract",
  version: "v1",
  capabilities: [],
};

type Backend = "xberg" | "builtin";

const BACKENDS: Backend[] = ["xberg", "builtin"];

/**
 * When pages get read by an OCR engine rather than only for their text layer.
 *
 * `auto` is the library's own judgement — images always, a scanned PDF page by
 * page, a PDF with a text layer not at all — and the right default because the
 * engine is local. `force` reads every page even where a text layer exists,
 * which is what a bad text layer (a PDF built from a scan by an office suite)
 * needs. `off` reads text layers only.
 */
type OcrMode = "auto" | "off" | "force";

const OCR_MODES: OcrMode[] = ["auto", "off", "force"];

/** Resolved at runtime, so this package does not depend on it. */
const XBERG_MODULE = "@xberg-io/xberg";

export const XBERG_INSTALL_HINT = `document extraction needs ${XBERG_MODULE} — run: npm install ${XBERG_MODULE}`;

/**
 * A page's worth of text, below which a text layer is not worth trusting.
 *
 * A page of prose runs to a couple of thousand characters; a scanned page with
 * a stray header yields a handful. The gap between them is wide enough that the
 * threshold does not need to be precise.
 */
const DEFAULT_MIN_CHARS_PER_PAGE = 100;

/** Below this fraction of pages carrying a text layer, the same applies. */
const DEFAULT_MIN_TEXT_COVERAGE = 0.6;

type Notify = (payload: unknown, instanceId?: string) => void;

/** The parts of the extraction library this service uses. */
type XbergDocument = {
  content?: string;
  mimeType?: string;
  metadata?: unknown;
  extractionMethod?: string;
  tables?: unknown[];
  counts?: { pages?: number; tables?: number; images?: number };
  extractionConfidence?: { textCoverage?: number; combined?: number };
};

type XbergModule = {
  extract(
    input: {
      kind: string;
      bytes?: Uint8Array;
      mimeType?: string;
      filename?: string;
    },
    config?: JsonRecord,
  ): Promise<{
    results?: XbergDocument[];
    errors?: Array<{ message?: string; errorType?: string }>;
  }>;
};

/** What was handed in: the bytes, and whatever is known about them. */
type Source = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
};

let xbergModule: XbergModule | null = null;

/**
 * Loads the extraction library, once.
 *
 * The specifier is a variable so that neither the compiler nor a bundler tries
 * to resolve a package that is deliberately not installed.
 */
async function loadXberg(): Promise<XbergModule | null> {
  if (xbergModule) {
    return xbergModule;
  }
  try {
    const specifier = XBERG_MODULE;
    const loaded = (await import(specifier)) as XbergModule & {
      default?: XbergModule;
    };
    xbergModule = loaded.default?.extract ? loaded.default : loaded;
    return xbergModule;
  } catch {
    return null;
  }
}

/** Replaces the loaded module. Tests use this; nothing else should. */
export function setXbergModule(module: XbergModule | null): void {
  xbergModule = module;
}

/** Content type with any parameters (`; charset=…`) stripped, lower-cased. */
function mediaType(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

/** What the first bytes say the document is, when nothing else does. */
function sniff(bytes: Uint8Array): string {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46)) {
    return "application/pdf";
  }
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    // A zip. DOCX and XLSX are both zips, and telling them apart means reading
    // the archive — which is the extraction library's job, not this guess's.
    return "application/zip";
  }
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) {
    return "application/vnd.ms-office";
  }
  return "";
}

const TEXTUAL = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
]);

/** Text out of HTML, without pulling in a parser to do it. */
function textFromHtml(html: string): string {
  return html
    // Whatever these hold is markup or code, not the document's text.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block boundaries become line breaks so words do not run together.
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export class DocumentExtractService implements HostedService {
  readonly serviceId = documentExtractDescriptor.serviceId;
  readonly serviceName = documentExtractDescriptor.serviceName;
  readonly version = documentExtractDescriptor.version;
  readonly capabilities = documentExtractDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private backend: Backend = "xberg";
  private ocr: OcrMode = "auto";
  /** Empty leaves the choice of OCR engine to the library. */
  private ocrBackend = "";
  private ocrLanguage: string[] = [];
  private tables = false;
  private metadata = false;
  private maxChars = 0;
  private minCharsPerPage = DEFAULT_MIN_CHARS_PER_PAGE;
  private minTextCoverage = DEFAULT_MIN_TEXT_COVERAGE;
  private status = "idle";
  /** Why the last attempt failed; see the note in text-generation. */
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
      ocr: this.ocr,
      ocrBackend: this.ocrBackend,
      ocrLanguage: this.ocrLanguage,
      tables: this.tables,
      metadata: this.metadata,
      maxChars: this.maxChars,
      minCharsPerPage: this.minCharsPerPage,
      minTextCoverage: this.minTextCoverage,
      status: this.status,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (
      typeof config.backend === "string" &&
      BACKENDS.includes(config.backend as Backend)
    ) {
      this.backend = config.backend as Backend;
    }
    if (typeof config.ocr === "string" && OCR_MODES.includes(config.ocr as OcrMode)) {
      this.ocr = config.ocr as OcrMode;
    } else if (typeof config.ocr === "boolean") {
      // Read rather than ignored: silently dropping `ocr: false` would run OCR
      // on a board that said not to, which is the one mistake worth avoiding
      // here. `true` is "when it is needed", not "on every page" — that is
      // what "force" is for, and it has to be asked for by name.
      this.ocr = config.ocr ? "auto" : "off";
    }
    if (typeof config.ocrBackend === "string") {
      // Not checked against a list: the library ships eight engines and gains
      // more, and it is the one that can say whether a name is one of them.
      this.ocrBackend = config.ocrBackend;
    }
    if (typeof config.ocrLanguage === "string") {
      this.ocrLanguage = config.ocrLanguage
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean);
    } else if (Array.isArray(config.ocrLanguage)) {
      this.ocrLanguage = config.ocrLanguage.filter(
        (code): code is string => typeof code === "string" && !!code,
      );
    }
    if (typeof config.tables === "boolean") {
      this.tables = config.tables;
    }
    if (typeof config.metadata === "boolean") {
      this.metadata = config.metadata;
    }
    if (typeof config.maxChars === "number" && config.maxChars >= 0) {
      this.maxChars = Math.trunc(config.maxChars);
    }
    if (typeof config.minCharsPerPage === "number" && config.minCharsPerPage >= 0) {
      this.minCharsPerPage = Math.trunc(config.minCharsPerPage);
    }
    if (
      typeof config.minTextCoverage === "number" &&
      config.minTextCoverage >= 0 &&
      config.minTextCoverage <= 1
    ) {
      this.minTextCoverage = config.minTextCoverage;
    }
    return this.getState();
  }

  /**
   * Starts the extraction and stops the synchronous push.
   *
   * Reading a document takes long enough to matter and the runtime calls
   * services one after another without awaiting, so the text cannot be returned
   * from here — the rest of the pipeline is called with it once it exists.
   */
  process(input: unknown, notify: Notify): unknown {
    if (input === null || input === undefined) {
      return null;
    }

    const source = this.toSource(input);
    if (!source) {
      return this.fail(
        notify,
        "document-extract expects bytes — {meta, binary}, a Uint8Array, or text",
      );
    }
    if (source.bytes.byteLength === 0) {
      return this.fail(notify, "nothing to read: the document is empty");
    }

    void this.extract(
      source,
      notify,
      this.host?.currentContext() ?? undefined,
    );
    return null;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async extract(
    source: Source,
    notify: Notify,
    context?: ProcessContext,
  ): Promise<void> {
    this.setStatus(notify, "extracting");
    const started = Date.now();

    try {
      const result =
        this.backend === "builtin"
          ? this.extractBuiltin(source)
          : await this.extractXberg(source);
      if (!result) {
        // Already reported; nothing is passed on.
        return;
      }

      const output = this.shape(result, source, started);
      this.setStatus(notify, "idle");
      notify(output);
      this.push(output, notify, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(notify, `extraction failed: ${message}`);
    }
  }

  private async extractXberg(source: Source): Promise<XbergDocument | null> {
    const xberg = await loadXberg();
    if (!xberg) {
      throw new Error(XBERG_INSTALL_HINT);
    }

    const answer = await xberg.extract(
      {
        kind: "bytes",
        bytes: source.bytes,
        ...(source.contentType ? { mimeType: source.contentType } : {}),
        ...(source.filename ? { filename: source.filename } : {}),
      },
      this.extractionConfig(),
    );

    const document = answer.results?.[0];
    if (!document) {
      const reason = answer.errors?.[0]?.message ?? "no content could be read";
      throw new Error(reason);
    }
    return document;
  }

  /**
   * How the library is asked to read the document.
   *
   * Only what the board decided is sent; everything else is left to the
   * library's own judgement, which is better informed than a default of ours
   * would be — it can see the document.
   */
  private extractionConfig(): JsonRecord {
    if (this.ocr === "off") {
      // Hard off. The library will not fall back to an engine even for a page
      // that has no text at all, which is what "off" has to mean to be useful.
      return { disableOcr: true };
    }

    const ocr: JsonRecord = { enabled: true };
    if (this.ocrBackend) {
      ocr.backend = this.ocrBackend;
    }
    if (this.ocrLanguage.length > 0) {
      ocr.language = this.ocrLanguage;
    }
    return this.ocr === "force" ? { forceOcr: true, ocr } : { ocr };
  }

  /**
   * What can be read without any dependency at all.
   *
   * Anything else says so rather than returning the bytes as mojibake, which
   * would look like a successful extraction of nonsense.
   */
  private extractBuiltin(source: Source): XbergDocument {
    const type = source.contentType;
    const text = Buffer.from(source.bytes).toString("utf-8");

    if (type === "text/html" || type === "application/xhtml+xml") {
      return { content: textFromHtml(text), mimeType: type };
    }
    if (TEXTUAL.has(type) || type.startsWith("text/")) {
      return { content: text, mimeType: type };
    }
    throw new Error(
      `the builtin backend cannot read ${type || "this document"} — ` +
        `install ${XBERG_MODULE} and set backend: "xberg"`,
    );
  }

  /** The output contract, including what a board branches on. */
  private shape(
    document: XbergDocument,
    source: Source,
    started: number,
  ): JsonRecord {
    const full = (document.content ?? "").trim();
    const text = this.maxChars > 0 ? full.slice(0, this.maxChars) : full;
    const chars = full.length;
    const pages = document.counts?.pages ?? 0;
    // A document with no pages is one page as far as density goes; without
    // this a text file would divide by zero and read as empty.
    const charsPerPage = Math.round(chars / Math.max(pages, 1));
    const textCoverage = document.extractionConfidence?.textCoverage;

    const output: JsonRecord = {
      text,
      chars,
      pages,
      charsPerPage,
      // The one field a board branches on: too little text came back to trust,
      // whatever was tried to get it. With OCR on — the default — reaching this
      // means a local engine could not read the pages either, so what is left
      // is the paid tier (a vision model) or a person. Coverage is the better
      // answer where the backend reports it: it knows which pages produced
      // text, where density can only infer it.
      sparse:
        typeof textCoverage === "number"
          ? textCoverage < this.minTextCoverage
          : charsPerPage < this.minCharsPerPage,
      method: document.extractionMethod ?? "native",
      format: document.mimeType ?? source.contentType,
      backend: this.backend,
      durationMs: Date.now() - started,
    };
    if (this.maxChars > 0 && chars > this.maxChars) {
      // Said out loud: a truncated document that looked complete would be
      // summarised as though the rest did not exist.
      output.truncated = true;
    }
    if (typeof textCoverage === "number") {
      output.textCoverage = textCoverage;
    }
    if (typeof document.extractionConfidence?.combined === "number") {
      output.confidence = document.extractionConfidence.combined;
    }
    if (this.metadata && document.metadata) {
      output.metadata = document.metadata;
    }
    if (this.tables && document.tables) {
      output.tables = document.tables;
    }
    return output;
  }

  /**
   * Reads the bytes out of whatever the pipeline handed over.
   *
   * Accepts what `http-client` and `http-server-subservices` produce, so a
   * document fetched or received elsewhere in the board pipes straight in.
   */
  private toSource(input: unknown): Source | null {
    if (input instanceof Uint8Array) {
      return { bytes: input, contentType: sniff(input), filename: "" };
    }
    if (typeof input === "string") {
      return {
        bytes: Buffer.from(input, "utf-8"),
        contentType: "text/plain",
        filename: "",
      };
    }
    if (typeof input !== "object" || input === null) {
      return null;
    }

    const record = input as JsonRecord;
    const meta = (record.meta ?? {}) as JsonRecord;
    const declared =
      typeof meta.contentType === "string" ? mediaType(meta.contentType) : "";
    const filename =
      typeof meta.filename === "string"
        ? meta.filename
        : typeof record.filename === "string"
          ? record.filename
          : "";

    if (record.binary instanceof Uint8Array) {
      return {
        bytes: record.binary,
        contentType: declared || sniff(record.binary),
        filename,
      };
    }
    if (typeof record.body === "string") {
      return {
        bytes: Buffer.from(record.body, "utf-8"),
        contentType: declared || "text/plain",
        filename,
      };
    }
    if (record.body !== undefined) {
      // Already parsed upstream — a JSON response, say. Reading it back out as
      // text is what an extractor would have produced anyway.
      return {
        bytes: Buffer.from(JSON.stringify(record.body), "utf-8"),
        contentType: declared || "application/json",
        filename,
      };
    }
    return null;
  }

  private push(
    result: JsonRecord,
    notify: Notify,
    context?: ProcessContext,
  ): void {
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

  private setStatus(notify: Notify, status: string): void {
    this.status = status;
    if (status !== "error") {
      this.lastError = "";
    }
    notify({ status });
  }

  /** Reports a failure and produces nothing, so the pipeline stops here. */
  private fail(notify: Notify, error: string): null {
    this.lastError = error;
    this.setStatus(notify, "error");
    this.host?.log("error", "service.failed", { message: error });
    notify({ error });
    return null;
  }
}
