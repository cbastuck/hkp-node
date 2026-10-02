import { createHash, randomBytes, randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import {
  BoardParticipants,
  CLOSE_REPLACED,
  CLOSE_TICKET_REVOKED,
  CoordinatorToParticipant,
  Participant,
  ParticipantEvent,
  ParticipantHello,
  ParticipantRequest,
  ParticipantToCoordinator,
} from "./participantProtocol";
import {
  BinaryPayload,
  decodeBinaryFrame,
  encodeBinaryFrame,
  frameBytes,
} from "./binaryFrame";

/**
 * Tickets, and the runtime servers that connected with one.
 *
 * A ticket is a bearer credential, and deliberately a narrow one: it speaks for
 * one runtime of one board of one person. The person's own client asks for it
 * and hands it to a runtime server that person chose; that server presents it
 * when it connects, and again whenever it reconnects — with nobody present,
 * which is what lets a deployed board come back after a restart on either side.
 *
 * Only a hash is kept. A ticket is shown once, to the client that asked, so a
 * coordinator's memory or disk holds nothing that could be presented.
 *
 * There is one ticket per runtime of a board at a time. Asking again replaces
 * it, which is what deploying a board again does: the old ticket stops being
 * accepted at once, and whatever is connected with it gives way when the new
 * ticket's holder connects. Revoking — a board deleted, a runtime the board no
 * longer has — forgets the ticket and closes the connection.
 */

/** What a ticket speaks for. */
export type TicketBinding = {
  userId: string;
  boardName: string;
  runtimeId: string;
};

/** A ticket as it is kept: enough to recognise it, not enough to present it. */
export type StoredTicket = {
  runtimeId: string;
  hash: string;
  issuedAt: string;
};

type TicketRecord = TicketBinding & { hash: string; issuedAt: string };

type BoardListener = {
  onJoin: (participant: Participant) => void;
  onLeave: (runtimeId: string) => void;
};

const TICKET_PREFIX = "hkpt_";
/** How long a participant has to say hello before it is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
/** How long a participant has to answer a request. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How often a connection is asked whether it is still there. A runtime server
 * whose network vanished closes nothing, so without asking, a board would go
 * on believing in a runtime it can no longer reach — and saying it is running.
 */
const HEARTBEAT_MS = 30_000;

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

// NUL cannot occur in any part, so the join is unambiguous.
function boardKey(userId: string, boardName: string): string {
  return `${userId}\u0000${boardName}`;
}

function runtimeKey(binding: TicketBinding): string {
  return `${boardKey(binding.userId, binding.boardName)}\u0000${binding.runtimeId}`;
}

/** A runtime server's connection, once it has said what it is. */
class SocketParticipant implements Participant {
  private listener: ((event: ParticipantEvent) => void) | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(
    readonly runtimeId: string,
    readonly hello: ParticipantHello,
    readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {}

  request<T = unknown>(request: ParticipantRequest): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("its runtime server is not connected"));
    }
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`its runtime server did not answer "${request.op}"`));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send({ type: "request", requestId, ...request });
    });
  }

  process(params: unknown, context?: unknown): void {
    if (params instanceof BinaryPayload) {
      this.sendRaw(
        encodeBinaryFrame({ type: "processRuntime", context }, params),
      );
      return;
    }
    this.send({ type: "processRuntime", params, context });
  }

  listen(listener: ((event: ParticipantEvent) => void) | null): void {
    this.listener = listener;
  }

  send(message: CoordinatorToParticipant): void {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(frame: string | Buffer): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
    }
  }

  receive(message: ParticipantToCoordinator): void {
    if (message.type === "response") {
      const waiting = this.pending.get(message.requestId);
      if (!waiting) {
        return;
      }
      this.pending.delete(message.requestId);
      if (message.ok) {
        waiting.resolve(message.data);
      } else {
        waiting.reject(new Error(message.error || "the request failed"));
      }
      return;
    }
    if (
      message.type === "result" ||
      message.type === "notification" ||
      message.type === "log"
    ) {
      this.listener?.(message);
    }
  }

  /** Fails everything still waiting; called when the socket has gone. */
  abandon(): void {
    for (const [requestId, waiting] of this.pending) {
      this.pending.delete(requestId);
      waiting.reject(new Error("its runtime server disconnected"));
    }
  }
}

export class ParticipantRegistry {
  private readonly ticketsByHash = new Map<string, TicketRecord>();
  private readonly hashByRuntime = new Map<string, string>();
  private readonly connections = new Map<string, SocketParticipant>();
  private readonly listeners = new Map<string, Set<BoardListener>>();

  constructor(
    private readonly options: {
      helloTimeoutMs?: number;
      requestTimeoutMs?: number;
      heartbeatMs?: number;
      /**
       * The largest frame a participant may send that is passed on; larger
       * ones are dropped and recorded. Unset means no limit.
       */
      maxFrameBytes?: number;
    } = {},
  ) {}

  // ── Tickets ────────────────────────────────────────────────────────────────

  /**
   * Issues the ticket for one runtime of one board, replacing any before it.
   * Returns the ticket itself — the only time it exists outside the machine it
   * is handed to.
   */
  issue(binding: TicketBinding): string {
    // The ticket before it stops being one. Whatever is connected with it
    // stays connected until the new ticket's holder arrives and takes its
    // place: the board must not lose a runtime to a deploy that has not
    // happened yet, and may never happen.
    const previous = this.hashByRuntime.get(runtimeKey(binding));
    if (previous) {
      this.ticketsByHash.delete(previous);
    }
    const ticket = `${TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const hash = hashTicket(ticket);
    this.ticketsByHash.set(hash, {
      ...binding,
      hash,
      issuedAt: new Date().toISOString(),
    });
    this.hashByRuntime.set(runtimeKey(binding), hash);
    return ticket;
  }

  /** What a presented ticket speaks for, or null when it is not one of ours. */
  resolve(ticket: string | undefined): TicketBinding | null {
    if (!ticket || !ticket.startsWith(TICKET_PREFIX)) {
      return null;
    }
    const record = this.ticketsByHash.get(hashTicket(ticket));
    if (!record) {
      return null;
    }
    const { userId, boardName, runtimeId } = record;
    return { userId, boardName, runtimeId };
  }

  /** Forgets a runtime's ticket and closes whatever connected with it. */
  revoke(binding: TicketBinding): void {
    const key = runtimeKey(binding);
    const hash = this.hashByRuntime.get(key);
    if (hash) {
      this.ticketsByHash.delete(hash);
      this.hashByRuntime.delete(key);
    }
    this.connections
      .get(key)
      ?.socket.close(CLOSE_TICKET_REVOKED, "ticket revoked");
  }

  /**
   * Forgets every ticket of a board except those for `keep`. Used when a board
   * is deployed again without a runtime it used to have, and — keeping nothing
   * — when a board is deleted: a ticket for a runtime the board no longer has
   * must not go on being a way in.
   */
  revokeBoard(userId: string, boardName: string, keep: string[] = []): void {
    const kept = new Set(keep);
    for (const record of [...this.ticketsByHash.values()]) {
      if (
        record.userId === userId &&
        record.boardName === boardName &&
        !kept.has(record.runtimeId)
      ) {
        this.revoke(record);
      }
    }
  }

  /** A board's tickets in the form they are stored. */
  exportTickets(userId: string, boardName: string): StoredTicket[] {
    return [...this.ticketsByHash.values()]
      .filter((t) => t.userId === userId && t.boardName === boardName)
      .map(({ runtimeId, hash, issuedAt }) => ({ runtimeId, hash, issuedAt }));
  }

  /** Takes back tickets a store held, so participants can reconnect. */
  importTickets(
    userId: string,
    boardName: string,
    tickets: StoredTicket[],
  ): void {
    for (const ticket of tickets) {
      const binding = { userId, boardName, runtimeId: ticket.runtimeId };
      const key = runtimeKey(binding);
      // One already issued in this process is newer than what was stored.
      if (this.hashByRuntime.has(key)) {
        continue;
      }
      this.ticketsByHash.set(ticket.hash, { ...binding, ...ticket });
      this.hashByRuntime.set(key, ticket.hash);
    }
  }

  // ── Connections ────────────────────────────────────────────────────────────

  /**
   * Takes a socket that presented a valid ticket.
   *
   * The connection is not a participant until it has said what it is: the
   * board's owner needs to know whether the runtime is already running there
   * before deciding to build it or pick it back up.
   */
  accept(socket: WebSocket, ticket: string): boolean {
    const binding = this.resolve(ticket);
    if (!binding) {
      return false;
    }
    const hash = hashTicket(ticket);
    const key = runtimeKey(binding);
    let participant: SocketParticipant | null = null;

    const helloTimer = setTimeout(() => {
      socket.close(1008, "no hello");
    }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    // Asked, and dropped when it does not answer by the next asking: a
    // connection that is gone without having closed must become a participant
    // that left, or the board's status would be a claim nobody can check.
    let answered = true;
    socket.on("pong", () => {
      answered = true;
    });
    const heartbeat = setInterval(() => {
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on("message", (raw, isBinary) => {
      const bytes = frameBytes(raw);
      const limit = this.options.maxFrameBytes;
      // Asked of a participant, not of a connection still saying what it is:
      // a hello carries a registry, and a limit meant for values must not be
      // what keeps a runtime server from joining.
      if (participant && limit && bytes.length > limit) {
        // Dropped rather than answered with a close: the participant is not
        // gone, and a board that lost a runtime over one value would be wrong
        // about what happened.
        participant.receive({
          type: "log",
          entry: {
            runId: "",
            ts: new Date().toISOString(),
            runtimeId: binding.runtimeId,
            serviceUuid: "",
            level: "warn",
            event: "frame-dropped",
            data: { bytes: bytes.length, limit },
          },
        });
        return;
      }

      let message: ParticipantToCoordinator;
      if (isBinary) {
        // Only a runtime's output travels as bytes.
        const frame = decodeBinaryFrame(bytes);
        if (!frame || frame.header.type !== "result") {
          return;
        }
        message = { type: "result", data: frame.payload };
      } else {
        try {
          message = JSON.parse(bytes.toString("utf8"));
        } catch {
          return;
        }
      }
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (!participant) {
        if (message.type !== "hello") {
          return;
        }
        clearTimeout(helloTimer);
        // The ticket may have been replaced while this socket was connecting.
        if (this.hashByRuntime.get(key) !== hash) {
          socket.close(CLOSE_TICKET_REVOKED, "ticket revoked");
          return;
        }
        // One connection per runtime of a board. A second one is the same
        // machine reconnecting before the first was noticed gone.
        const previous = this.connections.get(key);
        participant = new SocketParticipant(
          binding.runtimeId,
          {
            type: "hello",
            server: typeof message.server === "string" ? message.server : undefined,
            registry: Array.isArray(message.registry) ? message.registry : [],
            runtimeExists: message.runtimeExists === true,
          },
          socket,
          this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        );
        this.connections.set(key, participant);
        previous?.socket.close(CLOSE_REPLACED, "replaced by a newer connection");
        participant.send({
          type: "welcome",
          boardName: binding.boardName,
          runtimeId: binding.runtimeId,
        });
        for (const listener of this.listenersOf(binding)) {
          listener.onJoin(participant);
        }
        return;
      }

      participant.receive(message);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      if (!participant) {
        return;
      }
      participant.abandon();
      // Only the connection that is current leaves; one that was replaced has
      // already been succeeded, and saying it left would un-join its successor.
      if (this.connections.get(key) !== participant) {
        return;
      }
      this.connections.delete(key);
      for (const listener of this.listenersOf(binding)) {
        listener.onLeave(binding.runtimeId);
      }
    });

    socket.on("error", () => {
      // The close that follows is what is acted on.
    });
    return true;
  }

  /** Which of a board's runtimes hold a ticket, and which are connected. */
  describe(
    userId: string,
    boardName: string,
  ): Array<{
    runtimeId: string;
    connected: boolean;
    server?: string;
    issuedAt: string;
  }> {
    return this.exportTickets(userId, boardName).map((ticket) => {
      const connection = this.connections.get(
        runtimeKey({ userId, boardName, runtimeId: ticket.runtimeId }),
      );
      return {
        runtimeId: ticket.runtimeId,
        connected: !!connection,
        server: connection?.hello.server,
        issuedAt: ticket.issuedAt,
      };
    });
  }

  /** One board's participants, for the session that owns that board. */
  forBoard(userId: string, boardName: string): BoardParticipants {
    const key = boardKey(userId, boardName);
    return {
      get: (runtimeId) =>
        this.connections.get(runtimeKey({ userId, boardName, runtimeId })),
      subscribe: (listener) => {
        const set = this.listeners.get(key) ?? new Set<BoardListener>();
        set.add(listener);
        this.listeners.set(key, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) {
            this.listeners.delete(key);
          }
        };
      },
    };
  }

  /** Closes every connection; tickets are kept, so participants may return. */
  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.socket.close(1001, "coordinator shutting down");
    }
  }

  private listenersOf(binding: TicketBinding): BoardListener[] {
    return [
      ...(this.listeners.get(boardKey(binding.userId, binding.boardName)) ?? []),
    ];
  }
}
