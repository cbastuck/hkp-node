import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import { createFileLogStore } from "../src/coordinator/logStore";
import { createCoordinatorRouter } from "../src/coordinator/router";
import { LogEntry } from "../src/types";

const roots: string[] = [];
const coordinators: BoardCoordinator[] = [];

afterEach(async () => {
  while (coordinators.length) {
    coordinators.pop()?.destroyAll();
  }
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    runId: "run-1",
    ts: "2026-08-15T10:00:00.000Z",
    runtimeId: "node",
    serviceUuid: "svc",
    level: "info",
    event: "handled",
    ...over,
  };
}

/**
 * A coordinator with a board registered and a log already written.
 *
 * The board is registered with no runtimes so nothing has to be provisioned —
 * the route only needs the board to exist, and what it reads comes from the
 * store rather than from anything running.
 */
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-log-route-"));
  roots.push(root);
  const logStore = createFileLogStore(root);
  const coordinator = new BoardCoordinator(undefined, logStore);
  coordinators.push(coordinator);

  await coordinator.registerBoard("user-1", {
    boardName: "board-1",
    runtimes: [],
    services: {},
  });

  const app = express();
  // The real server mounts this router on an app that already parses JSON
  // (createRuntimeServer does it before the coordinator router is added).
  app.use(express.json());
  // Auth is off in tests, which makes requireSelf compare `sub` against the
  // username in the path — so a mismatch is still rejected here.
  app.use(createCoordinatorRouter({ coordinator }).router);

  return { app, logStore, root };
}

describe("entries from a browser runtime", () => {
  it("reach the board's log through the bridge", async () => {
    // A browser runtime holds no socket of its own to the coordinator, so the
    // bridge is the only route its entries have into the board's log. Without
    // this leg a board's browser half would record into nothing.
    const { logStore } = await setup();
    const coordinator = coordinators[coordinators.length - 1];
    const session = coordinator.getBoard("user-1", "board-1")!;

    const sent: string[] = [];
    const fakeBridge = {
      readyState: 1,
      send: (raw: string) => sent.push(raw),
      on: (event: string, handler: (raw: string) => void) => {
        if (event === "message") {
          handler(
            JSON.stringify({
              type: "log",
              entry: entry({ runtimeId: "ui", event: "from-browser" }),
            }),
          );
        }
      },
      removeAllListeners: () => {},
      close: () => {},
    } as unknown as Parameters<typeof session.registerBrowserSocket>[0];

    session.registerBrowserSocket(fakeBridge, ["ui"]);
    await logStore.close();

    const entries = await logStore.read("user-1", "board-1");
    expect(entries.map((e) => e.event)).toEqual(["from-browser"]);
    expect(entries[0].runtimeId).toBe("ui");
  });
});

describe("the logging toggle", () => {
  it("remembers the answer on the board", async () => {
    // The setting has to survive a restart, and a runtime provisioned later has
    // to come up with it already on — so it lives on the board, not only in
    // whatever is running now.
    const { app } = await setup();
    const coordinator = coordinators[coordinators.length - 1];

    await request(app)
      .post("/users/user-1/boards/board-1/logging")
      .send({ enabled: true })
      .expect(200);

    const session = coordinator.getBoard("user-1", "board-1")!;
    // logData moves with it, so turning logging on gives whole entries rather
    // than ones with their contents missing and no way in the UI to ask.
    expect(
      session.config.runtimes.every(
        (r) => r.state?.logging === true && r.state?.logData === true,
      ),
    ).toBe(true);

    await request(app)
      .post("/users/user-1/boards/board-1/logging")
      .send({ enabled: false })
      .expect(200);

    expect(
      session.config.runtimes.every((r) => r.state?.logging === false),
    ).toBe(true);
  });

  it("refuses anything that is not a plain yes or no", async () => {
    // Recording payloads is the kind of switch that should only move on an
    // unambiguous answer.
    const { app } = await setup();

    await request(app)
      .post("/users/user-1/boards/board-1/logging")
      .send({ enabled: "true" })
      .expect(400);

    await request(app)
      .post("/users/user-1/boards/board-1/logging")
      .send({})
      .expect(400);
  });

  it("reports a board it does not have", async () => {
    const { app } = await setup();

    await request(app)
      .post("/users/user-1/boards/absent/logging")
      .send({ enabled: true })
      .expect(404);
  });
});

describe("the board log route", () => {
  it("serves what the board recorded", async () => {
    const { app, logStore } = await setup();
    logStore.append("user-1", "board-1", entry({ event: "first" }));
    logStore.append("user-1", "board-1", entry({ event: "second" }));
    await logStore.close();

    const res = await request(app)
      .get("/users/user-1/boards/board-1/runs")
      .expect(200);

    expect(res.body.entries.map((e: LogEntry) => e.event)).toEqual([
      "first",
      "second",
    ]);
  });

  it("withholds `data` unless it is asked for", async () => {
    const { app, logStore } = await setup();
    logStore.append("user-1", "board-1", entry({ data: { secret: "shhh" } }));
    await logStore.close();

    const withheld = await request(app)
      .get("/users/user-1/boards/board-1/runs")
      .expect(200);
    expect(withheld.body.entries[0].data).toBeUndefined();

    const asked = await request(app)
      .get("/users/user-1/boards/board-1/runs?withData=true")
      .expect(200);
    expect(asked.body.entries[0].data).toEqual({ secret: "shhh" });
  });

  it("narrows to one run", async () => {
    const { app, logStore } = await setup();
    logStore.append("user-1", "board-1", entry({ runId: "a" }));
    logStore.append("user-1", "board-1", entry({ runId: "b" }));
    await logStore.close();

    const res = await request(app)
      .get("/users/user-1/boards/board-1/runs?runId=a")
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].runId).toBe("a");
  });

  it("does not serve one user's log under another user's name", async () => {
    // Board names are unique per user, not globally, so two people can both own
    // a "board-1". The log has to be namespaced the same way the boards are, or
    // the second owner would read the first one's entries.
    //
    // With auth off, requireSelf takes the username in the path as the caller,
    // so this exercises the namespacing rather than the token check — which is
    // the part that could leak. Under a real token the request would not get
    // this far: requireSelf rejects a `sub` that does not match the path.
    const { app, logStore } = await setup();
    logStore.append("user-1", "board-1", entry({ event: "private" }));
    await logStore.close();

    const coordinator = coordinators[coordinators.length - 1];
    await coordinator.registerBoard("user-2", {
      boardName: "board-1",
      runtimes: [],
      services: {},
    });

    const res = await request(app)
      .get("/users/user-2/boards/board-1/runs")
      .expect(200);

    expect(res.body.entries).toEqual([]);
  });

  it("reports a board it does not have rather than an empty log", async () => {
    // An empty answer for a board that does not exist would read as "this board
    // logged nothing", which is a different fact.
    const { app } = await setup();

    await request(app).get("/users/user-1/boards/absent/runs").expect(404);
  });
});
