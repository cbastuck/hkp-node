import { CloudBoardConfig, BoardSessionInfo } from "./types";
import { BoardSession } from "./session";
import { BoardStore, createMemoryBoardStore } from "./boardStore";
import { LogStore } from "./logStore";
import { LogEntry, LogLevel } from "../types";
import { ParticipantRegistry } from "./participants";
import { isRemoteRuntime } from "./types";

export class BoardCoordinator {
  // userId → boardName → BoardSession
  private readonly sessions = new Map<string, Map<string, BoardSession>>();
  // In-flight registrations, keyed by user and board, so a second one waits for
  // the first rather than tearing down what it is building.
  private readonly registrations = new Map<string, Promise<BoardSession>>();

  /** Where the boards themselves are kept; see BoardStore. In memory unless a
   *  caller supplies somewhere that outlives the process. */
  /**
   * The tickets this coordinator has issued and the runtime servers connected
   * with them. Everything a board's remote runtimes do reaches it through
   * here: the coordinator accepts connections and makes none.
   */
  readonly participants: ParticipantRegistry;

  constructor(
    private readonly store: BoardStore = createMemoryBoardStore(),
    /** Where boards' log entries are kept; absent means none are collected. */
    private readonly logStore?: LogStore,
    participants?: ParticipantRegistry,
    /**
     * What this coordinator's operator allows. `maxFrameBytes` bounds a single
     * value passed between runtimes; unset means no limit.
     */
    private readonly limits: { maxFrameBytes?: number } = {},
  ) {
    this.participants =
      participants ??
      new ParticipantRegistry({
        maxFrameBytes: limits.maxFrameBytes,
        // A board that exists has to remember the ticket that now counts, or
        // a restart would bring back the one it replaced.
        onTicketsChanged: (userId, boardName) => {
          const session = this.getBoard(userId, boardName);
          if (session) {
            void this.persist(session);
          }
        },
      });
  }

  /** Entries this board has recorded; see LogStore.read. */
  readLog(
    userId: string,
    boardName: string,
    query?: Parameters<LogStore["read"]>[2],
  ): Promise<LogEntry[]> {
    return this.logStore?.read(userId, boardName, query) ?? Promise.resolve([]);
  }

  /**
   * Takes back the boards the store holds.
   *
   * Await this before serving: until it finishes the coordinator will report
   * that the user has no boards, and a browser told that would be told wrongly.
   * A board already registered in this process wins — it is the live one, and
   * what the store holds is an older copy of the same document.
   *
   * A board that was running is run again. Nothing is connected yet, so it
   * comes back in `error`, naming every runtime it is waiting for, and builds
   * each one as its runtime server reconnects with the ticket it kept — with
   * nobody present, which is the point of a ticket. A board that was stopped
   * stays stopped.
   */
  async restore(): Promise<void> {
    for (const board of await this.store.load()) {
      if (this.getBoard(board.userId, board.boardName)) {
        continue;
      }
      this.participants.importTickets(
        board.userId,
        board.boardName,
        board.tickets ?? [],
      );
      // Written by a coordinator that kept no tickets: there is nothing that
      // could reconnect, so the board is as stopped as it always came back.
      const stopped = board.stopped ?? true;
      const session = new BoardSession(
        board.boardName,
        board.userId,
        board.config,
        this.participants.forBoard(board.userId, board.boardName),
        { createdAt: board.createdAt, stopped },
        this.logStore,
        this.limits,
      );
      this.userSessions(board.userId).set(board.boardName, session);
      if (!stopped) {
        await session.start();
      }
    }
  }

  /**
   * Issues a ticket for each of a board's runtimes named. Asked for before the
   * board is registered: the person's client hands each ticket to the runtime
   * server it chose, which connects with it, and only then is the board
   * registered.
   *
   * For a board that is already running the new tickets are pending: its
   * runtime servers stay its own until the registration that follows, so a
   * deploy that fails part-way leaves it as it was. See ParticipantRegistry.
   */
  async issueTickets(
    userId: string,
    boardName: string,
    runtimeIds: string[],
  ): Promise<Record<string, string>> {
    const tickets: Record<string, string> = {};
    for (const runtimeId of runtimeIds) {
      tickets[runtimeId] = this.participants.issue({
        userId,
        boardName,
        runtimeId,
      });
    }
    // A board that already exists has to remember a ticket that counts at
    // once — one for a runtime it had none for.
    const session = this.getBoard(userId, boardName);
    if (session) {
      await this.persist(session);
    }
    return tickets;
  }

  /** Writes a board down, with its tickets and whether it is stopped. */
  private async persist(session: BoardSession): Promise<void> {
    try {
      await this.store.save({
        userId: session.userId,
        boardName: session.boardName,
        createdAt: session.createdAt,
        config: session.config,
        stopped: session.isStopped(),
        tickets: this.participants.exportTickets(
          session.userId,
          session.boardName,
        ),
      });
    } catch (err) {
      // The board is as it should be in this process; only its survival of a
      // restart is in doubt. Failing the request over that would be the worse
      // trade.
      console.error(
        `[coordinator] Failed to persist board "${session.boardName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Stops a board without giving it up, and remembers that it is stopped — a
   * restart must not start a board its owner stopped.
   */
  async stopBoard(
    userId: string,
    boardName: string,
  ): Promise<BoardSession | null> {
    const session = this.getBoard(userId, boardName);
    if (!session) {
      return null;
    }
    await session.stop();
    await this.persist(session);
    return session;
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
  ): Promise<BoardSession> {
    const key = `${userId}\u0000${config.boardName}`;
    const queued = (this.registrations.get(key) ?? Promise.resolve())
      // A failed registration must not stop the next one from being attempted.
      .catch(() => undefined)
      .then(() => this.replaceSession(userId, config));
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
  ): Promise<BoardSession> {
    const existing = this.sessions.get(userId)?.get(config.boardName);
    // Lift the browser bridges out of the old session before destroying it so
    // connected browsers don't see a disconnect when infrastructure changes
    // cause the session to be replaced (e.g. the user adds a runtime).
    const existingBridges = existing?.takeBridges() ?? [];
    if (existing) {
      await existing.destroy();
    }

    // The deploy went through: the servers introduced for it are the board's
    // from here. After the old session released its runtimes, which it did
    // over the connections it had.
    this.participants.promoteBoard(userId, config.boardName);

    // A ticket for a runtime the board no longer has stops being a way in. The
    // old session has already released that runtime, over the connection this
    // closes.
    this.participants.revokeBoard(
      userId,
      config.boardName,
      config.runtimes.filter(isRemoteRuntime).map((runtime) => runtime.id),
    );

    const session = new BoardSession(
      config.boardName,
      userId,
      config,
      this.participants.forBoard(userId, config.boardName),
      undefined,
      this.logStore,
      this.limits,
    );
    await session.start();

    for (const bridge of existingBridges) {
      if (bridge.ws.readyState === 1 /* OPEN */) {
        session.registerBrowserSocket(bridge.ws, bridge.runtimeIds);
      }
    }

    this.userSessions(userId).set(config.boardName, session);

    // Deploying is what makes a board the coordinator's, so it is what the
    // store is told about. Starting a stopped board registers the same config
    // again and lands here too.
    await this.persist(session);
    return session;
  }

  /**
   * Turn logging on or off for a board, and remember the answer.
   *
   * The session applies it to what is running; the store is told so a restart
   * does not quietly revert it. Returns the runtimes that did not take it —
   * a runtime that is unreachable, or one whose server has no such route.
   */
  async setBoardLogging(
    userId: string,
    boardName: string,
    enabled: boolean,
    level: LogLevel = "info",
  ): Promise<{ unreachable: string[] } | null> {
    const session = this.getBoard(userId, boardName);
    if (!session) {
      return null;
    }

    const unreachable = await session.setLogging(enabled, level);
    await this.persist(session);

    return { unreachable };
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
    await session.destroy();
    this.sessions.get(userId)?.delete(boardName);
    // After the runtimes were released over them: the tickets are the board's,
    // and a deleted board has no participants.
    this.participants.revokeBoard(userId, boardName);
    // Deleting a board that outlived a restart has to delete it there too, or
    // the next restore brings it back.
    await this.store.remove(userId, boardName);
    return true;
  }

  destroyAll(): void {
    for (const userSessions of this.sessions.values()) {
      for (const session of userSessions.values()) {
        void session.destroy();
      }
    }
    this.sessions.clear();
    this.participants.closeAll();
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
