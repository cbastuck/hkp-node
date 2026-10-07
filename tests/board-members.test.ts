import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { AuthenticatedUser } from "../src/auth";
import {
  BoardStore,
  createMemoryBoardStore,
} from "../src/coordinator/boardStore";
import {
  CLOSE_NO_SUCH_BOARD,
  CLOSE_TOO_MANY_BRIDGES,
} from "../src/coordinator/bridge";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import {
  projectConfig,
  projectNotification,
  projectState,
  readFacadeAccess,
} from "../src/coordinator/facadeAccess";
import { readMember } from "../src/coordinator/members";
import { BoardSession, CLOSE_NOT_A_MEMBER } from "../src/coordinator/session";
import { CloudBoardConfig } from "../src/coordinator/types";
import { mapDescriptor } from "../src/services/map";
import { sqlDescriptor } from "../src/services/sql";
import { timerDescriptor } from "../src/services/timer";
import { LogEntry } from "../src/types";
import {
  attachBrowser,
  BrowserEnd,
  CoordinatorHost,
  deploy,
  eventually,
  fakeParticipants,
  openBridge,
  settle,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A deployed board other people can use.
 *
 * One owner, and a list of members kept by the coordinator. A member attaches
 * to the owner's board and is handed its facade — what the facade reads, and
 * the right to ask for what the facade asks for — and nothing else of the
 * board. Whatever a member does reaches the services carrying who did it.
 */

const OWNER: AuthenticatedUser = { sub: "auth0|owner", email: "owner@club.example" };
const ANNA: AuthenticatedUser = { sub: "auth0|anna", email: "anna@example.com" };
const BEN: AuthenticatedUser = { sub: "auth0|ben", email: "ben@example.com" };
/** Signed in, known to nobody's list. */
const MALLORY: AuthenticatedUser = { sub: "auth0|mallory", email: "mallory@example.com" };
/** Signed in with an address nobody verified, so with none. */
const UNVERIFIED: AuthenticatedUser = { sub: "auth0|unverified" };

const PEOPLE = [OWNER, ANNA, BEN, MALLORY, UNVERIFIED];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** Answers with the caller of the run it is called in. */
const whoami = (uuid: string) => ({
  serviceId: sqlDescriptor.serviceId,
  uuid,
  state: {
    mode: "query",
    statement:
      "SELECT $caller_sub AS sub, $caller_email AS email, $caller_name AS name",
  },
});

/**
 * A board with something to act on, something to read, and things the facade
 * does not mention at all.
 */
const BOARD: CloudBoardConfig = {
  boardName: "court",
  runtimes: [{ id: "node", name: "Node", type: "rest", url: "http://127.0.0.1:8080" }],
  services: {
    node: [
      whoami("book"),
      {
        serviceId: sqlDescriptor.serviceId,
        uuid: "admin",
        state: { mode: "query", statement: "SELECT 'secret' AS value" },
      },
      {
        serviceId: mapDescriptor.serviceId,
        uuid: "tail",
        state: { mode: "add", template: { apiKey: "hunter2" } },
      },
    ],
  },
  facade: {
    layout: "single",
    panels: [
      {
        id: "main",
        layout: {
          direction: "column",
          items: [
            {
              type: "button",
              label: "Book",
              actions: [
                {
                  type: "process",
                  serviceUuid: "book",
                  payload: { hour: 10, serviceUuid: "admin" },
                },
              ],
            },
            { type: "text", source: { serviceUuid: "book", path: "error" } },
            { type: "data-table", source: { serviceUuid: "book", path: "rows" } },
          ],
        },
      },
    ],
    notices: [{ source: { serviceUuid: "book", path: "error" } }],
  },
};

async function hostWith(
  options: {
    allowedEmails?: string[];
    coordinator?: BoardCoordinator;
    board?: CloudBoardConfig;
  } = {},
) {
  const host = await startCoordinator(
    options.coordinator ?? new BoardCoordinator(),
    0,
    { people: PEOPLE, allowedEmails: options.allowedEmails },
  );
  const runtime = await startRuntimeServer();
  cleanups.push(host.stop, () => runtime.server.stop());
  const board = options.board ?? BOARD;
  await deploy(host, OWNER.sub, board, { node: runtime.server });
  return { host, runtime, board };
}

async function attachAs(
  host: CoordinatorHost,
  person: AuthenticatedUser,
  boardName = BOARD.boardName,
): Promise<BrowserEnd> {
  const end = await openBridge(host, person.sub, OWNER.sub, boardName);
  cleanups.push(async () => end.socket.terminate());
  return end;
}

async function attached(
  host: CoordinatorHost,
  person: AuthenticatedUser,
): Promise<BrowserEnd> {
  const end = await attachAs(host, person);
  await eventually(() => !!end.last("snapshot"), "the board to be told");
  return end;
}

const asOwner = (call: request.Test) => call.set("Authorization", `Bearer ${OWNER.sub}`);
const members = (boardName = BOARD.boardName) =>
  `/coordinator/users/${encodeURIComponent(OWNER.sub)}/boards/${boardName}/members`;

describe("a board's member list", () => {
  it("is the owner's to keep: add, rename, remove", async () => {
    const { host } = await hostWith();
    const api = request(`http://127.0.0.1:${host.port}`);

    await asOwner(api.get(members())).expect(200, { members: [] });
    await asOwner(api.post(members()))
      .send({ email: " Anna@Example.com ", name: "Anna" })
      .expect(200, { members: [{ email: ANNA.email, name: "Anna" }] });
    // The same address again is the same person, renamed.
    await asOwner(api.post(members()))
      .send({ email: ANNA.email, name: "Anna K." })
      .expect(200, { members: [{ email: ANNA.email, name: "Anna K." }] });
    await asOwner(api.post(members()))
      .send({ email: BEN.email, name: "Ben" })
      .expect(200);

    await asOwner(api.delete(`${members()}/${encodeURIComponent(ANNA.email!)}`))
      .expect(200, { members: [{ email: BEN.email, name: "Ben" }] });
  });

  it("is not another person's to read or change", async () => {
    const { host } = await hostWith();
    const api = request(`http://127.0.0.1:${host.port}`);
    host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    const asAnna = (call: request.Test) =>
      call.set("Authorization", `Bearer ${ANNA.sub}`);
    // A member is on the list; the list is still not hers.
    await asAnna(api.get(members())).expect(403);
    await asAnna(api.post(members())).send({ email: BEN.email, name: "Ben" }).expect(403);
    await api.get(members()).expect(401);
  });

  it("takes only an address and a name", async () => {
    const { host } = await hostWith();
    const api = request(`http://127.0.0.1:${host.port}`);

    await asOwner(api.post(members())).send({ email: "not-an-address", name: "X" }).expect(400);
    await asOwner(api.post(members())).send({ email: ANNA.email }).expect(400);
    await asOwner(api.post(members())).send({ email: ANNA.email, name: "  " }).expect(400);
    await asOwner(api.post(members("no-such-board")))
      .send({ email: ANNA.email, name: "Anna" })
      .expect(404);

    expect(readMember({ email: "A@B.example", name: " A " })).toEqual({
      email: "a@b.example",
      name: "A",
    });
  });

  it("stops at the number of people a board may be shared with", async () => {
    const coordinator = new BoardCoordinator(undefined, undefined, undefined, {
      maxMembersPerBoard: 1,
    });
    const { host } = await hostWith({ coordinator });
    const api = request(`http://127.0.0.1:${host.port}`);

    await asOwner(api.post(members())).send({ email: ANNA.email, name: "Anna" }).expect(200);
    await asOwner(api.post(members())).send({ email: BEN.email, name: "Ben" }).expect(429);
    // Renaming somebody already on it is not one more.
    await asOwner(api.post(members())).send({ email: ANNA.email, name: "A." }).expect(200);
  });

  it("survives the board being deployed again, and a restart", async () => {
    const store = createMemoryBoardStore();
    const coordinator = new BoardCoordinator(store);
    const { host, runtime } = await hostWith({ coordinator });
    await coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    // Deployed again: a new session, the same board.
    await deploy(host, OWNER.sub, BOARD, { node: runtime.server });
    expect(coordinator.getMembers(OWNER.sub, BOARD.boardName)).toEqual([
      { email: ANNA.email, name: "Anna" },
    ]);

    // Restarted: what comes back is what the store held.
    const restarted = new BoardCoordinator(store);
    cleanups.push(async () => restarted.destroyAll());
    await restarted.restore();
    expect(restarted.getMembers(OWNER.sub, BOARD.boardName)).toEqual([
      { email: ANNA.email, name: "Anna" },
    ]);
  });

  /**
   * A store that finishes what it is asked when it is told to, in whatever
   * order: a file system gives no better promise about two writes begun
   * together.
   */
  function slowStore() {
    const kept = createMemoryBoardStore();
    const waiting: Array<() => void> = [];
    let hold = false;
    const held = <T,>(work: () => Promise<T>) =>
      hold
        ? new Promise<T>((resolve, reject) =>
            waiting.push(() => work().then(resolve, reject)),
          )
        : work();
    const store: BoardStore = {
      load: () => kept.load(),
      save: (board) => {
        // What is written is what was handed over, however long it then takes.
        const copy = structuredClone(board);
        return held(() => kept.save(copy));
      },
      remove: (userId, boardName) => held(() => kept.remove(userId, boardName)),
    };
    return {
      store,
      kept,
      holdWrites: () => {
        hold = true;
      },
      /** Lets what is waiting finish, last asked first. */
      async finishBackwards() {
        hold = false;
        while (waiting.length) {
          waiting.pop()!();
          await settle();
        }
      },
      waiting: () => waiting.length,
    };
  }

  const keptMembers = async (kept: BoardStore) =>
    (await kept.load()).find((b) => b.boardName === BOARD.boardName)?.members;

  it("keeps the list as it last was, whichever write the store finishes last", async () => {
    const slow = slowStore();
    const coordinator = new BoardCoordinator(slow.store);
    await hostWith({ coordinator });
    await coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    slow.holdWrites();
    // Two changes at once, as two requests arriving together are.
    const adding = coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: BEN.email!,
      name: "Ben",
    });
    const removing = coordinator.removeMember(OWNER.sub, BOARD.boardName, ANNA.email!);
    await settle();
    await slow.finishBackwards();
    await Promise.all([adding, removing]);

    // Somebody taken off the list is not back on it after a restart.
    expect(await keptMembers(slow.kept)).toEqual([{ email: BEN.email, name: "Ben" }]);
  });

  it("writes the board that is deployed, not one a slower request was holding", async () => {
    const slow = slowStore();
    const coordinator = new BoardCoordinator(slow.store);
    const { host, runtime } = await hostWith({ coordinator });
    const old = coordinator.getBoard(OWNER.sub, BOARD.boardName)!;
    // Stopping takes a while, and the board is deployed again meanwhile.
    const stop = old.stop.bind(old);
    let stopped!: () => void;
    old.stop = async () => {
      await new Promise<void>((resolve) => (stopped = resolve));
      await stop();
    };
    const stopping = coordinator.stopBoard(OWNER.sub, BOARD.boardName);
    const renamed = { ...BOARD, facade: { layout: "single", panels: [] } };
    await deploy(host, OWNER.sub, renamed, { node: runtime.server });
    stopped();
    await stopping;

    const kept = (await slow.kept.load()).find((b) => b.boardName === BOARD.boardName)!;
    expect(kept.config.facade).toEqual(renamed.facade);
    expect(kept.stopped).toBe(false);
  });

  it("is not brought back by a write still on its way when the board is deleted", async () => {
    const slow = slowStore();
    const coordinator = new BoardCoordinator(slow.store);
    await hostWith({ coordinator });

    slow.holdWrites();
    const adding = coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const removing = coordinator.removeBoard(OWNER.sub, BOARD.boardName);
    await settle();
    await slow.finishBackwards();
    await Promise.all([adding, removing]);

    expect(await slow.kept.load()).toEqual([]);
  });

  it("goes with the board", async () => {
    const { host } = await hostWith();
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    await host.coordinator.removeBoard(OWNER.sub, BOARD.boardName);

    expect(host.coordinator.getMembers(OWNER.sub, BOARD.boardName)).toEqual([]);
    expect(host.coordinator.getSharedBoards(ANNA.email)).toEqual([]);
  });
});

describe("who the server's allowlist gates", () => {
  it("lets a listed member find and attach to a board without being on it", async () => {
    // Only the owner may own anything on this server.
    const { host } = await hostWith({ allowedEmails: [OWNER.email!] });
    const api = request(`http://127.0.0.1:${host.port}`);
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    const { body } = await api
      .get("/coordinator/shared")
      .set("Authorization", `Bearer ${ANNA.sub}`)
      .expect(200);
    expect(body.boards).toEqual([
      { owner: OWNER.sub, boardName: "court", status: "running", name: "Anna" },
    ]);

    const anna = await attached(host, ANNA);
    expect(anna.last("snapshot")?.role).toBe("member");
  });

  it("still keeps everybody else out of everything else", async () => {
    const { host } = await hostWith({ allowedEmails: [OWNER.email!] });
    const api = request(`http://127.0.0.1:${host.port}`);
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const asAnna = (call: request.Test) =>
      call.set("Authorization", `Bearer ${ANNA.sub}`);

    // Being on a board's list is permission to use that board, and no more.
    await asAnna(api.get("/runtimes")).expect(401);
    await asAnna(api.post("/runtimes")).send({ id: "x", name: "X", services: [] }).expect(401);
    await asAnna(
      api.get(`/coordinator/users/${encodeURIComponent(ANNA.sub)}/boards`),
    ).expect(401);
    await asAnna(
      api.post(`/coordinator/users/${encodeURIComponent(ANNA.sub)}/boards`),
    )
      .send(BOARD)
      .expect(401);
    // And the one open route still wants to know who is asking.
    await api.get("/coordinator/shared").expect(401);
    await asAnna(api.post("/coordinator/shared")).expect(401);
  });

  it("shows somebody nobody listed an empty list", async () => {
    const { host } = await hostWith();
    const api = request(`http://127.0.0.1:${host.port}`);
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    for (const person of [MALLORY, UNVERIFIED]) {
      await api
        .get("/coordinator/shared")
        .set("Authorization", `Bearer ${person.sub}`)
        .expect(200, { boards: [] });
    }
  });
});

describe("attaching to a board", () => {
  it("admits the owner as its owner, and gives them the board", async () => {
    const { host } = await hostWith();

    const owner = await attached(host, OWNER);

    const snapshot = owner.last("snapshot")!;
    expect(snapshot.role).toBe("owner");
    expect(snapshot.config).toEqual(BOARD);
    expect(snapshot.you).toEqual({ email: OWNER.email });
  });

  it("closes on somebody the board is not shared with, as on a board that is not there", async () => {
    const { host } = await hostWith();
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    const stranger = await attachAs(host, MALLORY);
    const nowhere = await attachAs(host, MALLORY, "no-such-board");
    const unverified = await attachAs(host, UNVERIFIED);

    const codes = await Promise.all([
      stranger.closed,
      nowhere.closed,
      unverified.closed,
    ]);
    // The same answer three times, and nothing sent before it. An answer,
    // not a connection going away: whoever asked is to stop asking, which a
    // close without a code would not tell them apart from a restart.
    expect(codes).toEqual([
      CLOSE_NO_SUCH_BOARD,
      CLOSE_NO_SUCH_BOARD,
      CLOSE_NO_SUCH_BOARD,
    ]);
    expect(stranger.received).toEqual([]);
    expect(unverified.received).toEqual([]);
  });

  it("does not make an owner of somebody naming their own id", async () => {
    const { host } = await hostWith();

    // Mallory's own tenant has no such board; naming the owner's does not
    // make her its owner.
    const own = await openBridge(host, MALLORY.sub, MALLORY.sub, BOARD.boardName);
    cleanups.push(async () => own.socket.terminate());

    expect(await own.closed).toBe(CLOSE_NO_SUCH_BOARD);
    expect(own.received).toEqual([]);
  });

  it("refuses a bridge with no token at all", async () => {
    const { host } = await hostWith();

    await expect(
      openBridge(host, null, OWNER.sub, BOARD.boardName),
    ).rejects.toThrow(/401/);
  });

  it("bounds how many bridges one member holds", async () => {
    const coordinator = new BoardCoordinator(undefined, undefined, undefined, {
      maxBridgesPerMember: 1,
    });
    const { host } = await hostWith({ coordinator });
    await coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });

    const first = await attached(host, ANNA);
    const second = await attachAs(host, ANNA);

    // Told why, and not as a board that is not there: it is shared with her.
    expect(await second.closed).toBe(CLOSE_TOO_MANY_BRIDGES);
    expect(second.received).toEqual([]);
    expect(first.socket.readyState).toBe(first.socket.OPEN);
  });
});

describe("what a member is sent", () => {
  async function shared() {
    const made = await hostWith();
    await made.host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    await made.host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: BEN.email!,
      name: "Ben",
    });
    return made;
  }

  it("is the facade and what it names, not the board", async () => {
    const { host } = await shared();

    const anna = await attached(host, ANNA);

    const snapshot = anna.last("snapshot")!;
    expect(snapshot.role).toBe("member");
    expect(snapshot.you).toEqual({ email: ANNA.email, name: "Anna" });
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.config).toEqual({
      boardName: "court",
      // No address, no settings: there is nothing underneath to dial.
      runtimes: [{ id: "node", name: "Node", type: "rest" }],
      services: {
        node: [
          // What it is, and of its state only what the facade reads.
          { uuid: "book", serviceId: "sql", serviceName: "sql", state: { error: "" } },
        ],
      },
      facade: BOARD.facade,
    });
    expect(snapshot.runtimes).toEqual([
      { runtimeId: "node", registry: [], services: { book: { error: "" } } },
    ]);
    // Nothing of the board the facade does not mention, anywhere in it.
    const wire = JSON.stringify(anna.received);
    expect(wire).not.toContain("SELECT");
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("hunter2");
    expect(wire).not.toContain("tail");
    expect(wire).not.toContain("127.0.0.1");
  });

  it("is never the board's log", async () => {
    const board = {
      ...BOARD,
      runtimes: [{ ...BOARD.runtimes[0], state: { logging: true, logLevel: "debug" } }],
    };
    const { host } = await hostWith({ board });
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const owner = await attached(host, OWNER);
    const anna = await attached(host, ANNA);

    await anna.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "node",
      serviceUuid: "book",
      payload: {},
    });

    await eventually(() => owner.all("log").length > 0, "the owner to see the log");
    expect(anna.all("log")).toEqual([]);
    // And the owner's log says who it was, by `sub` alone.
    const entry = owner.all("log")[0].entry as LogEntry;
    expect(entry.caller).toBe(ANNA.sub);
    expect(JSON.stringify(owner.all("log"))).not.toContain(ANNA.email);
  });
});

describe("what a member may send", () => {
  async function shared() {
    const made = await hostWith();
    for (const [person, name] of [
      [ANNA, "Anna"],
      [BEN, "Ben"],
    ] as const) {
      await made.host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
        email: person.email!,
        name,
      });
    }
    return made;
  }

  const rowsOf = (end: BrowserEnd, uuid = "book") =>
    end
      .all("notification")
      .filter((n) => n.serviceUuid === uuid)
      .map((n) => (n.payload as { rows?: unknown[] }).rows)
      .filter((rows) => Array.isArray(rows));

  it("is a process call at a service the facade asks to process, as themselves", async () => {
    const { host } = await shared();
    const anna = await attached(host, ANNA);

    const answer = await anna.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "node",
      serviceUuid: "book",
      // What a custom client might try: none of it names the caller.
      payload: {
        caller_email: BEN.email,
        caller_sub: BEN.sub,
        __context: {
          actor: {
            kind: "person",
            sub: BEN.sub,
            email: BEN.email,
            expiresAt: Date.now() + 60_000,
          },
        },
      },
    });

    expect(answer.data).toEqual({ accepted: true });
    await eventually(() => rowsOf(anna).length > 0, "the answer");
    expect(rowsOf(anna)[0]).toEqual([
      { sub: ANNA.sub, email: ANNA.email, name: "Anna" },
    ]);
  });

  it("is not a process call anywhere else, whatever runtime it names", async () => {
    const { host } = await shared();
    const anna = await attached(host, ANNA);

    for (const serviceUuid of ["admin", "tail", "nobody"]) {
      const answer = await anna.ask({
        type: "processService",
        requestId: `p-${serviceUuid}`,
        runtimeId: "node",
        serviceUuid,
        payload: {},
      });
      expect(answer.error).toBe("This board does not offer that");
    }
  });

  it("is never a configure", async () => {
    const { host, runtime } = await shared();
    const anna = await attached(host, ANNA);

    const answer = await anna.ask({
      type: "configureService",
      requestId: "c-1",
      runtimeId: "node",
      serviceUuid: "book",
      config: { statement: "SELECT 'rewritten' AS sub" },
    });

    expect(answer.error).toBe("Only the board's owner may configure it");
    const [held] = runtime.server.runtimeApp.getBoardRuntimes("anonymous");
    expect(held.getService("book")?.getState().statement).toContain("$caller_sub");
  });

  it("is bounded in how often", async () => {
    const coordinator = new BoardCoordinator(undefined, undefined, undefined, {
      maxMemberProcessPerMinute: 2,
    });
    const { host } = await hostWith({ coordinator });
    await coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const anna = await attached(host, ANNA);
    const call = (requestId: string) =>
      anna.ask({
        type: "processService",
        requestId,
        runtimeId: "node",
        serviceUuid: "book",
        payload: {},
      });

    expect((await call("p-1")).error).toBeUndefined();
    expect((await call("p-2")).error).toBeUndefined();
    expect((await call("p-3")).error).toMatch(/Too many requests/);
  });

  it("produces news for the one who acted, and for nobody else", async () => {
    const { host } = await shared();
    const owner = await attached(host, OWNER);
    const anna = await attached(host, ANNA);
    const ben = await attached(host, BEN);

    await anna.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "node",
      serviceUuid: "book",
      payload: {},
    });
    await eventually(() => rowsOf(anna).length > 0, "Anna's answer");
    await settle();

    // Not another member's to read, and not the owner's to watch.
    expect(ben.all("notification")).toEqual([]);
    expect(owner.all("notification")).toEqual([]);
    // And of her own run, only what the facade reads: the flow through the
    // services it does not mention never reaches her.
    expect(anna.all("notification").every((n) => n.serviceUuid === "book")).toBe(true);
    expect(JSON.stringify(anna.all("notification"))).not.toContain("__internal");
  });
});

describe("a member's bridge and the board's runtimes", () => {
  const CHAIN: CloudBoardConfig = {
    boardName: "chain",
    runtimes: [
      { id: "a", name: "A", type: "rest" },
      { id: "ui", name: "Browser", type: "browser" },
      { id: "b", name: "B", type: "rest" },
    ],
    services: {
      a: [{ uuid: "tick", serviceId: timerDescriptor.serviceId }],
      ui: [],
      b: [],
    },
    facade: {
      layout: "single",
      panels: [
        {
          id: "main",
          layout: { type: "text", source: { serviceUuid: "tick" } },
        },
      ],
    },
  };

  async function chain() {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const session = new BoardSession("chain", OWNER.sub, CHAIN, fakes.participants);
    cleanups.push(() => session.destroy());
    await session.start();
    const attach = async (...args: Parameters<typeof attachBrowser> extends [unknown, ...infer R] ? R : never) => {
      const end = await attachBrowser(session, ...args);
      cleanups.push(end.stop);
      return end;
    };
    return { session, a, b, attach };
  }

  const member = (person: AuthenticatedUser, name: string) => ({
    role: "member" as const,
    caller: { sub: person.sub, email: person.email!, name },
  });

  it("is never asked to run a browser runtime", async () => {
    const { a, b, attach } = await chain();
    // Says it hosts the runtime; a member's bridge hosts none.
    const anna = await attach(["ui"], member(ANNA, "Anna"));

    a.emit({ type: "result", data: { n: 1 } });
    await settle();

    expect(anna.all("processRuntime")).toEqual([]);
    // With only a member attached the browser runtime is away, and the data
    // stops there rather than waiting on an answer nobody may give.
    expect(b.processed).toEqual([]);
  });

  it("does not answer for one either", async () => {
    const { a, b, attach } = await chain();
    const owner = await attach(["ui"], { role: "owner" });
    const anna = await attach([], member(ANNA, "Anna"));

    a.emit({ type: "result", data: { n: 1 } });
    await eventually(() => !!owner.last("processRuntime"), "the owner to be asked");
    const { requestId } = owner.last("processRuntime")!;
    anna.send({ type: "result", requestId: requestId!, data: { forged: true } });
    anna.send({ type: "result-from-browser", runtimeId: "ui", data: { forged: true } });
    await settle();
    expect(b.processed).toEqual([]);

    owner.send({ type: "result", requestId: requestId!, data: { n: 2 } });
    await eventually(() => b.processed.length > 0, "the next runtime to run");
    expect(b.processed).toEqual([{ n: 2 }]);
  });

  it("hears what the board says by itself, where the facade reads it", async () => {
    const { a, attach } = await chain();
    const owner = await attach([], { role: "owner" });
    const anna = await attach([], member(ANNA, "Anna"));

    // No caller: a timer's tick is nobody's run.
    a.emit({ type: "notification", serviceUuid: "tick", payload: { at: 1 } });
    a.emit({
      type: "notification",
      serviceUuid: "tick",
      payload: { __internal: { state: "call-process", data: { private: true } } },
    });
    a.emit({ type: "notification", serviceUuid: "elsewhere", payload: { at: 2 } });
    await eventually(() => owner.all("notification").length === 3, "the owner to hear all of it");

    expect(anna.all("notification").map((n) => n.payload)).toEqual([{ at: 1 }]);
  });

  it("drops a person's late result after membership is revoked", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    let allowed = true;
    const session = new BoardSession(
      "chain",
      OWNER.sub,
      CHAIN,
      fakes.participants,
      undefined,
      undefined,
      {},
      () => allowed,
    );
    cleanups.push(() => session.destroy());
    await session.start();
    allowed = false;

    a.emit({
      type: "result",
      data: { private: true },
      context: {
        runId: "late",
        actor: {
          kind: "person",
          sub: ANNA.sub,
          email: ANNA.email,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await settle();

    expect(b.processed).toEqual([]);
  });

  it("drops an expired person's notification", async () => {
    const { a, attach } = await chain();
    const anna = await attach([], member(ANNA, "Anna"));
    a.emit({
      type: "notification",
      serviceUuid: "tick",
      payload: { private: true },
      context: {
        runId: "expired",
        actor: {
          kind: "person",
          sub: ANNA.sub,
          email: ANNA.email,
          name: "Anna",
          expiresAt: Date.now() - 1,
        },
      },
    });
    await settle();
    expect(anna.all("notification")).toEqual([]);
  });

  it("hears of what a service says only what the facade reads of it", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const reading = (source: object): CloudBoardConfig => ({
      ...CHAIN,
      facade: {
        layout: "single",
        panels: [
          {
            id: "main",
            layout: {
              direction: "column",
              items: [
                { type: "data-table", source },
                { type: "text", source: { serviceUuid: "tick", path: "error" } },
              ],
            },
          },
        ],
      },
    });
    const session = new BoardSession(
      "chain",
      OWNER.sub,
      reading({ serviceUuid: "tick", path: "rows" }),
      fakes.participants,
    );
    cleanups.push(() => session.destroy());
    await session.start();
    const owner = await attachBrowser(session, [], { role: "owner" });
    const anna = await attachBrowser(session, [], member(ANNA, "Anna"));
    cleanups.push(owner.stop, anna.stop);

    const said = { rows: [{ court: 1 }], secret: "hunter2", count: 1 };
    a.emit({ type: "notification", serviceUuid: "tick", payload: said });
    // Nothing the facade reads is in these. They reveal neither their payload
    // nor that the service spoke, and cannot accidentally look like a clear.
    a.emit({ type: "notification", serviceUuid: "tick", payload: { secret: "hunter2" } });
    a.emit({ type: "notification", serviceUuid: "tick", payload: "hunter2" });
    // A clear is explicit and does pass the projection.
    a.emit({ type: "notification", serviceUuid: "tick", payload: { rows: [] } });
    await eventually(() => owner.all("notification").length === 4, "the owner to hear all of it");
    await eventually(() => anna.all("notification").length === 2, "the member to hear what it reads");

    expect(owner.all("notification")[0].payload).toEqual(said);
    expect(anna.all("notification").map((n) => n.payload)).toEqual([
      { rows: [{ court: 1 }] },
      { rows: [] },
    ]);
  });

  it("is told a service's state only where the facade names it, in its own sequence", async () => {
    const { a, attach } = await chain();
    const owner = await attach([], { role: "owner" });
    const anna = await attach([], member(ANNA, "Anna"));
    const mount = (uuid: string, url: string) =>
      a.emit({ type: "notification", serviceUuid: uuid, payload: { __hkpMount: url } });

    mount("elsewhere", "http://x/hosted/1");
    mount("tick", "http://x/hosted/2");
    await eventually(() => owner.all("serviceState").length === 2, "the owner to be told both");
    await eventually(() => anna.all("serviceState").length === 1, "the member to be told one");

    const told = anna.all("serviceState")[0];
    expect(told.serviceUuid).toBe("tick");
    // The facade reads no path of its state, so none of it is given.
    expect(told.state).toEqual({});
    // Consecutive from her own snapshot, though she was sent one increment
    // where the owner was sent two.
    expect(told.seq).toBe(anna.last("snapshot")!.seq + 1);
  });
});

describe("leaving a board", () => {
  it("closes a member's bridges at once when they are taken off the list", async () => {
    const { host } = await hostWith();
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const owner = await attached(host, OWNER);
    const anna = await attached(host, ANNA);

    await host.coordinator.removeMember(OWNER.sub, BOARD.boardName, ANNA.email!);

    expect(await anna.closed).toBe(CLOSE_NOT_A_MEMBER);
    expect(owner.socket.readyState).toBe(owner.socket.OPEN);
    // And they are not let back in.
    const again = await attachAs(host, ANNA);
    await again.closed;
    expect(again.received).toEqual([]);
  });

  it("asks the list again when the board is deployed again", async () => {
    const { host, runtime } = await hostWith();
    for (const person of [ANNA, BEN]) {
      await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
        email: person.email!,
        name: person.sub,
      });
    }
    const anna = await attached(host, ANNA);
    const ben = await attached(host, BEN);
    const before = anna.all("snapshot").length;

    await deploy(host, OWNER.sub, BOARD, { node: runtime.server });

    // Carried over to the new session without a disconnect, still a member.
    await eventually(() => anna.all("snapshot").length > before, "the board again");
    expect(anna.last("snapshot")?.role).toBe("member");
    expect(ben.socket.readyState).toBe(ben.socket.OPEN);
  });

  it("tells somebody attached what the list now calls them", async () => {
    const { host } = await hostWith();
    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna",
    });
    const anna = await attached(host, ANNA);

    await host.coordinator.setMember(OWNER.sub, BOARD.boardName, {
      email: ANNA.email!,
      name: "Anna K.",
    });

    await eventually(
      () => anna.last("snapshot")?.you?.name === "Anna K.",
      "the new name",
    );
    await anna.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "node",
      serviceUuid: "book",
      payload: {},
    });
    await eventually(
      () => anna.all("notification").some((n) => "rows" in (n.payload as object)),
      "the answer",
    );
    const rows = anna
      .all("notification")
      .map((n) => (n.payload as { rows?: Array<{ name: string }> }).rows)
      .find((r) => Array.isArray(r));
    expect(rows?.[0].name).toBe("Anna K.");
  });
});

describe("reading a facade for what it grants", () => {
  const access = readFacadeAccess({
    layout: "columns",
    init: [{ type: "process", serviceUuid: "load", payload: {} }],
    panels: [
      {
        id: "p",
        layout: {
          direction: "column",
          collapsible: true,
          summary: { serviceUuid: "counter", path: "count" },
          items: [
            {
              type: "repeat",
              source: { serviceUuid: "list", path: "rows" },
              template: {
                type: "button",
                label: "{{item.name}}",
                indicator: { source: { serviceUuid: "status" } },
                actions: [
                  { type: "confirm", question: "Sure?" },
                  { type: "process", serviceUuid: "pick", payload: { serviceUuid: "smuggled" } },
                  { type: "process", serviceUuid: "{{item.target}}" },
                  { type: "configure", serviceUuid: "knobbed", configure: { serviceUuid: "inner" } },
                ],
              },
            },
            { type: "canvas", serviceUuid: "drawing" },
            { type: "file-pick", action: { serviceUuid: "upload" }, progressServiceUuid: "progress" },
            {
              type: "data-table",
              source: { serviceUuid: "list", path: "meta.total" },
              cellActions: [{ type: "process", serviceUuid: "edit", payload: "$$input" }],
            },
          ],
        },
      },
    ],
    notices: [{ source: { serviceUuid: "pick", path: "error" } }],
  });

  it("finds the services a process action names, and no payload's", () => {
    expect([...access.processTargets].sort()).toEqual(["edit", "load", "pick"]);
  });

  it("finds what is read, with the paths", () => {
    expect(Object.fromEntries(
      [...access.sources].map(([uuid, paths]) => [uuid, [...paths].sort()]),
    )).toEqual({
      counter: ["count"],
      list: ["meta.total", "rows"],
      status: [""],
      pick: ["error"],
    });
  });

  it("names every service the facade refers to", () => {
    expect([...access.named].sort()).toEqual([
      "counter",
      "drawing",
      "edit",
      "knobbed",
      "list",
      "load",
      "pick",
      "progress",
      "status",
      "upload",
    ]);
  });

  it("gives of a state only the paths read", () => {
    const state = {
      rows: [1, 2],
      meta: { total: 2, cursor: "c" },
      statement: "SELECT",
    };
    expect(projectState(access, "list", state)).toEqual({
      rows: [1, 2],
      meta: { total: 2 },
    });
    // Read whole as a notification, which is not its state.
    expect(projectState(access, "status", { secret: 1 })).toEqual({});
    expect(projectState(access, "upload", { secret: 1 })).toEqual({});
  });

  it("gives of a notification only the paths read, and all of it to a source reading it whole", () => {
    const said = {
      rows: [1, 2],
      meta: { total: 2, cursor: "c" },
      statement: "SELECT",
    };
    const given = projectNotification(access, "list", said);
    expect(given).toEqual({ rows: [1, 2], meta: { total: 2 } });
    // What was said is not what is cut down.
    expect(said.meta).toEqual({ total: 2, cursor: "c" });

    expect(projectNotification(access, "status", { secret: 1 })).toEqual({ secret: 1 });
    expect(projectNotification(access, "status", "text")).toBe("text");
    // Named by the facade, read by none of its sources, or carrying none of
    // the paths read: no observable notification is produced.
    expect(projectNotification(access, "upload", { secret: 1 })).toBeUndefined();
    expect(projectNotification(access, "list", "text")).toBeUndefined();
    expect(projectNotification(access, "list", null)).toBeUndefined();
    // Clearing something the facade actually reads remains observable.
    expect(projectNotification(access, "list", { rows: [] })).toEqual({ rows: [] });
  });

  it("leaves a browser runtime's services with the owner", () => {
    const projected = projectConfig(
      {
        boardName: "b",
        runtimes: [
          { id: "ui", name: "Browser", type: "browser" },
          { id: "node", name: "Node", type: "rest", url: "http://x" },
        ],
        services: {
          ui: [{ uuid: "drawing", serviceId: "canvas" }],
          node: [
            { uuid: "list", serviceId: "sql", state: { rows: [], statement: "S" } },
            { uuid: "unnamed", serviceId: "sql" },
          ],
        },
      },
      access,
      () => undefined,
    );
    expect(projected.runtimes).toEqual([{ id: "node", name: "Node", type: "rest" }]);
    expect(projected.services).toEqual({
      node: [{ uuid: "list", serviceId: "sql", serviceName: "sql", state: {} }],
    });
  });
});
