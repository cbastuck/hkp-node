import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { createMemoryRecordStore } from "../src/services/recordStore";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { subServiceDescriptor } from "../src/services/sub-service";
import { storeDescriptor } from "../src/services/store";

/**
 * Which board a nested pipeline belongs to.
 *
 * A service that hosts a pipeline builds it with an id of its own and nothing
 * else, so a nested runtime starts with no owner and an empty board name. That
 * is invisible until something inside it keeps state: a `store` in a nested
 * pipeline would write against an empty board name, and the identical service
 * sitting beside its host would look in the board's table and find nothing.
 *
 * Both hosts have to hand the scope down, so both are pinned here — the bug
 * was found in `http-server-subservices` after `sub-service` already did it.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const BOARD = "Offer Intake";

/** A runtime whose nested pipeline stores what it is given. */
async function runtimeWith(host: Record<string, unknown>) {
  const records = createMemoryRecordStore();
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    recordStore: records,
  });
  servers.push(server);
  await server.start();

  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt-1",
      name: "Node",
      boardName: BOARD,
      services: [
        host,
        // The reader: same board, no nesting, nothing configured to connect the
        // two. Sharing a table is what being on one board means.
        {
          serviceId: storeDescriptor.serviceId,
          uuid: "reader",
          state: { mode: "list" },
        },
      ],
    })
    .expect(200);

  return { server, records };
}

const nestedStore = {
  instanceId: "dump",
  serviceId: "store",
  serviceName: "Dump",
  state: { mode: "put", key: "from-nested" },
};

describe("a nested pipeline belongs to the board around it", () => {
  it("stores against the board when the pipeline is behind an endpoint", async () => {
    // The case that failed: the record landed under an empty board name, so the
    // `list` beside it always came back empty.
    const { server, records } = await runtimeWith({
      serviceId: httpServerSubservicesDescriptor.serviceId,
      uuid: "http-1",
      state: {
        bypass: false,
        mode: "process_on_session",
        pipeline: [nestedStore],
      },
    });

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    const mount = new URL(String(body.__hkpMount));

    await request(server.httpServer)
      .post(mount.pathname)
      .send({ enquiry: true });

    // Give the store's write, which happens after the response, a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stored = await records.list({ owner: "anonymous", boardName: BOARD });
    expect(stored.map((r) => r.key)).toEqual(["from-nested"]);
  });

  it("stores against the board when the pipeline is inside a sub-service", async () => {
    const { server, records } = await runtimeWith({
      serviceId: subServiceDescriptor.serviceId,
      uuid: "sub-1",
      state: { pipeline: [nestedStore] },
    });

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ enquiry: true })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const stored = await records.list({ owner: "anonymous", boardName: BOARD });
    expect(stored.map((r) => r.key)).toEqual(["from-nested"]);
  });

  it("does not leave a nested record under an empty board name", async () => {
    // The shape of the bug, asserted directly: an unscoped nested runtime
    // writes to sha256("") and nothing on the board can ever read it.
    const { server, records } = await runtimeWith({
      serviceId: httpServerSubservicesDescriptor.serviceId,
      uuid: "http-1",
      state: {
        bypass: false,
        mode: "process_on_session",
        pipeline: [nestedStore],
      },
    });

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    await request(server.httpServer)
      .post(new URL(String(body.__hkpMount)).pathname)
      .send({ enquiry: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await records.list({ owner: "anonymous", boardName: "" })).toEqual([]);
  });
});
