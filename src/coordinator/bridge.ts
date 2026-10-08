import { Duplex } from "node:stream";

import { WebSocket } from "ws";

import { AuthenticatedUser } from "../auth";
import { Caller } from "../types";
import { BoardCoordinator } from "./coordinator";
import { findMember } from "./members";
import { BridgeAttach } from "./session";

/**
 * Who may attach a browser to a board, and as what.
 *
 * A bridge names an owner and a board. Two kinds of people are admitted:
 *
 * - the **owner** — the token's `sub` is the owner named, and it passes the
 *   server's allowlist, which is what gates who may own anything here;
 * - a **member** — the token carries a verified email that the board's list
 *   names. The allowlist is not asked of them: a board's list is what gates
 *   that board, and it admits people the server's operator never heard of.
 *
 * Anybody else is closed on the way an unknown board is — after the same
 * wait, with the same code — so that asking is not a way to learn which
 * boards exist or who they are shared with.
 */

/**
 * Closing a bridge because there is no such board for whoever asked: it does
 * not exist, or it is not theirs and not shared with them. One code for both.
 * Said as a code so that a client can tell an answer from a connection that
 * merely dropped, which says nothing about the board.
 */
export const CLOSE_NO_SUCH_BOARD = 4404;

/** Closing a member's bridge because they already hold as many as one member
 *  may. Only ever said to somebody the board is shared with. */
export const CLOSE_TOO_MANY_BRIDGES = 4429;

export type BridgeAdmissionOptions = {
  /**
   * How this coordinator's server authenticates. Without authentication there
   * is no identity to admit by: everybody is the one anonymous tenant, and a
   * bridge is its owner's, as it always was on a development machine.
   */
  authMode: "jwt" | "none";
  /** How often a board that is not there yet is looked for again. */
  attempts?: number;
  attemptDelayMs?: number;
  /** How long a socket may stay open without saying which board it wants. */
  connectTimeoutMs?: number;
  /** How much a socket may send before it has been admitted to a board. */
  maxConnectBytes?: number;
  /** How many sockets one identity may have waiting to be admitted. */
  maxPendingPerIdentity?: number;
};

/**
 * What is allowed of a socket nobody has admitted yet. The upgrade establishes
 * only who is asking, and that may be anybody able to sign in — so until a
 * board has taken the socket it gets a short time, a small message and few
 * siblings. Once admitted, what a bridge may carry is the board's to say.
 */
export const DEFAULT_ADMISSION_LIMITS = {
  connectTimeoutMs: 10_000,
  maxConnectBytes: 64 * 1024,
  maxPendingPerIdentity: 8,
};

type ConnectMessage = {
  type?: string;
  userId?: string;
  boardName?: string;
  runtimeIds?: unknown;
};

export function createBridgeHandler(
  coordinator: BoardCoordinator,
  options: BridgeAdmissionOptions,
): (
  ws: WebSocket,
  user: AuthenticatedUser,
  mayOwn: boolean,
  transport?: Duplex,
) => void {
  const attempts = options.attempts ?? 30;
  const attemptDelayMs = options.attemptDelayMs ?? 100;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_ADMISSION_LIMITS.connectTimeoutMs;
  const maxConnectBytes =
    options.maxConnectBytes ?? DEFAULT_ADMISSION_LIMITS.maxConnectBytes;
  const maxPendingPerIdentity =
    options.maxPendingPerIdentity ??
    DEFAULT_ADMISSION_LIMITS.maxPendingPerIdentity;
  /** Sockets waiting to be admitted, counted by who opened them. */
  const pending = new Map<string, number>();

  /** What this person is to the board, or null when they are nothing to it. */
  function admit(
    user: AuthenticatedUser,
    mayOwn: boolean,
    userId: string,
    boardName: string,
  ): BridgeAttach | null {
    if (options.authMode === "none") {
      return { role: "owner" };
    }
    const listed = findMember(
      coordinator.getMembers(userId, boardName),
      user.email,
    );
    const caller: Caller = {
      sub: user.sub,
      ...(user.email ? { email: user.email } : {}),
      // The owner is called what their own list calls them, when it names
      // them: the name on a booking is the same for everybody.
      ...(listed ? { name: listed.name } : {}),
    };
    if (user.sub === userId && mayOwn) {
      return { role: "owner", caller };
    }
    return listed ? { role: "member", caller } : null;
  }

  return (ws, user, mayOwn, transport) => {
    // Without authentication everybody is the one anonymous tenant, and there
    // is no identity to count by.
    const counted = options.authMode !== "none";
    const waiting = pending.get(user.sub) ?? 0;
    if (counted && waiting >= maxPendingPerIdentity) {
      console.warn(
        `[bridge] Too many sockets waiting for "${user.sub}" — closing`,
      );
      ws.terminate();
      return;
    }
    if (counted) {
      pending.set(user.sub, waiting + 1);
    }

    // Counted on the connection rather than on the message: the socket has no
    // ceiling of its own, so a message is only seen once all of it has been
    // buffered, which is too late to refuse it.
    let received = 0;
    const count = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxConnectBytes) {
        console.warn(
          `[bridge] "${user.sub}" sent more than ${maxConnectBytes} bytes before being admitted — closing`,
        );
        ws.terminate();
      }
    };
    transport?.on("data", count);

    const deadline = setTimeout(() => {
      console.warn(`[bridge] No connect message from "${user.sub}" — closing`);
      ws.close(1008, "connect expected");
    }, connectTimeoutMs);

    let settled = false;
    /** The socket stops waiting: a board took it, or it is gone. */
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      transport?.off("data", count);
      if (counted) {
        const left = (pending.get(user.sub) ?? 1) - 1;
        if (left > 0) {
          pending.set(user.sub, left);
        } else {
          pending.delete(user.sub);
        }
      }
    };
    ws.once("close", settle);

    ws.once("message", (raw) => {
      // Said which board, or failed to: either way the wait for it is over.
      // The rest of what applies to an unadmitted socket stays until `settle`.
      clearTimeout(deadline);
      let msg: ConnectMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn("[bridge] Failed to parse connect message — closing");
        ws.close();
        return;
      }
      if (msg.type !== "connect" || !msg.userId || !msg.boardName) {
        console.warn(
          `[bridge] Invalid connect message (type=${msg.type}, boardName=${msg.boardName}) — closing`,
        );
        ws.close();
        return;
      }
      const { userId, boardName } = msg;
      const runtimeIds = Array.isArray(msg.runtimeIds)
        ? msg.runtimeIds.filter((id): id is string => typeof id === "string")
        : [];

      // The session may not exist yet if the bridge connects before the board
      // has been registered, so it is looked for a few times before giving up.
      // Somebody who is not admitted waits just as long: a refusal that came
      // sooner than "no such board" would say the board is there.
      const look = (attemptsLeft: number) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const session = coordinator.getBoard(userId, boardName);
        const attach = session ? admit(user, mayOwn, userId, boardName) : null;
        if (session && attach) {
          if (
            attach.role === "member" &&
            session.countMemberBridges(attach.caller?.email ?? "") >=
              coordinator.maxBridgesPerMember
          ) {
            console.warn(
              `[bridge] Too many bridges for one member of "${boardName}" — closing`,
            );
            ws.close(CLOSE_TOO_MANY_BRIDGES, "open in too many places");
            return;
          }
          settle();
          session.registerBrowserSocket(ws, runtimeIds, attach);
          return;
        }
        if (attemptsLeft <= 0) {
          console.warn(
            `[bridge] No board "${boardName}" to attach "${user.sub}" to — closing`,
          );
          ws.close(CLOSE_NO_SUCH_BOARD, "no such board");
          return;
        }
        setTimeout(() => look(attemptsLeft - 1), attemptDelayMs);
      };
      look(attempts);
    });
  };
}
