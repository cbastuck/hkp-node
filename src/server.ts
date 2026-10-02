import http from "node:http";
import { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";

import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";

import { MapService, mapDescriptor } from "./services/map";
import { MonitorService, monitorDescriptor } from "./services/monitor";
import { SubService, subServiceDescriptor } from "./services/sub-service";
import { IteratorService, iteratorDescriptor } from "./services/iterator";
import { TracksService, tracksDescriptor } from "./services/tracks";
import {
  CommunicationDispatcherService,
  communicationDispatcherDescriptor,
} from "./services/communication-dispatcher";
import { JoinService, joinDescriptor } from "./services/join";
import {
  HttpServerSubservicesService,
  httpServerSubservicesDescriptor,
} from "./services/http-server";
import {
  HttpClientService,
  httpClientDescriptor,
} from "./services/http-client";
import { StopperService, stopperDescriptor } from "./services/stopper";
import { TimerService, timerDescriptor } from "./services/timer";
import {
  PeerServerService,
  peerServerDescriptor,
} from "./services/peer-server";
import {
  WebsocketReaderService,
  websocketReaderDescriptor,
} from "./services/websocket-reader";
import {
  ImapEmailService,
  imapEmailDescriptor,
} from "./services/imap-email";
import {
  TelegramListenerService,
  telegramListenerDescriptor,
} from "./services/telegram-listener";
import {
  TelegramSenderService,
  telegramSenderDescriptor,
} from "./services/telegram-sender";
import {
  SmtpEmailService,
  smtpEmailDescriptor,
} from "./services/smtp-email";
import { HoldService, holdDescriptor } from "./services/hold";
import {
  createFileRecordStore,
  createMemoryRecordStore,
  RecordStore,
} from "./services/recordStore";
import {
  FileStore,
  checkFilePath,
  checkVolumeName,
  createDiskFileStore,
  createMemoryFileStore,
} from "./services/fileStore";
import { FilesystemService, filesystemDescriptor } from "./services/filesystem";
import { StorageService, storageDescriptor } from "./services/storage";
import { StoreService, storeDescriptor } from "./services/store";
import { SqlService, sqlDescriptor } from "./services/sql";
import { QueueService, queueDescriptor } from "./services/queue";
import {
  ConversationsService,
  conversationsDescriptor,
} from "./services/conversations";
import {
  DatabaseStore,
  createFileDatabaseStore,
  createMemoryDatabaseStore,
} from "./services/database";
import {
  DocumentExtractService,
  documentExtractDescriptor,
} from "./services/document-extract";
import {
  TextGenerationService,
  textGenerationDescriptor,
} from "./services/text-generation";
import { InjectorService, injectorDescriptor } from "./services/injector";
import { RssService, rssDescriptor } from "./services/rss";
import { AssetService, assetDescriptor } from "./services/asset";
import {
  contextFromWire,
  HostedRuntime,
  RuntimeApp,
  TenantRuntimes,
} from "./runtime";
import { MountRegistry } from "./mounts";
import { MessagePurpose, decodeYasMessage, encodeYasBinary } from "./yas";
import {
  AllowedOrigins,
  AuthConfig,
  AuthenticatedUser,
  Authenticator,
  AuthenticatorOptions,
  createAuthenticator,
  isOriginAllowed,
  ownerKeyOf,
} from "./auth";
import {
  HostedServiceFactory,
  JsonRecord,
  LogEntry,
  LogLevel,
  RuntimeConfiguration,
  RuntimeNotification,
  ServiceConfiguration,
} from "./types";
import { readSecretsPayload, referencedSecrets } from "./secrets";
import {
  AssetDescriptor,
  DEFAULT_MAX_INLINE_ASSET_BYTES,
  readAssetsPayload,
} from "./assets";
import {
  CoordinatorLinks,
  CoordinatorLinksOptions,
  LinkStore,
  createFileLinkStore,
  createMemoryLinkStore,
} from "./coordinatorLinks";

/**
 * Per-tenant limits. Runtimes, services and timers all consume resources on a
 * shared host, so without a cap one tenant can degrade the server for everyone.
 * Unset (or 0) means unlimited, which is the right default for a single-user
 * instance and for local development.
 */
export type Quotas = {
  maxRuntimesPerUser?: number;
  maxServicesPerRuntime?: number;
  minTimerIntervalMs?: number;
  /** Largest accepted request body on a public service endpoint; 0 disables. */
  maxRequestBodyBytes?: number;
  /**
   * Largest content an asset descriptor may carry itself (`text`, `base64`).
   * Unset keeps the default. Content past it is named by URL, which a runtime
   * fetches for itself.
   */
  maxInlineAssetBytes?: number;
  /**
   * Largest body of a request that carries asset descriptors: creating a
   * runtime, pushing assets to one, deploying a board. In effect how much
   * inline content one runtime — or one deployed board — may be handed at
   * once, counted as it travels: base64 for bytes, JSON-escaped for text.
   * Unset keeps the default.
   */
  maxAssetRequestBodyBytes?: number;
};

/**
 * Service endpoints are reachable without a token, so an unbounded body read is
 * available to anyone holding the URL. Unlike the other quotas this one defaults
 * to a real value rather than "unlimited": leaving it off would make the
 * dangerous choice the automatic one.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

/**
 * What a request carrying asset descriptors may weigh when nothing says
 * otherwise. A quota of its own rather than a multiple of the inline limit: a
 * runtime's create payload carries every asset its services reference and a
 * deployed board carries all of its own, so this is what bounds how much
 * inline content a board may hold, however many assets it is spread over.
 */
const DEFAULT_MAX_ASSET_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The largest body a request carrying asset descriptors may have, in bytes.
 * What was configured, as it stands. Left to the default it is never less
 * than one asset at the inline limit takes to travel — base64, four
 * characters for three bytes, and room for the rest of the request — so that
 * raising the inline limit alone does not leave it out of reach.
 */
function assetRequestBodyLimit(quotas: Quotas, maxInlineAssetBytes: number): number {
  if (quotas.maxAssetRequestBodyBytes && quotas.maxAssetRequestBodyBytes > 0) {
    return quotas.maxAssetRequestBodyBytes;
  }
  return Math.max(
    DEFAULT_MAX_ASSET_REQUEST_BODY_BYTES,
    Math.ceil((maxInlineAssetBytes * 4) / 3) + 1024 * 1024,
  );
}

/**
 * Whether a request is one that carries asset descriptors: provisioning a
 * runtime, pushing to one, and deploying a board to a coordinator.
 */
function carriesAssets(req: Request): boolean {
  return (
    req.method === "POST" &&
    (req.path === "/runtimes" ||
      /^\/runtimes\/[^/]+\/assets$/.test(req.path) ||
      /^\/coordinator\/users\/[^/]+\/boards$/.test(req.path))
  );
}

/**
 * Which runtime server this is, reported beside the runtimes so a client can
 * tell remote runtimes apart without reading their address.
 */
const RUNTIME_SERVER_KIND = "node";

type CreateRuntimeServerOptions = {
  auth?: AuthConfig;
  quotas?: Quotas;
  /**
   * Builds the authenticator, defaulting to a JWKS-backed one for `auth`.
   * Overriding it replaces only how a raw token is verified — the server still
   * resolves its own session tokens first, by passing the resolver it owns into
   * whatever this returns.
   */
  buildAuthenticator?: (options: AuthenticatorOptions) => Authenticator;
  allowedOrigins?: AllowedOrigins;
  externalHost?: string;
  externalSecure?: boolean;
  host?: string;
  name?: string;
  /**
   * Where `store` keeps what boards remember, or a store to use as given.
   *
   * Absent means memory: a runtime nobody told where to persist keeps records
   * for as long as it runs and no longer, which is the honest default for a
   * server that may be running from a checkout.
   */
  recordStore?: RecordStore | string;
  /**
   * Where SQL databases live, one file per board. Absent or empty means memory:
   * a runtime nobody told where to persist keeps them for as long as it runs.
   */
  database?: string;
  /**
   * Where `filesystem` keeps the files boards write, or a store to use as
   * given. Absent or empty means memory, as with the two stores above — bytes
   * a runtime was not told where to put outlive nothing.
   */
  files?: FileStore | string;
  /**
   * Keys the derivation of public mount addresses; see MountRegistry.
   *
   * Absent draws one per process, so endpoints work but change on restart.
   * `index.ts` persists one so a webhook configured elsewhere keeps working.
   */
  mountSecret?: string;
  /**
   * Where the tickets this server connects to coordinators with are kept, or a
   * store to use as given. Absent or empty means memory: the links work, and
   * are not re-established after a restart.
   */
  coordinatorLinks?: LinkStore | string;
  /** Timing of those connections; the defaults suit a real deployment. */
  coordinatorLinkOptions?: CoordinatorLinksOptions;
};

/** Refused for being over a per-tenant limit; carries what to tell the caller. */
class QuotaError extends Error {}

/** A coordinator session token, bound to the user it was minted for and the
 *  runtime it grants access to. */
type SessionToken = {
  sub: string;
  runtimeId: string;
};

/**
 * Runtime ids are unique per tenant, not globally, so anything keyed by runtime
 * outside a tenant view (socket sets, mounts) must be keyed by both. NUL cannot
 * occur in either part, so the join is unambiguous.
 */
function tenantKey(owner: string, runtimeId: string): string {
  return `${owner}\u0000${runtimeId}`;
}

type WsInboundMessage = {
  type?: string;
  params?: unknown;
  /** The run this call belongs to, as its caller named it; see ProcessContext. */
  context?: unknown;
};

/**
 * What a runtime socket frame asks for. Text frames are JSON; a binary frame is
 * a YAS message carrying bytes, which JSON cannot — the peer sends one for a
 * pass that is bytes (encoded audio, say), and it runs the pipeline with those
 * bytes as a Buffer. A binary frame has no room for a run context, so its pass
 * begins a run of its own.
 */
function readInbound(
  raw: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
): WsInboundMessage | null {
  const bytes = Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw);
  if (!isBinary) {
    try {
      return JSON.parse(bytes.toString());
    } catch {
      return null;
    }
  }
  const message = decodeYasMessage(bytes);
  // A NOTIFICATION frame answers a request this server never makes, and a type
  // this server does not read has nothing a Node service could use.
  if (
    !message ||
    message.purpose === MessagePurpose.NOTIFICATION ||
    message.data === undefined
  ) {
    return null;
  }
  return { type: "processRuntime", params: message.data };
}

export function createRuntimeServer(options: CreateRuntimeServerOptions = {}) {
  // Tests and local dev default to no auth; index.ts always resolves an explicit
  // config and fails closed for the published package (see resolveServerAuthConfig).
  const authConfig: AuthConfig = options.auth ?? { mode: "none" };
  const allowedOrigins: AllowedOrigins = options.allowedOrigins ?? "*";

  // Coordinator session tokens this runtime has issued (see POST .../session-token).
  // Opaque, in-memory, and bound to the minting user — so they resolve back to a
  // real `sub`, not an unscoped superuser. They live only as long as this process:
  // if the runtime dies, the coordinator must re-provision (which needs a live
  // user JWT). That bound is intentional for v1 — see the session-token route.
  const sessionTokens = new Map<string, SessionToken>();
  const buildAuthenticator =
    options.buildAuthenticator ??
    ((authOptions: AuthenticatorOptions) =>
      createAuthenticator(authConfig, authOptions));
  const authenticator: Authenticator = buildAuthenticator({
    resolveOpaqueToken: (token) => {
      const session = sessionTokens.get(token);
      return session ? { sub: session.sub } : null;
    },
  });
  const externalHost = options.externalHost ?? options.host ?? "127.0.0.1";
  const externalSecure = options.externalSecure ?? false;
  const quotas = options.quotas ?? {};
  const maxInlineAssetBytes =
    quotas.maxInlineAssetBytes && quotas.maxInlineAssetBytes > 0
      ? quotas.maxInlineAssetBytes
      : DEFAULT_MAX_INLINE_ASSET_BYTES;
  // Databases follow records below: one store for the whole server, scoped per
  // call, and an empty path saying "keep nothing on disk" rather than naming
  // the working directory as a root.
  const databases: DatabaseStore =
    typeof options.database === "string"
      ? options.database
        ? createFileDatabaseStore(options.database)
        : createMemoryDatabaseStore()
      : createMemoryDatabaseStore();

  // One store for the whole server; it is the scope handed to each call, not a
  // store per board, that keeps one board's records out of another's.
  // An empty path is how "keep nothing on disk" is said, and must not be read
  // as a root — which would be the working directory.
  const records: RecordStore =
    typeof options.recordStore === "string"
      ? options.recordStore
        ? createFileRecordStore(options.recordStore)
        : createMemoryRecordStore()
      : (options.recordStore ?? createMemoryRecordStore());

  // Files follow records and databases: one store for the server, scoped per
  // call, and an empty path saying "keep nothing on disk".
  const files: FileStore =
    typeof options.files === "string"
      ? options.files
        ? createDiskFileStore(options.files)
        : createMemoryFileStore()
      : (options.files ?? createMemoryFileStore());

  /** True when adding one more to `count` would pass the limit (0/unset = no limit). */
  function atQuota(count: number, limit: number | undefined): boolean {
    return !!limit && limit > 0 && count >= limit;
  }

  /** True when `count` items is already more than the limit allows. */
  function exceedsQuota(count: number, limit: number | undefined): boolean {
    return !!limit && limit > 0 && count > limit;
  }
  const factories = new Map<string, HostedServiceFactory>([
    [
      monitorDescriptor.serviceId,
      {
        descriptor: monitorDescriptor,
        create: (config, _createService) => new MonitorService(config),
      },
    ],
    [
      mapDescriptor.serviceId,
      {
        descriptor: mapDescriptor,
        create: (config, _createService) => new MapService(config),
      },
    ],
    [
      subServiceDescriptor.serviceId,
      {
        descriptor: subServiceDescriptor,
        create: (config, createService) =>
          new SubService(config, createService),
      },
    ],
    [
      iteratorDescriptor.serviceId,
      {
        descriptor: iteratorDescriptor,
        create: (config, createService) =>
          new IteratorService(config, createService),
      },
    ],
    [
      tracksDescriptor.serviceId,
      {
        descriptor: tracksDescriptor,
        create: (config, createService) => new TracksService(config, createService),
      },
    ],
    [
      communicationDispatcherDescriptor.serviceId,
      {
        descriptor: communicationDispatcherDescriptor,
        create: (config, createService) =>
          new CommunicationDispatcherService(config, createService),
      },
    ],
    [
      joinDescriptor.serviceId,
      {
        descriptor: joinDescriptor,
        create: (config, createService) => new JoinService(config, createService),
      },
    ],
    [
      httpServerSubservicesDescriptor.serviceId,
      {
        descriptor: httpServerSubservicesDescriptor,
        create: (config, createService) =>
          new HttpServerSubservicesService(
            config,
            createService,
            options.quotas?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
          ),
      },
    ],
    [
      timerDescriptor.serviceId,
      {
        descriptor: timerDescriptor,
        create: (config, _createService) =>
          new TimerService(config, options.quotas?.minTimerIntervalMs ?? 0),
      },
    ],
    [
      peerServerDescriptor.serviceId,
      {
        descriptor: peerServerDescriptor,
        create: (config, _createService) => new PeerServerService(config),
      },
    ],
    [
      websocketReaderDescriptor.serviceId,
      {
        descriptor: websocketReaderDescriptor,
        create: (config, _createService) => new WebsocketReaderService(config),
      },
    ],
    [
      httpClientDescriptor.serviceId,
      {
        descriptor: httpClientDescriptor,
        create: (config, _createService) => new HttpClientService(config),
      },
    ],
    [
      stopperDescriptor.serviceId,
      {
        descriptor: stopperDescriptor,
        create: (config, _createService) => new StopperService(config),
      },
    ],
    [
      imapEmailDescriptor.serviceId,
      {
        descriptor: imapEmailDescriptor,
        create: (config, _createService) => new ImapEmailService(config),
      },
    ],
    [
      telegramListenerDescriptor.serviceId,
      {
        descriptor: telegramListenerDescriptor,
        create: (config, _createService) =>
          new TelegramListenerService(config),
      },
    ],
    [
      telegramSenderDescriptor.serviceId,
      {
        descriptor: telegramSenderDescriptor,
        create: (config, _createService) => new TelegramSenderService(config),
      },
    ],
    [
      smtpEmailDescriptor.serviceId,
      {
        descriptor: smtpEmailDescriptor,
        create: (config, _createService) => new SmtpEmailService(config),
      },
    ],
    [
      holdDescriptor.serviceId,
      {
        descriptor: holdDescriptor,
        create: (config, _createService) => new HoldService(config),
      },
    ],
    [
      textGenerationDescriptor.serviceId,
      {
        descriptor: textGenerationDescriptor,
        create: (config, _createService) => new TextGenerationService(config),
      },
    ],
    [
      storeDescriptor.serviceId,
      {
        descriptor: storeDescriptor,
        create: (config, _createService) => new StoreService(config, records),
      },
    ],
    [
      sqlDescriptor.serviceId,
      {
        descriptor: sqlDescriptor,
        create: (config, _createService) => new SqlService(config, databases),
      },
    ],
    [
      filesystemDescriptor.serviceId,
      {
        descriptor: filesystemDescriptor,
        create: (config, _createService) => new FilesystemService(config, files),
      },
    ],
    [
      storageDescriptor.serviceId,
      {
        descriptor: storageDescriptor,
        create: (config, createService) => new StorageService(config, createService),
      },
    ],
    [
      conversationsDescriptor.serviceId,
      {
        descriptor: conversationsDescriptor,
        create: (config, _createService) =>
          new ConversationsService(config, databases),
      },
    ],
    [
      queueDescriptor.serviceId,
      {
        descriptor: queueDescriptor,
        create: (config, _createService) => new QueueService(config, databases),
      },
    ],
    [
      documentExtractDescriptor.serviceId,
      {
        descriptor: documentExtractDescriptor,
        create: (config, _createService) => new DocumentExtractService(config),
      },
    ],
    [
      injectorDescriptor.serviceId,
      {
        descriptor: injectorDescriptor,
        create: (config, _createService) => new InjectorService(config),
      },
    ],
    [
      rssDescriptor.serviceId,
      {
        descriptor: rssDescriptor,
        create: (config, _createService) => new RssService(config),
      },
    ],
    [
      assetDescriptor.serviceId,
      {
        descriptor: assetDescriptor,
        create: (config, _createService) => new AssetService(config),
      },
    ],
  ]);

  // Public service endpoints. Declared before the runtime app because runtimes
  // hand mounts to their services as they are created.
  const mounts = new MountRegistry(
    (mountPath) => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        return undefined;
      }
      return externalSecure
        ? `https://${externalHost}${mountPath}`
        : `http://${externalHost}:${address.port}${mountPath}`;
    },
    options.mountSecret,
  );

  const runtimeApp = new RuntimeApp(
    factories,
    (owner, runtimeId) => ({
      mount: (serviceUuid, handlers, options) =>
        mounts.register(owner, runtimeId, serviceUuid, handlers, options),
    }),
    // A `file://` asset is a file in one of the tenant's volumes —
    // `file:///<volume>/<path>` — read through the same store and the same
    // checks as `filesystem`. Nothing outside a volume is ever read: a shared
    // board naming a path on this machine is refused, not served.
    async (scope, url) => {
      const [volume, ...rest] = decodeURIComponent(url.pathname)
        .split("/")
        .filter((segment) => segment !== "");
      if (!volume || url.host || checkVolumeName(volume)) {
        return null;
      }
      const checked = checkFilePath(rest.join("/"));
      if ("error" in checked) {
        return null;
      }
      const found = await files.read({ ...scope, volume }, checked.path);
      return found?.bytes ?? null;
    },
    { maxInlineBytes: maxInlineAssetBytes },
  );
  const expressApp = express();
  expressApp.use(
    cors({
      origin: allowedOrigins === "*" ? true : allowedOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  // Not strict: a JSON `null` is a payload here, and the one that means "no
  // input". A pipeline is started with it whenever nothing precedes the first
  // service — a panel's Send button, an external trigger — and the strict
  // parser rejects a bare `null` before a route sees it, turning that into a
  // 400. The process routes tell the two apart themselves: no body at all is
  // `undefined` and refused, `null` runs the pipeline with nothing on its
  // input. Every other route already checks the shape it needs.
  //
  // Requests that carry asset descriptors are larger than any other control
  // request, by design: inline content travels in them. They get a limit of
  // their own, derived from the largest inline asset a runtime takes — and
  // only once the caller is known, so that the larger body is not something
  // anyone can make this server read.
  const controlBody = express.json({ strict: false });
  const assetBody = express.json({
    strict: false,
    limit: assetRequestBodyLimit(quotas, maxInlineAssetBytes),
  });
  expressApp.use((req, res, next) =>
    carriesAssets(req) ? next() : controlBody(req, res, next),
  );
  expressApp.use(authenticator.middleware);
  expressApp.use((req, res, next) =>
    carriesAssets(req) ? assetBody(req, res, next) : next(),
  );

  // Mounts are matched before Express so they bypass CORS and the auth
  // middleware entirely: they exist to be called by outside parties (webhooks,
  // uploads, PeerJS clients) that hold no token. Their unguessable mount id is
  // what gates access.
  const httpServer = http.createServer((req, res) => {
    if (mounts.handleRequest(req, res)) {
      return;
    }
    expressApp(req, res);
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  // Keyed by tenantKey(owner, runtimeId), not runtimeId — see tenantKey.
  const runtimeSockets = new Map<string, Set<WebSocket>>();

  /** The caller's runtime namespace. Every route resolves runtimes through it. */
  function tenantOf(req: Request): TenantRuntimes {
    return runtimeApp.forOwner(ownerKeyOf(req.authenticatedUser));
  }

  function runtimeOutputUrl(runtimeId: string): string | undefined {
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    if (externalSecure) {
      return `wss://${externalHost}/${runtimeId}`;
    }
    return `ws://${externalHost}:${address.port}/${runtimeId}`;
  }

  function serializeRuntime(runtime: HostedRuntime) {
    return runtime.serialize(runtimeOutputUrl(runtime.id));
  }

  /**
   * Carry a log entry to whoever is collecting this runtime's output.
   *
   * The same socket a notification takes, and for the same reason: it is the
   * connection the board's coordinator already holds, authenticated with a
   * credential minted to outlive the user's session. An entry differs in what
   * it is for — a notification is for whoever is watching, an entry has to
   * survive with nobody attached — but not in how it travels.
   */
  function sendJsonLog(socketKey: string, entry: LogEntry) {
    const sockets = runtimeSockets.get(socketKey);
    if (!sockets || sockets.size === 0) {
      return;
    }

    const message = JSON.stringify({ type: "log", entry });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }

  function sendJsonNotification(
    socketKey: string,
    notification: RuntimeNotification,
  ) {
    const sockets = runtimeSockets.get(socketKey);
    if (!sockets || sockets.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: "notification",
      instanceId: notification.instanceId,
      value: JSON.stringify(notification.payload),
    });

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }

  function sendJsonResult(socket: WebSocket, result: unknown) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // Bytes as bytes: JSON would spell each one out as a numbered key.
    if (result instanceof Uint8Array) {
      socket.send(encodeYasBinary(result, MessagePurpose.RESULT));
      return;
    }
    socket.send(JSON.stringify({ type: "result", data: result }));
  }

  /**
   * Resolve a runtime inside the caller's namespace. A runtime owned by another
   * tenant is reported as 404 rather than 403, so runtime ids belonging to other
   * users cannot be probed for existence.
   */
  function getRuntimeOr404(
    req: Request,
    res: Response,
    runtimeId: string,
  ): HostedRuntime | null {
    const runtime = tenantOf(req).getRuntime(runtimeId);
    if (!runtime) {
      res.sendStatus(404);
      return null;
    }
    return runtime;
  }

  // Tear a runtime down and drop any session tokens it issued, so a dead
  // runtime's tokens can't linger as valid credentials.
  function removeRuntimeAndSessions(owner: string, runtimeId: string): void {
    runtimeApp.removeRuntime(owner, runtimeId);
    mounts.releaseRuntime(owner, runtimeId);
    for (const [token, info] of sessionTokens) {
      if (info.sub === owner && info.runtimeId === runtimeId) {
        sessionTokens.delete(token);
      }
    }
  }

  /**
   * Builds a runtime for a tenant, replacing anything under that id, and wires
   * what it says to whoever is listening: the sockets watching it, and the
   * coordinator it belongs to when it has one.
   *
   * Provisioning creates. Attaching to a runtime that is already running is a
   * different intent and has its own verb — GET /runtimes/:id, which a client
   * uses before posting when it means "take back over" rather than "build
   * this".
   *
   * Replacing rather than reusing matters most for the flag the config
   * carries: reusing would keep the *old* runtime's lifecycle, so a board
   * deployed to a coordinator could inherit a browser's "clean me up when I
   * disconnect" and vanish when that browser closed.
   */
  function provisionRuntime(
    owner: string,
    config: RuntimeConfiguration,
  ): HostedRuntime {
    const tenant = runtimeApp.forOwner(owner);
    const replacing = tenant.getRuntime(config.id);

    // Quotas apply only to genuinely new runtimes — replacing one that already
    // exists must never be refused for being over the limit.
    if (
      !replacing &&
      atQuota(tenant.getRuntimes().length, quotas.maxRuntimesPerUser)
    ) {
      throw new QuotaError(
        `Runtime limit reached (${quotas.maxRuntimesPerUser})`,
      );
    }
    if (exceedsQuota(config.services.length, quotas.maxServicesPerRuntime)) {
      throw new QuotaError(
        `Service limit reached (${quotas.maxServicesPerRuntime})`,
      );
    }

    const runtime = tenant.createRuntime(config);
    const socketKey = tenantKey(owner, runtime.id);
    runtime.registerNotificationTarget((notification) => {
      sendJsonNotification(socketKey, notification);
      coordinatorLinks.emit(owner, runtime.id, {
        type: "notification",
        serviceUuid: notification.instanceId,
        payload: notification.payload,
      });
    });
    runtime.registerLogTarget((entry) => {
      sendJsonLog(socketKey, entry);
      coordinatorLinks.emit(owner, runtime.id, { type: "log", entry });
    });
    runtime.registerResultTarget((result) => {
      coordinatorLinks.emit(owner, runtime.id, { type: "result", data: result });
      const sockets = runtimeSockets.get(socketKey);
      if (!sockets) return;
      for (const socket of sockets) {
        sendJsonResult(socket, result);
      }
    });
    return runtime;
  }

  /**
   * What a coordinator may do here, over a connection this server opened to
   * it: the operations on one runtime, as the tenant who introduced the link.
   * The same things the REST routes below do for a caller holding a token.
   */
  const coordinatorLinks = new CoordinatorLinks(
    {
      kind: RUNTIME_SERVER_KIND,
      registry: () => runtimeApp.getRegistry(),
      runtimeExists: (owner, runtimeId) =>
        !!runtimeApp.getRuntime(owner, runtimeId),
      provision: (owner, runtimeId, payload, secrets) => {
        const config = validateRuntimeConfiguration({
          id: runtimeId,
          name: payload.name,
          boardName: payload.boardName,
          // The coordinator's until it says otherwise: a deployed board keeps
          // running with nobody watching.
          garbageCollected: false,
          state: payload.state,
          services: payload.services,
          assets: payload.assets,
        });
        if (!config) {
          throw new Error("The board's description of this runtime is malformed");
        }
        // The values this server was handed for the runtime, by the person's
        // own client. They do not come from the coordinator and never go to it.
        config.secrets = secrets;
        const runtime = provisionRuntime(owner, config);
        const held = new Set(runtime.secrets().aliases());
        const missingSecrets = referencedSecrets(
          config.services.map((service) => service.state),
        ).filter((alias) => !held.has(alias));
        return {
          registry: runtimeApp.getRegistry(),
          services: runtime.listServices(),
          missingSecrets,
        };
      },
      describe: (owner, runtimeId) => {
        const runtime = runtimeApp.getRuntime(owner, runtimeId);
        return runtime ? { services: runtime.listServices() } : null;
      },
      configureService: async (owner, runtimeId, serviceUuid, config) => {
        const runtime = runtimeApp.getRuntime(owner, runtimeId);
        if (!runtime) {
          throw new Error("the runtime is not running");
        }
        if (!isJsonRecord(config)) {
          throw new Error("a service is configured with an object");
        }
        if (!runtime.configureService(serviceUuid, config)) {
          throw new Error(`no service "${serviceUuid}"`);
        }
        return waitForServiceActivationState(runtime, serviceUuid);
      },
      setState: (owner, runtimeId, state) => {
        const runtime = runtimeApp.getRuntime(owner, runtimeId);
        if (!runtime) {
          throw new Error("the runtime is not running");
        }
        return applyRuntimeState(runtime, state);
      },
      remove: (owner, runtimeId) => removeRuntimeAndSessions(owner, runtimeId),
      process: async (owner, runtimeId, params, context) => {
        const runtime = runtimeApp.getRuntime(owner, runtimeId);
        if (!runtime) {
          throw new Error("the runtime is not running");
        }
        return runtime.process(
          params,
          () => {
            // Notifications are broadcast through runtime notification targets.
          },
          // The coordinator names the run its call belongs to, so that a board
          // spanning several runtimes reads as one trace.
          contextFromWire(context),
        );
      },
    },
    typeof options.coordinatorLinks === "string"
      ? options.coordinatorLinks
        ? createFileLinkStore(options.coordinatorLinks)
        : createMemoryLinkStore()
      : (options.coordinatorLinks ?? createMemoryLinkStore()),
    options.coordinatorLinkOptions,
  );

  /** Applies the parts of a runtime's state that can change while it runs. */
  function applyRuntimeState(runtime: HostedRuntime, state: JsonRecord) {
    if (typeof state.logging === "boolean") {
      runtime.setLogging(state.logging);
    }
    if (isLogLevel(state.logLevel)) {
      runtime.setLogLevel(state.logLevel);
    }
    if (typeof state.logData === "boolean") {
      runtime.setLogData(state.logData);
    }
    return {
      logging: runtime.getLogging(),
      logData: runtime.getLogData(),
      logLevel: runtime.getLogLevel(),
    };
  }

  /**
   * Introduces this server to a coordinator, for one runtime of one board.
   *
   * Called by the person's own client while it deploys a board: it has asked
   * the coordinator for a ticket and passes it on, over the same session it
   * creates runtimes here with. This server then connects to the coordinator —
   * the coordinator connects to nothing — and keeps the ticket to reconnect
   * with.
   *
   * The address dialled is one the caller chose, and the caller is someone this
   * server already runs services for; nothing here can be made to reach further
   * than they could with a service of their own.
   *
   * `secrets` are the values for the references that runtime's services carry.
   * They are handed to the runtime when the coordinator builds it, and are not
   * sent to the coordinator.
   */
  expressApp.post("/coordinator-links", async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (
      !isJsonRecord(body) ||
      typeof body.coordinatorUrl !== "string" ||
      typeof body.ticket !== "string" ||
      typeof body.boardName !== "string" ||
      typeof body.runtimeId !== "string" ||
      !body.coordinatorUrl ||
      !body.ticket ||
      !body.boardName ||
      !body.runtimeId
    ) {
      res.sendStatus(400);
      return;
    }
    try {
      await coordinatorLinks.introduce(
        {
          owner: ownerKeyOf(req.authenticatedUser),
          boardName: body.boardName,
          runtimeId: body.runtimeId,
          coordinatorUrl: body.coordinatorUrl,
          ticket: body.ticket,
        },
        readSecretsPayload(body.secrets),
      );
      res.status(201).json({ connected: true });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : "Could not connect",
      });
    }
  });

  /** The caller's links: which runtimes belong to which board, never a ticket. */
  expressApp.get("/coordinator-links", (req, res) => {
    res.json({ links: coordinatorLinks.list(ownerKeyOf(req.authenticatedUser)) });
  });

  /** Leaves a board: drops the link and the runtime it was for. */
  expressApp.delete("/coordinator-links/:runtimeId", (req, res) => {
    const removed = coordinatorLinks.remove(
      ownerKeyOf(req.authenticatedUser),
      req.params.runtimeId,
    );
    res.sendStatus(removed ? 200 : 404);
  });

  expressApp.get("/runtimes", (req, res) => {
    res.json({
      runtimes: tenantOf(req)
        .getRuntimes()
        .map((runtime) => serializeRuntime(runtime)),
      // The service registry is a property of the build, not of a tenant.
      registry: runtimeApp.getRegistry(),
      server: RUNTIME_SERVER_KIND,
      // This server can connect to a coordinator when introduced to one; see
      // POST /coordinator-links. Said here so a client can tell before it
      // deploys a board that needs it.
      coordinatorLinks: true,
    });
  });

  expressApp.delete("/runtimes", (req, res) => {
    const owner = ownerKeyOf(req.authenticatedUser);
    runtimeApp.removeAllRuntimes(owner);
    mounts.releaseOwner(owner);
    for (const [token, info] of sessionTokens) {
      if (info.sub === owner) {
        sessionTokens.delete(token);
      }
    }
    res.sendStatus(200);
  });

  expressApp.post("/runtimes", (req, res) => {
    if (
      !req.body ||
      (typeof req.body !== "object" && !Array.isArray(req.body))
    ) {
      res.sendStatus(400);
      return;
    }

    const owner = ownerKeyOf(req.authenticatedUser);
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const runtimes: ReturnType<typeof serializeRuntime>[] = [];

    for (const payload of payloads) {
      const config = validateRuntimeConfiguration(payload);
      if (!config) {
        res.sendStatus(400);
        return;
      }

      try {
        runtimes.push(serializeRuntime(provisionRuntime(owner, config)));
      } catch (err) {
        if (err instanceof QuotaError) {
          res.status(429).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    res.json({
      runtimes,
      registry: runtimeApp.getRegistry(),
      server: RUNTIME_SERVER_KIND,
    });
  });

  expressApp.get("/runtimes/:runtimeId", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.delete("/runtimes/:runtimeId", (req, res) => {
    // Always return success — if the runtime was already destroyed (e.g. by a
    // WebSocket disconnect) the desired state is the same as an explicit delete.
    // Scoped to the caller, so this can only ever remove their own runtime; an
    // id owned by another tenant is a no-op that still reports success, matching
    // the already-destroyed case.
    removeRuntimeAndSessions(
      ownerKeyOf(req.authenticatedUser),
      req.params.runtimeId,
    );
    res.json({ id: req.params.runtimeId });
  });

  // Mint a coordinator session token for a runtime. Gated by the normal auth
  // middleware, so the caller must present a valid user JWT (the "bootstrap").
  // The returned opaque token is bound to that user and this runtime, and the
  // coordinator then uses it for its long-lived machine calls (the result WS,
  // teardown) without needing a user JWT that would expire.
  //
  // Limitation (v1): tokens live only in this process. If the runtime restarts
  // the token is gone and the coordinator must re-provision — which requires a
  // live user JWT. Boards therefore don't self-heal across a runtime restart
  // while the user is offline; persisting these bindings is future work.
  expressApp.post("/runtimes/:runtimeId/session-token", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const sub = ownerKeyOf(req.authenticatedUser);
    const token = randomBytes(32).toString("hex");
    sessionTokens.set(token, { sub, runtimeId: req.params.runtimeId });
    res.json({ token });
  });

  /**
   * Values for the references this runtime's services hold.
   *
   * Provisioning carries them already; this is for the moments it cannot cover
   * — a board being built a service at a time, an entry edited while a board
   * is running, and a re-push after a restart where the services survived but
   * the vault did not. It merges, so a client sending one entry does not strip
   * the rest.
   *
   * POST rather than PUT: this merges rather than replaces, and every other
   * mutation this server takes is a POST — the CORS allowlist says so, and a
   * lone PUT is a method each runtime implementation would have to remember to
   * allow separately.
   *
   * There is deliberately no GET. The values go one way: in, and then only to
   * a service resolving a reference for a call it is making. What is held can
   * be *named* — the response says which aliases the runtime now has — because
   * a client needs to show whether a credential is configured.
   */
  expressApp.post("/runtimes/:runtimeId/secrets", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const entries = readSecretsPayload(req.body);
    runtime.setSecrets(entries);
    res.json({ aliases: runtime.secrets().aliases() });
  });

  /**
   * Descriptors for the assets this runtime's services reference.
   *
   * Provisioning carries them already; this is for a configuration that names
   * one the runtime was not given, for an asset edited while the board runs —
   * which is how an edit reaches a service without reconfiguring it — and for a
   * re-push after a restart. It merges, and `null` removes an asset.
   *
   * Answers with the ids held, never content: what a runtime has can be named,
   * and a client that wants the content has the board.
   */
  expressApp.post("/runtimes/:runtimeId/assets", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    runtime.setAssets(readAssetsPayload(req.body));
    res.json({ ids: runtime.assets().ids() });
  });

  /**
   * Whether an asset resolves here, and to what — its media type and size, or
   * the reason it does not. A check, not a download: the content stays where
   * it is, and a URL source is fetched from where it will actually be used.
   */
  expressApp.get("/runtimes/:runtimeId/assets/:assetId", async (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const { asset, problem } = await runtime
      .assets()
      .resolve(`hkp-asset://${req.params.assetId}`);
    res.json(
      asset
        ? { ok: true, mediaType: asset.mediaType, size: asset.bytes.length }
        : { ok: false, problem },
    );
  });

  expressApp.post("/runtimes/:runtimeId/rearrange", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (
      !Array.isArray(req.body) ||
      !req.body.every((entry) => typeof entry === "string")
    ) {
      res.sendStatus(400);
      return;
    }
    if (!runtime.rearrangeServices(req.body)) {
      res.sendStatus(400);
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.post("/runtimes/:runtimeId", async (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (req.body === undefined) {
      res.sendStatus(400);
      return;
    }

    // No context: an external HTTP caller is not continuing a run, it is
    // starting one.
    const result = await runtime.process(req.body, () => {
      // Notifications are broadcast through runtime notification targets.
    });
    res.json(result);
  });

  /**
   * Change what a running runtime records, without rebuilding it.
   *
   * `logData` is a decision a board revisits — switched on to look into
   * something, off again afterwards — and re-provisioning to carry it would
   * restart every service in the runtime to change one boolean. Separate from
   * POST /runtimes/:id, which processes data rather than configuring anything.
   */
  expressApp.patch("/runtimes/:runtimeId/state", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (!isJsonRecord(req.body)) {
      res.sendStatus(400);
      return;
    }
    res.json(applyRuntimeState(runtime, req.body));
  });

  expressApp.get("/runtimes/:runtimeId/inputs", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(serializeRuntime(runtime).inputs);
  });

  expressApp.get("/runtimes/:runtimeId/inputs/:inputId", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const input = serializeRuntime(runtime).inputs.find(
      (entry) => entry.id === req.params.inputId,
    );
    if (!input) {
      res.sendStatus(404);
      return;
    }
    res.json(input);
  });

  expressApp.get("/runtimes/:runtimeId/services", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(runtime.listServices());
  });

  expressApp.post("/runtimes/:runtimeId/services", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const config = validateServiceConfiguration(req.body);
    if (!config) {
      res.sendStatus(400);
      return;
    }
    if (atQuota(runtime.listServices().length, quotas.maxServicesPerRuntime)) {
      res.status(429).json({
        error: `Service limit reached (${quotas.maxServicesPerRuntime})`,
      });
      return;
    }

    try {
      const state = runtime.addService(config);
      res.json(state);
    } catch {
      res.sendStatus(400);
    }
  });

  expressApp.delete("/runtimes/:runtimeId/services/:instanceId", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (!runtime.removeService(req.params.instanceId)) {
      res.sendStatus(404);
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.post(
    "/runtimes/:runtimeId/services/:instanceId",
    async (req, res) => {
      const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
      if (!runtime) {
        return;
      }
      if (!isJsonRecord(req.body)) {
        res.sendStatus(400);
        return;
      }

      let state = runtime.configureService(req.params.instanceId, req.body);
      if (!state) {
        res.sendStatus(404);
        return;
      }

      // Some services (for example http-server-subservices with port 0)
      // transition asynchronously and update state shortly after configure().
      state = await waitForServiceActivationState(
        runtime,
        req.params.instanceId,
      );

      res.json(state);
    },
  );

  /**
   * Run the pipeline starting at one service, with a given payload.
   *
   * Distinct from configuring it: configure says what a service *is*, this says
   * do your job with this. A facade button had only the former, so anything it
   * needed to cause had to be smuggled in as a config field that a service read
   * as a command — which is how `store` ended up releasing records from inside
   * `configure`.
   *
   * The service named here runs; it is not skipped the way `processFrom` skips
   * the caller that is handing work onward.
   */
  expressApp.post(
    "/runtimes/:runtimeId/services/:instanceId/process",
    async (req, res) => {
      const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
      if (!runtime) {
        return;
      }
      if (req.body === undefined) {
        res.sendStatus(400);
        return;
      }
      if (!runtime.getService(req.params.instanceId)) {
        res.sendStatus(404);
        return;
      }

      // No context: an external caller is not continuing a run, it is starting
      // one — the same reasoning as POST /runtimes/:runtimeId.
      const result = await runtime.processAt(
        req.params.instanceId,
        req.body,
        () => {
          // Notifications are broadcast through runtime notification targets.
        },
        contextFromWire((req.body as JsonRecord | undefined)?.__context),
      );
      res.json(result ?? null);
    },
  );

  expressApp.get("/runtimes/:runtimeId/services/:instanceId", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const service = runtime.getService(req.params.instanceId);
    if (!service) {
      res.sendStatus(404);
      return;
    }
    res.json(service.getState());
  });

  expressApp.get(
    "/runtimes/:runtimeId/services/:instanceId/property/:propertyId",
    (req, res) => {
      const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
      if (!runtime) {
        return;
      }
      const service = runtime.getService(req.params.instanceId);
      if (!service) {
        res.sendStatus(404);
        return;
      }

      const state = service.getState();
      const property = state[req.params.propertyId];
      if (property === undefined) {
        res.sendStatus(404);
        return;
      }
      res.json(property);
    },
  );

  expressApp.use(
    (err: Error, req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof SyntaxError) {
        res.sendStatus(400);
        return;
      }
      // Said in words: the caller is a board editor, and "too large" is
      // something its author can act on.
      if ((err as { type?: string }).type === "entity.too.large") {
        const limit = (err as { limit?: number }).limit;
        res.status(413).json({
          error: carriesAssets(req)
            ? `Request body is larger than ${limit} bytes, which is what the assets sent at once may weigh here. Name larger content by url.`
            : `Request body is larger than ${limit} bytes`,
        });
        return;
      }
      // Don't leak internal error details (paths, stack hints) to clients.
      console.error("[server] Unhandled request error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    },
  );

  // No ceiling of the library's own; see attachCoordinatorJoin.
  const bridgeWsServer = new WebSocketServer({ noServer: true, maxPayload: 0 });
  let bridgeUpgradeHandler:
    | ((ws: WebSocket, user: AuthenticatedUser) => void)
    | undefined;

  function rejectUpgrade(
    socket: Duplex,
    status: number,
    reason: string,
  ): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
    socket.destroy();
  }

  // Upgrade paths that authenticate their own callers, by exact path. A
  // coordinator's join endpoint is one: what connects there holds a ticket,
  // not a user's token.
  const upgradeRoutes = new Map<
    string,
    (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void
  >();

  httpServer.on("upgrade", (request, socket, head) => {
    // Mounts are matched first and are not token-authenticated, for the same
    // reason their HTTP requests are not: the callers are outside parties.
    if (mounts.handleUpgrade(request, socket, head)) {
      return;
    }

    // Protocol is irrelevant — base is only needed to resolve the relative path.
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    const upgradeRoute = upgradeRoutes.get(url.pathname);
    if (upgradeRoute) {
      upgradeRoute(request, socket, head);
      return;
    }

    // Authenticate every upgrade with the same rules as HTTP routes. Browsers
    // can't set headers on a WS handshake, so the token rides in ?access_token=.
    // The Origin check blocks cross-site WebSocket hijacking from a page a local
    // user happens to visit.
    if (!isOriginAllowed(request.headers.origin, allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    // Browsers can't set headers on a WS handshake, so they pass the token as
    // ?access_token=. Non-browser clients (the coordinator) use the standard
    // Authorization header, keeping the token out of URLs/logs.
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    const token = bearer ?? url.searchParams.get("access_token");

    void authenticator
      .verifyToken(token)
      .then((user) => {
        if (!user) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }

        if (url.pathname === "/coordinator/bridge") {
          if (bridgeUpgradeHandler) {
            bridgeWsServer.handleUpgrade(request, socket, head, (ws) => {
              bridgeUpgradeHandler!(ws, user);
            });
          } else {
            rejectUpgrade(socket, 503, "Service Unavailable");
          }
          return;
        }

        // The runtime is resolved in the authenticated user's namespace, so a
        // token cannot open a socket onto another tenant's runtime; an id owned
        // by someone else is indistinguishable from one that does not exist.
        const owner = ownerKeyOf(user);
        const runtimeId = url.pathname.slice(1);
        if (!runtimeId || !runtimeApp.getRuntime(owner, runtimeId)) {
          rejectUpgrade(socket, 404, "Not Found");
          return;
        }

        webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
          webSocketServer.emit("connection", websocket, request, {
            owner,
            runtimeId,
          });
        });
      })
      .catch(() => {
        rejectUpgrade(socket, 401, "Unauthorized");
      });
  });

  webSocketServer.on(
    "connection",
    (
      socket: WebSocket,
      _request: http.IncomingMessage,
      { owner, runtimeId }: { owner: string; runtimeId: string },
    ) => {
      const socketKey = tenantKey(owner, runtimeId);
      const sockets = runtimeSockets.get(socketKey) ?? new Set<WebSocket>();
      sockets.add(socket);
      runtimeSockets.set(socketKey, sockets);

      socket.on("close", () => {
        const current = runtimeSockets.get(socketKey);
        current?.delete(socket);
        if (current && current.size === 0) {
          runtimeSockets.delete(socketKey);
          if (!runtimeApp.forOwner(owner).getRuntime(runtimeId)?.garbageCollected) {
            // Nobody asked for this one to be cleaned up, so it outlives the
            // clients that happened to be watching it. A coordinator's board
            // keeps running with no browser attached; a runtime from a config
            // file or a script was never anyone's to reap.
            return;
          }
          // Its creator said it should not outlive them — a browser running the
          // board is the controller, and this was the last one connected. Free
          // the resources now; provisioning again recreates it cleanly.
          removeRuntimeAndSessions(owner, runtimeId);
        }
      });

      // Passes enter the pipeline in the order their frames arrive: nothing
      // is awaited before process() starts, and the pipeline runs until its
      // first asynchronous service within that call.
      socket.on("message", async (raw, isBinary) => {
        const message = readInbound(raw, isBinary);
        if (!message) {
          return;
        }

        if (message.type === "readwrite") {
          return;
        }

        if (message.type === "processRuntime" && message.params !== undefined) {
          const runtime = runtimeApp.getRuntime(owner, runtimeId);
          if (!runtime) {
            return;
          }
          const result = await runtime.process(
            message.params,
            () => {
              // Notifications are broadcast through runtime notification targets.
            },
            // A peer driving this runtime names the run its call belongs to, so
            // that a board spanning several runtimes reads as one trace rather
            // than one per runtime.
            contextFromWire(message.context),
          );
          sendJsonResult(socket, result);
        }
      });
    },
  );

  return {
    expressApp,
    httpServer,
    runtimeApp,
    coordinatorLinks,
    /** Serves WebSocket upgrades on a path with a handler that does its own
     *  authentication, ahead of the token check every other upgrade gets. */
    addUpgradeRoute(
      pathname: string,
      handler: (
        request: http.IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => void,
    ) {
      upgradeRoutes.set(pathname, handler);
    },
    async start(port = 0, host = options.host ?? "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });

      const address = httpServer.address() as AddressInfo;
      return {
        host,
        port: address.port,
        baseUrl: `http://${host}:${address.port}`,
      };
    },
    setBridgeUpgradeHandler(
      handler: (ws: WebSocket, user: AuthenticatedUser) => void,
    ) {
      bridgeUpgradeHandler = handler;
    },
    async stop() {
      coordinatorLinks.stop();
      for (const sockets of runtimeSockets.values()) {
        for (const socket of sockets) {
          socket.close();
        }
      }
      runtimeSockets.clear();

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is one of the levels a runtime understands. */
function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === "debug" || value === "info" || value === "warn" || value === "error"
  );
}

function validateRuntimeConfiguration(
  value: unknown,
): RuntimeConfiguration | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (!Array.isArray(value.services)) {
    return null;
  }

  const services: ServiceConfiguration[] = [];
  for (const entry of value.services) {
    const config = validateServiceConfiguration(entry);
    if (!config) {
      return null;
    }
    services.push(config);
  }

  return {
    id: value.id,
    name: value.name,
    boardName:
      typeof value.boardName === "string" ? value.boardName : undefined,
    // Absent means persist; see RuntimeConfiguration.garbageCollected.
    garbageCollected: value.garbageCollected === true,
    // Both absent mean off; see RuntimeConfiguration.logging / logData.
    logging: isJsonRecord(value.state) && value.state.logging === true,
    logLevel:
      isJsonRecord(value.state) && isLogLevel(value.state.logLevel)
        ? value.state.logLevel
        : undefined,
    // Absent means allowed; see RuntimeConfiguration.logData.
    logData: !(isJsonRecord(value.state) && value.state.logData === false),
    // Values for the references the services carry. Read out of the payload
    // here and handed to the runtime's vault; they are never put back into any
    // service's state, and never appear in a serialized runtime.
    secrets: readSecretsPayload(value.secrets),
    // Descriptors for the assets the services reference; a removal means
    // nothing to a runtime being created, so only descriptors are kept.
    assets: presentAssets(readAssetsPayload(value.assets)),
    services,
  };
}

function presentAssets(
  entries: Record<string, AssetDescriptor | null>,
): Record<string, AssetDescriptor> {
  const present: Record<string, AssetDescriptor> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (entry) {
      present[id] = entry;
    }
  }
  return present;
}

function validateServiceConfiguration(
  value: unknown,
): ServiceConfiguration | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  if (typeof value.serviceId !== "string" || typeof value.uuid !== "string") {
    return null;
  }
  if (value.state !== undefined && !isJsonRecord(value.state)) {
    return null;
  }

  return {
    serviceId: value.serviceId,
    uuid: value.uuid,
    name: typeof value.name === "string" ? value.name : undefined,
    serviceName:
      typeof value.serviceName === "string" ? value.serviceName : undefined,
    state: value.state,
  };
}

async function waitForServiceActivationState(
  runtime: HostedRuntime,
  instanceId: string,
): Promise<JsonRecord> {
  const maxAttempts = 20;
  const delayMs = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const service = runtime.getService(instanceId);
    if (!service) {
      return {};
    }

    const state = service.getState();
    const bypass = state.bypass;
    const port = state.port;

    if (
      typeof bypass === "boolean" &&
      bypass === false &&
      typeof port === "number" &&
      port === 0
    ) {
      await sleep(delayMs);
      continue;
    }

    return state;
  }

  const service = runtime.getService(instanceId);
  return service?.getState() ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
