import { afterEach, describe, expect, it } from "vitest";

import { BoardSession } from "../src/coordinator/session";
import { CloudBoardConfig } from "../src/coordinator/types";
import { mapDescriptor } from "../src/services/map";
import { sqlDescriptor } from "../src/services/sql";
import { Caller } from "../src/types";
import {
  attachBrowser,
  eventually,
  fakeParticipants,
  settle,
  startCoordinator,
  startRuntimeServer,
  startSession,
} from "./cloud";

/**
 * Asking a service on a deployed board to do its job.
 *
 * A browser attached to a board dials none of its runtimes, so "do this now" —
 * what a facade's `process` action means — travels the bridge like everything
 * else, and the coordinator begins the run. Two things follow from that and
 * are pinned here: the run's caller is whoever attached with the bridge, and
 * the run is one run across every runtime of the board it reaches.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const ALICE: Caller = {
  sub: "auth0|alice",
  email: "alice@example.com",
  name: "Alice",
};

const tag = (uuid: string, value: string) => ({
  serviceId: mapDescriptor.serviceId,
  uuid,
  state: { mode: "add", template: { [uuid]: value } },
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

/** A board of two runtimes, each on a runtime server of its own. */
async function twoRuntimeBoard(config: CloudBoardConfig) {
  const host = await startCoordinator();
  const first = await startRuntimeServer();
  const second = await startRuntimeServer();
  cleanups.push(host.stop, () => first.server.stop(), () => second.server.stop());
  const session = await startSession(host, config, {
    a: first.server,
    b: second.server,
  });
  cleanups.push(() => session.destroy());
  return session;
}

async function browser(
  session: BoardSession,
  attach?: Parameters<typeof attachBrowser>[2],
  runtimeIds: string[] = [],
) {
  const end = await attachBrowser(session, runtimeIds, attach);
  cleanups.push(end.stop);
  return end;
}

describe("processing at a service over the bridge", () => {
  const board: CloudBoardConfig = {
    boardName: "two",
    runtimes: [
      { id: "a", name: "A", type: "rest" },
      { id: "b", name: "B", type: "rest" },
    ],
    services: {
      a: [tag("first", "ran"), tag("second", "ran"), whoami("who-a")],
      b: [whoami("who-b")],
    },
  };

  it("begins at the service named, and says the work was taken", async () => {
    const session = await twoRuntimeBoard(board);
    const owner = await browser(session, { role: "owner", caller: ALICE });

    const answer = await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "second",
      payload: { hello: true },
    });

    expect(answer.error).toBeUndefined();
    expect(answer.data).toEqual({ accepted: true });
    // What the pipeline did arrives as notifications: "first" was not run.
    await eventually(
      () => owner.all("notification").some((n) => n.serviceUuid === "who-b"),
      "the board's second runtime to run",
    );
    const touched = owner.all("notification").map((n) => n.serviceUuid);
    expect(touched).toContain("second");
    expect(touched).not.toContain("first");
  });

  it("runs every runtime of the board as the same caller", async () => {
    const session = await twoRuntimeBoard(board);
    const owner = await browser(session, { role: "owner", caller: ALICE });

    await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "first",
      payload: {},
    });

    const rowsFrom = (uuid: string) =>
      owner
        .all("notification")
        .filter((n) => n.serviceUuid === uuid)
        .map((n) => (n.payload as { rows?: unknown[] }).rows)
        .find((rows) => Array.isArray(rows));
    await eventually(() => !!rowsFrom("who-b"), "the second runtime's answer");

    const alice = [{ sub: ALICE.sub, email: ALICE.email, name: ALICE.name }];
    // The first runtime was told by the coordinator; the second was told what
    // the first handed back. Without the context surviving the hop, only the
    // first would know.
    expect(rowsFrom("who-a")).toEqual(alice);
    expect(rowsFrom("who-b")).toEqual(alice);
  });

  it("names no caller on a coordinator without identities", async () => {
    const session = await twoRuntimeBoard(board);
    const owner = await browser(session);

    await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "who-a",
      // Not somewhere a caller can be claimed from.
      payload: { caller_sub: "typed", __context: { caller: ALICE } },
    });

    await eventually(
      () => owner.all("notification").some((n) => n.serviceUuid === "who-b"),
      "the second runtime's answer",
    );
    const rows = owner
      .all("notification")
      .filter((n) => n.serviceUuid === "who-b")
      .map((n) => (n.payload as { rows?: unknown[] }).rows)
      .find((r) => Array.isArray(r));
    expect(rows).toEqual([{ sub: null, email: null, name: null }]);
  });

  it("says why when the service is not there", async () => {
    const session = await twoRuntimeBoard(board);
    const owner = await browser(session, { role: "owner", caller: ALICE });

    const answer = await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "nobody",
      payload: {},
    });

    expect(answer.error).toMatch(/no service "nobody"/);
  });

  it("says why when the runtime is not connected, or is no runtime", async () => {
    const fakes = fakeParticipants();
    const session = new BoardSession(
      "two",
      "user-1",
      board,
      fakes.participants,
    );
    cleanups.push(() => session.destroy());
    await session.start();
    const owner = await browser(session);

    const away = await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "first",
    });
    expect(away.error).toBe('Runtime "a" is not connected');

    const unknown = await owner.ask({
      type: "processService",
      requestId: "p-2",
      runtimeId: "nowhere",
      serviceUuid: "first",
    });
    expect(unknown.error).toBe('Unknown runtime "nowhere"');
  });
});

describe("a run across a board's runtimes", () => {
  const board: CloudBoardConfig = {
    boardName: "chain",
    runtimes: [
      { id: "a", name: "A", type: "rest" },
      { id: "ui", name: "Browser", type: "browser" },
      { id: "b", name: "B", type: "rest" },
    ],
    services: { a: [], ui: [], b: [] },
  };

  async function chain() {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const session = new BoardSession("chain", "user-1", board, fakes.participants);
    cleanups.push(() => session.destroy());
    await session.start();
    return { session, a, b };
  }

  it("is told to the participant it begins on", async () => {
    const { session, a } = await chain();
    const owner = await browser(session, { role: "owner", caller: ALICE });

    await owner.ask({
      type: "processService",
      requestId: "p-1",
      runtimeId: "a",
      serviceUuid: "svc",
      payload: { n: 1 },
    });

    const request = a.requests.find((r) => r.op === "processService");
    expect(request).toMatchObject({
      op: "processService",
      serviceUuid: "svc",
      params: { n: 1 },
      context: { caller: ALICE },
    });
    expect(
      (request as { context?: { runId?: string } }).context?.runId,
    ).toBeTruthy();
  });

  it("keeps its context through a browser runtime, whatever the browser sends back", async () => {
    const { session, a, b } = await chain();
    const owner = await browser(session, { role: "owner", caller: ALICE }, ["ui"]);
    const run = { runId: "run-1", caller: ALICE };

    a.emit({ type: "result", data: { n: 1 }, context: run });
    await eventually(() => !!owner.last("processRuntime"), "the browser to be asked");
    const asked = owner.last("processRuntime")!;
    expect(asked.context).toEqual(run);

    owner.send({
      type: "result",
      requestId: asked.requestId!,
      data: { n: 2 },
      // Not the browser's to restate: what continues is what the coordinator held.
      context: { runId: "forged", caller: { sub: "auth0|mallory" } },
    } as never);

    await eventually(() => b.processed.length > 0, "the next runtime to run");
    expect(b.processed).toEqual([{ n: 2 }]);
    expect(b.contexts).toEqual([run]);
  });

  it("begins a run as the bridge's caller when a browser runtime produces something", async () => {
    const { session, b } = await chain();
    const owner = await browser(session, { role: "owner", caller: ALICE }, ["ui"]);

    owner.send({ type: "result-from-browser", runtimeId: "ui", data: { n: 1 } });

    await eventually(() => b.processed.length > 0, "the next runtime to run");
    expect(b.contexts[0]?.caller).toEqual(ALICE);
    expect(b.contexts[0]?.runId).toBeTruthy();
  });

  it("carries a run nobody began without inventing a caller for it", async () => {
    const { session, a, b } = await chain();
    // Attached as somebody: the run is still not theirs, they only host the
    // browser runtime it passes through.
    const owner = await browser(session, { role: "owner", caller: ALICE }, ["ui"]);

    a.emit({ type: "result", data: { n: 1 }, context: { runId: "tick" } });
    await eventually(() => !!owner.last("processRuntime"), "the browser to be asked");
    owner.send({
      type: "result",
      requestId: owner.last("processRuntime")!.requestId!,
      data: { n: 2 },
    });

    await eventually(() => b.processed.length > 0, "the next runtime to run");
    expect(b.contexts).toEqual([{ runId: "tick" }]);
  });

  it("stops at a browser runtime nobody is hosting", async () => {
    const { a, b } = await chain();

    a.emit({ type: "result", data: { n: 1 }, context: { runId: "tick" } });
    await settle();

    expect(b.processed).toEqual([]);
  });
});
