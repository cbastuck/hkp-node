import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { monitorDescriptor } from "../src/services/monitor";
import {
  FAST_LINKS,
  fakeParticipants,
  startCoordinator,
  startSession,
} from "./cloud";

/**
 * What posting a runtime means.
 *
 * `POST /runtimes` **provisions**: it builds the runtime the payload describes,
 * replacing anything under that id. Taking over one that is already running is
 * a different intent with its own verb — `GET /runtimes/:id` — which a client
 * uses before posting when it means "resume", not "build this". Keeping the two
 * apart is what let every runtime agree: hkp-node used to reuse on a repeat
 * post, hkp-python and hkp-rt rebuilt, and each was guessing at an intent the
 * caller had not stated.
 *
 * Replacing also matters for the lifecycle the payload declares. Reusing would
 * keep the *old* runtime's, so a board deployed to a coordinator could inherit
 * a browser's "clean me up when I disconnect" and vanish with that browser.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    coordinatorLinkOptions: FAST_LINKS,
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

async function provision(
  server: Server,
  runtimeId: string,
  services: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  await request(server.httpServer)
    .post("/runtimes")
    .send({ id: runtimeId, name: "Node", services, ...extra })
    .expect(200);
}

const endpointService = {
  uuid: "http-1",
  serviceId: httpServerSubservicesDescriptor.serviceId,
  state: {
    bypass: false,
    mode: "process_on_session",
    pipeline: [
      {
        instanceId: "answer",
        serviceId: "map",
        serviceName: "Answer",
        state: { mode: "replace", template: { answer: "hello" } },
      },
    ],
  },
};

async function publishedMount(server: Server, runtimeId: string): Promise<string> {
  const { body } = await request(server.httpServer)
    .get(`/runtimes/${runtimeId}/services/http-1`)
    .expect(200);
  return String(body.__hkpMount);
}

describe("posting a runtime id that already exists", () => {
  it("builds it again, and its mounts with it", async () => {
    const { server } = await startServer();
    await provision(server, "rt-1", [endpointService]);

    const first = await publishedMount(server, "rt-1");
    expect((await fetch(first)).status).toBe(200);

    await provision(server, "rt-1", [endpointService]);

    // The address is derived from what identifies the mount, so rebuilding
    // reproduces it. What proves the rebuild is that the endpoint still
    // answers after the old runtime was destroyed.
    const second = await publishedMount(server, "rt-1");
    // Same address, and it answers: a rebuilt runtime re-derives the endpoint
    // it had rather than being handed a new one. Anything outside pointing at
    // it — a webhook configured in somebody else's product — keeps working.
    expect(second).toBe(first);
    expect((await fetch(second)).status).toBe(200);
  });

  it("takes the services the caller asked for", async () => {
    // Posting describes what the runtime should be, so a board whose services
    // changed gets those services — no separate update path needed.
    const { server } = await startServer();
    await provision(server, "rt-1", [
      { uuid: "mon-1", serviceId: monitorDescriptor.serviceId },
    ]);
    await provision(server, "rt-1", [
      { uuid: "mon-2", serviceId: monitorDescriptor.serviceId },
    ]);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services")
      .expect(200);
    expect(body.map((svc: { uuid: string }) => svc.uuid)).toEqual(["mon-2"]);
  });

  it("takes the lifecycle the caller declared", async () => {
    // The reason reusing would be wrong: a deploy must not inherit a browser's
    // "clean me up when I disconnect".
    const { server } = await startServer();
    await provision(server, "rt-1", [], { garbageCollected: true });
    await provision(server, "rt-1", [], { garbageCollected: false });

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1")
      .expect(200);
    expect(body.garbageCollected).toBe(false);
  });

  it("is scoped per runtime id", async () => {
    const { server } = await startServer();
    await provision(server, "rt-1", [endpointService]);
    await provision(server, "rt-2", [endpointService]);

    expect(await publishedMount(server, "rt-2")).not.toBe(
      await publishedMount(server, "rt-1"),
    );
  });
});

describe("deploying a board", () => {
  it("provisions runtimes that outlive every browser", async () => {
    // The point of deploying: the coordinator owns the board, so its runtimes
    // are not tied to whoever is watching. A viewer that never provisions
    // cannot disturb them either.
    const { server } = await startServer();
    const host = await startCoordinator();
    cleanups.push(host.stop);
    const fakes = fakeParticipants();
    const consumer = fakes.join("rt-consumer");

    const session = await startSession(
      host,
      {
        boardName: "board-1",
        runtimes: [
          { id: "rt-owner", name: "Owner", type: "rest" },
          { id: "rt-consumer", name: "Consumer", type: "rest" },
        ],
        services: {
          "rt-owner": [endpointService],
          "rt-consumer": [
            {
              uuid: "consumer-1",
              serviceId: monitorDescriptor.serviceId,
              state: { __hkpMount: "hkp-mount://rt-owner/http-1" },
            },
          ],
        },
      },
      { "rt-owner": server },
      fakes.participants,
    );
    cleanups.push(() => session.destroy());

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-owner")
      .expect(200);
    expect(body.garbageCollected).toBe(false);

    // And the address it resolved for the consumer is live.
    const configure = consumer.requests.find(
      (request) => request.op === "configureService",
    ) as { config: Record<string, unknown> };
    expect((await fetch(String(configure.config.__hkpMount))).status).toBe(200);
  });
});
