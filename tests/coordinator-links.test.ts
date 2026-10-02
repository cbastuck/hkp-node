import { promises as fs } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  createFileLinkStore,
  joinUrlFor,
} from "../src/coordinatorLinks";
import { CloudBoardConfig } from "../src/coordinator/types";
import { monitorDescriptor } from "../src/services/monitor";
import {
  CoordinatorHost,
  FAST_LINKS,
  boardRuntime,
  OWNER,
  RuntimeServer,
  deploy,
  eventually,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * The runtime server's end of a coordinator connection.
 *
 * A person's client tells a runtime server to connect to a coordinator, with a
 * ticket. These tests are about that server: what it accepts as an
 * introduction, what it keeps, and what the connection is able to do there.
 */

const hosts: CoordinatorHost[] = [];
const servers: RuntimeServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function coordinatorHost() {
  const host = await startCoordinator();
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

const board: CloudBoardConfig = {
  boardName: "doorbell",
  runtimes: [{ id: "node", name: "Node", type: "rest" }],
  services: {
    node: [{ uuid: "mon-1", serviceId: monitorDescriptor.serviceId }],
  },
};

async function ticketFor(host: CoordinatorHost, runtimeId = "node") {
  const tickets = await host.coordinator.issueTickets("user-1", "doorbell", [
    runtimeId,
  ]);
  return tickets[runtimeId];
}

describe("the address a runtime server connects to", () => {
  it("is the coordinator's join endpoint, over the matching socket scheme", () => {
    expect(joinUrlFor("http://127.0.0.1:8080/coordinator")).toBe(
      "ws://127.0.0.1:8080/coordinator/join",
    );
    expect(joinUrlFor("https://cloud.example/coordinator/")).toBe(
      "wss://cloud.example/coordinator/join",
    );
  });

  it("is refused when it is not an http address", () => {
    expect(() => joinUrlFor("file:///etc/passwd")).toThrow();
    expect(() => joinUrlFor("hkp://remotes/local")).toThrow();
    expect(() => joinUrlFor("not a url")).toThrow();
  });
});

describe("being introduced to a coordinator", () => {
  it("says it can be, beside what else it says about itself", async () => {
    const { server } = await runtimeServer();

    const { body } = await request(server.httpServer).get("/runtimes").expect(200);

    expect(body.coordinatorLinks).toBe(true);
    expect(body.server).toBe("node");
  });

  it("connects with the ticket it is handed and reports the link, never the ticket", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const ticket = await ticketFor(host);

    await request(server.httpServer)
      .post("/coordinator-links")
      .send({
        coordinatorUrl: host.url,
        ticket,
        boardName: "doorbell",
        runtimeId: "node",
      })
      .expect(201, { connected: true });

    const { body } = await request(server.httpServer)
      .get("/coordinator-links")
      .expect(200);
    expect(body.links).toEqual([
      {
        boardName: "doorbell",
        runtimeId: "node",
        coordinatorUrl: host.url,
        connected: true,
        // Introduced, and not yet built by the coordinator.
        running: false,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(ticket);
  });

  it("says why when the coordinator does not accept the ticket, and keeps nothing", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();

    const res = await request(server.httpServer)
      .post("/coordinator-links")
      .send({
        coordinatorUrl: host.url,
        ticket: "hkpt_made-up",
        boardName: "doorbell",
        runtimeId: "node",
      })
      .expect(502);

    expect(res.body.error).toMatch(/did not accept the ticket/);
    expect(server.coordinatorLinks.list(OWNER)).toEqual([]);
  });

  it("says why when there is no coordinator at that address", async () => {
    const { server } = await runtimeServer();

    const res = await request(server.httpServer)
      .post("/coordinator-links")
      .send({
        coordinatorUrl: "http://127.0.0.1:1/coordinator",
        ticket: "hkpt_whatever",
        boardName: "doorbell",
        runtimeId: "node",
      })
      .expect(502);

    expect(res.body.error).toBeTruthy();
    expect(server.coordinatorLinks.list(OWNER)).toEqual([]);
  });

  it("refuses an introduction that leaves something out", async () => {
    const { server } = await runtimeServer();

    await request(server.httpServer)
      .post("/coordinator-links")
      .send({ coordinatorUrl: "http://127.0.0.1:1/coordinator" })
      .expect(400);
  });

  it("keeps the link it had when a new introduction names a malformed address", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board, { node: server });

    await request(server.httpServer)
      .post("/coordinator-links")
      .send({
        coordinatorUrl: "file:///nope",
        ticket: "hkpt_x",
        boardName: "doorbell",
        runtimeId: "node",
      })
      .expect(502);

    expect(server.coordinatorLinks.list(OWNER)[0]?.connected).toBe(true);
  });
});

describe("what a link is able to do", () => {
  it("builds the runtime for the board it was introduced for, whatever it is told", async () => {
    // A ticket speaks for one board: the board name a runtime is built under
    // decides its mount addresses and where its data lives.
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await host.coordinator.issueTickets("user-1", "doorbell", ["node"]).then(
      (tickets) =>
        server.coordinatorLinks.introduce({
          owner: OWNER,
          boardName: "doorbell",
          runtimeId: "node",
          coordinatorUrl: host.url,
          ticket: tickets.node,
        }),
    );
    const participant = host.coordinator.participants
      .forBoard("user-1", "doorbell")
      .get("node")!;

    await participant.request({
      op: "provision",
      name: "Node",
      boardName: "someone-elses-board",
      state: {},
      services: [],
    });

    expect(boardRuntime(server, "node")?.scope().boardName).toBe("doorbell");
    expect(boardRuntime(server, "node", "someone-elses-board")).toBeUndefined();
  });

  it("answers an operation it does not know with an error rather than silence", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board, { node: server });
    const participant = host.coordinator.participants
      .forBoard("user-1", "doorbell")
      .get("node")!;

    await expect(
      participant.request({ op: "shell" } as never),
    ).rejects.toThrow(/Unknown operation/);
  });

  it("carries what the runtime says to the coordinator", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    await deploy(host, "user-1", board, { node: server });
    const heard: unknown[] = [];
    host.coordinator.participants
      .forBoard("user-1", "doorbell")
      .get("node")!
      .listen((event) => heard.push(event));

    void boardRuntime(server, "node")!
      .process({ hello: "there" }, () => {});

    await eventually(
      () =>
        heard.some(
          (event) =>
            (event as { type: string; serviceUuid?: string }).type ===
              "notification" &&
            (event as { serviceUuid?: string }).serviceUuid === "mon-1",
        ),
      "the monitor's notification",
    );
  });

  it("leaves a board when asked to, dropping the runtime it was for", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const session = await deploy(host, "user-1", board, { node: server });

    await request(server.httpServer).delete("/coordinator-links/doorbell/node").expect(200);

    expect(boardRuntime(server, "node")).toBeUndefined();
    expect(server.coordinatorLinks.list(OWNER)).toEqual([]);
    await eventually(() => session.getStatus() === "error", "the board to notice");
    await request(server.httpServer).delete("/coordinator-links/doorbell/node").expect(404);
  });
});

describe("a coordinator that is gone without having closed", () => {
  it("is reconnected to by a runtime server that noticed", async () => {
    // A network that vanished closes nothing. A link that went on waiting for
    // it would never come back, and the board would wait for it for ever.
    const hellos: number[] = [];
    const httpServer = http.createServer();
    // A coordinator that welcomes and then never answers a ping.
    const sockets = new WebSocketServer({ server: httpServer, autoPong: false });
    sockets.on("connection", (ws) => {
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "hello") {
          hellos.push(Date.now());
          ws.send(
            JSON.stringify({
              type: "welcome",
              boardName: "doorbell",
              runtimeId: "node",
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = httpServer.address() as AddressInfo;
    const { server } = await runtimeServer({
      coordinatorLinkOptions: { ...FAST_LINKS, heartbeatMs: 25 },
    });

    try {
      await server.coordinatorLinks.introduce({
        owner: OWNER,
        boardName: "doorbell",
        runtimeId: "node",
        coordinatorUrl: `http://127.0.0.1:${port}/coordinator`,
        ticket: "hkpt_any",
      });

      await eventually(() => hellos.length >= 2, "the link to reconnect");
    } finally {
      await server.stop();
      servers.splice(servers.indexOf(server), 1);
      sockets.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("keeping tickets on disk", () => {
  async function freshFile() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkp-links-"));
    roots.push(root);
    return path.join(root, "nested", "coordinator-links.json");
  }

  it("writes them where only their owner can read them", async () => {
    const file = await freshFile();
    const host = await coordinatorHost();
    const { server } = await runtimeServer({ coordinatorLinks: file });

    await deploy(host, "user-1", board, { node: server });

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const kept = JSON.parse(await fs.readFile(file, "utf8"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      owner: OWNER,
      boardName: "doorbell",
      runtimeId: "node",
      coordinatorUrl: host.url,
    });
  });

  it("reads back nothing from a file that is missing or not what it wrote", async () => {
    const file = await freshFile();
    expect(createFileLinkStore(file).load()).toEqual([]);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    expect(createFileLinkStore(file).load()).toEqual([]);

    await fs.writeFile(file, JSON.stringify([{ owner: "x" }, "junk"]));
    expect(createFileLinkStore(file).load()).toEqual([]);
  });

  it("forgets a link once the board has no use for it", async () => {
    const file = await freshFile();
    const host = await coordinatorHost();
    const { server } = await runtimeServer({ coordinatorLinks: file });
    await deploy(host, "user-1", board, { node: server });

    await host.coordinator.removeBoard("user-1", "doorbell");

    await eventually(
      async () => JSON.parse(await fs.readFile(file, "utf8")).length === 0,
      "the ticket to be removed from disk",
    );
  });
});

describe("credentials for a runtime a coordinator builds", () => {
  const withSecret: CloudBoardConfig = {
    boardName: "doorbell",
    runtimes: [{ id: "node", name: "Node", type: "rest" }],
    services: {
      node: [
        {
          uuid: "client",
          serviceId: "http-client",
          state: { url: "https://api.example", token: "{{secret.api.key}}" },
        },
      ],
    },
  };

  it("come from the person's client, straight to the runtime server", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const ticket = await ticketFor(host);
    await request(server.httpServer)
      .post("/coordinator-links")
      .send({
        coordinatorUrl: host.url,
        ticket,
        boardName: "doorbell",
        runtimeId: "node",
        secrets: { "api.key": { value: "s3cret" } },
      })
      .expect(201);

    const session = await host.coordinator.registerBoard("user-1", withSecret);

    expect(session.getStatus()).toBe("running");
    expect(
      boardRuntime(server, "node")!.secrets().aliases(),
    ).toEqual(["api.key"]);
  });

  it("are reported missing, by alias and by runtime, when the runtime server was handed none", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();

    const session = await deploy(host, "user-1", withSecret, { node: server });

    expect(session.getStatus()).toBe("error");
    expect(session.getErrors()).toEqual([
      'Runtime "node": needs configuration — its runtime server holds no value for api.key',
    ]);
  });

  it("never reach the coordinator", async () => {
    const host = await coordinatorHost();
    const { server } = await runtimeServer();
    const ticket = await ticketFor(host);
    await server.coordinatorLinks.introduce(
      {
        owner: OWNER,
        boardName: "doorbell",
        runtimeId: "node",
        coordinatorUrl: host.url,
        ticket,
      },
      { "api.key": { value: "s3cret" } },
    );
    const participant = host.coordinator.participants
      .forBoard("user-1", "doorbell")
      .get("node")!;

    const session = await host.coordinator.registerBoard("user-1", withSecret);
    const described = await participant.request({ op: "describe" });

    expect(JSON.stringify(described)).not.toContain("s3cret");
    expect(JSON.stringify(session.config)).not.toContain("s3cret");
    expect(JSON.stringify(participant.hello)).not.toContain("s3cret");
  });
});
