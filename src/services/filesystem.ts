/**
 * Service Documentation
 * Service ID: filesystem
 * Service Name: Filesystem
 * Runtime: hkp-node
 * Modes: read | write | list | stat | delete — the request says which
 * Key Config: volume, operation, path
 * IO: in=a file request, JSON -> out={meta, binary} for a read, {meta, body}
 *     otherwise — the same envelope an HTTP request and response travel in
 * Arrays: a listing is one answer carrying many, not one pass per file
 * Binary: the point of the service
 * MixedData: not native in runtime
 *
 * The node counterpart of the `filesystem` service hkp-rt provides: the bytes a
 * board keeps, under a directory the runtime owns. What it does *not* do is
 * reach the machine's own file tree — a board names a path inside a volume, and
 * nothing it can write resolves outside one. A multi-tenant runtime cannot
 * offer "the local filesystem" and remain one; see `fileStore` for the layout
 * and the checks.
 *
 * **The operation comes from the request, not from a mode.** One instance
 * therefore answers a read and a write, which is what lets it sit behind
 * `storage` as an interchangeable backend: a board swaps this for something
 * that speaks S3 or SQL without the services around it noticing. Configuration
 * is what a request may leave unsaid — `operation` and `path` are defaults, not
 * overrides.
 *
 * **The answer is shaped like an HTTP response** (`meta` beside `binary` or
 * `body`), because that is what most reads become: a mount in front of this
 * serves a file by handing the answer straight back, content type and all. A
 * miss is a 404 in `meta.status` rather than an exception, for the same reason.
 */
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { FileStore, checkFilePath, contentTypeFor } from "./fileStore";

export const filesystemDescriptor: ServiceRegistryEntry = {
  serviceId: "filesystem",
  serviceName: "Filesystem",
  version: "v1",
  capabilities: [],
};

/** What a request may ask for. */
export type FileOperation = "read" | "write" | "list" | "stat" | "delete";

const OPERATIONS: FileOperation[] = ["read", "write", "list", "stat", "delete"];

type Notify = (payload: unknown, instanceId?: string) => void;

/** An answer, in the envelope a response travels in. */
function answer(meta: JsonRecord, carried: { binary?: Uint8Array; body?: unknown }): JsonRecord {
  return { meta, ...carried };
}

function failure(status: number, message: string, meta: JsonRecord = {}): JsonRecord {
  return answer(
    { ...meta, status, contentType: "application/json" },
    { body: { error: message } },
  );
}

/**
 * The bytes a write request carries, in whichever form it carried them.
 *
 * Three forms rather than one because three transports reach here: a service in
 * the same runtime hands over a `Uint8Array`, an HTTP body arrives as one too,
 * and a caller with only JSON to send has `base64`. Text and objects are a
 * convenience for the boards that write a feed or a manifest, where insisting
 * on an encoder service between the two would be ceremony.
 */
function bytesOf(request: JsonRecord): Uint8Array | { error: string } {
  if (request.binary instanceof Uint8Array) {
    return request.binary;
  }
  if (typeof request.base64 === "string") {
    try {
      return new Uint8Array(Buffer.from(request.base64, "base64"));
    } catch {
      return { error: "base64 is not decodable" };
    }
  }
  const body = request.body;
  if (typeof body === "string") {
    return new Uint8Array(Buffer.from(body, "utf8"));
  }
  if (body !== undefined && body !== null) {
    return new Uint8Array(Buffer.from(JSON.stringify(body), "utf8"));
  }
  return { error: "a write needs bytes: binary, base64 or body" };
}

export class FilesystemService implements HostedService {
  readonly serviceId = filesystemDescriptor.serviceId;
  readonly serviceName = filesystemDescriptor.serviceName;
  readonly version = filesystemDescriptor.version;
  readonly capabilities = filesystemDescriptor.capabilities;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  /** Which library this instance reads and writes. Empty is the board's own. */
  private volume = "";
  /** What a request that names no operation means. */
  private operation: FileOperation = "read";
  /** What a request that names no path means. */
  private path = "";
  private lastError = "";
  private lastPath = "";

  constructor(
    config: ServiceConfiguration,
    private readonly files: FileStore,
  ) {
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
      volume: this.volume,
      operation: this.operation,
      path: this.path,
      lastPath: this.lastPath,
      error: this.lastError,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    if (typeof config.volume === "string") {
      this.volume = config.volume.trim();
    }
    if (
      typeof config.operation === "string" &&
      OPERATIONS.includes(config.operation as FileOperation)
    ) {
      this.operation = config.operation as FileOperation;
    }
    if (typeof config.path === "string") {
      this.path = config.path.trim();
    }
    return this.getState();
  }

  async process(input: unknown, notify: Notify): Promise<unknown> {
    const scope = this.host?.scope();
    if (!scope) {
      return this.fail(notify, 500, "filesystem has no runtime to scope its volume to");
    }

    const request: JsonRecord =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as JsonRecord)
        : {};

    const operation = OPERATIONS.includes(request.op as FileOperation)
      ? (request.op as FileOperation)
      : this.operation;
    const requestedPath =
      typeof request.path === "string" && request.path.trim()
        ? request.path.trim()
        : this.path;
    const volume = this.volume || undefined;
    const fileScope = { ...scope, volume };

    // A listing is the one operation with nothing to name: a volume is a legal
    // thing to list, and an empty prefix says the whole of it.
    if (operation !== "list") {
      const checked = checkFilePath(requestedPath);
      if ("error" in checked) {
        return this.fail(notify, 400, checked.error, { op: operation });
      }
    }

    try {
      const result = await this.run(operation, fileScope, requestedPath, request);
      this.lastError = "";
      this.lastPath = requestedPath;
      notify(this.getState());
      return result;
    } catch (error) {
      return this.fail(
        notify,
        400,
        error instanceof Error ? error.message : String(error),
        { op: operation, path: requestedPath },
      );
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async run(
    operation: FileOperation,
    scope: Parameters<FileStore["read"]>[0],
    filePath: string,
    request: JsonRecord,
  ): Promise<JsonRecord> {
    switch (operation) {
      case "read": {
        const found = await this.files.read(scope, filePath);
        if (!found) {
          return failure(404, `no file at '${filePath}'`, { op: operation, path: filePath });
        }
        return answer(
          { op: operation, status: 200, ...found.info },
          { binary: found.bytes },
        );
      }

      case "write": {
        const bytes = bytesOf(request);
        if (!(bytes instanceof Uint8Array)) {
          return failure(400, bytes.error, { op: operation, path: filePath });
        }
        const info = await this.files.write(scope, filePath, bytes);
        return answer(
          { op: operation, status: 200, ...info },
          { body: { written: true, ...info } },
        );
      }

      case "list": {
        const prefix =
          typeof request.prefix === "string" ? request.prefix : filePath;
        const files = await this.files.list(scope, prefix || undefined);
        return answer(
          { op: operation, status: 200, path: prefix ?? "", count: files.length },
          { body: { files, count: files.length } },
        );
      }

      case "stat": {
        const info = await this.files.stat(scope, filePath);
        // Absence is an answer here, not a miss: "is this already rendered" is
        // the question, and "no" is what makes a board skip the work.
        return answer(
          {
            op: operation,
            status: 200,
            path: filePath,
            exists: !!info,
            contentType: contentTypeFor(filePath),
          },
          { body: info ? { exists: true, ...info } : { exists: false, path: filePath } },
        );
      }

      case "delete": {
        const deleted = await this.files.remove(scope, filePath);
        return answer(
          { op: operation, status: 200, path: filePath, deleted },
          { body: { deleted, path: filePath } },
        );
      }
    }
  }

  private fail(
    notify: Notify,
    status: number,
    message: string,
    meta: JsonRecord = {},
  ): JsonRecord {
    this.lastError = message;
    notify(this.getState());
    this.host?.log("error", "service.failed", { message: `filesystem: ${message}` });
    return failure(status, message, meta);
  }
}
