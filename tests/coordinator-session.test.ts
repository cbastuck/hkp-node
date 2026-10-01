import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeMessage } from "../src/coordinator/bridgeProtocol";
import { BoardSession } from "../src/coordinator/session";
import { CloudBoardConfig } from "../src/coordinator/types";
import { eventually, fakeParticipants, settle } from "./cloud";

/**
 * What a session does with its participants.
 *
 * The participants here exist only in memory and record what they are asked,
 * so each test is about a decision the session makes — build or pick up, error
 * or carry on, tell or drop — and not about a socket.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const config: CloudBoardConfig = {
  boardName: "board-1",
  runtimes: [
    { id: "a", name: "A", type: "rest" },
    { id: "ui", name: "Browser", type: "browser" },
    { id: "b", name: "B", type: "rest" },
  ],
  services: {
    a: [{ uuid: "a-1", serviceId: "monitor", state: { n: 1 } }],
    ui: [],
    b: [{ uuid: "b-1", serviceId: "monitor" }],
  },
};

function session(fakes: ReturnType<typeof fakeParticipants>, board = config) {
  const created = new BoardSession(
    board.boardName,
    "user-1",
    board,
    fakes.participants,
  );
  cleanups.push(() => created.destroy());
  return created;
}

/** A browser attached to the session, over a real socket pair. */
async function attach(target: BoardSession, runtimeIds: string[] = ["ui"]) {
  const received: BridgeMessage[] = [];
  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  const serverSide = new Promise<WebSocket>((resolve) =>
    sockets.on("connection", (ws) => resolve(ws)),
  );
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.on("message", (raw) =>
    received.push(JSON.parse(raw.toString()) as BridgeMessage),
  );
  await new Promise<void>((resolve) => client.on("open", () => resolve()));
  target.registerBrowserSocket(await serverSide, runtimeIds);
  cleanups.push(async () => {
    client.close();
    sockets.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  return {
    received,
    send: (message: BridgeMessage) => client.send(JSON.stringify(message)),
    close: () => client.close(),
    last: <T extends BridgeMessage["type"]>(type: T) =>
      [...received].reverse().find((m) => m.type === type) as
        | Extract<BridgeMessage, { type: T }>
        | undefined,
  };
}

describe("building a board over its participants", () => {
  it("builds each required runtime from the board's description of it", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    fakes.join("b");
    const board = session(fakes);

    await board.start();

    expect(board.getStatus()).toBe("running");
    expect(a.requests[0]).toEqual({
      op: "provision",
      name: "A",
      boardName: "board-1",
      state: {},
      services: [
        { uuid: "a-1", serviceId: "monitor", serviceName: "monitor", state: { n: 1 } },
      ],
      assets: {},
    });
  });

  it("names every required runtime that is not connected, and no browser", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    const board = session(fakes);

    await board.start();

    expect(board.getStatus()).toBe("error");
    expect(board.getErrors()).toEqual([
      'Runtime "b" is not connected — its runtime server has to connect to this coordinator',
    ]);
  });

  it("builds a runtime when its participant arrives later", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    const board = session(fakes);
    await board.start();

    const b = fakes.join("b");
    await settle();

    expect(b.requests.map((r) => r.op)).toEqual(["provision"]);
    expect(board.getStatus()).toBe("running");
  });

  it("says what a runtime server refused, against the runtime it refused", async () => {
    const fakes = fakeParticipants();
    fakes.join("a", {
      answer: (request) => {
        if (request.op === "provision") {
          throw new Error("Unknown serviceId: monitor");
        }
        return undefined;
      },
    });
    fakes.join("b");
    const board = session(fakes);

    await board.start();

    expect(board.getErrors()).toEqual([
      'Runtime "a": Unknown serviceId: monitor',
    ]);
  });

  it("says which credentials a runtime was built without, and where they are missing", async () => {
    const fakes = fakeParticipants();
    fakes.join("a", {
      answer: (request) =>
        request.op === "provision"
          ? { services: [], missingSecrets: ["imap.password", "slack"] }
          : undefined,
    });
    fakes.join("b");
    const board = session(fakes);

    await board.start();

    expect(board.getStatus()).toBe("error");
    expect(board.getErrors()).toEqual([
      'Runtime "a": needs configuration — its runtime server holds no value for imap.password, slack',
    ]);
  });
});

describe("a required participant coming and going", () => {
  it("puts the board in error while it is away and tells attached browsers", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    fakes.join("b");
    const board = session(fakes);
    await board.start();
    const browser = await attach(board);
    await eventually(() => !!browser.last("snapshot"), "the first snapshot");

    fakes.leave("b");

    await eventually(
      () => browser.last("snapshot")?.status === "error",
      "the browser to be told",
    );
    expect(browser.last("snapshot")?.errors).toEqual([
      'Runtime "b" is not connected — its runtime server has to connect to this coordinator',
    ]);
    // What it last reported is still shown; the status says it is away.
    expect(browser.last("snapshot")?.runtimes.map((r) => r.runtimeId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("picks the runtime back up when it returns still running", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    fakes.join("b");
    const board = session(fakes);
    await board.start();
    fakes.leave("b");

    const back = fakes.join("b", { hello: { runtimeExists: true } });
    await settle();

    expect(back.requests.map((r) => r.op)).toEqual(["describe"]);
    expect(board.getStatus()).toBe("running");
  });

  it("rebuilds the runtime when it returns without it", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    fakes.join("b");
    const board = session(fakes);
    await board.start();
    fakes.leave("b");

    const back = fakes.join("b", { hello: { runtimeExists: false } });
    await settle();

    expect(back.requests.map((r) => r.op)).toEqual(["provision"]);
  });

  it("builds a runtime it never built even when one is already running there", async () => {
    // Whatever is under that id was not built from this board — the copy a
    // browser was running before it deployed, say.
    const fakes = fakeParticipants();
    const a = fakes.join("a", { hello: { runtimeExists: true } });
    fakes.join("b");
    const board = session(fakes);

    await board.start();

    expect(a.requests[0].op).toBe("provision");
  });
});

describe("driving the chain", () => {
  it("drops data headed for a browser nobody has open, and stays running", async () => {
    // A transient participant being away is not an error: the data stops
    // there, the way a null stops a pipeline.
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = session(fakes);
    await board.start();

    a.emit({ type: "result", data: { n: 1 } });
    await settle();

    expect(b.processed).toEqual([]);
    expect(board.getStatus()).toBe("running");
    expect(board.getErrors()).toEqual([]);
  });

  it("passes data through an attached browser to the runtime after it", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = session(fakes);
    await board.start();
    const browser = await attach(board);
    await eventually(() => !!browser.last("snapshot"), "the first snapshot");

    a.emit({ type: "result", data: { n: 1 } });
    await eventually(
      () => !!browser.last("processRuntime"),
      "the browser to be asked",
    );
    const asked = browser.last("processRuntime")!;
    expect(asked.runtimeId).toBe("ui");
    browser.send({
      type: "result",
      requestId: asked.requestId!,
      data: { n: 2 },
    });

    await eventually(() => b.processed.length > 0, "the next runtime to run");
    expect(b.processed).toEqual([{ n: 2 }]);
  });

  it("does not drive a required runtime that is away", async () => {
    const twoRemote: CloudBoardConfig = {
      boardName: "board-1",
      runtimes: [
        { id: "a", name: "A", type: "rest" },
        { id: "b", name: "B", type: "rest" },
      ],
      services: { a: [], b: [] },
    };
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = session(fakes, twoRemote);
    await board.start();
    fakes.leave("b");

    a.emit({ type: "result", data: { n: 1 } });
    await settle();

    expect(b.processed).toEqual([]);
    expect(board.getStatus()).toBe("error");
  });

  it("drives a runtime the board gives no address for", async () => {
    // The coordinator used to skip a remote runtime without a `url`. It reads
    // no address now, so a runtime named by `remote` or `requires` is driven
    // like any other.
    const named: CloudBoardConfig = {
      boardName: "board-1",
      runtimes: [
        { id: "a", name: "A", type: "rest", remote: "Laptop" },
        { id: "b", name: "B", type: "rest", requires: { kind: "python" } },
      ],
      services: { a: [], b: [] },
    };
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = session(fakes, named);
    await board.start();

    a.emit({ type: "result", data: { n: 1 } });
    await settle();

    expect(board.getStatus()).toBe("running");
    expect(b.processed).toEqual([{ n: 1 }]);
  });
});

describe("acting on a board's runtimes", () => {
  it("refuses to configure a service on a runtime that is away, saying so", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    fakes.join("b");
    const board = session(fakes);
    await board.start();
    const browser = await attach(board);
    fakes.leave("b");

    browser.send({
      type: "configureService",
      requestId: "req-1",
      runtimeId: "b",
      serviceUuid: "b-1",
      config: {},
    });

    await eventually(() => !!browser.last("response"), "the answer");
    expect(browser.last("response")?.error).toBe('Runtime "b" is not connected');
  });

  it("reports the runtimes a logging change did not reach", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    fakes.join("b");
    const board = session(fakes);
    await board.start();
    fakes.leave("b");

    const unreachable = await board.setLogging(true, "debug");

    expect(unreachable).toEqual(["b"]);
    expect(a.requests.at(-1)).toEqual({
      op: "setState",
      state: { logging: true, logLevel: "debug" },
    });
  });

  it("releases every runtime it built when it is stopped", async () => {
    const fakes = fakeParticipants();
    const a = fakes.join("a");
    const b = fakes.join("b");
    const board = session(fakes);
    await board.start();

    await board.stop();

    expect(a.requests.at(-1)).toEqual({ op: "remove" });
    expect(b.requests.at(-1)).toEqual({ op: "remove" });
    expect(board.getStatus()).toBe("stopped");
    expect(board.getErrors()).toEqual([]);
  });

  it("does not build a runtime that connects while the board is stopped", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    const board = session(fakes);
    await board.start();
    await board.stop();

    const b = fakes.join("b");
    await settle();

    expect(b.requests).toEqual([]);
    expect(board.getStatus()).toBe("stopped");
  });

  it("stops listening to participants once it has been replaced", async () => {
    const fakes = fakeParticipants();
    fakes.join("a");
    const board = session(fakes);
    await board.start();
    await board.destroy();

    const b = fakes.join("b");
    await settle();

    expect(b.requests).toEqual([]);
  });
});
