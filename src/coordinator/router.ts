import { Router, Request, Response } from "express";
import { BoardCoordinator } from "./coordinator";
import { createAuthMiddleware, requireSelf } from "./auth";
import { AuthConfig } from "../auth";
import { CloudBoardConfig, CloudRuntimeDescriptor, CloudServiceDescriptor } from "./types";

export type CoordinatorRouterOptions = {
  coordinator?: BoardCoordinator;
  auth?: AuthConfig;
};

export function createCoordinatorRouter(
  options: CoordinatorRouterOptions = {},
): { router: Router; coordinator: BoardCoordinator } {
  const authConfig: AuthConfig = options.auth ?? { mode: "none" };
  const coordinator = options.coordinator ?? new BoardCoordinator();
  const router = Router();
  const auth = createAuthMiddleware(authConfig);

  // All /users/:username routes require a valid token that matches the username.
  router.use("/users/:username", auth, requireSelf);

  router.get("/users/:username/boards", (req: Request, res: Response) => {
    const { username } = req.params as Record<string, string>;
    const boards = coordinator.getBoards(username);
    res.json({ boards });
  });

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
        // Forward the caller's JWT so the session can provision runtimes and
        // mint delegated session tokens on their behalf.
        const authHeader = req.headers.authorization;
        const userJwt = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : undefined;
        const session = await coordinator.registerBoard(
          username,
          config,
          userJwt,
        );
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
      const session = coordinator.getBoard(username, boardName);
      if (!session) {
        res.sendStatus(404);
        return;
      }
      await session.stop();
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

  return {
    boardName: obj.boardName,
    runtimes,
    services,
    facade: obj.facade,
  };
}
