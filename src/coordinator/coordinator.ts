import { CloudBoardConfig, BoardSessionInfo } from "./types";
import { BoardSession } from "./session";
import { BoardStore, createMemoryBoardStore } from "./boardStore";

export class BoardCoordinator {
  // userId → boardName → BoardSession
  private readonly sessions = new Map<string, Map<string, BoardSession>>();
  // In-flight registrations, keyed by user and board, so a second one waits for
  // the first rather than tearing down what it is building.
  private readonly registrations = new Map<string, Promise<BoardSession>>();

  /** Where the boards themselves are kept; see BoardStore. In memory unless a
   *  caller supplies somewhere that outlives the process. */
  constructor(private readonly store: BoardStore = createMemoryBoardStore()) {}

  /**
   * Takes back the boards the store holds, as boards that are not running.
   *
   * Await this before serving: until it finishes the coordinator will report
   * that the user has no boards, and a browser told that would be told wrongly.
   * A board already registered in this process wins — it is the live one, and
   * what the store holds is an older copy of the same document.
   */
  async restore(): Promise<void> {
    for (const board of await this.store.load()) {
      if (this.getBoard(board.userId, board.boardName)) {
        continue;
      }
      const session = new BoardSession(
        board.boardName,
        board.userId,
        board.config,
        undefined,
        { createdAt: board.createdAt },
      );
      this.userSessions(board.userId).set(board.boardName, session);
    }
  }

  /**
   * Registers a board, one registration at a time per board.
   *
   * Registering *replaces* a board's session, and replacing it destroys the old
   * one — which hands back the runtimes it had provisioned. Two registrations
   * running at once therefore delete each other's work: the second one's
   * teardown removes the runtime the first has just created, and the first then
   * fails on the next call it makes against it. Boards are registered whenever
   * a board changes, so overlapping calls are ordinary, not exotic.
   *
   * Serialising them per board keeps each replacement whole: destroy, then
   * provision, then the next caller starts from a settled state.
   */
  async registerBoard(
    userId: string,
    config: CloudBoardConfig,
    userJwt?: string,
  ): Promise<BoardSession> {
    const key = `${userId}\u0000${config.boardName}`;
    const queued = (this.registrations.get(key) ?? Promise.resolve())
      // A failed registration must not stop the next one from being attempted.
      .catch(() => undefined)
      .then(() => this.replaceSession(userId, config, userJwt));
    this.registrations.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this.registrations.get(key) === queued) {
        this.registrations.delete(key);
      }
    }
  }

  private async replaceSession(
    userId: string,
    config: CloudBoardConfig,
    // The caller's JWT, forwarded so the session can provision runtimes and mint
    // delegated session tokens on the user's behalf.
    userJwt?: string,
  ): Promise<BoardSession> {
    const existing = this.sessions.get(userId)?.get(config.boardName);
    // Lift the browser bridges out of the old session before destroying it so
    // connected browsers don't see a disconnect when infrastructure changes
    // cause the session to be replaced (e.g. the user adds a runtime).
    const existingBridges = existing?.takeBridges() ?? [];
    if (existing) {
      await existing.destroy();
    }

    const session = new BoardSession(config.boardName, userId, config, userJwt);
    await session.start();

    for (const bridge of existingBridges) {
      if (bridge.ws.readyState === 1 /* OPEN */) {
        session.registerBrowserSocket(bridge.ws, bridge.runtimeIds);
      }
    }

    this.userSessions(userId).set(config.boardName, session);

    // Deploying is what makes a board the coordinator's, so it is what the
    // store is told about. Starting a stopped board registers the same config
    // again and lands here too, which is harmless: it writes what is already
    // written.
    try {
      await this.store.save({
        userId,
        boardName: config.boardName,
        createdAt: session.createdAt,
        config,
      });
    } catch (err) {
      // The board is provisioned and running; only its survival of a restart is
      // in doubt. Failing the deploy over that would be the worse trade.
      console.error(
        `[coordinator] Failed to persist board "${config.boardName}":`,
        err instanceof Error ? err.message : err,
      );
    }
    return session;
  }

  /** How many boards this coordinator holds, across every user. */
  getBoardCount(): number {
    let total = 0;
    for (const boards of this.sessions.values()) {
      total += boards.size;
    }
    return total;
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
      errors: s.getErrors(),
    }));
  }

  async removeBoard(userId: string, boardName: string): Promise<boolean> {
    const session = this.sessions.get(userId)?.get(boardName);
    if (!session) {
      return false;
    }
    session.destroy();
    this.sessions.get(userId)?.delete(boardName);
    // Deleting a board that outlived a restart has to delete it there too, or
    // the next restore brings it back.
    await this.store.remove(userId, boardName);
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
