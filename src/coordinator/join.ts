import http from "node:http";
import { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { BoardCoordinator } from "./coordinator";
import { JOIN_PATH } from "./participantProtocol";
import { socketCeiling } from "./frameLimits";

/**
 * Where runtime servers connect in.
 *
 * The one endpoint of a coordinator that a user's token does not open: what
 * connects here is a machine holding a ticket, possibly long after the person
 * who deployed the board has gone. The ticket is presented as a bearer token on
 * the upgrade and decides everything — which person, which board, which
 * runtime — so the connection is told nothing and asks for nothing else.
 */

type UpgradeHost = {
  addUpgradeRoute(
    pathname: string,
    handler: (
      request: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void,
  ): void;
};

export function attachCoordinatorJoin(
  host: UpgradeHost,
  coordinator: BoardCoordinator,
  basePath = "/coordinator",
): void {
  // What a coordinator's operator allows is decided per frame, and an
  // oversized value is dropped without closing anything (ParticipantRegistry).
  // The library's own ceiling sits above that, so it refuses only what the
  // frame limit would have dropped anyway; see frameLimits.ts.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: socketCeiling(coordinator.maxFrameBytes),
  });

  host.addUpgradeRoute(`${basePath}${JOIN_PATH}`, (request, socket, head) => {
    const header = request.headers.authorization;
    const ticket = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    // Decided before the upgrade, so a ticket this coordinator does not hold is
    // refused as an HTTP answer — which is what tells its holder to stop
    // presenting it, rather than to try again.
    if (!ticket || !coordinator.participants.resolve(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!coordinator.participants.accept(ws, ticket)) {
        ws.close();
      }
    });
  });
}
