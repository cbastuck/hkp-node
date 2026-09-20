/**
 * Service Documentation
 * Service ID: http-server-subservices
 * Service Name: HttpServerSubservices
 * Runtime: hkp-node
 * Modes: none — the entry points a board declares say what it is for
 * Key Config: bypass/onProcess/onRequest (the endpoint is assigned, not configured)
 * IO: in=request envelope -> out=response envelope
 * Arrays: not primary
 * Binary: depends on endpoint + nested services
 * MixedData: not native in runtime
 *
 * **There are two ways in, and a board names the ones it uses.** `onRequest` is
 * a caller arriving; `onProcess` is a pass of the board's own chain. Each is a
 * pipeline of its own, because they are different jobs:
 *
 *     { "onRequest": [ … ] }                      requests; a pass goes through
 *     { "onProcess": [ … ] }                      passes; the board answers
 *     { "onProcess": [ … ], "onRequest": [ … ] }  both, separately
 *     { "pipeline":  [ … ] }                      one pipeline, entered from both
 *
 * **Declaring `onRequest` is what takes the answer away from the chain.** With
 * one, that pipeline is the handler and what it returns is what the caller
 * gets; the services after this one still run — that is where a board acts on
 * having served a request — but after the answer is decided. Without one, the
 * request flows into the services after this one and whatever they return is
 * the answer, which is the inversion of control this service is built around
 * and what makes a board able to answer an endpoint at all.
 *
 * So an endpoint can have something to run on a pass without silently becoming
 * an HTTP handler, which is what a single unnamed pipeline could not express:
 * having one at all decided who answered.
 *
 * **A value does not survive between the two on its own.** They are separate
 * pipelines, and a pass ends where it ends — so an endpoint that publishes what
 * the board last handed it holds that value in a slot (see `hold`), in cells
 * this service owns and lends to both of its pipelines. Legacy boards say the
 * same thing as `mode: "process_on_data"`, which is this arrangement built in
 * and unnamed; `entryFor` is where the older spellings are read.
 *
 * **What the handler answers with is the envelope, read backwards.** A value
 * carrying `meta.status` beside `body` or `binary` sets the status, the content
 * type and the headers — the status being what distinguishes an answer from a
 * request passed through unchanged, which is the same shape. Anything else is
 * answered by its own type, which is JSON for everything a board returned
 * before this existed. That is what lets one board
 * serve a feed as XML and the next serve an audio file as audio — without which
 * an endpoint can only ever say `application/json`, whatever it is holding.
 *
 * Byte answers are seekable: `Range` is honoured against the bytes the handler
 * produced, because a player dragging a scrubber asks for one and a server that
 * ignores it re-sends the whole file each time.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { newRun } from "../runtime";
import { MountContext, MountHandle } from "../mounts";
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeScope,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
  SlotStore,
} from "../types";
import { NestedPipeline } from "./nested-pipeline";

export const httpServerSubservicesDescriptor: ServiceRegistryEntry = {
  serviceId: "http-server-subservices",
  serviceName: "HttpServerSubservices",
  capabilities: ["subservices"],
};

/**
 * How a board that predates named entry points says which side enters the one
 * pipeline it declares. Still accepted, and still reported back to a board that
 * arrived carrying it; `entryFor` is the whole of what it means now.
 *
 * - `process_on_session` — requests only; data from the outer chain passes
 *   through untouched.
 * - `process_on_data` — data from the outer chain is stored and served back to
 *   requests verbatim; the nested pipeline is not used.
 * - `process_on_both` — both entry points run the one pipeline, which is why a
 *   service inside it can only tell a request from a pass by looking at what it
 *   was given.
 */
type HttpServerMode =
  "process_on_session" | "process_on_data" | "process_on_both";

/**
 * The two ways into this service, named.
 *
 * `onProcess` is a pass of the board's own chain arriving; `onRequest` is a
 * caller. They are declared as separate pipelines because they are separate
 * jobs — which is what the `mode` flag above was standing in for, badly: one
 * unnamed list could not say what it was for, so a flag beside it had to.
 */
type EntryName = "onProcess" | "onRequest";

const ENTRY_NAMES: EntryName[] = ["onProcess", "onRequest"];

/**
 * An incoming request as MixedData: JSON metadata plus the raw body. Mirrors
 * hkp-rt's body-carrying HTTP service so the same pipeline works on either.
 */
type MixedRequest = {
  meta: JsonRecord;
  /**
   * The raw body, for content whose type does not say what the bytes mean.
   * Absent once the body has been decoded into `body` — keeping both would
   * double the payload to restate what the decoded value already carries — and
   * absent entirely when the request had no body.
   */
  binary?: Uint8Array;
  /**
   * The body decoded according to its content type. Present for the cases a
   * board can act on directly — a JSON webhook, a form post — instead of
   * needing bytes decoded by hand. Absent when the type is not textual, when
   * there is no body, or when it did not parse.
   */
  body?: unknown;
};

/** Content type with any parameters (`; charset=…`) stripped, lower-cased. */
function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Decode a body for the content types where a board would otherwise be stuck
 * with raw bytes. Returns undefined when there is nothing sensible to produce,
 * which includes malformed input: a public endpoint receives whatever it is
 * given, and a parse failure should leave the raw bytes to inspect rather than
 * fail the request.
 */
function decodeBody(
  binary: Uint8Array,
  contentType: string | undefined,
): unknown {
  if (binary.length === 0) {
    return undefined;
  }

  const type = mediaType(contentType);
  const asText = () => Buffer.from(binary).toString("utf8");

  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(asText());
    } catch {
      return undefined;
    }
  }

  if (type === "application/x-www-form-urlencoded") {
    const fields: JsonRecord = {};
    for (const [key, value] of new URLSearchParams(asText())) {
      fields[key] = value;
    }
    return fields;
  }

  if (type.startsWith("text/")) {
    return asText();
  }

  return undefined;
}

class RequestTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Extracts `filename="…"` from a content-disposition header, if present. */
function filenameFromDisposition(
  disposition: string | undefined,
): string | undefined {
  if (!disposition) {
    return undefined;
  }
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * What a pipeline may answer with, as against what it was given.
 *
 * The same envelope a request arrives in — `meta` beside `body` or `binary` —
 * read in the other direction, which is also the shape `http-client` hands back
 * for a call it made. So a board that proxies one endpoint to another passes
 * the response along untouched, and a board that builds one writes the shape it
 * already reads.
 *
 * Without an envelope the answer is JSON, which is what every board written
 * before this got and still gets. The single exception is raw bytes, which are
 * sent as bytes: JSON encoding them produced an object of numbered keys, and no
 * board wanted that.
 */
type MixedResponse = {
  meta?: JsonRecord;
  binary?: Uint8Array;
  body?: unknown;
};

/** A response, reduced to the three things writing one needs. */
type Answer = {
  status: number;
  headers: JsonRecord;
  /** The bytes to send; text and JSON are encoded before they get here. */
  payload: Uint8Array;
};

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Reads a value as a response envelope, or returns null when it is not one.
 *
 * **A status is what tells the two apart.** A request envelope and a response
 * envelope are the same shape, and a pipeline that passes its input through
 * returns the request — so reading any `meta` as a response would answer the
 * caller with the content type they sent, and silently change what every board
 * written before this did. A request has no status and a response always has
 * one, which makes `meta.status` the one field that cannot be a coincidence.
 *
 * It is also what a proxied answer already carries: `http-client` reports a
 * response as `{meta: {status, headers, contentType}, …}`, so a board that
 * calls one endpoint and answers with what it got does nothing special.
 */
function asResponseEnvelope(value: unknown): MixedResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as MixedResponse;
  const meta = candidate.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  if (typeof meta.status !== "number") {
    return null;
  }
  const carries = "binary" in candidate || "body" in candidate;
  return carries ? candidate : null;
}

/** Header map from an envelope's `meta.headers`, names lower-cased. */
function envelopeHeaders(meta: JsonRecord): JsonRecord {
  const declared = meta.headers;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    return {};
  }
  const headers: JsonRecord = {};
  for (const [name, value] of Object.entries(declared as JsonRecord)) {
    if (value !== null && value !== undefined) {
      headers[name.toLowerCase()] = String(value);
    }
  }
  return headers;
}

/**
 * The answer a value stands for: an envelope's status, headers and payload, or
 * the type-led default for a bare value.
 */
function toAnswer(value: unknown): Answer {
  const envelope = asResponseEnvelope(value);
  if (envelope) {
    const meta = envelope.meta ?? {};
    const headers = envelopeHeaders(meta);
    const status = typeof meta.status === "number" ? meta.status : 200;
    const declaredType =
      typeof meta.contentType === "string" ? meta.contentType : undefined;

    if (isBytes(envelope.binary)) {
      headers["content-type"] =
        declaredType ?? headers["content-type"] ?? "application/octet-stream";
      return { status, headers, payload: envelope.binary };
    }

    const body = envelope.body;
    if (typeof body === "string") {
      headers["content-type"] =
        declaredType ?? headers["content-type"] ?? "text/plain; charset=utf-8";
      return {
        status,
        headers,
        payload: new Uint8Array(Buffer.from(body, "utf8")),
      };
    }

    headers["content-type"] =
      declaredType ?? headers["content-type"] ?? "application/json";
    return {
      status,
      headers,
      payload: new Uint8Array(Buffer.from(JSON.stringify(body ?? null), "utf8")),
    };
  }

  // Bytes are the one value whose own type says what to do with it: JSON
  // encoding a Uint8Array produces an object of numbered keys, which is nothing
  // anybody asked for. Everything else stays JSON, including a bare string —
  // that is what a board serving a held value already answers with, and a board
  // that means text says so in an envelope.
  if (isBytes(value)) {
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      payload: value,
    };
  }

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    payload: new Uint8Array(Buffer.from(JSON.stringify(value ?? null), "utf8")),
  };
}

/**
 * The range a `Range: bytes=…` header asks for, clamped to what there is, or
 * null when the header asks for nothing this can serve — no header, a unit
 * other than bytes, more than one range, or a start past the end.
 *
 * A player seeking inside an audio file sends one of these, and a server that
 * ignores it answers the whole file every time somebody drags the scrubber.
 * Slicing an answer already in hand is the whole of it: the pipeline produced
 * the bytes, and which of them travel is the server's business.
 */
function requestedRange(
  value: string | undefined,
  length: number,
): { start: number; end: number } | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  // "bytes=-500" is the last 500 bytes, not a range starting at zero.
  if (rawStart === "") {
    const span = Number(rawEnd);
    if (!span) {
      return null;
    }
    return { start: Math.max(0, length - span), end: length - 1 };
  }

  const start = Number(rawStart);
  if (start >= length) {
    return null;
  }
  const end = rawEnd === "" ? length - 1 : Math.min(Number(rawEnd), length - 1);
  return end < start ? null : { start, end };
}

type HttpServerSubservicesState = JsonRecord & {
  bypass: boolean;
  mode: HttpServerMode;
  /** Name this endpoint is known by; see the field on the service. */
  mountName: string;
  /** Public endpoint assigned by the runtime; empty while bypassed. Reserved
   *  name: generic board machinery reads and rewrites it (see the frontend's
   *  runtime/board/mount). */
  __hkpMount: string;
  /** Which request headers reach the pipeline; see the field on the service. */
  forwardHeaders: string[] | null;
  pipeline: Array<{
    serviceId: string;
    instanceId: string;
    state: JsonRecord;
  }>;
};

export class HttpServerSubservicesService implements HostedService {
  readonly serviceId = httpServerSubservicesDescriptor.serviceId;
  readonly serviceName = httpServerSubservicesDescriptor.serviceName;
  readonly capabilities = httpServerSubservicesDescriptor.capabilities;
  readonly uuid: string;

  private bypass = true;
  private mode: HttpServerMode = "process_on_session";
  /**
   * What this endpoint is called, which is what its public address is derived
   * from. Empty falls back to the service's uuid, which is stable in a board
   * file too — so an address only changes when a board deliberately renames it.
   */
  private mountName = "";
  /**
   * Which of a request's headers the pipeline is shown, or null for all.
   *
   * Headers are where a caller puts a credential, and `meta` goes wherever the
   * pipeline takes it — including into a board, if a service is wired to write
   * it there. Naming the ones a board actually reads is how it stops carrying
   * the ones it does not: an empty list forwards none, and no list at all
   * forwards everything, which is what a board that has not thought about it
   * gets.
   */
  private forwardHeaders: string[] | null = null;
  private latestData: unknown = null;

  private mount: MountHandle | null = null;
  /**
   * Which way the board declared its pipelines; see the header.
   *
   * Kept because state reports what was declared rather than a canonical form:
   * a board saved after being loaded has to come back out the way it went in,
   * or every board on the older spelling rewrites itself the first time
   * somebody saves it.
   */
  private form: "legacy" | "entries" = "legacy";
  /** The one pipeline a legacy board declares, entered from whichever side its
   *  `mode` says. */
  private legacy: NestedPipeline | null = null;
  private readonly entries: Record<EntryName, NestedPipeline | null> = {
    onProcess: null,
    onRequest: null,
  };
  /**
   * The cells this endpoint's pipelines hold values in.
   *
   * Owned here because the two entry points are pipelines that never meet: a
   * value one of them produces has nowhere to live until the other runs. One
   * store per endpoint is also what keeps the names in it private, so two
   * endpoints on a runtime may both call a slot `document`.
   */
  private readonly slotStore: SlotStore = new Map<string, unknown>();
  private readonly createService: ServiceCreator;
  private host: RuntimeHost | null = null;

  constructor(
    config: ServiceConfiguration,
    createService: ServiceCreator,
    // Upper bound on a request body, in bytes; 0 disables the limit. Supplied by
    // the server because the endpoint is public and shared.
    private readonly maxBodyBytes = 0,
  ) {
    this.uuid = config.uuid;
    this.createService = createService;

    if (config.state) {
      this.configure(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    // `port` is accepted and ignored: the endpoint is served by the shared
    // runtime server under an assigned path, so a service no longer picks a
    // port. Older boards still carry the field, and rejecting it would fail
    // them on load for a setting that no longer means anything.

    // An array is a decision, including an empty one. Anything else — absent,
    // null, a string — leaves the default of forwarding all of them.
    if (config.forwardHeaders !== undefined) {
      this.forwardHeaders = Array.isArray(config.forwardHeaders)
        ? config.forwardHeaders
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.toLowerCase())
        : null;
    }
    if (typeof config.mountName === "string") {
      // Renaming rotates this endpoint's address, so an already-claimed mount
      // is released and claimed again under the new name rather than left
      // answering on the old one.
      const renamed = config.mountName !== this.mountName;
      this.mountName = config.mountName;
      if (renamed && this.mount) {
        this.releaseMount();
      }
    }

    if (
      config.mode === "process_on_session" ||
      config.mode === "process_on_data" ||
      config.mode === "process_on_both"
    ) {
      this.mode = config.mode;
    }

    // Declaring an entry point by name is what puts this endpoint in the newer
    // form, and from then on its state is reported that way.
    for (const name of ENTRY_NAMES) {
      if (Array.isArray(config[name])) {
        this.form = "entries";
        this.entryPipeline(name).setPipeline(config[name]);
      }
    }

    // An edit aimed at one named entry. The unscoped verbs below cannot say
    // which pipeline they mean once there is more than one.
    if (isJsonRecord(config.configurePipeline)) {
      const payload = config.configurePipeline;
      const name = payload.entry;
      if (name === "onProcess" || name === "onRequest") {
        this.form = "entries";
        this.editPipeline(this.entryPipeline(name), payload);
      }
    }

    if (
      Array.isArray(config.pipeline) ||
      isJsonRecord(config.appendService) ||
      typeof config.removeService === "string" ||
      isJsonRecord(config.configureService)
    ) {
      // The unscoped verbs belong to the one pipeline a legacy board declares.
      // Left working rather than redirected at an entry, because which entry
      // they would mean is exactly what the older form cannot say.
      this.editPipeline(this.legacyPipeline(), config);
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.releaseMount();
      } else {
        this.claimMount();
      }
    }

    // Anything above may have left this without an endpoint it should have —
    // coming out of bypass, or a rename that released the old address. One
    // check covers them rather than one per cause.
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }

    return this.getState();
  }

  /**
   * The pipeline behind one entry point, built on first use.
   *
   * Built lazily because an endpoint declaring only `onRequest` should not
   * carry an empty runtime for the side it never uses — and because an empty
   * pipeline and an absent one differ here: only the second leaves the board
   * answering.
   */
  private entryPipeline(name: EntryName): NestedPipeline {
    const existing = this.entries[name];
    if (existing) {
      return existing;
    }
    const created = this.newPipeline(name);
    this.entries[name] = created;
    return created;
  }

  private legacyPipeline(): NestedPipeline {
    if (!this.legacy) {
      this.legacy = this.newPipeline("pipeline");
    }
    return this.legacy;
  }

  private newPipeline(label: string): NestedPipeline {
    const pipeline = new NestedPipeline(
      `${this.uuid}:${label}`,
      this.createService,
      this.uuid,
    );
    // Both entries hold in the same cells: that they can is the whole reason
    // for declaring them separately.
    pipeline.shareSlots(this.slotStore);
    if (this.host) {
      pipeline.attach(this.host);
    }
    return pipeline;
  }

  /** The four edit verbs, applied to whichever pipeline was named. */
  private editPipeline(pipeline: NestedPipeline, payload: JsonRecord): void {
    if (Array.isArray(payload.pipeline)) {
      pipeline.setPipeline(payload.pipeline);
    } else if (isJsonRecord(payload.appendService)) {
      pipeline.append(payload.appendService);
    } else if (typeof payload.removeService === "string") {
      pipeline.remove(payload.removeService);
    } else if (isJsonRecord(payload.configureService)) {
      const edit = payload.configureService;
      if (typeof edit.instanceId === "string" && isJsonRecord(edit.state)) {
        pipeline.configureService(edit.instanceId, edit.state);
      }
    }
  }

  /**
   * The nested service a scoped address names, searching every pipeline this
   * endpoint owns. The two entries are separate pipelines rather than branches
   * of one, so an instanceId used in both resolves to whichever `pipelines()`
   * lists first.
   */
  findNested(instanceId: string): HostedService | undefined {
    for (const pipeline of this.pipelines()) {
      const found = pipeline.find(instanceId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  getState(): JsonRecord {
    const common = {
      bypass: this.bypass,
      mountName: this.mountName,
      __hkpMount: this.mount?.url ?? "",
      forwardHeaders: this.forwardHeaders,
    };

    // What was declared, not what it was understood as. A board that named its
    // entries gets them back; one that carries a `mode` keeps it, because that
    // is the version an older runtime can still load.
    if (this.form === "entries") {
      const state: JsonRecord = { ...common };
      for (const name of ENTRY_NAMES) {
        const pipeline = this.entries[name];
        if (pipeline) {
          state[name] = pipeline.state();
        }
      }
      return state;
    }

    const state: HttpServerSubservicesState = {
      ...common,
      mode: this.mode,
      pipeline: this.legacy?.state() ?? [],
    };
    return state;
  }

  /** Passes the scope on to the nested pipelines; see SubService.setScope. */
  setScope(scope: RuntimeScope): void {
    for (const pipeline of this.pipelines()) {
      pipeline.setScope(scope);
    }
  }

  /** Every pipeline this endpoint owns, each one only once. */
  private pipelines(): NestedPipeline[] {
    const all = [this.legacy, this.entries.onProcess, this.entries.onRequest];
    return [...new Set(all.filter((p): p is NestedPipeline => !!p))];
  }

  /**
   * The pipeline one side enters through, or null where that side has none.
   *
   * This is where a legacy `mode` is read, and the only place it is: a board
   * that names its entries never reaches the table below.
   *
   * | declared                       | onProcess | onRequest |
   * |--------------------------------|-----------|-----------|
   * | `process_on_session`           | —         | the one   |
   * | `process_on_both`              | the one   | the one   |
   * | `process_on_data`              | —         | —         |
   *
   * `process_on_both` answers with *the same instance* on both sides, never a
   * second copy of the configuration: a pipeline holding a Hold, a timer or a
   * mount is one running thing, and duplicating it would give a board two of
   * each and a slot that never reaches itself.
   */
  private entryFor(name: EntryName): NestedPipeline | null {
    if (this.form === "entries") {
      return this.entries[name];
    }
    if (this.mode === "process_on_data") {
      return null;
    }
    if (name === "onProcess" && this.mode !== "process_on_both") {
      return null;
    }
    return this.legacy;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    // State is applied in the constructor, before the host exists, so a service
    // configured as already-active has nothing to claim its mount from until
    // now. Claiming here is what makes a board load into a live endpoint.
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }
    // A pipeline built in the constructor was built before there was a host to
    // ask what board it belongs to, or to report through.
    for (const pipeline of this.pipelines()) {
      pipeline.attach(host);
    }
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    // The legacy built-in slot: what the board hands this endpoint is what a
    // caller gets back. Expressible now as an `onProcess` that writes a slot
    // and an `onRequest` that reads it, and kept because boards carry the older
    // spelling and a board is a document people keep.
    if (this.form === "legacy" && this.mode === "process_on_data") {
      this.latestData = input;
      return input;
    }

    const entry = this.bypass ? null : this.entryFor("onProcess");
    if (!entry) {
      return input;
    }
    // Routing only: what the pass's own pipeline returns carries on down the
    // chain. Whatever has to survive until a request arrives — a value this
    // side produces and the other reads — belongs in a slot, which is a
    // service's job and not this one's.
    return this.runEntry(entry, input);
  }

  destroy(): void {
    this.releaseMount();
    // Nested services hold the same things top-level ones do — timers, sockets,
    // mounts — and nothing else will ever reach them once this service is gone.
    for (const pipeline of this.pipelines()) {
      pipeline.destroy();
    }
    this.legacy = null;
    this.entries.onProcess = null;
    this.entries.onRequest = null;
  }

  /** See HostedService.remount: the runtime can serve one now. */
  remount(): void {
    // Bypassed is the same answer it gives at setHost: an endpoint switched
    // off holds no address, and gaining somewhere to claim one does not switch
    // it back on.
    if (!this.bypass) {
      this.claimMount();
    }
  }

  private claimMount(): void {
    if (this.mount || !this.host?.mount) {
      return;
    }

    this.mount = this.host.mount(
      this.uuid,
      {
        request: (req, res, context) => {
          void this.handleRequest(req, res, context);
        },
      },
      { mountName: this.mountName },
    );

    // A board reads the assigned endpoint from here (or from state), since it
    // is not knowable at design time.
    this.notify({ __hkpMount: this.mount?.url ?? "" }, this.uuid);
  }

  private releaseMount(): void {
    this.mount?.release();
    this.mount = null;
  }

  /**
   * Build the MixedData an incoming request becomes: JSON `meta` describing it,
   * plus the body in whichever single form is useful — decoded as `body` when
   * the content type says what the bytes mean, raw as `binary` otherwise. The
   * meta/binary pair is the shape hkp-rt's body-carrying HTTP service produces,
   * so pipelines handling uploads can be written once against it.
   *
   * `meta.path` stays the URL path this service has always reported. A filename
   * from content-disposition is surfaced separately as `meta.filename` rather
   * than overloading `path`, which would silently change what existing
   * pipelines match on.
   */
  private async readRequest(
    req: IncomingMessage,
    context: MountContext,
  ): Promise<MixedRequest> {
    // The mount prefix is transport addressing, not part of the route the
    // pipeline matches on, so the pipeline sees the path below the mount.
    const url = new URL(context.subPath, "http://localhost");
    const query: JsonRecord = {};
    for (const [key, value] of url.searchParams) {
      query[key] = value;
    }

    const contentType = header(req, "content-type");
    const meta: JsonRecord = {
      method: req.method ?? "GET",
      path: url.pathname,
      query,
      headers: this.requestHeaders(req),
    };
    if (contentType) {
      meta.contentType = contentType;
    }
    const filename = filenameFromDisposition(
      header(req, "content-disposition"),
    );
    if (filename) {
      meta.filename = filename;
    }

    const binary = await this.readBody(req);

    // Exactly one representation of the body, or neither when there was none.
    const body = decodeBody(binary, contentType);
    if (body !== undefined) {
      return { meta, body };
    }
    return binary.length > 0 ? { meta, binary } : { meta };
  }

  /**
   * The headers this pipeline is shown, lower-cased as HTTP names compare.
   *
   * A caller that has to prove who it is does so in a header — a shared secret,
   * a signature, a bearer token — so a pipeline that cannot see them cannot
   * check one. What a board does not name, it does not receive.
   */
  private requestHeaders(req: IncomingMessage): JsonRecord {
    const headers: JsonRecord = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      if (this.forwardHeaders && !this.forwardHeaders.includes(name)) {
        continue;
      }
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
  }

  /**
   * Read the request body, refusing anything past the configured cap.
   *
   * A mount is reachable without a token by design, so an unbounded read is a
   * way for anyone holding the URL to exhaust the host — which on a shared
   * instance is everyone else's problem too. The cap is enforced while reading
   * rather than from content-length, which a client controls.
   */
  private readBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let rejected = false;

      req.on("data", (chunk: Buffer) => {
        if (rejected) {
          // Keep draining but stop accumulating: memory is what the limit
          // protects, and tearing the socket down here would lose the 413 the
          // caller is about to write.
          return;
        }
        total += chunk.length;
        if (this.maxBodyBytes > 0 && total > this.maxBodyBytes) {
          rejected = true;
          chunks.length = 0;
          reject(new RequestTooLargeError());
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (!rejected) {
          resolve(new Uint8Array(Buffer.concat(chunks)));
        }
      });

      req.on("error", (err) => {
        if (!rejected) {
          reject(err);
        }
      });
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    context: MountContext,
  ): Promise<void> {
    if (this.bypass) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "http-server-subservices is bypassed" }));
      return;
    }

    // Serving a request is one run, however many pipelines it passes through:
    // the nested handler below descends from it, and the outer chain afterwards
    // continues it. Minting one here rather than letting each leg mint its own
    // is what keeps a request's trace joined up instead of arriving as two
    // unrelated runs that happen to share a timestamp.
    const runContext = newRun();

    let output: unknown;
    let processInput: unknown;
    // Whether the answer is already decided here, or is whatever the rest of
    // the outer chain makes of what this service emitted.
    let answeredHere = false;
    if (this.form === "legacy" && this.mode === "process_on_data") {
      processInput = this.latestData;
      output = processInput;
      // The mode's whole contract: what the board handed this endpoint is what
      // a caller gets back, verbatim. The services after it still run — having
      // served a request is something a board may want to act on — but what
      // they make of it is theirs, not the answer. Letting the chain's tail
      // answer instead would mean an endpoint could only ever be the last
      // service in its runtime, so a runtime could publish only one document.
      answeredHere = true;
    } else {
      let request: MixedRequest;
      try {
        request = await this.readRequest(req, context);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          res.statusCode = 413;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
        throw error;
      }
      processInput = request;
      // A declared handler is what takes the answer away from the chain — not
      // the presence of a pipeline, which says only that this endpoint has
      // something to run, possibly on the other side. Without one the board
      // answers, which is the inversion of control this service is built
      // around.
      const handler = this.entryFor("onRequest");
      answeredHere = !!handler && !handler.isEmpty();
      output = handler
        ? await this.runEntry(handler, processInput, runContext)
        : processInput;
    }

    // What the nested pipeline produced, before the outer runtime sees it.
    const answer = output;

    // processFrom reports this service's own call-process pair, so there is no
    // manual pair here — emitting one too would double every request in the UI.
    // It also reports the right value: what this service emitted, rather than
    // what the whole downstream chain finally returned.
    if (this.host) {
      // No-op: the runtime already fans these out to its notification targets.
      // Re-notifying through the host would deliver every one twice.
      output = await this.host.processFrom(this.uuid, output, () => {}, runContext);
      this.host.emitResult(output);
    }

    this.sendAnswer(req, res, answeredHere ? answer : output);
  }

  /**
   * Writes what the handler produced, honouring a range request when the
   * answer is bytes a caller can seek inside.
   */
  private sendAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    value: unknown,
  ): void {
    const answer = toAnswer(value);
    for (const [name, headerValue] of Object.entries(answer.headers)) {
      res.setHeader(name, String(headerValue));
    }

    const seekable = answer.status === 200;
    if (seekable) {
      res.setHeader("accept-ranges", "bytes");
    }

    const range = seekable
      ? requestedRange(header(req, "range"), answer.payload.length)
      : null;
    if (range) {
      const slice = answer.payload.subarray(range.start, range.end + 1);
      res.statusCode = 206;
      res.setHeader(
        "content-range",
        `bytes ${range.start}-${range.end}/${answer.payload.length}`,
      );
      res.setHeader("content-length", String(slice.length));
      res.end(Buffer.from(slice));
      return;
    }

    res.statusCode = answer.status;
    res.setHeader("content-length", String(answer.payload.length));
    res.end(Buffer.from(answer.payload));
  }

  /**
   * Runs one entry's pipeline as a run descended from `parent`.
   *
   * Both entry points land here, and they differ only in what they descend
   * from: a request brings the run its caller minted for the whole exchange,
   * while data from the outer chain arrives mid-call and descends from whatever
   * that call is running as.
   */
  private async runEntry(
    pipeline: NestedPipeline,
    input: unknown,
    parent?: ProcessContext | null,
  ): Promise<unknown> {
    return await pipeline.process(
      input,
      parent ?? this.host?.currentContext() ?? null,
    );
  }

  private notify(payload: unknown, instanceId?: string): void {
    this.host?.notify(payload, instanceId ?? this.uuid);
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

