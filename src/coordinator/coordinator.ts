import { CloudBoardConfig, BoardSessionInfo } from "./types";
import { BoardSession } from "./session";

export class BoardCoordinator {
  // userId → boardName → BoardSession
  private readonly sessions = new Map<string, Map<string, BoardSession>>();

  async registerBoard(
    userId: string,
    config: CloudBoardConfig,
  ): Promise<BoardSession> {
    const existing = this.sessions.get(userId)?.get(config.boardName);
    // Lift the browser bridge out of the old session before destroying it so
    // the browser doesn't see a disconnect when infrastructure changes cause
    // the session to be replaced (e.g. the user adds a runtime).
    const existingBridge = existing?.takeBridge() ?? null;
    if (existing) {
      await existing.destroy();
    }

    const session = new BoardSession(config.boardName, userId, config);
    await session.start();

    if (existingBridge && existingBridge.ws.readyState === 1 /* OPEN */) {
      session.registerBrowserSocket(existingBridge.ws, existingBridge.runtimeIds);
    }

    this.userSessions(userId).set(config.boardName, session);
    return session;
  }

  getBoard(userId: string, boardName: string): BoardSession | undefined {
    return this.sessions.get(userId)?.get(boardName);
  }

  getBoards(userId: string): BoardSessionInfo[] {
    const sessions = this.sessions.get(userId);
    if (!sessions) {
      return [];
    }
    return [...sessions.values()].map((s) => ({
      boardName: s.boardName,
      userId: s.userId,
      status: s.getStatus(),
      createdAt: s.createdAt,
      config: s.config,
    }));
  }

  removeBoard(userId: string, boardName: string): boolean {
    const session = this.sessions.get(userId)?.get(boardName);
    if (!session) {
      return false;
    }
    session.destroy();
    this.sessions.get(userId)?.delete(boardName);
    return true;
  }

  destroyAll(): void {
    for (const userSessions of this.sessions.values()) {
      for (const session of userSessions.values()) {
        session.destroy();
      }
    }
    this.sessions.clear();
  }

  private userSessions(userId: string): Map<string, BoardSession> {
    const existing = this.sessions.get(userId);
    if (existing) {
      return existing;
    }
    const map = new Map<string, BoardSession>();
    this.sessions.set(userId, map);
    return map;
  }
}
