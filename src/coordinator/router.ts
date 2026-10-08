import { Router, Request, Response } from "express";
import { BoardCoordinator } from "./coordinator";
import {
  createAuthMiddleware,
  createIdentifyMiddleware,
  requireSelf,
} from "./auth";
import { AuthConfig, Authenticator } from "../auth";
import { MemberLimitError, readMember } from "./members";
import { AssetDescriptor, readAssetsPayload } from "../assets";
import { CloudBoardConfig, CloudRuntimeDescriptor, CloudServiceDescriptor } from "./types";

export type CoordinatorRouterOptions = {
  coordinator?: BoardCoordinator;
  auth?: AuthConfig;
  /**
   * The authenticator of the server this router is mounted on. Absent, the
   * router builds one from `auth`.
   */
  authenticator?: Authenticator;
};

/**
 * Where a member asks which boards are shared with them, relative to the
 * router. It authenticates its own caller — by identity, not by the server's
 * allowlist — so a server mounting the router has to let it past the check
 * every other route gets; see `addSelfAuthenticatedRoute`.
 */
export const SHARED_BOARDS_PATH = "/shared";

/** A board has a handful of runtimes; this only bounds a malformed request. */
const MAX_TICKETS_PER_REQUEST = 64;

export function createCoordinatorRouter(
  options: CoordinatorRouterOptions = {},
): { router: Router; coordinator: BoardCoordinator } {
  const authConfig: AuthConfig = options.auth ?? { mode: "none" };
  const coordinator = options.coordinator ?? new BoardCoordinator();
  const router = Router();
  const auth = createAuthMiddleware(authConfig, options.authenticator);
  const identify = createIdentifyMiddleware(authConfig, options.authenticator);

  // All /users/:username routes require a valid token that matches the username.
  router.use("/users/:username", auth, requireSelf);

  /**
   * The boards shared with whoever is asking: every board, of any owner, whose
   * member list names their verified email.
   *
   * Open to anybody with a verified identity. The server's allowlist says who
   * may own boards here; being on one board's list is permission to use that
   * board, and somebody the operator never listed has to be able to find it.
   */
  router.get(SHARED_BOARDS_PATH, identify, (req: Request, res: Response) => {
    res.json({
      boards: coordinator.getSharedBoards(req.authenticatedUser?.email),
    });
  });

  /** Who a board is shared with. The owner's to read: it is a list of addresses. */
  router.get(
    "/users/:username/boards/:boardName/members",
    (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      if (!coordinator.getBoard(username, boardName)) {
        res.sendStatus(404);
        return;
      }
      res.json({ members: coordinator.getMembers(username, boardName) });
    },
  );

  /**
   * Shares the board with an email, under a name — or renames the entry that
   * email already has. POST for both, like every other change this server
   * takes.
   */
  router.post(
    "/users/:username/boards/:boardName/members",
    async (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const member = readMember(req.body);
      if (!member) {
        res.status(400).json({ error: "A member is an email and a name" });
        return;
      }
      try {
        const members = await coordinator.setMember(username, boardName, member);
        if (!members) {
          res.sendStatus(404);
          return;
        }
        res.json({ members });
      } catch (err) {
        if (err instanceof MemberLimitError) {
          res.status(429).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  /** Stops sharing with an email. Whatever they have open on the board closes. */
  router.delete(
    "/users/:username/boards/:boardName/members/:email",
    async (req: Request, res: Response) => {
      const { username, boardName, email } = req.params as Record<string, string>;
      const members = await coordinator.removeMember(username, boardName, email);
      if (!members) {
        res.sendStatus(404);
        return;
      }
      res.json({ members });
    },
  );

  router.get("/users/:username/boards", (req: Request, res: Response) => {
    const { username } = req.params as Record<string, string>;
    const boards = coordinator.getBoards(username);
    res.json({ boards });
  });

  /**
   * Tickets for a board's runtimes: one per runtime named, each replacing the
   * one before it.
   *
   * Asked for by the person's own client, which hands each ticket to the
   * runtime server it chose for that runtime. This is the whole of how a
   * runtime server comes to belong to a board: the coordinator is told no
   * address and looks none up.
   */
  router.post(
    "/users/:username/boards/:boardName/tickets",
    async (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const runtimeIds = (req.body as { runtimeIds?: unknown } | undefined)
        ?.runtimeIds;
      if (
        !Array.isArray(runtimeIds) ||
        runtimeIds.length > MAX_TICKETS_PER_REQUEST ||
        !runtimeIds.every((id) => typeof id === "string" && !!id)
      ) {
        res.sendStatus(400);
        return;
      }
      const tickets = await coordinator.issueTickets(
        username,
        boardName,
        runtimeIds as string[],
      );
      res.status(201).json({ tickets });
    },
  );

  /**
   * Takes back the tickets of a deploy that did not go through: the client
   * asked for them, could not introduce every runtime server, and will not
   * register the board. See BoardCoordinator.cancelTickets.
   */
  router.delete(
    "/users/:username/boards/:boardName/tickets",
    (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      coordinator.cancelTickets(username, boardName);
      res.sendStatus(204);
    },
  );

  /**
   * Which of a board's runtimes hold a ticket, and whether the runtime server
   * holding it is connected. Never the tickets themselves — a coordinator
   * keeps only what recognises one.
   */
  router.get(
    "/users/:username/boards/:boardName/participants",
    (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      res.json({
        participants: coordinator.participants.describe(username, boardName),
      });
    },
  );

  router.post(
    "/users/:username/boards",
    async (req: Request, res: Response) => {
      const { username } = req.params as Record<string, string>;
      const config = parseCloudBoardConfig(req.body);
      if (!config) {
        res.sendStatus(400);
        return;
      }

      try {
        const session = await coordinator.registerBoard(username, config);
        res.status(201).json({
          boardName: session.boardName,
          status: session.getStatus(),
          createdAt: session.createdAt,
          errors: session.getErrors(),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to register board";
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/users/:username/boards/:boardName",
    (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const session = coordinator.getBoard(username, boardName);
      if (!session) {
        res.sendStatus(404);
        return;
      }
      res.json({
        boardName: session.boardName,
        status: session.getStatus(),
        createdAt: session.createdAt,
        config: session.config,
        errors: session.getErrors(),
      });
    },
  );

  /**
   * What this board recorded, newest last.
   *
   * Behind the same `auth` + `requireSelf` the other board routes sit behind —
   * a valid token whose `sub` matches the username — and deliberately not
   * behind a runtime session token: that is a machine credential minted to
   * outlive a user's session, and reading a board's history is not something it
   * should be able to do.
   *
   * `data` is withheld unless asked for, because filtering it after it had been
   * sent would defeat the point of withholding it at all.
   */
  router.get(
    "/users/:username/boards/:boardName/runs",
    async (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      if (!coordinator.getBoard(username, boardName)) {
        res.sendStatus(404);
        return;
      }

      const level = req.query.level as string | undefined;
      const limit = Number(req.query.limit);
      try {
        const entries = await coordinator.readLog(username, boardName, {
          runId: (req.query.runId as string) || undefined,
          level:
            level === "debug" || level === "info" || level === "warn" ||
            level === "error"
              ? level
              : undefined,
          since: (req.query.since as string) || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          withData: req.query.withData === "true",
        });
        res.json({ entries });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to read the log";
        res.status(500).json({ error: message });
      }
    },
  );

  /**
   * Whether this board records anything at all.
   *
   * Its own route rather than part of re-registering the board, because it is a
   * setting a board revisits while it runs: registering again would rebuild
   * every runtime to change one boolean.
   */
  router.post(
    "/users/:username/boards/:boardName/logging",
    async (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const body = req.body as
        | { enabled?: unknown; level?: unknown }
        | undefined;
      const enabled = body?.enabled;
      if (typeof enabled !== "boolean") {
        res.sendStatus(400);
        return;
      }
      const level =
        body?.level === "debug" ||
        body?.level === "info" ||
        body?.level === "warn" ||
        body?.level === "error"
          ? body.level
          : "info";

      const result = await coordinator.setBoardLogging(
        username,
        boardName,
        enabled,
        level,
      );
      if (!result) {
        res.sendStatus(404);
        return;
      }
      res.json({ logging: enabled, level, unreachable: result.unreachable });
    },
  );

  router.post(
    "/users/:username/boards/:boardName/stop",
    async (req: Request, res: Response) => {
      // Releases the board's runtimes without giving up the board: it keeps
      // its place and its config, so registering that config again starts it
      // back up.
      const { username, boardName } = req.params as Record<string, string>;
      const session = await coordinator.stopBoard(username, boardName);
      if (!session) {
        res.sendStatus(404);
        return;
      }
      res.json({
        boardName: session.boardName,
        status: session.getStatus(),
        createdAt: session.createdAt,
        errors: session.getErrors(),
      });
    },
  );

  router.delete(
    "/users/:username/boards/:boardName",
    async (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const removed = await coordinator.removeBoard(username, boardName);
      if (!removed) {
        res.sendStatus(404);
        return;
      }
      res.sendStatus(204);
    },
  );

  return { router, coordinator };
}

function parseCloudBoardConfig(value: unknown): CloudBoardConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.boardName !== "string" || !obj.boardName) {
    return null;
  }
  if (!Array.isArray(obj.runtimes)) {
    return null;
  }
  if (typeof obj.services !== "object" || Array.isArray(obj.services)) {
    return null;
  }

  const runtimes = obj.runtimes as CloudRuntimeDescriptor[];
  const services = obj.services as Record<string, CloudServiceDescriptor[]>;

  // Descriptors only; one that cannot be read is dropped, and the service
  // referencing it says so by name when it resolves.
  const assets = Object.values(readAssetsPayload(obj.assets)).filter(
    (entry): entry is AssetDescriptor => entry !== null,
  );

  return {
    boardName: obj.boardName,
    runtimes,
    services,
    facade: obj.facade,
    ...(assets.length ? { assets } : {}),
  };
}
