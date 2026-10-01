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
  CoordinatorHost,
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
    const { body } = await request(server.httpServer)
      .get("/runtimes/node")
      .expect(200);
    expect(body.services.map((s: { uuid: string }) => s.uuid)).toEqual([
      "mon-1",
    ]);
    // The coordinator's, until the coordinator says otherwise.
    expect(body.garbageCollected).toBe(false);
    expect(body.boardName).toBe("doorbell");
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
    second.server.runtimeApp
      .getRuntime(OWNER, "b")!
      .registerNotificationTarget((notification) => seen.push(notification.payload));

    // Something sets the first runtime going — here a caller of that server.
    first.server.runtimeApp.getRuntime(OWNER, "a")!.emitResult({ ping: 1 });

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
    await request(server.httpServer).get("/runtimes/node").expect(200);
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
    await request(server.httpServer).get("/runtimes/node").expect(200);
  });

  it("picks a runtime back up rather than rebuilding it when only the connection dropped", async () => {
    // Its state is live and the board's is not: a rebuild would throw away
    // whatever the runtime had been doing.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board(), { node: server });
    const before = server.runtimeApp.getRuntime(OWNER, "node");

    host.coordinator.participants.closeAll();
    await eventually(() => session.getStatus() === "error", "the drop to show");
    await eventually(() => session.getStatus() === "running", "the reconnect");

    expect(server.runtimeApp.getRuntime(OWNER, "node")).toBe(before);
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
    const { body } = await request(second.server.httpServer)
      .get("/runtimes/node")
      .expect(200);
    expect(body.services.map((s: { uuid: string }) => s.uuid)).toEqual([
      "mon-1",
    ]);
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

  it("stops accepting a ticket once it has been replaced", async () => {
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

    expect(await outcome(joinSocket(host, first))).toBe("refused 401");
    const accepted = joinSocket(host, second);
    expect(await outcome(accepted)).toBe("open");
    accepted.close();
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
    await request(server.httpServer).get("/runtimes/node").expect(404);
  });

  it("are all revoked when the board is deleted, and the runtimes released", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board(), { node: server });

    await host.coordinator.removeBoard("user-1", "doorbell");

    await request(server.httpServer).get("/runtimes/node").expect(404);
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
    await request(studio.server.httpServer).get("/runtimes/node").expect(200);
    await eventually(
      async () =>
        (await request(laptop.server.httpServer).get("/runtimes/node"))
          .status === 404,
      "the first server to let go of its copy",
    );
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
    await request(server.httpServer).get("/runtimes/node").expect(404);

    // Start is registering the same config again.
    const started = await host.coordinator.registerBoard("user-1", board());

    expect(started.getStatus()).toBe("running");
    await request(server.httpServer).get("/runtimes/node").expect(200);
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
      async () =>
        (await request(server.httpServer).get("/runtimes/node")).status === 404,
      "the orphaned runtime to be released",
    );
    expect(session.getStatus()).toBe("stopped");
  });
});
