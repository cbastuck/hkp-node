import { randomBytes } from "node:crypto";

import { AuthenticatedUser } from "./auth";

/**
 * Single-use tickets that open a WebSocket in place of a token.
 *
 * A browser cannot set a header on a WebSocket handshake, so a token it
 * authenticated one with would have to ride in the address — and an address
 * is what proxies and access logs keep. So a browser first asks for a ticket
 * (`POST /ws-tickets`, with its token in the `Authorization` header like any
 * request) and opens the socket with `?ticket=` instead. A ticket opens one
 * socket, within seconds, as whoever asked for it, and is worth nothing once
 * written down.
 *
 * What the ticket remembers is what checking the token found: who the caller
 * is, and whether this server's allowlist lets them own. The socket is then
 * judged exactly as the token would have been, without the token.
 *
 * The same in hkp-python (`ws_tickets.py`) and hkp-rt (`http/server.cpp`).
 */

export type TicketHolder = {
  /** Who the token named; null for a token that names nobody. */
  identity: AuthenticatedUser | null;
  /** The same person, when they may own here; null otherwise. */
  owner: AuthenticatedUser | null;
};

/** Long enough for a browser to open the socket it asked for, and no longer. */
export const TICKET_TTL_MS = 30_000;

/** Outstanding tickets kept; past this the oldest go first. */
const MAX_OUTSTANDING = 10_000;

export class WsTickets {
  private readonly tickets = new Map<string, TicketHolder & { expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A ticket for `holder`, good for one socket within TICKET_TTL_MS. */
  mint(holder: TicketHolder): string {
    this.prune();
    while (this.tickets.size >= MAX_OUTSTANDING) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { ...holder, expires: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Who a ticket was minted for — once. Unknown, used or expired: null. */
  redeem(ticket: string): TicketHolder | null {
    const held = this.tickets.get(ticket);
    if (!held) {
      return null;
    }
    this.tickets.delete(ticket);
    if (held.expires < this.now()) {
      return null;
    }
    return { identity: held.identity, owner: held.owner };
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, held] of this.tickets) {
      if (held.expires < now) {
        this.tickets.delete(ticket);
      }
    }
  }
}
