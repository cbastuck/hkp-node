import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { StopperService } from "../src/services/stopper";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { stopperDescriptor } from "../src/services/stopper";
import { mapDescriptor } from "../src/services/map";

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

describe("stopper", () => {
  it("returns null so the runtime stops there", () => {
    const stopper = new StopperService({
      uuid: "stop-1",
      serviceId: "stopper",
    } as never);
    expect(stopper.process({ anything: true }, () => {})).toBeNull();
  });

  it("passes input through when bypassed", () => {
    // Opens the chain back up without moving services around.
    const stopper = new StopperService({
      uuid: "stop-1",
      serviceId: "stopper",
      state: { bypass: true },
    } as never);
    expect(stopper.process({ kept: true }, () => {})).toEqual({ kept: true });
  });

  it("stops the services that follow it in the runtime", async () => {
    const { server } = await startServer();

    // The map would rewrite anything that reached it, so the result says
    // plainly whether it was called.
    const withServices = async (
      runtimeId: string,
      services: Array<Record<string, unknown>>,
    ) => {
      await request(server.httpServer)
        .post("/runtimes")
        .send({ id: runtimeId, name: "Node", services })
        .expect(200);
      const { body } = await request(server.httpServer)
        .post(`/runtimes/${runtimeId}`)
        .send({ value: 42 })
        .expect(200);
      return body;
    };

    const mapService = {
      serviceId: mapDescriptor.serviceId,
      uuid: "map-1",
      state: { mode: "replace", template: { reached: true } },
    };

    // Control: without the stopper the map runs and rewrites the value.
    expect(await withServices("rt-control", [mapService])).toEqual({
      reached: true,
    });

    expect(
      await withServices("rt-stopped", [
        { serviceId: stopperDescriptor.serviceId, uuid: "stop-1" },
        mapService,
      ]),
    ).toBeNull();
  });
});

describe("stopper after an http-server", () => {
  /**
   * The case that motivated adding it: a runtime that serves an endpoint sits
   * ahead of the runtime that calls it, and its result would otherwise be fed
   * into that caller — which calls the endpoint again.
   */
  async function serveWith(pipelineTail: Array<Record<string, unknown>>) {
    const { server } = await startServer();
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
              pipeline: [
                {
                  instanceId: "answer",
                  serviceId: "map",
                  serviceName: "Answer",
                  state: { mode: "replace", template: { answer: "hello" } },
                },
              ],
            },
          },
          ...pipelineTail,
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    return String(body.__hkpMount);
  }

  it("answers the HTTP caller with the pipeline result when nothing follows", async () => {
    const endpoint = await serveWith([]);
    const res = await fetch(`${endpoint}/hello`);
    expect(await res.json()).toEqual({ answer: "hello" });
  });

  it("blanks the HTTP response when a stopper follows the server", async () => {
    // http-server-subservices answers with whatever the *outer* pipeline
    // returned, not with what its own sub-pipeline produced. A stopper after it
    // therefore silences the chain and the response together — the two share
    // one value, so they cannot be decided separately.
    const endpoint = await serveWith([
      { serviceId: stopperDescriptor.serviceId, uuid: "stop-1" },
    ]);
    const res = await fetch(`${endpoint}/hello`);
    expect(await res.json()).toBeNull();
  });
});
