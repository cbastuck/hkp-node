/**
 * Service Documentation
 * Service ID: websocket-reader
 * Service Name: WebsocketReader
 * Runtime: hkp-node
 * Modes: none
 * Key Config: bypass, key, exclusive (the endpoint is assigned, not configured)
 * IO: in=anything -> out=the same, unchanged; each received message is also
 *     pushed on through the pipeline as a pass of its own
 * Binary: a binary message becomes a Buffer
 * Text: parsed as JSON where it is JSON, a string otherwise
 *
 * **Accepts WebSocket connections and hands on every message they send**, each
 * one a pass through the services after this one and on to the next runtime.
 * The counterpart of `websocket-writer`: the writer connects outward, from
 * wherever it is, and this is what it connects to — hkp-rt's service of the
 * same id binds a port, this one is served at a runtime-assigned mount like
 * every hkp-node endpoint.
 *
 * **Only a client holding `key` is let in**, presented as
 * `Authorization: Bearer <key>` or as `?key=<key>` for a client that cannot set
 * headers (a browser). The mount address is public by design, so without a key
 * anyone who learnt it could feed the pipeline: an unset key admits nobody.
 * `key` is usually a `{{secret.<alias>}}` reference, resolved at each
 * connection and never kept.
 *
 * **`exclusive`** admits one client at a time, a new one closing the one
 * before — what a client reconnecting after its network dropped looks like
 * from here, before this side has noticed the old connection is gone. Without
 * it, messages from every connected client are handed on as they arrive.
 *
 * Messages enter the pipeline in the order they arrive.
 */
import { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import { MountHandle } from "../mounts";
import { resolveCredential } from "../secrets";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";

export const websocketReaderDescriptor: ServiceRegistryEntry = {
  serviceId: "websocket-reader",
  serviceName: "WebsocketReader",
};

type Connection = {
  socket: WebSocket;
  address: string;
  since: number;
  messages: number;
  bytesReceived: number;
};

export class WebsocketReaderService implements HostedService {
  readonly serviceId = websocketReaderDescriptor.serviceId;
  readonly serviceName = websocketReaderDescriptor.serviceName;
  readonly uuid: string;

  private bypass = true;
  private key = "";
  private exclusive = false;
  private mountName: string | undefined;
  private mount: MountHandle | null = null;
  private host: RuntimeHost | null = null;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<Connection>();

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
    // State is applied in the constructor, before the host exists, so a service
    // configured as already-active has nothing to claim its mount from until now.
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }
  }

  configure(config: JsonRecord): JsonRecord {
    // `host`, `port` and `path` are accepted and ignored: hkp-rt's reader binds
    // a port of its own, while this one is served at an assigned path.
    if (typeof config.key === "string") {
      this.key = config.key;
    }
    if (typeof config.exclusive === "boolean") {
      this.exclusive = config.exclusive;
    }
    if (typeof config.mountName === "string") {
      // Renaming rotates the address, so the old one is let go.
      const renamed = config.mountName !== this.mountName;
      this.mountName = config.mountName;
      if (renamed && this.mount) {
        this.releaseMount();
      }
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.releaseMount();
      }
    }
    if (!this.bypass && !this.mount) {
      this.claimMount();
    }

    return this.getState();
  }

  getState(): JsonRecord {
    const state: JsonRecord = {
      bypass: this.bypass,
      __hkpMount: this.mount?.url ?? "",
      // The reference as configured; its value is never reported.
      key: this.key,
      exclusive: this.exclusive,
      connections: this.describeConnections(),
    };
    if (this.mountName !== undefined) {
      state.mountName = this.mountName;
    }
    return state;
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    return input;
  }

  destroy(): void {
    this.releaseMount();
    this.sockets.close();
  }

  /** See HostedService.remount: the runtime can serve one now. */
  remount(): void {
    if (!this.bypass) {
      this.claimMount();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private claimMount(): void {
    if (this.mount || !this.host?.mount) {
      return;
    }
    this.mount = this.host.mount(
      this.uuid,
      {
        request: (_req, res) => {
          res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" });
          res.end("This address takes a WebSocket connection.\n");
        },
        upgrade: (req, socket, head) => {
          const refusal = this.admit(req);
          if (refusal) {
            socket.write(`HTTP/1.1 ${refusal}\r\n\r\n`);
            socket.destroy();
            return;
          }
          this.sockets.handleUpgrade(req, socket, head, (ws) =>
            this.accept(ws, req),
          );
        },
      },
      { mountName: this.mountName },
    );
    this.notify({ __hkpMount: this.mount?.url ?? "" });
  }

  private releaseMount(): void {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    this.connections.clear();
    this.mount?.release();
    this.mount = null;
    this.notify({ __hkpMount: "", connections: [] });
  }

  /** Why a connection is refused, or nothing when it may connect. */
  private admit(req: IncomingMessage): string | null {
    if (this.bypass) {
      return "404 Not Found";
    }
    const { value: expected, problem } = resolveCredential(
      this.host?.secrets?.(),
      this.key,
      this.mount?.url ?? "http://localhost",
    );
    if (!this.key || problem || !expected) {
      // Nothing to check a client against, so nobody is let in.
      return "403 Forbidden";
    }
    const presented = presentedKey(req);
    if (!presented || !sameKey(presented, expected)) {
      return "401 Unauthorized";
    }
    return null;
  }

  private accept(socket: WebSocket, req: IncomingMessage): void {
    if (this.exclusive) {
      for (const previous of this.connections) {
        previous.socket.terminate();
      }
      this.connections.clear();
    }
    const connection: Connection = {
      socket,
      address: requestAddress(req),
      since: Date.now(),
      messages: 0,
      bytesReceived: 0,
    };
    this.connections.add(connection);
    this.notify({ connections: this.describeConnections() });

    socket.on("message", (raw, isBinary) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      connection.messages += 1;
      connection.bytesReceived += bytes.length;
      this.handOn(isBinary ? bytes : parseText(bytes.toString("utf8")));
    });
    socket.on("close", () => {
      if (this.connections.delete(connection)) {
        this.notify({ connections: this.describeConnections() });
      }
    });
    socket.on("error", () => socket.terminate());
  }

  /**
   * One message, one pass through the services after this one, then on to the
   * next runtime. Started synchronously, so passes begin in arrival order.
   */
  private handOn(message: unknown): void {
    const host = this.host;
    if (!host || this.bypass) {
      return;
    }
    host
      .processFrom(this.uuid, message, () => {})
      .then((output) => {
        // A downstream service returning null means "stop".
        if (output !== null && output !== undefined) {
          host.emitResult(output);
        }
      })
      .catch((err) => {
        // Nobody called for this pass, so there is no caller to report to.
        host.log("error", "service.failed", {
          message: `websocket-reader: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private describeConnections(): JsonRecord[] {
    const now = Date.now();
    return [...this.connections].map((connection) => ({
      address: connection.address,
      seconds: Math.round((now - connection.since) / 100) / 10,
      messages: connection.messages,
      bytesReceived: connection.bytesReceived,
    }));
  }

  private notify(payload: JsonRecord): void {
    this.host?.notify(payload, this.uuid);
  }
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The key a client presents: a bearer token, or `?key=`. */
function presentedKey(req: IncomingMessage): string {
  const authorization = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) {
    return bearer[1].trim();
  }
  return (
    new URL(req.url ?? "/", "http://localhost").searchParams.get("key") ?? ""
  );
}

function sameKey(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestAddress(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) {
    return first.split(",")[0].trim();
  }
  return `${req.socket.remoteAddress ?? ""}:${req.socket.remotePort ?? ""}`;
}
