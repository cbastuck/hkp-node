/**
 * Service Documentation
 * Service ID: http-server-subservices
 * Service Name: HttpServerSubservices
 * Runtime: hkp-node
 * Modes: session pipeline hosting
 * Key Config: bypass/mode/pipeline (the endpoint is assigned, not configured)
 * IO: in=request envelope -> out=response envelope
 * Arrays: not primary
 * Binary: depends on endpoint + nested services
 * MixedData: not native in runtime
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { HostedRuntime } from "../runtime";
import { MountContext, MountHandle } from "../mounts";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";

export const httpServerSubservicesDescriptor: ServiceRegistryEntry = {
  serviceId: "http-server-subservices",
  serviceName: "HttpServerSubservices",
  capabilities: ["subservices"],
};

type HttpServerMode = "process_on_session" | "process_on_data";

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

type HttpServerSubservicesState = JsonRecord & {
  bypass: boolean;
  mode: HttpServerMode;
  /** Public endpoint assigned by the runtime; empty while bypassed. Reserved
   *  name: generic board machinery reads and rewrites it (see the frontend's
   *  runtime/board/mount). */
  __hkpMount: string;
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
  private latestData: unknown = null;

  private mount: MountHandle | null = null;
  private pipelineConfig: ServiceConfiguration[] = [];
  private pipeline: HostedRuntime | null = null;
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
    const previousBypass = this.bypass;

    // `port` is accepted and ignored: the endpoint is served by the shared
    // runtime server under an assigned path, so a service no longer picks a
    // port. Older boards still carry the field, and rejecting it would fail
    // them on load for a setting that no longer means anything.

    if (
      config.mode === "process_on_session" ||
      config.mode === "process_on_data"
    ) {
      this.mode = config.mode;
    }

    if (Array.isArray(config.pipeline)) {
      const nextPipeline = normalizePipelineArray(config.pipeline);
      if (!nextPipeline) {
        throw new Error("Invalid http-server-subservices pipeline format");
      }
      this.pipelineConfig = nextPipeline;
      this.rebuild();
    } else if (isJsonRecord(config.appendService)) {
      const appended = normalizePipelineEntry(config.appendService);
      if (!appended) {
        throw new Error("Invalid appendService payload");
      }
      this.syncStates();
      this.pipelineConfig.push(appended);
      this.rebuild();
    } else if (typeof config.removeService === "string") {
      this.syncStates();
      this.pipelineConfig = this.pipelineConfig.filter(
        (entry) => entry.uuid !== config.removeService,
      );
      this.rebuild();
    } else if (isJsonRecord(config.configureService)) {
      const payload = config.configureService;
      if (
        typeof payload.instanceId === "string" &&
        isJsonRecord(payload.state) &&
        this.pipeline
      ) {
        this.pipeline.configureService(payload.instanceId, payload.state);
        this.syncStates();
      }
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.releaseMount();
      } else {
        this.claimMount();
      }
    }

    if (previousBypass && !this.bypass && !this.mount) {
      this.claimMount();
    }

    return this.getState();
  }

  getState(): JsonRecord {
    const state: HttpServerSubservicesState = {
      bypass: this.bypass,
      mode: this.mode,
      __hkpMount: this.mount?.url ?? "",
      pipeline: this.getPipelineState(),
    };
    return state;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    // State is applied in the constructor, before the host exists, so a service
    // configured as already-active has nothing to claim its mount from until
    // now. Claiming here is what makes a board load into a live endpoint.
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (this.mode === "process_on_data") {
      this.latestData = input;
    }

    return input;
  }

  destroy(): void {
    this.releaseMount();
    this.pipeline = null;
    this.pipelineConfig = [];
  }

  private claimMount(): void {
    if (this.mount || !this.host?.mount) {
      return;
    }

    this.mount = this.host.mount(this.uuid, {
      request: (req, res, context) => {
        void this.handleRequest(req, res, context);
      },
    });

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
    };
    if (contentType) {
      meta.contentType = contentType;
    }
    const filename = filenameFromDisposition(header(req, "content-disposition"));
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

    let output: unknown;
    let processInput: unknown;
    if (this.mode === "process_on_data") {
      processInput = this.latestData;
      output = processInput;
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
      output = this.processSessionInput(processInput);
    }

    // processFrom reports this service's own call-process pair, so there is no
    // manual pair here — emitting one too would double every request in the UI.
    // It also reports the right value: what this service emitted, rather than
    // what the whole downstream chain finally returned.
    if (this.host) {
      // No-op: the runtime already fans these out to its notification targets.
      // Re-notifying through the host would deliver every one twice.
      output = this.host.processFrom(this.uuid, output, () => {});
      this.host.emitResult(output);
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    const json = JSON.stringify(output ?? null);
    res.end(json);
  }

  private processSessionInput(input: unknown): unknown {
    if (!this.pipeline || this.pipeline.listServices().length === 0) {
      return input;
    }

    return this.pipeline.process(input, (notification) => {
      this.notify(notification.payload, notification.instanceId);
    });
  }

  private notify(payload: unknown, instanceId?: string): void {
    this.host?.notify(payload, instanceId ?? this.uuid);
  }

  private syncStates(): void {
    if (!this.pipeline) {
      return;
    }

    const byId = new Map(
      this.pipeline
        .listServices()
        .map((service) => [service.uuid, service.state] as const),
    );

    this.pipelineConfig = this.pipelineConfig.map((entry) => {
      const state = byId.get(entry.uuid);
      if (!state || !isJsonRecord(state)) {
        return entry;
      }
      return { ...entry, state };
    });
  }

  private rebuild(): void {
    this.pipeline = new HostedRuntime(
      {
        id: `${this.uuid}:http-sub-runtime`,
        name: `${this.serviceName}-${this.uuid}`,
        boardName: "",
        services: this.pipelineConfig,
      },
      this.createService,
    );
  }

  private getPipelineState(): HttpServerSubservicesState["pipeline"] {
    if (!this.pipeline) {
      return this.pipelineConfig.map((entry) => ({
        serviceId: entry.serviceId,
        instanceId: entry.uuid,
        state: entry.state ?? {},
      }));
    }

    return this.pipeline.listServices().map((service) => ({
      serviceId: service.serviceId,
      instanceId: service.uuid,
      state: service.state,
    }));
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePipelineArray(
  value: unknown[],
): ServiceConfiguration[] | null {
  const result: ServiceConfiguration[] = [];
  for (const entry of value) {
    const normalized = normalizePipelineEntry(entry);
    if (!normalized) {
      return null;
    }
    result.push(normalized);
  }
  return result;
}

function normalizePipelineEntry(value: unknown): ServiceConfiguration | null {
  if (!isJsonRecord(value) || typeof value.serviceId !== "string") {
    return null;
  }

  const instanceId =
    typeof value.instanceId === "string" && value.instanceId.length > 0
      ? value.instanceId
      : typeof value.uuid === "string" && value.uuid.length > 0
        ? value.uuid
        : randomUUID();

  const state = value.state;
  if (state !== undefined && !isJsonRecord(state)) {
    return null;
  }

  return {
    serviceId: value.serviceId,
    uuid: instanceId,
    name: typeof value.name === "string" ? value.name : undefined,
    serviceName:
      typeof value.serviceName === "string" ? value.serviceName : undefined,
    state,
  };
}
