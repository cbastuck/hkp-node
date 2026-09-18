/**
 * Service Documentation
 * Service ID: storage
 * Service Name: Storage
 * Runtime: hkp-node
 * Modes: none — a request says whether it reads or writes
 * Key Config: prefix, readOnly, operation, pipeline (the backend), bypass
 * IO: in=a storage request, as JSON or as an HTTP request envelope
 *     -> out={meta, binary} for a read, {meta, body} otherwise
 * Arrays: a listing is one answer carrying many
 * Binary: the point of the service
 * MixedData: not native in runtime
 *
 * **A place on the board, rather than a place on a disk.** Everything a board
 * keeps that is bytes — rendered audio, an export, an image — is addressed
 * here, and what actually holds it is the nested pipeline: `filesystem` today,
 * something speaking S3 or SQL tomorrow, without a service in front of it
 * changing. That indirection is the whole service. Removing it would not save a
 * hop so much as spread one backend's vocabulary through every board that keeps
 * anything.
 *
 * **The contract is the shape of a request, not a set of paths.** A request
 * says what it wants done (`op`), to what (`path`), and with what (`binary`,
 * `base64`, `body`) — so the same request stands whether it arrived as a value
 * in a pipeline, as JSON over a mount, or as a plain HTTP call. That is what
 * keeps this from being an API somebody has to learn twice: a caller that can
 * say "write these bytes at this path" has said everything, and the transport
 * is the runtime's problem rather than the board author's.
 *
 * An HTTP request is read as the same thing: the method says the operation
 * (GET reads, HEAD stats, PUT and POST write, DELETE deletes) and the URL path
 * says which file. A path ending in `/` — or no path at all — is a directory
 * rather than a file, and lists. This is what a podcast client, a browser or
 * `curl` does without being told anything, which is the point of a resource
 * being reachable at all.
 *
 * **`readOnly` is what makes a public endpoint safe.** A mount is
 * unauthenticated by design, so the instance serving one answers reads and
 * refuses everything else; the instance boards write through is a different
 * one, reachable only from inside. Two instances over one volume, with the
 * policy in the board where it can be read, rather than a flag inside whatever
 * happens to hold the bytes.
 *
 * `prefix` confines every path to one part of the store, so a board can hand
 * out an endpoint over its episodes without handing out one over everything
 * else it kept. It is invisible from outside: a caller asks for `one.mp3` and a
 * listing answers `one.mp3`, because a path that cannot be asked for again is
 * not an answer.
 */
import {
  JsonRecord,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";
import { childRun } from "../runtime";
import { SubService } from "./sub-service";
import { FileOperation } from "./filesystem";

export const storageDescriptor: ServiceRegistryEntry = {
  serviceId: "storage",
  serviceName: "Storage",
  version: "v1",
  // Like SubService and Iterator: this service holds a pipeline, and the
  // board's UI needs to know that to let anyone look inside it.
  capabilities: ["subservices"],
};

const OPERATIONS: FileOperation[] = ["read", "write", "list", "stat", "delete"];

/** What an HTTP method asks a store to do. */
const BY_METHOD: Record<string, FileOperation> = {
  GET: "read",
  HEAD: "stat",
  PUT: "write",
  POST: "write",
  PATCH: "write",
  DELETE: "delete",
};

type Notify = (payload: unknown, instanceId?: string) => void;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An HTTP request envelope, as `http-server-subservices` builds one. */
function asHttpRequest(input: unknown): JsonRecord | null {
  if (!isRecord(input) || !isRecord(input.meta)) {
    return null;
  }
  return typeof input.meta.method === "string" ? input : null;
}

function failure(status: number, message: string, meta: JsonRecord = {}): JsonRecord {
  return {
    meta: { ...meta, status, contentType: "application/json" },
    body: { error: message },
  };
}

/** Joins a prefix to a path without either end having to know about the other. */
function join(prefix: string, filePath: string): string {
  const head = prefix.replace(/^\/+|\/+$/g, "");
  const tail = filePath.replace(/^\/+/, "");
  if (!head) {
    return tail;
  }
  return tail ? `${head}/${tail}` : head;
}

export class StorageService extends SubService {
  readonly serviceId = storageDescriptor.serviceId;
  readonly serviceName = storageDescriptor.serviceName;
  readonly version = storageDescriptor.version;
  readonly capabilities = storageDescriptor.capabilities;

  private prefix = "";
  private readOnly = false;
  private operation: FileOperation = "read";
  private lastOperation = "";
  private lastPath = "";
  private lastError = "";

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    super(config, createService);
    // See Iterator: a subclass's fields exist only once `super()` has returned,
    // so what the base constructor's `configure` read has to be read again.
    if (config.state) {
      this.settle(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    this.settle(config);
    super.configure(config);
    return this.getState();
  }

  getState(): JsonRecord {
    return {
      ...super.getState(),
      prefix: this.prefix,
      readOnly: this.readOnly,
      operation: this.operation,
      lastOperation: this.lastOperation,
      lastPath: this.lastPath,
      error: this.lastError,
    };
  }

  /** The part of a configuration this service owns rather than its base. */
  private settle(config: JsonRecord): void {
    if (typeof config.prefix === "string") {
      this.prefix = config.prefix.trim();
    }
    if (typeof config.readOnly === "boolean") {
      this.readOnly = config.readOnly;
    }
    if (
      typeof config.operation === "string" &&
      OPERATIONS.includes(config.operation as FileOperation)
    ) {
      this.operation = config.operation as FileOperation;
    }
  }

  async process(input: unknown, notify: Notify): Promise<unknown> {
    if (this.bypass) {
      return input;
    }
    if (!this.pipeline || this.pipeline.listServices().length === 0) {
      return this.fail(notify, 500, "storage has no backend pipeline");
    }

    const request = this.requestOf(input);
    if ("error" in request) {
      return this.fail(notify, request.status, request.error);
    }

    if (this.readOnly && request.value.op !== "read" && request.value.op !== "list" && request.value.op !== "stat") {
      return this.fail(
        notify,
        405,
        `this storage is read-only; '${request.value.op}' is not offered here`,
        { path: request.value.path },
      );
    }

    const parent = this.host?.currentContext() ?? null;
    const answer = await this.pipeline.process(
      request.value,
      () => {},
      childRun(parent),
    );

    this.lastOperation = String(request.value.op);
    this.lastPath = String(request.value.path ?? "");
    this.lastError = "";
    notify(this.getState());

    // A backend that stopped its pipeline answered nothing, which as an answer
    // is a miss: the caller asked a question and no one holding bytes replied.
    return this.withoutPrefix(
      answer ??
        failure(404, "the storage backend returned nothing", {
          op: request.value.op,
          path: request.value.path,
        }),
    );
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * The request a value stands for, whichever way it arrived.
   *
   * An HTTP envelope is translated; anything else is already a storage request
   * and is only given the defaults it left unsaid. Both come out as the one
   * shape the backend sees, which is what lets the backend be ignorant of how
   * the call reached the board.
   */
  private requestOf(
    input: unknown,
  ): { value: JsonRecord } | { error: string; status: number } {
    const http = asHttpRequest(input);
    if (http) {
      const meta = http.meta as JsonRecord;
      const method = String(meta.method ?? "GET").toUpperCase();
      const op = BY_METHOD[method];
      if (!op) {
        return { error: `'${method}' is not something a store can do`, status: 405 };
      }
      const requestPath = String(meta.path ?? "").replace(/^\/+/, "");
      // A directory rather than a file: no path, or one that says so.
      const listing = op === "read" && (!requestPath || requestPath.endsWith("/"));
      return {
        value: {
          op: listing ? "list" : op,
          path: join(this.prefix, requestPath),
          ...(listing ? { prefix: join(this.prefix, requestPath) } : {}),
          ...(http.binary instanceof Uint8Array ? { binary: http.binary } : {}),
          ...(http.body !== undefined ? { body: http.body } : {}),
          ...(typeof meta.contentType === "string"
            ? { contentType: meta.contentType }
            : {}),
        },
      };
    }

    const record = isRecord(input) ? input : {};
    const op = OPERATIONS.includes(record.op as FileOperation)
      ? (record.op as FileOperation)
      : this.operation;
    const requestPath = typeof record.path === "string" ? record.path : "";
    return {
      value: {
        ...record,
        op,
        path: join(this.prefix, requestPath),
        ...(op === "list" && typeof record.prefix === "string"
          ? { prefix: join(this.prefix, record.prefix) }
          : op === "list"
            ? { prefix: join(this.prefix, requestPath) }
            : {}),
      },
    };
  }

  /**
   * Answers in the caller's vocabulary, not the store's.
   *
   * A prefix is this instance's confinement and no part of what a caller
   * addresses: they ask for `one.mp3`, so a listing answering `episodes/one.mp3`
   * is naming a path that, asked for here, resolves to
   * `episodes/episodes/one.mp3`. Anything acting on a listing — a browser, a
   * player, the next service — would get a 404 it could do nothing about.
   */
  private withoutPrefix(answer: unknown): unknown {
    const head = this.prefix.replace(/^\/+|\/+$/g, "");
    if (!head || !isRecord(answer)) {
      return answer;
    }

    const strip = (value: unknown): unknown => {
      if (typeof value !== "string") {
        return value;
      }
      if (value === head) {
        return "";
      }
      return value.startsWith(`${head}/`) ? value.slice(head.length + 1) : value;
    };

    const meta = isRecord(answer.meta)
      ? { ...answer.meta, ...("path" in answer.meta ? { path: strip(answer.meta.path) } : {}) }
      : answer.meta;

    let body = answer.body;
    if (isRecord(body)) {
      body = {
        ...body,
        ...("path" in body ? { path: strip(body.path) } : {}),
        ...(Array.isArray(body.files)
          ? {
              files: body.files.map((file) =>
                isRecord(file) ? { ...file, path: strip(file.path) } : file,
              ),
            }
          : {}),
      };
    }

    return {
      ...answer,
      ...(meta !== undefined ? { meta } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }

  private fail(
    notify: Notify,
    status: number,
    message: string,
    meta: JsonRecord = {},
  ): JsonRecord {
    this.lastError = message;
    notify(this.getState());
    this.host?.log("error", "service.failed", { message: `storage: ${message}` });
    return failure(status, message, meta);
  }
}
