import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";

/**
 * Where a mount is served and how much of the request path belongs to it.
 */
export type MountContext = {
  /** Public path prefix this mount owns, e.g. `/hosted/ab12…`. */
  mountPath: string;
  /**
   * Request target with `mountPath` removed; always starts with `/` and keeps
   * any query string, so a handler can parse it as a URL and see both.
   */
  subPath: string;
};

export type MountRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: MountContext,
) => void;

export type MountUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: MountContext,
) => void;

export type MountHandlers = {
  request: MountRequestHandler;
  /** Only needed by mounts that speak WebSocket (e.g. PeerJS signalling). */
  upgrade?: MountUpgradeHandler;
};

/** A live mount, handed back to the service that registered it. */
export type MountHandle = {
  /** Public URL clients should be pointed at. */
  url: string;
  /** Path prefix of `url`, useful for clients configured by host/port/path. */
  path: string;
  release(): void;
};

type MountRecord = {
  owner: string;
  runtimeId: string;
  serviceUuid: string;
  handlers: MountHandlers;
};

/** Requests under this prefix are served by mounts rather than the REST API. */
export const MOUNT_PREFIX = "/hosted";

/**
 * Routes public traffic to services that need to expose an endpoint, without
 * any of them binding a port of their own.
 *
 * A service asks for a mount and gets back an opaque, server-assigned id. That
 * id — rather than a port or a caller-chosen path — is what makes the endpoint
 * addressable, which matters for three reasons:
 *
 * - Ports are a single machine-wide namespace. With several tenants on one
 *   host, a service asking for a specific port is a land grab: the second
 *   claimant fails, and whoever wins receives traffic the other expected.
 * - Runtime ids are only unique per tenant (boards ship stable ones like
 *   `node`), so they cannot appear in a globally-routable path.
 * - These endpoints are deliberately unauthenticated — they exist to be called
 *   by outside parties. An unguessable id therefore doubles as the capability
 *   to reach them, and it carries no user identifier that a public URL would
 *   otherwise leak.
 */
export class MountRegistry {
  private readonly mounts = new Map<string, MountRecord>();

  /**
   * @param publicUrlFor Resolves a mount path to the URL clients should use.
   *   Returns undefined before the server is listening, since the port is not
   *   known until then.
   */
  constructor(
    private readonly publicUrlFor: (mountPath: string) => string | undefined,
  ) {}

  register(
    owner: string,
    runtimeId: string,
    serviceUuid: string,
    handlers: MountHandlers,
  ): MountHandle | null {
    const mountId = randomBytes(16).toString("hex");
    const mountPath = `${MOUNT_PREFIX}/${mountId}`;
    const url = this.publicUrlFor(mountPath);
    if (!url) {
      return null;
    }

    this.mounts.set(mountId, { owner, runtimeId, serviceUuid, handlers });
    return {
      url,
      path: mountPath,
      release: () => {
        this.mounts.delete(mountId);
      },
    };
  }

  /**
   * Drop every mount belonging to a runtime. Services release their own mounts
   * on destroy; this is the backstop so a torn-down runtime can never leave a
   * publicly reachable endpoint behind.
   */
  releaseRuntime(owner: string, runtimeId: string): void {
    for (const [mountId, record] of this.mounts) {
      if (record.owner === owner && record.runtimeId === runtimeId) {
        this.mounts.delete(mountId);
      }
    }
  }

  releaseOwner(owner: string): void {
    for (const [mountId, record] of this.mounts) {
      if (record.owner === owner) {
        this.mounts.delete(mountId);
      }
    }
  }

  get size(): number {
    return this.mounts.size;
  }

  /** Number of live mounts for a tenant, for quota checks. */
  countForOwner(owner: string): number {
    let count = 0;
    for (const record of this.mounts.values()) {
      if (record.owner === owner) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Serve a request if it targets a mount. Returns false when the path is not
   * a mount path, so the caller can fall through to the REST API.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const resolved = this.resolve(req.url);
    if (!resolved) {
      return false;
    }
    resolved.record.handlers.request(req, res, resolved.context);
    return true;
  }

  /**
   * Serve a WebSocket upgrade if it targets a mount. Returns false when the
   * path is not a mount path. A mount without an upgrade handler still returns
   * true — the request was addressed to it, and refusing it here is correct
   * rather than letting it fall through to runtime socket handling.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const resolved = this.resolve(req.url);
    if (!resolved) {
      return false;
    }
    const upgrade = resolved.record.handlers.upgrade;
    if (!upgrade) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return true;
    }
    upgrade(req, socket, head, resolved.context);
    return true;
  }

  private resolve(
    rawUrl: string | undefined,
  ): { record: MountRecord; context: MountContext } | null {
    if (!rawUrl) {
      return null;
    }
    // The base is a placeholder for parsing; only the path and query matter.
    const { pathname, search } = new URL(rawUrl, "http://localhost");
    if (!pathname.startsWith(`${MOUNT_PREFIX}/`)) {
      return null;
    }

    const remainder = pathname.slice(MOUNT_PREFIX.length + 1);
    const slash = remainder.indexOf("/");
    const mountId = slash === -1 ? remainder : remainder.slice(0, slash);
    const record = this.mounts.get(mountId);
    if (!record) {
      return null;
    }

    const subPath = (slash === -1 ? "/" : remainder.slice(slash)) + search;
    return {
      record,
      context: { mountPath: `${MOUNT_PREFIX}/${mountId}`, subPath },
    };
  }
}
