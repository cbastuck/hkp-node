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
import { HostedRuntime, RuntimeApp, TenantRuntimes } from "./runtime";
import { MountRegistry } from "./mounts";
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
  RuntimeConfiguration,
  RuntimeNotification,
  ServiceConfiguration,
} from "./types";

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
};

/**
 * Service endpoints are reachable without a token, so an unbounded body read is
 * available to anyone holding the URL. Unlike the other quotas this one defaults
 * to a real value rather than "unlimited": leaving it off would make the
 * dangerous choice the automatic one.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

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
};

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
};

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
  ]);

  // Public service endpoints. Declared before the runtime app because runtimes
  // hand mounts to their services as they are created.
  const mounts = new MountRegistry((mountPath) => {
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    return externalSecure
      ? `https://${externalHost}${mountPath}`
      : `http://${externalHost}:${address.port}${mountPath}`;
  });

  const runtimeApp = new RuntimeApp(factories, (owner, runtimeId) => ({
    mount: (serviceUuid, handlers) =>
      mounts.register(owner, runtimeId, serviceUuid, handlers),
  }));
  const expressApp = express();
  expressApp.use(
    cors({
      origin: allowedOrigins === "*" ? true : allowedOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  expressApp.use(express.json());
  expressApp.use(authenticator.middleware);

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

  expressApp.get("/runtimes", (req, res) => {
    res.json({
      runtimes: tenantOf(req)
        .getRuntimes()
        .map((runtime) => serializeRuntime(runtime)),
      // The service registry is a property of the build, not of a tenant.
      registry: runtimeApp.getRegistry(),
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
    const tenant = tenantOf(req);
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const runtimes: ReturnType<typeof serializeRuntime>[] = [];

    for (const payload of payloads) {
      const config = validateRuntimeConfiguration(payload);
      if (!config) {
        res.sendStatus(400);
        return;
      }

      // POST provisions: it creates the runtime, replacing anything under that
      // id. Attaching to a runtime that is already running is a different
      // intent and has its own verb — GET /runtimes/:id, which a client uses
      // before posting when it means "take back over" rather than "build this".
      //
      // Replacing rather than reusing matters most for the flag the payload
      // carries: reusing would keep the *old* runtime's lifecycle, so a board
      // deployed to a coordinator could inherit a browser's "clean me up when I
      // disconnect" and vanish when that browser closed.
      const replacing = tenant.getRuntime(config.id);

      // Quotas apply only to genuinely new runtimes — replacing one that
      // already exists must never be refused for being over the limit.
      if (!replacing && atQuota(tenant.getRuntimes().length, quotas.maxRuntimesPerUser)) {
        res.status(429).json({
          error: `Runtime limit reached (${quotas.maxRuntimesPerUser})`,
        });
        return;
      }
      if (
        exceedsQuota(config.services.length, quotas.maxServicesPerRuntime)
      ) {
        res.status(429).json({
          error: `Service limit reached (${quotas.maxServicesPerRuntime})`,
        });
        return;
      }

      const runtime = tenant.createRuntime(config);
      const socketKey = tenantKey(owner, runtime.id);
      runtime.registerNotificationTarget((notification) => {
        sendJsonNotification(socketKey, notification);
      });
      runtime.registerResultTarget((result) => {
        const sockets = runtimeSockets.get(socketKey);
        if (!sockets) return;
        for (const socket of sockets) {
          sendJsonResult(socket, result);
        }
      });
      runtimes.push(serializeRuntime(runtime));
    }

    res.json({ runtimes, registry: runtimeApp.getRegistry() });
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

  expressApp.post("/runtimes/:runtimeId", (req, res) => {
    const runtime = getRuntimeOr404(req, res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (req.body === undefined) {
      res.sendStatus(400);
      return;
    }

    const result = runtime.process(req.body, () => {
      // Notifications are broadcast through runtime notification targets.
    });
    res.json(result);
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
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof SyntaxError) {
        res.sendStatus(400);
        return;
      }
      // Don't leak internal error details (paths, stack hints) to clients.
      console.error("[server] Unhandled request error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    },
  );

  const bridgeWsServer = new WebSocketServer({ noServer: true });
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

  httpServer.on("upgrade", (request, socket, head) => {
    // Mounts are matched first and are not token-authenticated, for the same
    // reason their HTTP requests are not: the callers are outside parties.
    if (mounts.handleUpgrade(request, socket, head)) {
      return;
    }

    // Protocol is irrelevant — base is only needed to resolve the relative path.
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

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

      socket.on("message", (raw) => {
        let message: WsInboundMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
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
          const result = runtime.process(message.params, () => {
            // Notifications are broadcast through runtime notification targets.
          });
          sendJsonResult(socket, result);
        }
      });
    },
  );

  return {
    expressApp,
    httpServer,
    runtimeApp,
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
    services,
  };
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
