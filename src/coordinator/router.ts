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
      });
    },
  );

  router.delete(
    "/users/:username/boards/:boardName",
    (req: Request, res: Response) => {
      const { username, boardName } = req.params as Record<string, string>;
      const removed = coordinator.removeBoard(username, boardName);
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
