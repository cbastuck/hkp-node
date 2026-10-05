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
 * wait, saying the same nothing — so that asking is not a way to learn which
 * boards exist or who they are shared with.
 */

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
): (ws: WebSocket, user: AuthenticatedUser, mayOwn: boolean) => void {
  const attempts = options.attempts ?? 30;
  const attemptDelayMs = options.attemptDelayMs ?? 100;

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

  return (ws, user, mayOwn) => {
    ws.once("message", (raw) => {
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
            ws.close();
            return;
          }
          session.registerBrowserSocket(ws, runtimeIds, attach);
          return;
        }
        if (attemptsLeft <= 0) {
          console.warn(
            `[bridge] No board "${boardName}" to attach "${user.sub}" to — closing`,
          );
          ws.close();
          return;
        }
        setTimeout(() => look(attemptsLeft - 1), attemptDelayMs);
      };
      look(attempts);
    });
  };
}
