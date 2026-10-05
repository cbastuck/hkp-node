import http from "node:http";
import { AddressInfo } from "node:net";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

import {
  AuthenticatedUser,
  Authenticator,
  mayOwn,
  ownerKeyOf,
} from "../src/auth";
import { createBridgeHandler } from "../src/coordinator/bridge";
import { BridgeMessage } from "../src/coordinator/bridgeProtocol";
import { BridgeAttach } from "../src/coordinator/session";
import { SHARED_BOARDS_PATH } from "../src/coordinator/router";
import { ProcessContext } from "../src/types";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import { attachCoordinatorJoin } from "../src/coordinator/join";
import {
  BoardParticipants,
  Participant,
  ParticipantEvent,
  ParticipantHello,
  ParticipantRequest,
} from "../src/coordinator/participantProtocol";
import { createCoordinatorRouter } from "../src/coordinator/router";
import { BoardSession } from "../src/coordinator/session";
import { CloudBoardConfig } from "../src/coordinator/types";
import { createRuntimeServer } from "../src/server";

/**
 * A coordinator and the runtime servers that connect to it, for tests.
 *
 * Everything here is the real thing over loopback: a coordinator listening for
 * joins, runtime servers that open a connection to it, and the tickets in
 * between. What a test supplies is only what a person's client would — which
 * runtime server each of a board's runtimes belongs on.
 */

export type RuntimeServer = ReturnType<typeof createRuntimeServer>;

/** The tenant a runtime server with no auth runs everything as. */
export const OWNER = ownerKeyOf(undefined);

/** Reconnects in milliseconds rather than seconds, so a test can wait for one. */
/**
 * The runtime a server holds for a deployed board. It is the board's, so it is
 * not among the runtimes the server's clients created; a test that deploys one
 * board to a server finds it by id alone.
 */
export function boardRuntime(
  server: RuntimeServer,
  runtimeId: string,
  boardName?: string,
) {
  return server.runtimeApp
    .getBoardRuntimes(OWNER)
    .find(
      (runtime) =>
        runtime.id === runtimeId &&
        (boardName === undefined || runtime.scope().boardName === boardName),
    );
}

export const FAST_LINKS = { reconnectDelayMs: 20, maxReconnectDelayMs: 40 };

export async function startRuntimeServer(
  options: Parameters<typeof createRuntimeServer>[0] = {},
) {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    coordinatorLinkOptions: FAST_LINKS,
    ...options,
  });
  const { baseUrl, port } = await server.start(options.host ? undefined : 0);
  return { server, baseUrl, port };
}

/**
 * People a coordinator under test knows, standing in for an identity provider:
 * a bearer token is the `sub` it authenticates as. `allowedEmails` is the
 * server's allowlist — who may own — and is asked only by `authorizeOwner`.
 */
export function peopleAuthenticator(
  people: AuthenticatedUser[],
  allowedEmails?: string[],
): Authenticator {
  const known = new Map(people.map((person) => [person.sub, person]));
  const identifyToken = async (token: string | undefined | null) =>
    (token && known.get(token)) || null;
  const authorizeOwner = async (token: string | undefined | null) => {
    const user = await identifyToken(token);
    return user && mayOwn(user, allowedEmails) ? user : null;
  };
  return {
    middleware: (req, res, next) => {
      const header = req.headers.authorization;
      void authorizeOwner(
        header?.startsWith("Bearer ") ? header.slice(7) : null,
      ).then((user) => {
        if (!user) {
          res.sendStatus(401);
          return;
        }
        req.authenticatedUser = user;
        next();
      });
    },
    identifyToken,
    authorizeOwner,
  };
}

export type CoordinatorHost = {
  coordinator: BoardCoordinator;
  /** The coordinator's base address, as a client or a runtime server is given it. */
  url: string;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Serves a coordinator: its REST routes and its join endpoint. `port` lets a
 * test bring one back where the last one was, which is what a restart is to
 * the runtime servers that kept its address.
 */
export async function startCoordinator(
  coordinator: BoardCoordinator = new BoardCoordinator(),
  port = 0,
  /**
   * Given, the coordinator authenticates: these are the people it knows, and
   * `allowedEmails` those of them who may own boards. Its bridge then admits
   * by identity, as a deployed coordinator's does.
   */
  auth?: { people: AuthenticatedUser[]; allowedEmails?: string[] },
): Promise<CoordinatorHost> {
  const host = createRuntimeServer({
    externalHost: "127.0.0.1",
    ...(auth
      ? {
          buildAuthenticator: () =>
            peopleAuthenticator(auth.people, auth.allowedEmails),
        }
      : { auth: { mode: "none" as const } }),
  });
  host.expressApp.use(
    "/coordinator",
    createCoordinatorRouter({
      coordinator,
      ...(auth
        ? {
            // Never contacted: the authenticator above does the verifying.
            auth: { mode: "jwt" as const, domain: "auth.invalid", audience: "test" },
            authenticator: host.authenticator,
          }
        : {}),
    }).router,
  );
  host.addSelfAuthenticatedRoute("GET", `/coordinator${SHARED_BOARDS_PATH}`);
  host.setBridgeUpgradeHandler(
    createBridgeHandler(coordinator, {
      authMode: auth ? "jwt" : "none",
      // A board that is not there is given up on quickly, so a refusal does
      // not hold a test up.
      attempts: 3,
      attemptDelayMs: 10,
    }),
  );
  attachCoordinatorJoin(host, coordinator);
  const started = await new Promise<{ port: number }>((resolve, reject) => {
    host.httpServer.once("error", reject);
    host.httpServer.listen(port, "127.0.0.1", () => {
      const address = host.httpServer.address();
      resolve({ port: (address as { port: number }).port });
    });
  });
  return {
    coordinator,
    url: `http://127.0.0.1:${started.port}/coordinator`,
    port: started.port,
    stop: async () => {
      coordinator.destroyAll();
      // Participants hold their sockets open; a close that waited for them
      // would never finish.
      host.httpServer.closeAllConnections();
      await host.stop().catch(() => undefined);
    },
  };
}

/**
 * What a person's client does before handing a board over: asks the
 * coordinator for a ticket per runtime and tells each runtime's server to
 * connect with it.
 */
export async function introduce(
  host: CoordinatorHost,
  userId: string,
  boardName: string,
  placement: Record<string, RuntimeServer>,
): Promise<void> {
  const tickets = await host.coordinator.issueTickets(
    userId,
    boardName,
    Object.keys(placement),
  );
  await Promise.all(
    Object.entries(placement).map(([runtimeId, server]) =>
      server.coordinatorLinks.introduce({
        owner: OWNER,
        boardName,
        runtimeId,
        coordinatorUrl: host.url,
        ticket: tickets[runtimeId],
      }),
    ),
  );
}

/** Deploys a board: introduces its runtime servers, then registers it. */
export async function deploy(
  host: CoordinatorHost,
  userId: string,
  config: CloudBoardConfig,
  placement: Record<string, RuntimeServer>,
) {
  await introduce(host, userId, config.boardName, placement);
  return host.coordinator.registerBoard(userId, config);
}

/** Two sources of participants as one; the first to know a runtime answers. */
export function combine(
  first: BoardParticipants,
  second: BoardParticipants,
): BoardParticipants {
  return {
    get: (runtimeId) => first.get(runtimeId) ?? second.get(runtimeId),
    subscribe: (listener) => {
      const stops = [first.subscribe(listener), second.subscribe(listener)];
      return () => stops.forEach((stop) => stop());
    },
  };
}

/**
 * A session of its own, for tests about a session rather than a coordinator:
 * the runtime servers in `placement` are introduced for real, and `extra`
 * supplies any participants that exist only in the test.
 */
export async function startSession(
  host: CoordinatorHost,
  config: CloudBoardConfig,
  placement: Record<string, RuntimeServer>,
  extra?: BoardParticipants,
): Promise<BoardSession> {
  const userId = "user-1";
  await introduce(host, userId, config.boardName, placement);
  const real = host.coordinator.participants.forBoard(userId, config.boardName);
  const session = new BoardSession(
    config.boardName,
    userId,
    config,
    extra ? combine(real, extra) : real,
  );
  await session.start();
  return session;
}

/** Waits until `check` holds, or fails saying what was being waited for. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  what = "condition",
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Participants that exist only in memory, recording what a session asks of
 * them. For tests about what a session *does* with its participants, where a
 * real runtime server would only be in the way.
 */
export type FakeParticipant = Participant & {
  requests: ParticipantRequest[];
  processed: unknown[];
  /** The run each `processed` value was handed over as, in the same order. */
  contexts: Array<ProcessContext | undefined>;
  /** Says something, as the runtime would. */
  emit: (event: ParticipantEvent) => void;
};

export function fakeParticipants() {
  const connected = new Map<string, FakeParticipant>();
  const listeners = new Set<{
    onJoin: (participant: Participant) => void;
    onLeave: (runtimeId: string) => void;
  }>();

  const participants: BoardParticipants = {
    get: (runtimeId) => connected.get(runtimeId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    participants,
    /** Connects a runtime server for `runtimeId`. `answer` overrides replies. */
    join(
      runtimeId: string,
      options: {
        hello?: Partial<ParticipantHello>;
        answer?: (request: ParticipantRequest) => unknown;
      } = {},
    ): FakeParticipant {
      let listener: ((event: ParticipantEvent) => void) | null = null;
      const participant: FakeParticipant = {
        runtimeId,
        hello: {
          type: "hello",
          server: "node",
          registry: [],
          runtimeExists: false,
          ...options.hello,
        },
        requests: [],
        processed: [],
        contexts: [],
        request: async <T>(request: ParticipantRequest) => {
          participant.requests.push(request);
          const answered = options.answer?.(request);
          if (answered !== undefined) {
            return (await answered) as T;
          }
          return (
            request.op === "provision" || request.op === "describe"
              ? { registry: [], services: [] }
              : {}
          ) as T;
        },
        process: (params, context) => {
          participant.processed.push(params);
          participant.contexts.push(context);
        },
        listen: (next) => {
          listener = next;
        },
        emit: (event) => listener?.(event),
      };
      connected.set(runtimeId, participant);
      for (const each of [...listeners]) {
        each.onJoin(participant);
      }
      return participant;
    },
    leave(runtimeId: string): void {
      if (!connected.delete(runtimeId)) {
        return;
      }
      for (const each of [...listeners]) {
        each.onLeave(runtimeId);
      }
    },
  };
}

/** A browser's end of a bridge, as a test drives and reads it. */
export type BrowserEnd = {
  socket: WebSocket;
  received: BridgeMessage[];
  send: (message: BridgeMessage) => void;
  /** The newest message of a type, if one arrived. */
  last: <T extends BridgeMessage["type"]>(
    type: T,
  ) => Extract<BridgeMessage, { type: T }> | undefined;
  /** Every message of a type, oldest first. */
  all: <T extends BridgeMessage["type"]>(
    type: T,
  ) => Array<Extract<BridgeMessage, { type: T }>>;
  /** Sends a request and resolves with the `response` that answers it. */
  ask: (
    message: Extract<
      BridgeMessage,
      { type: "processService" | "configureService" }
    >,
  ) => Promise<Extract<BridgeMessage, { type: "response" }>>;
  /** Resolves with the close code once the other end closes this bridge. */
  closed: Promise<number>;
  close: () => void;
};

function browserEnd(socket: WebSocket): BrowserEnd {
  const received: BridgeMessage[] = [];
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) {
      received.push(JSON.parse(raw.toString()) as BridgeMessage);
    }
  });
  const closed = new Promise<number>((resolve) =>
    socket.on("close", (code) => resolve(code)),
  );
  const all = <T extends BridgeMessage["type"]>(type: T) =>
    received.filter((m) => m.type === type) as Array<
      Extract<BridgeMessage, { type: T }>
    >;
  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    last: (type) => all(type).at(-1),
    all,
    ask: async (message) => {
      socket.send(JSON.stringify(message));
      let answer: Extract<BridgeMessage, { type: "response" }> | undefined;
      await eventually(() => {
        answer = all("response").find(
          (response) => response.requestId === message.requestId,
        );
        return !!answer;
      }, `an answer to ${message.type}`);
      return answer!;
    },
    closed,
    close: () => socket.close(),
  };
}

/**
 * Attaches a browser straight to a session, as whoever admitted it would
 * have: for tests about what a session does with a bridge, where who may have
 * one is not the question.
 */
export async function attachBrowser(
  session: BoardSession,
  runtimeIds: string[] = [],
  attach?: BridgeAttach,
): Promise<BrowserEnd & { stop: () => Promise<void> }> {
  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  const serverSide = new Promise<WebSocket>((resolve) =>
    sockets.on("connection", (ws) => resolve(ws)),
  );
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const end = browserEnd(client);
  await new Promise<void>((resolve) => client.on("open", () => resolve()));
  session.registerBrowserSocket(await serverSide, runtimeIds, attach);
  return {
    ...end,
    stop: async () => {
      client.terminate();
      sockets.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Attaches a browser through a coordinator's bridge endpoint, the way a
 * client does: a token, then the owner and board it means.
 */
export async function openBridge(
  host: CoordinatorHost,
  token: string | null,
  ownerId: string,
  boardName: string,
  runtimeIds: string[] = [],
): Promise<BrowserEnd> {
  const url = new URL(`ws://127.0.0.1:${host.port}/coordinator/bridge`);
  if (token) {
    url.searchParams.set("access_token", token);
  }
  const socket = new WebSocket(url);
  const end = browserEnd(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) =>
      reject(new Error(`bridge refused: ${res.statusCode}`)),
    );
  });
  end.send({ type: "connect", userId: ownerId, boardName, runtimeIds });
  return end;
}

/** Lets a session's queued work — a join being taken in — run to its end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Re-exported so a spec needs one import for the common case.
export { express };
