import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  projectNotification,
  readFacadeAccess,
} from "../src/coordinator/facadeAccess";
import { HostedRuntime } from "../src/runtime";
import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { Caller, LogEntry, ServiceConfiguration } from "../src/types";

/**
 * The court-booking board's own statements, run by more than one person.
 *
 * Deployed and shared with a club, the board is one database that several
 * people act on, and its facade's entry point is callable by a member with any
 * payload at all. So what is pinned here is that the statements decide who is
 * acting from the run's caller — the person the server verified — and hold the
 * club's rules whatever the payload claims.
 *
 * The statements are read out of the board rather than repeated here — a copy
 * would pass while the board was broken.
 */

const BOARD = path.join(__dirname, "../../boards/court-booking-demo-board.json");

const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as {
  services: { club: ServiceConfiguration[] };
  facade: unknown;
};

const ANNA: Caller = { sub: "auth0|anna", email: "anna@example.com", name: "Anna" };
const BEN: Caller = { sub: "auth0|ben", email: "ben@example.com", name: "Ben" };
/** On the list under an address, but called nothing by it. */
const NAMELESS: Caller = { sub: "auth0|cleo", email: "cleo@example.com" };
/** Signed in, and without an address anybody verified. */
const UNVERIFIED: Caller = { sub: "auth0|dan" };

type Cell = {
  column: number;
  hour: number;
  state: string;
  label: string;
  prompt: string;
  day: string;
  dayOffset: number;
  notice: string;
};

/** The board's runtime on one in-memory database, as its coordinator runs it. */
function club() {
  const databases = createMemoryDatabaseStore();
  const runtime = new HostedRuntime(
    { id: "club", name: "Club", boardName: "Court Booking", services: board.services.club },
    (config) => new SqlService(config, databases),
    undefined,
    "auth0|owner",
  );

  /**
   * What a tap on the facade does: begin at `give-back` with a payload, as
   * `caller`. Answers with the day the pipeline ends on.
   */
  const act = async (
    caller: Caller | undefined,
    payload: Record<string, unknown>,
  ): Promise<Cell[]> => {
    const result = (await runtime.processAt(
      "give-back",
      { state: "none", dayOffset: 0, ...payload },
      () => {},
      {
        runId: "run",
        actor: caller
          ? {
              kind: "person" as const,
              ...caller,
              expiresAt: Date.now() + 60_000,
            }
          : { kind: "local" as const },
      },
    )) as { rows: Cell[] };
    return result.rows;
  };

  const cell = (rows: Cell[], column: number, hour: number) =>
    rows.find((row) => row.column === column && row.hour === hour)!;

  return { act, cell };
}

const book = (court: number, hour: number, more: Record<string, unknown> = {}) => ({
  state: "free",
  court,
  hour,
  ...more,
});

describe("the court-booking board, shared", () => {
  it("lets the facade begin only where its statements take over", () => {
    // The capability a member is given: every tap enters here and nowhere
    // else, so everything that matters is checked by what follows it.
    expect([...readFacadeAccess(board.facade).processTargets]).toEqual([
      "give-back",
    ]);
  });

  it("draws the day from each person's own side", async () => {
    const { act, cell } = club();

    const annas = await act(ANNA, book(1, 10));
    const bens = await act(BEN, {});

    expect(cell(annas, 1, 10)).toMatchObject({ state: "mine", label: "You" });
    // Ben sees it taken, by the name the club gave her.
    expect(cell(bens, 1, 10)).toMatchObject({ state: "taken", label: "Anna" });
    // And still has his own hour to take.
    expect(cell(bens, 2, 10).state).toBe("free");
    // Hers is spent for the day.
    expect(cell(annas, 2, 10).state).toBe("blocked");
  });

  it("never shows one member another's address", async () => {
    const { act } = club();
    await act(ANNA, book(1, 10));
    await act(NAMELESS, book(2, 11));

    const bens = await act(BEN, {});

    expect(JSON.stringify(bens)).not.toContain("@");
    // Somebody the list gave no name is a member, not an address.
    expect(bens.find((c) => c.column === 2 && c.hour === 11)?.label).toBe("Member");
  });

  it("books in the caller's name, whoever the payload says it is", async () => {
    const { act, cell } = club();

    // Ben, claiming to be Anna every way a payload can.
    await act(
      BEN,
      book(1, 10, {
        member: ANNA.email,
        caller_email: ANNA.email,
        caller_sub: ANNA.sub,
        caller_name: "Anna",
      }),
    );

    expect(cell(await act(BEN, {}), 1, 10)).toMatchObject({ state: "mine" });
    expect(cell(await act(ANNA, {}), 1, 10)).toMatchObject({
      state: "taken",
      label: "Ben",
    });
    // Anna's hour for the day is still hers to take.
    expect(cell(await act(ANNA, {}), 2, 10).state).toBe("free");
  });

  it("gives back only the caller's own hour", async () => {
    const { act, cell } = club();
    await act(ANNA, book(1, 10));

    // Ben says the hour is his, and says he is Anna.
    await act(BEN, { state: "mine", court: 1, hour: 10, member: ANNA.email });
    expect(cell(await act(ANNA, {}), 1, 10).state).toBe("mine");

    await act(ANNA, { state: "mine", court: 1, hour: 10 });
    expect(cell(await act(ANNA, {}), 1, 10).state).toBe("free");
  });

  it("holds one hour a day per member, and one member per hour", async () => {
    const { act, cell } = club();
    await act(ANNA, book(1, 10));

    // A second hour the same day, with the state the facade would not send.
    await act(ANNA, book(2, 12));
    expect(cell(await act(ANNA, {}), 2, 12).state).toBe("blocked");

    // The hour that is taken.
    await act(BEN, book(1, 10));
    expect(cell(await act(BEN, {}), 1, 10)).toMatchObject({ state: "taken" });

    // Another day is another hour.
    const tomorrow = await act(ANNA, book(1, 10, { dayOffset: 1 }));
    expect(cell(tomorrow, 1, 10).state).toBe("mine");
  });

  it("books nothing outside the club's courts, hours and week", async () => {
    const { act } = club();

    for (const request of [
      book(9, 10),
      book(1, 6),
      book(1, 22),
      book(1, 10.5),
      book(1.5, 10),
      book(1, 10, { dayOffset: 8 }),
      book(1, 10, { dayOffset: -1 }),
      book(1, 10, { dayOffset: 0.5 }),
      book(1, 10, { dayOffset: "0" }),
      { state: "free", hour: 10 },
    ]) {
      await act(ANNA, request);
    }

    for (const dayOffset of [0, 1, 7]) {
      const day = await act(ANNA, { dayOffset });
      expect(day.filter((c) => c.state === "mine")).toEqual([]);
      expect(day).toHaveLength(45);
    }
  });

  it("shows only the week the club books, whatever day is asked for", async () => {
    const { act } = club();

    expect((await act(ANNA, { dayOffset: 400 }))[0].dayOffset).toBe(7);
    expect((await act(ANNA, { dayOffset: -400 }))[0].dayOffset).toBe(0);
  });

  it("books nothing for somebody signed in without a verified address", async () => {
    const { act } = club();

    // Not a fallback to what the payload claims: that would let anybody who
    // can sign in book as anybody.
    const day = await act(UNVERIFIED, book(1, 10, { member: ANNA.email }));

    expect(day.every((c) => c.state === "blocked")).toBe(true);
    expect((await act(ANNA, {})).find((c) => c.column === 1 && c.hour === 10)?.state)
      .toBe("free");
  });
});

describe("what a member is sent", () => {
  it("keeps the day a list when the facade also reads into it", async () => {
    // The calendar reads `rows`, the line above it `rows.0.day` and the
    // notice `rows.0.notice`: a member's copy must still be the rows, or
    // their calendar draws nothing.
    const { act } = club();
    const rows = await act(ANNA, book(1, 10));
    const access = readFacadeAccess(board.facade);

    const given = projectNotification(access, "day-grid", { rows, count: rows.length }) as {
      rows: Cell[];
    };

    expect(Array.isArray(given.rows)).toBe(true);
    expect(given.rows).toEqual(rows);
    expect(given).not.toHaveProperty("count");
  });
});

describe("what the board's log keeps of a booking", () => {
  it("says what each statement did, who began it, and nothing of what was sent", async () => {
    const databases = createMemoryDatabaseStore();
    const runtime = new HostedRuntime(
      {
        id: "club",
        name: "Club",
        boardName: "Court Booking",
        logging: true,
        services: board.services.club,
      },
      (config) => new SqlService(config, databases),
      undefined,
      "auth0|owner",
    );
    const entries: LogEntry[] = [];
    runtime.registerLogTarget((entry) => entries.push(entry));

    await runtime.processAt("give-back", book(2, 18, { dayOffset: 1 }), () => {}, {
      runId: "run-ana",
      actor: { kind: "person", ...ANNA, expiresAt: Date.now() + 60_000 },
    });

    const said = entries.filter((e) => e.event.startsWith("sql."));
    expect(said.map((e) => [e.serviceUuid, e.event, e.data])).toEqual([
      ["give-back", "sql.run", { changes: 0 }],
      ["take-hour", "sql.run", { changes: 1 }],
      ["day-grid", "sql.query", { count: 45 }],
    ]);
    expect(said.every((e) => e.caller === ANNA.sub && e.runId === "run-ana")).toBe(true);
    // Counts, never the parameters: no court, no hour, no address.
    expect(JSON.stringify(said)).not.toContain(ANNA.email);
    expect(JSON.stringify(said)).not.toContain("18");
  });
});

describe("telling the person who tapped", () => {
  it("lets exactly one of two people take the same hour, and tells the other", async () => {
    const { act, cell } = club();

    // Both saw the hour free and tapped at the same moment.
    const [annas, bens] = await Promise.all([
      act(ANNA, book(2, 18)),
      act(BEN, book(2, 18)),
    ]);

    const winner = cell(annas, 2, 18).state === "mine" ? annas : bens;
    const loser = winner === annas ? bens : annas;
    expect(cell(winner, 2, 18).state).toBe("mine");
    expect(cell(loser, 2, 18).state).toBe("taken");
    expect(winner[0].notice).toBe("");
    expect(loser[0].notice).toBe("Court 2 at 18:00 was just taken by someone else.");
    // The same answer on every row, so a notice can read it from the first.
    expect(new Set(loser.map((c) => c.notice)).size).toBe(1);
  });

  it("says why a second hour the same day was not booked", async () => {
    const { act } = club();
    const today = await act(ANNA, book(1, 10));

    const second = await act(ANNA, book(2, 12));

    expect(second[0].notice).toBe(`You already hold an hour on ${today[0].day}.`);
  });

  it("stays quiet unless a take did not land", async () => {
    const { act } = club();

    expect((await act(ANNA, book(1, 10)))[0].notice).toBe("");
    expect((await act(ANNA, { dayOffset: 1 }))[0].notice).toBe("");
    expect((await act(ANNA, { state: "mine", court: 1, hour: 10 }))[0].notice).toBe("");
  });

  it("is what the facade raises as a notice", () => {
    const notices = (board.facade as { notices: { source: { serviceUuid: string; path: string } }[] })
      .notices.map((n) => n.source);
    expect(notices).toContainEqual({ serviceUuid: "day-grid", path: "rows.0.notice" });
  });
});

describe("the court-booking board with nobody signed in", () => {
  it("offers nothing even when the payload names a member", async () => {
    const { act } = club();

    const day = await act(
      undefined,
      book(1, 10, { member: "you@club.example" }),
    );

    expect(day.every((c) => c.state === "blocked")).toBe(true);
  });
});
