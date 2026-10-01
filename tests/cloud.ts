import express from "express";

import { ownerKeyOf } from "../src/auth";
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
): Promise<CoordinatorHost> {
  const host = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  host.expressApp.use(
    "/coordinator",
    createCoordinatorRouter({ coordinator }).router,
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
        process: (params) => {
          participant.processed.push(params);
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

/** Lets a session's queued work — a join being taken in — run to its end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Re-exported so a spec needs one import for the common case.
export { express };
