import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { createMemoryRecordStore } from "../src/services/recordStore";
import { mapDescriptor } from "../src/services/map";
import { storeDescriptor } from "../src/services/store";

/**
 * Asking one service to do its job.
 *
 * Distinct from configuring it, and distinct from running the whole chain: a
 * facade button needs to say "you, with this payload, now". Before this, the
 * only verb it had was configure, so anything it needed to cause had to be
 * smuggled in as a config field a service read as a command.
 *
 * The service named here runs. `processFrom` deliberately skips the service it
 * names — it means "carry on behind me" — and that difference is the whole
 * reason this is a separate entry point rather than a flag on that one.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function serverWith(services: unknown[]) {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    recordStore: createMemoryRecordStore(),
  });
  servers.push(server);
  await server.start();
  await request(server.httpServer)
    .post("/runtimes")
    .send({ id: "rt-1", name: "Node", boardName: "Board", services })
    .expect(200);
  return server;
}

const tag = (uuid: string, value: string) => ({
  serviceId: mapDescriptor.serviceId,
  uuid,
  state: { mode: "add", template: { [uuid]: value } },
});

describe("processing at one service", () => {
  it("runs the service it names", async () => {
    const server = await serverWith([tag("first", "ran"), tag("second", "ran")]);

    const { body } = await request(server.httpServer)
      .post("/runtimes/rt-1/services/first/process")
      .send({ payload: true })
      .expect(200);

    expect(body.first).toBe("ran");
  });

  it("does not run what comes before it", async () => {
    const server = await serverWith([tag("first", "ran"), tag("second", "ran")]);

    const { body } = await request(server.httpServer)
      .post("/runtimes/rt-1/services/second/process")
      .send({ payload: true })
      .expect(200);

    expect(body.first).toBeUndefined();
    expect(body.second).toBe("ran");
  });

  it("carries on through the services after it", async () => {
    const server = await serverWith([tag("first", "ran"), tag("second", "ran")]);

    const { body } = await request(server.httpServer)
      .post("/runtimes/rt-1/services/first/process")
      .send({})
      .expect(200);

    expect(body.second).toBe("ran");
  });

  it("leaves configure meaning what it meant", async () => {
    // The old verb still only configures: it must not have become a way to
    // start work by accident.
    const server = await serverWith([
      { serviceId: storeDescriptor.serviceId, uuid: "queue", state: { mode: "release" } },
    ]);

    const { body } = await request(server.httpServer)
      .post("/runtimes/rt-1/services/queue")
      .send({ keys: ["nothing-here"] })
      .expect(200);

    expect(body.mode).toBe("release");
    expect(body.keys).toBeUndefined();
  });

  it("says so when there is no such service", async () => {
    const server = await serverWith([tag("first", "ran")]);

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/absent/process")
      .send({})
      .expect(404);
  });
});
