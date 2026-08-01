/**
 * Service Documentation
 * Service ID: http-client
 * Service Name: HTTP Client
 * Runtime: hkp-node
 * Modes: none (method is configuration, not a mode)
 * Key Config: url, __hkpMount (target), path, method, headers, userAgent, body
 * IO: in=body to send (string | object | bytes | {meta, body|binary})
 *     out=null immediately; the response is pushed through the rest of the
 *     pipeline when it arrives, shaped {meta, body?, binary?}
 *
 * The node implementation of the `http-client` concept hkp-rt also provides,
 * sharing its state contract (`url`, `method`, `headers`, `userAgent`, `body`)
 * and therefore its UI panel. It does not mirror the C++ service's URL
 * templating; this one takes its body from the pipeline.
 *
 * What it adds is `__hkpMount`, which takes precedence over `url` when set: an
 * address, or a `hkp-mount://<runtimeId>/<serviceUuid>` reference to the
 * service that owns the mount. A reference is resolved by the board's
 * coordinator, the only instance that can see across runtimes, and this service
 * is configured with the resulting address before it runs. Seeing a reference
 * here therefore means the owner has not published an address yet — a normal
 * state while a board is still coming up, not an error.
 *
 * The response shape mirrors what `http-server-subservices` produces for an
 * incoming request, so a pipeline that handles one handles the other.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { MOUNT_FIELD, parseMountRef } from "../coordinator/mount";

export const httpClientDescriptor: ServiceRegistryEntry = {
  serviceId: "http-client",
  serviceName: "HTTP Client",
  version: "v1",
  capabilities: [],
};

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

// Lower case, as hkp-rt's http-client stores them and the shared UI sends them.
const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/** Content type with any parameters (`; charset=…`) stripped, lower-cased. */
function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** Whether a response of this type is worth decoding rather than kept as bytes. */
function isTextual(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/x-www-form-urlencoded"
  );
}

type RequestBody = { body: BodyInit | Uint8Array; contentType?: string } | null;

export class HttpClientService implements HostedService {
  readonly serviceId = httpClientDescriptor.serviceId;
  readonly serviceName = httpClientDescriptor.serviceName;
  readonly version = httpClientDescriptor.version;
  readonly capabilities = httpClientDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private url = "";
  private mount = "";
  private path = "";
  private method: HttpMethod = "get";
  private headers: Record<string, string> = {};
  private userAgent = "";
  private body = "";
  private timeoutMs = 10000;
  private bypass = false;
  private inFlight = 0;

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
      url: this.url,
      // Reserved name: the coordinator reads and rewrites it. Holds the address
      // to call, or a reference to the service that owns it while unresolved.
      [MOUNT_FIELD]: this.mount,
      path: this.path,
      method: this.method,
      headers: this.headers,
      userAgent: this.userAgent,
      body: this.body,
      timeoutMs: this.timeoutMs,
      bypass: this.bypass,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.url === "string") {
      this.url = config.url;
    }
    if (typeof config[MOUNT_FIELD] === "string") {
      this.mount = config[MOUNT_FIELD] as string;
    }
    if (typeof config.path === "string") {
      this.path = config.path;
    }
    if (
      typeof config.method === "string" &&
      METHODS.includes(config.method.toLowerCase() as HttpMethod)
    ) {
      this.method = config.method.toLowerCase() as HttpMethod;
    }
    if (config.headers && typeof config.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        config.headers as JsonRecord,
      )) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
      this.headers = headers;
    }
    if (typeof config.userAgent === "string") {
      this.userAgent = config.userAgent;
    }
    if (typeof config.body === "string") {
      this.body = config.body;
    }
    if (typeof config.timeoutMs === "number" && config.timeoutMs > 0) {
      this.timeoutMs = config.timeoutMs;
    }
    if (typeof config.bypass === "boolean") {
      this.bypass = config.bypass;
    }
    return this.getState();
  }

  /**
   * Starts the request and stops the synchronous push.
   *
   * The runtime calls services one after another without awaiting, so a
   * response cannot be returned from here — it does not exist yet. Returning
   * null stops the push, and the rest of the pipeline is called with the
   * response once it arrives (the inversion-of-control path a cache or a
   * fetching service takes).
   */
  process(
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (this.bypass) {
      return input;
    }

    const target = this.targetUrl();
    if (!target) {
      // Either nothing is configured, or the mount's owner has not published an
      // address yet. Say so and stop; the next input tries again, by which time
      // the coordinator has usually handed the address over.
      notify({
        error: parseMountRef(this.mount)
          ? `Waiting for "${this.mount}" to publish an endpoint`
          : "No target configured",
      });
      return null;
    }

    void this.send(target, input, notify);
    return null;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * The URL to call, or null while there is nothing callable.
   *
   * A mount takes precedence over a typed URL — a board that names a service is
   * being explicit about which endpoint it means, and the address is not
   * knowable when the board is written. An unresolved reference is therefore
   * "not ready yet" rather than a reason to fall back to `url`, which would
   * silently call something else.
   */
  private targetUrl(): string | null {
    if (this.mount) {
      return parseMountRef(this.mount) ? null : this.join(this.mount);
    }
    return this.url ? this.join(this.url) : null;
  }

  private join(base: string): string {
    if (!this.path) {
      return base;
    }
    const stem = base.endsWith("/") ? base.slice(0, -1) : base;
    const suffix = this.path.startsWith("/") ? this.path : `/${this.path}`;
    return `${stem}${suffix}`;
  }

  private async send(
    url: string,
    input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inFlight += 1;
    notify({ requesting: true, url, inFlight: this.inFlight });

    try {
      const request = this.requestBody(input);
      const headers: Record<string, string> = { ...this.headers };
      if (request?.contentType && !headers["content-type"]) {
        headers["content-type"] = request.contentType;
      }
      if (this.userAgent && !headers["user-agent"]) {
        headers["user-agent"] = this.userAgent;
      }

      const response = await fetch(url, {
        method: this.method.toUpperCase(),
        headers,
        // Node's fetch takes a Uint8Array body; the DOM lib's BodyInit, which
        // these types come from, only admits the browser's set.
        body: request?.body as BodyInit | undefined,
        signal: controller.signal,
      });

      const result = await this.readResponse(url, response);
      notify({
        requesting: false,
        url,
        status: response.status,
        inFlight: this.inFlight - 1,
      });
      this.push(result, notify);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify({ requesting: false, url, error: message });
      // A failed request produces no result to pass on: the pipeline behind
      // this service is not called, rather than called with a fabricated one.
    } finally {
      clearTimeout(timer);
      this.inFlight -= 1;
    }
  }

  /**
   * Turns pipeline input into a request body.
   *
   * Accepts what an upstream `http-server-subservices` produces, so a request
   * received on one runtime can be forwarded from another unchanged.
   */
  private requestBody(input: unknown): RequestBody {
    if (this.method === "get") {
      return null;
    }
    if (input === undefined || input === null) {
      // Nothing came down the pipeline, so send the configured body — which is
      // how the shared UI's body field is meant to be used.
      return this.body
        ? { body: this.body, contentType: "text/plain; charset=utf-8" }
        : null;
    }

    if (typeof input === "string") {
      return { body: input, contentType: "text/plain; charset=utf-8" };
    }
    if (input instanceof Uint8Array) {
      return { body: input, contentType: "application/octet-stream" };
    }

    if (typeof input === "object") {
      const mixed = input as { meta?: JsonRecord; body?: unknown; binary?: unknown };
      const declared =
        typeof mixed.meta?.contentType === "string"
          ? (mixed.meta.contentType as string)
          : undefined;
      if (mixed.binary instanceof Uint8Array) {
        return {
          body: mixed.binary,
          contentType: declared ?? "application/octet-stream",
        };
      }
      if (mixed.meta !== undefined && mixed.body !== undefined) {
        return typeof mixed.body === "string"
          ? { body: mixed.body, contentType: declared ?? "text/plain; charset=utf-8" }
          : {
              body: JSON.stringify(mixed.body),
              contentType: declared ?? "application/json",
            };
      }
    }

    return { body: JSON.stringify(input), contentType: "application/json" };
  }

  /**
   * Shapes a response the way `http-server-subservices` shapes a request:
   * metadata always, a decoded body when the content type says what the bytes
   * mean, the bytes themselves when it does not.
   */
  private async readResponse(
    url: string,
    response: Response,
  ): Promise<JsonRecord> {
    const contentType = response.headers.get("content-type");
    const type = mediaType(contentType);
    const meta: JsonRecord = {
      url,
      status: response.status,
      statusText: response.statusText,
    };
    if (contentType) {
      meta.contentType = contentType;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return { meta };
    }

    if (isTextual(type)) {
      const text = Buffer.from(bytes).toString("utf-8");
      if (type === "application/json" || type.endsWith("+json")) {
        try {
          return { meta, body: JSON.parse(text) };
        } catch {
          // Declared JSON that is not JSON: hand over the text rather than
          // dropping the response.
          return { meta, body: text };
        }
      }
      return { meta, body: text };
    }

    return { meta, binary: bytes };
  }

  /**
   * Runs the rest of the pipeline with the response, then emits the runtime's
   * result. A service that produces data outside the push has to emit it
   * itself; nothing else will, and running the remaining services alone would
   * leave the chain dead from here on.
   */
  private push(
    result: JsonRecord,
    notify: (payload: unknown, instanceId?: string) => void,
  ): void {
    if (!this.host) {
      return;
    }
    const output = this.host.processFrom(
      this.uuid,
      result,
      (n: RuntimeNotification) => notify(n.payload, n.instanceId),
    );
    // A downstream service returning null means "stop" — honour it rather than
    // forwarding a dead result to the next runtime.
    if (output !== null && output !== undefined) {
      this.host.emitResult(output);
    }
  }
}
