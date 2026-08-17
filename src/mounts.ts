import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { createHmac, randomBytes } from "node:crypto";

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
 *
 * The id is **derived, not drawn**: an HMAC of who owns the mount, which board
 * and runtime it is in, and what it is called, keyed by a secret only the
 * server holds. Randomness would be just as unguessable and was what this did
 * first, but it made the address change every time a board was loaded — so
 * anything outside pointing at it (a webhook configured in somebody else's
 * product) broke on every restart, and a board could not be redeployed without
 * reconfiguring its callers.
 *
 * Deriving it keeps the address stable across reloads, restarts and redeploys
 * while keeping the secret out of the board: the board says only what the mount
 * is *called*, which is not sensitive, and the server turns that into an
 * address nobody can compute without the key. Rotating the key rotates every
 * endpoint, and renaming one mount rotates only that one.
 */
export class MountRegistry {
  private readonly mounts = new Map<string, MountRecord>();
  private readonly secret: string;

  /**
   * @param publicUrlFor Resolves a mount path to the URL clients should use.
   *   Returns undefined before the server is listening, since the port is not
   *   known until then.
   * @param secret Keys the id derivation. A server that is given none draws one
   *   for this process, which is the old behaviour: addresses that work but do
   *   not survive a restart. `index.ts` persists one so they do.
   */
  constructor(
    private readonly publicUrlFor: (mountPath: string) => string | undefined,
    secret?: string,
  ) {
    this.secret = secret || randomBytes(32).toString("hex");
  }

  /**
   * The address a given mount always gets.
   *
   * Every part that identifies the mount goes in, so two services cannot derive
   * the same id: the tenant, the board, the runtime, and the mount's name. NUL
   * separates them, as it cannot occur in any of them — the same reasoning as
   * `tenantKey` in the server.
   */
  private deriveId(
    owner: string,
    boardName: string,
    runtimeId: string,
    name: string,
  ): string {
    return createHmac("sha256", this.secret)
      .update([owner, boardName, runtimeId, name].join("\u0000"))
      .digest("hex")
      .slice(0, 32);
  }

  register(
    owner: string,
    runtimeId: string,
    serviceUuid: string,
    handlers: MountHandlers,
    // What the mount is called, and the board's, so the address survives a
    // reload. A service that names nothing is identified by its own uuid, which
    // is stable in a board file too.
    options: { boardName?: string; mountName?: string } = {},
  ): MountHandle | null {
    const mountId = this.deriveId(
      owner,
      options.boardName ?? "",
      runtimeId,
      options.mountName || serviceUuid,
    );
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
