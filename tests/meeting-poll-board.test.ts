import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readFacadeAccess } from "../src/coordinator/facadeAccess";
import { HostedRuntime } from "../src/runtime";
import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { Caller, RuntimeNotification, ServiceConfiguration } from "../src/types";

/**
 * The meeting poll's own statements, run by the people it is shared with.
 *
 * Deployed, the board is one database that its owner and every member act on,
 * and its facade's entry point is callable by a member with any payload at
 * all. So what is pinned here is that the statements decide who is answering
 * from the run's caller, and who may organise from the role the server states
 * for them — whatever the payload claims about either.
 *
 * The statements are read out of the board rather than repeated here — a copy
 * would pass while the board was broken.
 */

const BOARD = path.join(__dirname, "../../boards/meeting-poll-demo-board.json");

const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as {
  services: { office: ServiceConfiguration[] };
  facade: unknown;
};

const OWNER: Caller = { sub: "auth0|owner", email: "owner@team.example", role: "owner" };
const ANNA: Caller = {
  sub: "auth0|anna",
  email: "anna@example.com",
  name: "Anna",
  role: "member",
};
const BEN: Caller = { sub: "auth0|ben", email: "ben@example.com", name: "Ben", role: "member" };
/** On the list under an address, but called nothing by it. */
const NAMELESS: Caller = { sub: "auth0|cleo", email: "cleo@example.com", role: "member" };

type Said = Record<string, any>;

/** The board's runtime on one in-memory database, as its coordinator runs it. */
function office() {
  const databases = createMemoryDatabaseStore();
  const runtime = new HostedRuntime(
    { id: "office", name: "Office", boardName: "Meeting Poll", services: board.services.office },
    (config) => new SqlService(config, databases),
    undefined,
    OWNER.sub,
  );

  /**
   * What a tap on the facade does: begin at the head with a payload, as
   * `caller`. Answers with what each service said, by uuid.
   */
  const act = async (
    caller: Caller | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<Said> => {
    const said: Said = {};
    await runtime.processAt(
      "who-is-here",
      { intent: "none", poll: "", ...payload },
      (notification: RuntimeNotification) => {
        const payload = notification.payload as Record<string, unknown>;
        // The runtime's own account of its flow, not anything a service said.
        if (!("__internal" in payload)) {
          said[notification.instanceId] = payload;
        }
      },
      {
        runId: "run",
        actor: caller
          ? { kind: "person" as const, ...caller, expiresAt: Date.now() + 60_000 }
          : { kind: "local" as const },
      },
    );
    return said;
  };

  /** A meeting, called by the owner, with dates up. */
  const meeting = async (name: string, ...dates: string[]) => {
    await act(OWNER, { intent: "create", poll: name });
    for (const starts of dates) {
      await act(OWNER, { intent: "propose", poll: name, starts });
    }
  };

  const dates = (said: Said) => said["the-dates"].rows as Array<Record<string, any>>;

  return { act, meeting, dates };
}

describe("the meeting poll, shared", () => {
  it("lets the facade begin only where its statements take over", () => {
    expect([...readFacadeAccess(board.facade).processTargets]).toEqual(["who-is-here"]);
  });

  it("shows a member the Vote tab and not Organise, nor what only Organise reads", () => {
    const { facade, sources } = readFacadeAccess(board.facade);
    const shown = facade as { tabs: Array<{ id: string }>; panels: Array<{ id: string }> };
    expect(shown.tabs.map((tab) => tab.id)).toEqual(["answer"]);
    // Not left above the tabs either, as a panel no tab names would be.
    expect(shown.panels.map((panel) => panel.id)).toEqual(["vote"]);
    // Only the notices still name these, and a notice reads nothing but errors.
    expect([...(sources.get("organising") ?? [])]).toEqual(["error"]);
    expect([...(sources.get("withdrawable") ?? [])]).toEqual(["error"]);
  });

  it("lets only the owner call a meeting, and says why to anybody else", async () => {
    const { act } = office();

    // Anna, claiming to be the owner every way a payload can.
    const annas = await act(ANNA, {
      intent: "create",
      poll: "Offsite",
      caller_role: "owner",
      caller_email: OWNER.email,
    });
    expect(annas["open-poll"].error).toMatch(/only the board's owner can call a meeting/);
    expect(annas["the-meetings"]).toBeUndefined();

    const owners = await act(OWNER, { intent: "create", poll: "Offsite" });
    expect(owners["the-meetings"].rows).toEqual([{ name: "Offsite", label: "Offsite", current: 1 }]);
  });

  it("shows everybody the meeting called last, until they ask for another", async () => {
    const { act, meeting } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    await meeting("Roadmap", "2026-11-03 10:00");

    const annas = await act(ANNA);
    expect(annas["the-poll"].rows[0]).toMatchObject({
      name: "Roadmap",
      progress: "1 dates · 0 answered",
    });
    const asked = await act(ANNA, { poll: "Sprint review" });
    expect(asked["the-poll"].rows[0].name).toBe("Sprint review");
  });

  it("keeps whoever answers on the meeting they answer, after a newer one is called", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const opened = dates(await act(ANNA));
    expect(opened[0].poll).toBe("Sprint review");

    await meeting("Roadmap", "2026-11-03 10:00");
    // What the date's button sends: its own meeting, not whatever is newest.
    const answered = await act(ANNA, {
      intent: "vote",
      option: opened[0].id,
      poll: opened[0].poll,
    });

    expect(answered["the-poll"].rows[0].name).toBe("Sprint review");
    expect(dates(answered)[0]).toMatchObject({ yes: 1, mine: 1 });
    // Both are still there to go back to.
    expect(answered["the-meetings"].rows.map((row: Said) => row.name)).toEqual([
      "Roadmap",
      "Sprint review",
    ]);
  });

  it("tells somebody with nothing to answer why, and the owner what to do", async () => {
    const { act } = office();
    expect((await act(ANNA))["the-poll"].rows[0].notice).toMatch(/no meeting has been called/);
    expect((await act(OWNER))["the-poll"].rows[0].notice).toMatch(/Call one on Organise/);
  });

  it("gives the owner, and only the owner, what organising needs", async () => {
    const { act, meeting } = office();
    await meeting("Sprint review", "2026-11-02 10:00");

    const owners = await act(OWNER);
    expect(owners["organising"].rows).toEqual([
      expect.objectContaining({ name: "Sprint review", closeIntent: "close", nothingToClose: 0 }),
    ]);
    expect(owners["withdrawable"].rows).toHaveLength(1);

    const annas = await act(ANNA);
    expect(annas["organising"].rows).toEqual([]);
    expect(annas["withdrawable"].rows).toEqual([]);
  });

  it("lets the owner organise any meeting, not only the newest", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    await meeting("Roadmap");

    // Picking a meeting is a run naming it; what the owner organises follows.
    const picked = await act(OWNER, { poll: "Sprint review" });
    expect(picked["organising"].rows[0]).toMatchObject({
      name: "Sprint review",
      heading: "Organising Sprint review",
    });

    await act(OWNER, {
      intent: "propose",
      poll: picked["organising"].rows[0].name,
      starts: "2026-11-04 10:00",
    });
    expect(dates(await act(ANNA, { poll: "Sprint review" }))).toHaveLength(2);
    expect(dates(await act(ANNA, { poll: "Roadmap" }))).toHaveLength(0);
  });

  it("takes a date as the facade's picker gives it", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review");

    await act(OWNER, {
      intent: "propose",
      poll: "Sprint review",
      starts: "2026-11-04T10:00",
    });

    expect(dates(await act(ANNA))[0]).toMatchObject({
      starts: "2026-11-04 10:00",
      label: "Wed 2026-11-04 at 10:00",
    });
  });

  it("refuses a member's date, close and withdrawal, whatever they send", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const option = dates(await act(ANNA))[0].id;

    const proposed = await act(ANNA, {
      intent: "propose",
      poll: "Sprint review",
      starts: "2026-11-05 10:00",
      caller_email: OWNER.email,
    });
    expect(proposed["put-up-date"].error).toMatch(/only the person who called the meeting/);

    await act(ANNA, { intent: "close", poll: "Sprint review", caller_email: OWNER.email });
    await act(ANNA, { intent: "withdraw", option, caller_email: OWNER.email });

    const after = await act(BEN);
    expect(dates(after)).toHaveLength(1);
    expect(after["the-poll"].rows[0].notice).toMatch(/^Called by/);
  });

  it("counts an answer as the caller's, whoever the payload says it is", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const option = dates(await act(ANNA))[0].id;

    // Ben, claiming to be Anna.
    await act(BEN, { intent: "vote", option, voter: ANNA.email, caller_email: ANNA.email });

    expect(dates(await act(ANNA))[0]).toMatchObject({ yes: 1, mine: 0, who: "Ben" });
    expect(dates(await act(BEN))[0]).toMatchObject({ yes: 1, mine: 1, who: "you" });

    // Anna cannot take back what Ben said.
    await act(ANNA, { intent: "unvote", option });
    expect(dates(await act(BEN))[0].yes).toBe(1);
  });

  it("never shows one person another's address", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const option = dates(await act(ANNA))[0].id;
    await act(OWNER, { intent: "vote", option });
    await act(ANNA, { intent: "vote", option });
    await act(NAMELESS, { intent: "vote", option });

    const bens = await act(BEN);

    expect(JSON.stringify(bens)).not.toContain("@");
    // The owner by the role they have, somebody the list gave no name as a
    // member, the named by their name.
    expect(dates(bens)[0].who.split(", ").sort()).toEqual(["Anna", "a member", "the organiser"]);
    expect(bens["the-poll"].rows[0].notice).toMatch(/^Called by the board's owner/);
  });

  it("closes the poll for everybody when the owner closes it", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const option = dates(await act(ANNA))[0].id;

    await act(OWNER, { intent: "close", poll: "Sprint review" });

    const refused = await act(ANNA, { intent: "vote", option });
    expect(refused["say-yes"].error).toMatch(/the poll is closed/);
    expect(dates(await act(ANNA))[0]).toMatchObject({ yes: 0, locked: 1 });
  });

  it("answers nothing for somebody nobody signed in", async () => {
    const { act, meeting, dates } = office();
    await meeting("Sprint review", "2026-11-02 10:00");
    const option = dates(await act(ANNA))[0].id;

    const nobodys = await act(undefined, { intent: "vote", option, caller_email: ANNA.email });

    expect(dates(nobodys)[0]).toMatchObject({ yes: 0, locked: 1 });
  });
});
