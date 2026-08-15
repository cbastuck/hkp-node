import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { collectNotifications, collectState, flowCount } from "./collectState";
import { holdDescriptor } from "../src/services/hold";
import {
  HttpServerSubservicesService,
  httpServerSubservicesDescriptor,
} from "../src/services/http-server";
import { SubService, subServiceDescriptor } from "../src/services/sub-service";
import { timerDescriptor } from "../src/services/timer";

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

describe("sub-service notifications", () => {
  /**
   * Regression: a nested runtime has no notification targets of its own, and
   * SubService had no host to carry its pipeline's notifications out to. An
   * attached board saw nested services report nothing at all.
   */
  async function boardWithNestedTimer(server: Server) {
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "sub-1",
            state: {
              pipeline: [
                {
                  serviceId: timerDescriptor.serviceId,
                  uuid: "timer-1",
                  state: {
                    periodic: true,
                    periodicValue: 60,
                    periodicUnit: "s",
                  },
                },
                {
                  serviceId: holdDescriptor.serviceId,
                  uuid: "hold-1",
                  state: { property: "triggerCount" },
                },
              ],
            },
          },
        ],
      })
      .expect(200);
  }

  /** One tick, now, rather than waiting out the period. */
  function tick(server: Server) {
    return request(server.httpServer)
      .post("/runtimes/rt-1/services/sub-1")
      .send({
        configureService: {
          instanceId: "timer-1",
          state: { immediate: true, start: true },
        },
      })
      .expect(200);
  }

  it("reports a nested service's state to an attached board", async () => {
    const { server, baseUrl } = await startServer();
    await boardWithNestedTimer(server);

    const seen = await collectState(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      "hold-1",
      (states) => states.some((state) => state.writeCount >= 1),
      async () => {
        await tick(server);
      },
    );

    // The tick reached the Hold behind it, and the Hold's own report got out.
    expect(seen[seen.length - 1]).toMatchObject({ held: 1, writeCount: 1 });
  });

  it("reports each of a nested service's notifications exactly once", async () => {
    // Both failure modes at once. Zero means the nested runtime's reports are
    // being dropped; two means they travel by the host *and* by the callback
    // the outer runtime passes into process(). The flow (`__internal`) reports
    // are what double, since a service's own state goes by the host alone.
    const { server, baseUrl } = await startServer();
    await boardWithNestedTimer(server);

    const seen = await collectNotifications(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      async () => {
        await request(server.httpServer)
          .post("/runtimes/rt-1")
          .send({ triggerCount: 1 })
          .expect(200);
      },
    );

    expect(flowCount(seen, "hold-1", "call-process")).toBe(1);
    expect(flowCount(seen, "hold-1", "call-process-finished")).toBe(1);
    expect(
      seen.filter(
        (entry) =>
          entry.instanceId === "hold-1" && entry.payload?.writeCount === 1,
      ),
    ).toHaveLength(1);
  });
});

/**
 * Nested teardown is asserted on destroy() reaching the nested services rather
 * than on what stops arriving at the board: a leaked pipeline is unreachable,
 * so it goes quiet either way. Silence proves nothing; the call does.
 */
describe("nested pipeline teardown", () => {
  function recordingCreateService(destroyed: string[]) {
    return (config: { uuid: string }) => ({
      serviceId: "stub",
      serviceName: "Stub",
      uuid: config.uuid,
      configure: () => ({}),
      getState: () => ({}),
      process: (input: unknown) => input,
      destroy: () => destroyed.push(config.uuid),
    });
  }

  const pipelineOf = (uuid: string) => [{ serviceId: "stub", uuid }];

  it("destroys a sub-service's nested services with it", () => {
    const destroyed: string[] = [];
    const sub = new SubService(
      {
        uuid: "sub-1",
        serviceId: subServiceDescriptor.serviceId,
        state: { pipeline: pipelineOf("nested-1") },
      } as never,
      recordingCreateService(destroyed) as never,
    );

    sub.destroy();
    expect(destroyed).toEqual(["nested-1"]);
  });

  it("destroys the pipeline a sub-service replaces", () => {
    // The frequent path: every reconfiguration builds a new pipeline, and the
    // old one keeps its timers and sockets unless it is torn down.
    const destroyed: string[] = [];
    const sub = new SubService(
      {
        uuid: "sub-1",
        serviceId: subServiceDescriptor.serviceId,
        state: { pipeline: pipelineOf("nested-1") },
      } as never,
      recordingCreateService(destroyed) as never,
    );

    sub.configure({ pipeline: pipelineOf("nested-2") });
    expect(destroyed).toEqual(["nested-1"]);

    sub.destroy();
    expect(destroyed).toEqual(["nested-1", "nested-2"]);
  });

  it("destroys an http-server's nested services with it", () => {
    const destroyed: string[] = [];
    const endpoint = new HttpServerSubservicesService(
      {
        uuid: "http-1",
        serviceId: httpServerSubservicesDescriptor.serviceId,
        state: { pipeline: pipelineOf("nested-1") },
      } as never,
      recordingCreateService(destroyed) as never,
    );

    endpoint.configure({ pipeline: pipelineOf("nested-2") });
    expect(destroyed).toEqual(["nested-1"]);

    endpoint.destroy();
    expect(destroyed).toEqual(["nested-1", "nested-2"]);
  });
});
