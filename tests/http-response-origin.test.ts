import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { mapDescriptor } from "../src/services/map";
import { stopperDescriptor } from "../src/services/stopper";

/**
 * What forms the HTTP response of `http-server-subservices`.
 *
 * The same three rows are pinned in every runtime that implements this service
 * (hkp-node, hkp-python, hkp-rt), because a board written against one must
 * behave the same on the others:
 *
 *   | nested pipeline | service after the server | answer comes from |
 *   |-----------------|--------------------------|-------------------|
 *   | yes             | no                       | nested pipeline   |
 *   | yes             | yes                      | nested pipeline   |
 *   | no              | yes                      | the outer runtime |
 *
 * The middle row is the point: configuring a nested pipeline declares a
 * handler, and services added behind the server must not silently rewrite what
 * an external caller receives.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const nested = {
  instanceId: "inner",
  serviceId: "map",
  serviceName: "Inner",
  state: { mode: "replace", template: { from: "subservice" } },
};

const outer = {
  serviceId: mapDescriptor.serviceId,
  uuid: "outer-1",
  state: { mode: "replace", template: { from: "outer" } },
};

async function endpointWith(options: {
  subservices: boolean;
  after: Array<Record<string, unknown>>;
}): Promise<string> {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  await server.start();

  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: "rt-1",
      name: "Node",
      services: [
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid: "http-1",
          state: {
            bypass: false,
            mode: "process_on_session",
            pipeline: options.subservices ? [nested] : [],
          },
        },
        ...options.after,
      ],
    })
    .expect(200);

  const { body } = await request(server.httpServer)
    .get("/runtimes/rt-1/services/http-1")
    .expect(200);
  return String(body.__hkpMount);
}

describe("what forms the HTTP response", () => {
  it("the nested pipeline answers when it is the only handler", async () => {
    const url = await endpointWith({ subservices: true, after: [] });
    expect(await (await fetch(url)).json()).toEqual({ from: "subservice" });
  });

  it("the nested pipeline still answers when services follow the server", async () => {
    // The outer service runs — it is a side effect of having served a request —
    // but it does not get to rewrite the answer.
    const url = await endpointWith({ subservices: true, after: [outer] });
    expect(await (await fetch(url)).json()).toEqual({ from: "subservice" });
  });

  it("the outer runtime answers when there is no nested pipeline", async () => {
    // Inversion of control: with no handler configured, the rest of the board
    // is the handler.
    const url = await endpointWith({ subservices: false, after: [outer] });
    expect(await (await fetch(url)).json()).toEqual({ from: "outer" });
  });

  it("a Stopper behind the server ends the chain without touching the answer", async () => {
    // The case this rule exists for: a runtime that serves an endpoint can be
    // made terminal — so it does not drive the runtime that calls it — while
    // still answering its callers.
    const url = await endpointWith({
      subservices: true,
      after: [{ serviceId: stopperDescriptor.serviceId, uuid: "stop-1" }],
    });
    expect(await (await fetch(url)).json()).toEqual({ from: "subservice" });
  });
});
