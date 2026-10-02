import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { BoardCoordinator } from "../src/coordinator/coordinator";
import { JOIN_PATH } from "../src/coordinator/participantProtocol";
import { ParticipantRegistry } from "../src/coordinator/participants";
import { CloudBoardConfig } from "../src/coordinator/types";
import { createMemoryLinkStore } from "../src/coordinatorLinks";
import { mapDescriptor } from "../src/services/map";
import { monitorDescriptor } from "../src/services/monitor";
import { WebSocket } from "ws";
import {
  CLOSE_REPLACED,
  CLOSE_TICKET_REVOKED,
} from "../src/coordinator/participantProtocol";
import {
  CoordinatorHost,
  boardRuntime,
  OWNER,
  RuntimeServer,
  deploy,
  eventually,
  introduce,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A coordinator that accepts and never dials.
 *
 * Every runtime server in these tests is on loopback, which the coordinator
 * used to refuse to dial. Nothing here allows it to: it is told no address at
 * all. Each runtime server connects to the coordinator with a ticket, and the
 * board is built, driven and torn down over the connection that came in.
 */

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
});

async function coordinatorHost(coordinator?: BoardCoordinator, port?: number) {
  const host = await startCoordinator(coordinator, port);
  hosts.push(host);
  return host;
}

async function runtimeServer(
  options: Parameters<typeof startRuntimeServer>[0] = {},
) {
  const started = await startRuntimeServer(options);
  servers.push(started.server);
  return started;
}

function board(overrides: Partial<CloudBoardConfig> = {}): CloudBoardConfig {
  return {
    boardName: "doorbell",
    // No address anywhere: the coordinator would have nothing to do with one.
    runtimes: [{ id: "node", name: "Node", type: "rest" }],
    services: {
      node: [{ uuid: "mon-1", serviceId: monitorDescriptor.serviceId }],
    },
    ...overrides,
  };
}

function joinSocket(host: CoordinatorHost, ticket?: string) {
  return new WebSocket(
    `${host.url.replace("http", "ws")}${JOIN_PATH}`,
    ticket ? { headers: { Authorization: `Bearer ${ticket}` } } : {},
  );
}

/**
 * Connects with a ticket and says hello; resolves once welcomed. Answers
 * whatever it is then asked as a runtime server with nothing on it would.
 */
function joinAs(host: CoordinatorHost, ticket: string): Promise<WebSocket> {
  const socket = joinSocket(host, ticket);
  return new Promise((resolve, reject) => {
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "hello", server: "test", registry: [] })),
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "welcome") {
        resolve(socket);
      }
      if (message.type === "request") {
        socket.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: true,
            data: { registry: [], services: [], missingSecrets: [] },
          }),
        );
      }
    });
    socket.on("error", reject);
    socket.on("unexpected-response", () => reject(new Error("refused")));
  });
}

function outcome(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.on("open", () => resolve("open"));
    socket.on("unexpected-response", (_req, res) => {
      resolve(`refused ${res.statusCode}`);
      socket.terminate();
    });
    socket.on("error", () => {});
  });
}

describe("deploying to a coordinator that never dials", () => {
  it("builds the board's runtime on the server that connected for it", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();

    const session = await deploy(host, "user-1", board(), { node: server });

    expect(session.getStatus()).toBe("running");
    expect(session.getErrors()).toEqual([]);
    const built = boardRuntime(server, "node")!.serialize();
    expect(built.services.map((s) => s.uuid)).toEqual(["mon-1"]);
    // The coordinator's, until the coordinator says otherwise.
    expect(built.garbageCollected).toBe(false);
    expect(built.boardName).toBe("doorbell");
  });

  it("drives the chain from one runtime server to the next over their connections", async () => {
    const host = await coordinatorHost();
    const first = await runtimeServer();
    const second = await runtimeServer();
    const config = board({
      runtimes: [
        { id: "a", name: "A", type: "rest" },
        { id: "b", name: "B", type: "rest" },
      ],
      services: {
        a: [
          {
            uuid: "stamp",
            serviceId: mapDescriptor.serviceId,
            state: { mode: "add", template: { via: "a" } },
          },
        ],
        b: [{ uuid: "seen", serviceId: monitorDescriptor.serviceId }],
      },
    });
    await deploy(host, "user-1", config, {
      a: first.server,
      b: second.server,
    });
    const seen: unknown[] = [];
    boardRuntime(second.server, "b")!
      .registerNotificationTarget((notification) => seen.push(notification.payload));

    // Something sets the first runtime going — here a caller of that server.
    boardRuntime(first.server, "a")!.emitResult({ ping: 1 });

    await eventually(() => seen.length > 0, "the second runtime to be driven");
    expect(JSON.stringify(seen)).toContain("ping");
  });

  it("says which runtime is missing when its server never connected", async () => {
    const host = await coordinatorHost();

    const session = await host.coordinator.registerBoard("user-1", board());

    expect(session.getStatus()).toBe("error");
    expect(session.getErrors()).toEqual([
      'Runtime "node" is not connected — its runtime server has to connect to this coordinator',
    ]);
  });

  it("comes up when the missing runtime server connects afterwards", async () => {
    // `error` is not terminal: the board was waiting for exactly this.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await host.coordinator.registerBoard("user-1", board());

    await introduce(host, "user-1", "doorbell", { node: server });

    await eventually(
      () => session.getStatus() === "running",
      "the board to run",
    );
    expect(boardRuntime(server, "node")).toBeTruthy();
  });

  it("keeps a board with only a browser runtime running with no browser attached", async () => {
    // A browser is a transient participant: its absence is normal operation.
    const host = await coordinatorHost();

    const session = await host.coordinator.registerBoard(
      "user-1",
      board({
        runtimes: [{ id: "ui", name: "Browser", type: "browser" }],
        services: { ui: [] },
      }),
    );

    expect(session.getStatus()).toBe("running");
    expect(session.getErrors()).toEqual([]);
  });

  it("reports a runtime whose server lacks a service, by name", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();

    const session = await deploy(
      host,
      "user-1",
      board({ services: { node: [{ uuid: "x", serviceId: "no-such-service" }] } }),
      { node: server },
    );

    expect(session.getStatus()).toBe("error");
    expect(session.getErrors()[0]).toMatch(/Runtime "node": .*no-such-service/);
  });
});

describe("a participant that goes away", () => {
  it("puts the board in error naming it, and running again when it returns", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board(), { node: server });
    expect(session.getStatus()).toBe("running");

    // The connection drops; the runtime server itself keeps running.
    host.coordinator.participants.closeAll();

    await eventually(() => session.getStatus() === "error", "the drop to show");
    expect(session.getErrors()[0]).toMatch(/Runtime "node" is not connected/);

    // It reconnects on its own, with the ticket it kept.
    await eventually(
      () => session.getStatus() === "running",
      "the runtime server to reconnect",
    );
    expect(boardRuntime(server, "node")).toBeTruthy();
  });

  it("picks a runtime back up rather than rebuilding it when only the connection dropped", async () => {
    // Its state is live and the board's is not: a rebuild would throw away
    // whatever the runtime had been doing.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board(), { node: server });
    const before = boardRuntime(server, "node");

    host.coordinator.participants.closeAll();
    await eventually(() => session.getStatus() === "error", "the drop to show");
    await eventually(() => session.getStatus() === "running", "the reconnect");

    expect(boardRuntime(server, "node")).toBe(before);
  });

  it("rebuilds the runtime from the board when its server restarted", async () => {
    // What a restart loses is the runtime; what it keeps is the ticket.
    const host = await coordinatorHost();
    const store = createMemoryLinkStore();
    const first = await runtimeServer({ coordinatorLinks: store });
    const session = await deploy(host, "user-1", board(), {
      node: first.server,
    });

    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    await eventually(() => session.getStatus() === "error", "the stop to show");

    // The same machine, started again: an empty process holding the ticket.
    const second = await runtimeServer({ coordinatorLinks: store });
    second.server.coordinatorLinks.restore();

    await eventually(
      () => session.getStatus() === "running",
      "the restarted server to be provisioned",
    );
    expect(
      boardRuntime(second.server, "node")!
        .listServices()
        .map((s) => s.uuid),
    ).toEqual(["mon-1"]);
  });
});

describe("a participant whose connection is gone without having closed", () => {
  it("is dropped once it stops answering, and the board says so", async () => {
    // A network that vanished closes nothing. Without asking, the board would
    // go on reporting a runtime it can no longer reach as running.
    const host = await coordinatorHost(
      new BoardCoordinator(
        undefined,
        undefined,
        new ParticipantRegistry({ heartbeatMs: 25 }),
      ),
    );
    const { node: ticket } = await host.coordinator.issueTickets(
      "user-1",
      "doorbell",
      ["node"],
    );
    // A participant that says hello and then never answers a ping.
    const silent = new WebSocket(
      `${host.url.replace("http", "ws")}${JOIN_PATH}`,
      { headers: { Authorization: `Bearer ${ticket}` }, autoPong: false },
    );
    silent.on("error", () => {});
    silent.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request") {
        silent.send(
          JSON.stringify({
            type: "response",
            requestId: message.requestId,
            ok: true,
            data: { services: [] },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => silent.on("open", () => resolve()));
    silent.send(
      JSON.stringify({ type: "hello", registry: [], runtimeExists: false }),
    );
    const session = await host.coordinator.registerBoard("user-1", board());
    await eventually(() => session.getStatus() === "running", "the join");

    await eventually(
      () => session.getStatus() === "error",
      "the silent participant to be dropped",
    );
    expect(session.getErrors()[0]).toMatch(/Runtime "node" is not connected/);
  });

  it("is kept for as long as it answers", async () => {
    const host = await coordinatorHost(
      new BoardCoordinator(
        undefined,
        undefined,
        new ParticipantRegistry({ heartbeatMs: 25 }),
      ),
    );
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board(), { node: server });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(session.getStatus()).toBe("running");
  });
});

describe("tickets", () => {
  it("refuses a connection that presents none, or one the coordinator does not hold", async () => {
    const host = await coordinatorHost();

    expect(await outcome(joinSocket(host))).toBe("refused 401");
    expect(await outcome(joinSocket(host, "hkpt_not-a-ticket"))).toBe(
      "refused 401",
    );
  });

  it("keeps accepting a runtime's ticket while a newer one is pending", async () => {
    // Asking again is the start of a deploy, which may yet fail. Until the
    // board is registered the runtime server holding the first ticket can
    // still reconnect with it.
    const host = await coordinatorHost();
    const { node: first } = await host.coordinator.issueTickets(
      "user-1",
      "doorbell",
      ["node"],
    );
    const { node: second } = await host.coordinator.issueTickets(
      "user-1",
      "doorbell",
      ["node"],
    );

    for (const ticket of [first, second]) {
      const accepted = joinSocket(host, ticket);
      expect(await outcome(accepted)).toBe("open");
      accepted.terminate();
    }
  });

  it("has one pending ticket per runtime, the newest", async () => {
    const host = await coordinatorHost();
    const issue = async () =>
      (await host.coordinator.issueTickets("user-1", "doorbell", ["node"])).node;
    const first = await issue();
    const abandoned = await issue();
    const second = await issue();

    expect(await outcome(joinSocket(host, abandoned))).toBe("refused 401");
    expect(host.coordinator.participants.resolve(first)).toBeTruthy();
    expect(host.coordinator.participants.resolve(second)).toBeTruthy();
  });

  it("makes a pending ticket the one that counts once the board is registered, when a server came with it", async () => {
    const host = await coordinatorHost();
    const issue = async () =>
      (await host.coordinator.issueTickets("user-1", "doorbell", ["node"])).node;
    const first = await issue();
    const holder = await joinAs(host, first);
    const second = await issue();
    const successor = await joinAs(host, second);
    const gaveWay = new Promise<number>((resolve) =>
      holder.on("close", (code) => resolve(code)),
    );

    await host.coordinator.registerBoard("user-1", board());

    expect(await gaveWay).toBe(CLOSE_REPLACED);
    expect(await outcome(joinSocket(host, first))).toBe("refused 401");
    expect(host.coordinator.participants.resolve(second)).toBeTruthy();
    // What a restart would bring back is the ticket that counts.
    expect(
      host.coordinator.participants.exportTickets("user-1", "doorbell"),
    ).toHaveLength(1);
    successor.terminate();
  });

  it("drops a pending ticket nobody connected with when the board is registered", async () => {
    // A runtime server that is already the board's keeps its connection when
    // it is introduced again, so the ticket issued for that goes unused — and
    // the one the server holds has to go on counting.
    const host = await coordinatorHost();
    const issue = async () =>
      (await host.coordinator.issueTickets("user-1", "doorbell", ["node"])).node;
    const first = await issue();
    const unused = await issue();

    await host.coordinator.registerBoard("user-1", board());

    expect(await outcome(joinSocket(host, unused))).toBe("refused 401");
    expect(host.coordinator.participants.resolve(first)).toBeTruthy();
  });

  it("keeps a server waiting with a pending ticket waiting when the board's server drops", async () => {
    // A deploy that got this far and no further must not take effect later,
    // the next time the connection it would have replaced blinks.
    const host = await coordinatorHost();
    const issue = async () =>
      (await host.coordinator.issueTickets("user-1", "doorbell", ["node"])).node;
    const first = await issue();
    const holder = await joinAs(host, first);
    const waiting = await joinAs(host, await issue());

    holder.terminate();
    await eventually(
      () =>
        !host.coordinator.participants
          .describe("user-1", "doorbell")
          .some((p) => p.connected),
      "the runtime to have no server",
    );

    // Still the first ticket's place to come back to.
    const back = await joinAs(host, first);
    expect(
      host.coordinator.participants
        .describe("user-1", "doorbell")
        .map((p) => p.connected),
    ).toEqual([true]);
    expect(waiting.readyState).toBe(WebSocket.OPEN);
    back.terminate();
    waiting.terminate();
  });

  it("takes back a failed deploy's tickets and lets the servers waiting with them go", async () => {
    const host = await coordinatorHost();
    const issue = async () =>
      (await host.coordinator.issueTickets("user-1", "doorbell", ["node"])).node;
    const first = await issue();
    const holder = await joinAs(host, first);
    await host.coordinator.registerBoard("user-1", board());
    const second = await issue();
    const waiting = await joinAs(host, second);
    const letGo = new Promise<number>((resolve) =>
      waiting.on("close", (code) => resolve(code)),
    );

    await request(host.url.replace("/coordinator", ""))
      .delete("/coordinator/users/user-1/boards/doorbell/tickets")
      .expect(204);

    expect(await letGo).toBe(CLOSE_TICKET_REVOKED);
    expect(host.coordinator.participants.resolve(second)).toBeNull();
    expect(host.coordinator.participants.resolve(first)).toBeTruthy();
    expect(holder.readyState).toBe(WebSocket.OPEN);
    holder.terminate();
  });

  it("takes back every ticket of a board that was never registered", async () => {
    // A first deploy that failed: nothing else holds these tickets together.
    const host = await coordinatorHost();
    const { node: ticket } = await host.coordinator.issueTickets(
      "user-1",
      "doorbell",
      ["node"],
    );

    host.coordinator.cancelTickets("user-1", "doorbell");

    expect(host.coordinator.participants.resolve(ticket)).toBeNull();
  });

  it("speaks for one runtime of one board of one person", async () => {
    const host = await coordinatorHost();
    const { node: ticket } = await host.coordinator.issueTickets(
      "user-1",
      "doorbell",
      ["node"],
    );

    expect(host.coordinator.participants.resolve(ticket)).toEqual({
      userId: "user-1",
      boardName: "doorbell",
      runtimeId: "node",
    });
  });

  it("stops being a way in when the board is deployed without that runtime", async () => {
    // A stale ticket: the board changed and no longer has the runtime it was
    // issued for. The runtime server holding it lets go of the runtime.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board(), { node: server });

    await host.coordinator.registerBoard(
      "user-1",
      board({
        runtimes: [{ id: "ui", name: "Browser", type: "browser" }],
        services: { ui: [] },
      }),
    );

    await eventually(
      () => server.coordinatorLinks.list(OWNER).length === 0,
      "the runtime server to drop its link",
    );
    expect(host.coordinator.participants.describe("user-1", "doorbell")).toEqual(
      [],
    );
    expect(boardRuntime(server, "node")).toBeUndefined();
  });

  it("are all revoked when the board is deleted, and the runtimes released", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board(), { node: server });

    await host.coordinator.removeBoard("user-1", "doorbell");

    expect(boardRuntime(server, "node")).toBeUndefined();
    await eventually(
      () => server.coordinatorLinks.list(OWNER).length === 0,
      "the runtime server to drop its link",
    );
  });

  it("hands the runtime to another server when the board is deployed there instead", async () => {
    // Moving a runtime to another machine is something a person does, by
    // deploying again. The machine it left must not keep a copy running.
    const host = await coordinatorHost();
    const laptop = await runtimeServer();
    const studio = await runtimeServer();
    await deploy(host, "user-1", board(), { node: laptop.server });

    const session = await deploy(host, "user-1", board(), {
      node: studio.server,
    });

    expect(session.getStatus()).toBe("running");
    expect(boardRuntime(studio.server, "node")).toBeTruthy();
    await eventually(
      () => !boardRuntime(laptop.server, "node"),
      "the first server to let go of its copy",
    );
  });
});

describe("deploying a running board again", () => {
  function twoRuntimes(): CloudBoardConfig {
    return board({
      runtimes: [
        { id: "a", name: "A", type: "rest" },
        { id: "b", name: "B", type: "rest" },
      ],
      services: {
        a: [{ uuid: "mon-a", serviceId: monitorDescriptor.serviceId }],
        b: [{ uuid: "mon-b", serviceId: monitorDescriptor.serviceId }],
      },
    });
  }

  it("leaves it as it was when the deploy fails part-way", async () => {
    // The second deploy gets as far as introducing one of two runtime servers
    // and stops there; the board is never registered again.
    const host = await coordinatorHost();
    const first = await runtimeServer();
    const second = await runtimeServer();
    const tickets = await host.coordinator.issueTickets("user-1", "doorbell", [
      "a",
      "b",
    ]);
    const introduceTo = (
      server: RuntimeServer,
      runtimeId: string,
      ticket: string,
    ) =>
      server.coordinatorLinks.introduce({
        owner: OWNER,
        boardName: "doorbell",
        runtimeId,
        coordinatorUrl: host.url,
        ticket,
      });
    await introduceTo(first.server, "a", tickets.a);
    await introduceTo(second.server, "b", tickets.b);
    const session = await host.coordinator.registerBoard(
      "user-1",
      twoRuntimes(),
    );
    expect(session.getStatus()).toBe("running");

    const again = await host.coordinator.issueTickets("user-1", "doorbell", [
      "a",
      "b",
    ]);
    await introduceTo(first.server, "a", again.a);
    // ...and gives up, as a person's client does when an introduction fails.
    host.coordinator.cancelTickets("user-1", "doorbell");

    // Nothing moved: each server holds the ticket it had, which still counts,
    // and the tickets of the deploy that failed are no way in.
    expect(host.coordinator.participants.resolve(tickets.a)).toBeTruthy();
    expect(host.coordinator.participants.resolve(tickets.b)).toBeTruthy();
    expect(host.coordinator.participants.resolve(again.a)).toBeNull();
    expect(host.coordinator.participants.resolve(again.b)).toBeNull();
    expect(session.getStatus()).toBe("running");
    expect(session.getErrors()).toEqual([]);
    expect(
      host.coordinator.participants
        .describe("user-1", "doorbell")
        .map((p) => `${p.runtimeId} ${p.connected}`)
        .sort(),
    ).toEqual(["a true", "b true"]);
    expect(boardRuntime(first.server, "a")).toBeTruthy();
    expect(boardRuntime(second.server, "b")).toBeTruthy();
    expect(host.coordinator.getBoard("user-1", "doorbell")).toBe(session);
  });

  it("does not move a runtime when the deploy that would have is given up", async () => {
    const host = await coordinatorHost();
    const laptop = await runtimeServer();
    const studio = await runtimeServer();
    const session = await deploy(host, "user-1", board(), {
      node: laptop.server,
    });
    await introduce(host, "user-1", "doorbell", { node: studio.server });

    host.coordinator.cancelTickets("user-1", "doorbell");

    await eventually(
      () => studio.server.coordinatorLinks.list(OWNER).length === 0,
      "the server that was waiting to drop its link",
    );
    expect(laptop.server.coordinatorLinks.list(OWNER)).toMatchObject([
      { runtimeId: "node", connected: true, running: true },
    ]);
    expect(session.getStatus()).toBe("running");
  });

  it("moves a runtime to another server only once the board is registered", async () => {
    const host = await coordinatorHost();
    const laptop = await runtimeServer();
    const studio = await runtimeServer();
    const session = await deploy(host, "user-1", board(), {
      node: laptop.server,
    });

    await introduce(host, "user-1", "doorbell", { node: studio.server });

    // Welcomed and waiting: the board is still the laptop's to run.
    expect(studio.server.coordinatorLinks.list(OWNER)).toMatchObject([
      { runtimeId: "node", connected: true, running: false },
    ]);
    expect(laptop.server.coordinatorLinks.list(OWNER)).toMatchObject([
      { runtimeId: "node", connected: true, running: true },
    ]);
    expect(session.getStatus()).toBe("running");

    const moved = await host.coordinator.registerBoard("user-1", board());

    expect(moved.getStatus()).toBe("running");
    expect(boardRuntime(studio.server, "node")).toBeTruthy();
    await eventually(
      () => laptop.server.coordinatorLinks.list(OWNER).length === 0,
      "the first server to drop its link",
    );
    expect(boardRuntime(laptop.server, "node")).toBeUndefined();
  });
});

describe("a runtime id two boards share", () => {
  it("is a runtime of each board on the server they share", async () => {
    // Boards ship the same handful of ids. Deploying a second one must not
    // take the first one's runtime.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const doorbell = await deploy(host, "user-1", board(), { node: server });

    const garden = await deploy(
      host,
      "user-1",
      board({
        boardName: "garden",
        services: {
          node: [{ uuid: "mon-2", serviceId: monitorDescriptor.serviceId }],
        },
      }),
      { node: server },
    );

    expect(garden.getStatus()).toBe("running");
    expect(doorbell.getStatus()).toBe("running");
    const uuids = (boardName: string) =>
      boardRuntime(server, "node", boardName)!
        .listServices()
        .map((s) => s.uuid);
    expect(uuids("doorbell")).toEqual(["mon-1"]);
    expect(uuids("garden")).toEqual(["mon-2"]);

    await host.coordinator.stopBoard("user-1", "garden");

    expect(boardRuntime(server, "node", "garden")).toBeUndefined();
    expect(uuids("doorbell")).toEqual(["mon-1"]);
    expect(doorbell.getStatus()).toBe("running");
  });

  it("is not the runtime a client creates under that id", async () => {
    // What opening the same board in the playground does: it posts a runtime
    // under the id the deployed board uses, and deletes it when it leaves.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board(), { node: server });
    const deployed = boardRuntime(server, "node");

    await request(server.httpServer)
      .post("/runtimes")
      .send({ id: "node", name: "Node", boardName: "doorbell", services: [] })
      .expect(200);
    const listed = await request(server.httpServer).get("/runtimes").expect(200);
    await request(server.httpServer).delete("/runtimes/node").expect(200);
    await request(server.httpServer).delete("/runtimes").expect(200);

    // The client saw its own runtime and never the board's.
    expect(
      listed.body.runtimes.map((rt: { services: unknown[] }) => rt.services),
    ).toEqual([[]]);
    expect(boardRuntime(server, "node")).toBe(deployed);
    expect(session.getStatus()).toBe("running");
  });
});

describe("the coordinator's ticket routes", () => {
  it("issues a ticket per runtime named and shows who is connected, never a ticket", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const api = request(host.url.replace("/coordinator", ""));

    const issued = await api
      .post("/coordinator/users/user-1/boards/doorbell/tickets")
      .send({ runtimeIds: ["node", "py"] })
      .expect(201);
    expect(Object.keys(issued.body.tickets)).toEqual(["node", "py"]);

    await server.coordinatorLinks.introduce({
      owner: OWNER,
      boardName: "doorbell",
      runtimeId: "node",
      coordinatorUrl: host.url,
      ticket: issued.body.tickets.node,
    });

    const shown = await api
      .get("/coordinator/users/user-1/boards/doorbell/participants")
      .expect(200);
    expect(
      shown.body.participants.map(
        (p: { runtimeId: string; connected: boolean; server?: string }) => [
          p.runtimeId,
          p.connected,
          p.server,
        ],
      ),
    ).toEqual([
      ["node", true, "node"],
      ["py", false, undefined],
    ]);
    expect(JSON.stringify(shown.body)).not.toContain("hkpt_");
  });

  it("refuses a request that names no runtimes", async () => {
    const host = await coordinatorHost();

    await request(host.url.replace("/coordinator", ""))
      .post("/coordinator/users/user-1/boards/doorbell/tickets")
      .send({})
      .expect(400);
  });
});

describe("stopping a board", () => {
  it("releases its runtimes and keeps their servers connected, so Start needs no new tickets", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board(), { node: server });

    const stopped = await host.coordinator.stopBoard("user-1", "doorbell");

    expect(stopped!.getStatus()).toBe("stopped");
    expect(stopped!.getErrors()).toEqual([]);
    expect(boardRuntime(server, "node")).toBeUndefined();

    // Start is registering the same config again.
    const started = await host.coordinator.registerBoard("user-1", board());

    expect(started.getStatus()).toBe("running");
    expect(boardRuntime(server, "node")).toBeTruthy();
  });

  it("releases a runtime its server was away for, once that server reconnects", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board(), { node: server });
    const session = host.coordinator.getBoard("user-1", "doorbell")!;
    host.coordinator.participants.closeAll();
    await eventually(() => session.getStatus() === "error", "the drop to show");

    // Reconnection is quick, so stop in the window before it happens or after:
    // either way the runtime must be gone in the end.
    await host.coordinator.stopBoard("user-1", "doorbell");

    await eventually(
      () => !boardRuntime(server, "node"),
      "the orphaned runtime to be released",
    );
    expect(session.getStatus()).toBe("stopped");
  });
});
