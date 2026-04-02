import WebSocket from "ws";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { monitorDescriptor } from "../src/services/monitor";

describe("hkp-node runtime server", () => {
  const server = createRuntimeServer({ externalHost: "127.0.0.1" });
  let baseUrl = "";

  beforeAll(async () => {
    const address = await server.start();
    baseUrl = address.baseUrl;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await request(server.httpServer).delete("/runtimes").expect(200);
  });

  it("creates runtimes and returns the frontend registry shape", async () => {
    const response = await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node Runtime",
        boardName: "Board A",
        services: [],
      })
      .expect(200);

    expect(response.body.registry).toEqual([monitorDescriptor]);
    expect(response.body.runtimes).toHaveLength(1);
    expect(response.body.runtimes[0]).toMatchObject({
      id: "rt-1",
      name: "Node Runtime",
      boardName: "Board A",
      services: [],
      inputs: [],
    });
    expect(response.body.runtimes[0].outputUrl).toBe(`${baseUrl.replace("http", "ws")}/rt-1`);
  });

  it("adds, configures, queries, and removes services", async () => {
    await createRuntime();

    const createServiceResponse = await request(server.httpServer)
      .post("/runtimes/rt-1/services")
      .send({
        serviceId: monitorDescriptor.serviceId,
        uuid: "svc-1",
        state: { logToConsole: true, renderTextEditor: false },
      })
      .expect(200);

    expect(createServiceResponse.body).toMatchObject({
      logToConsole: true,
      renderTextEditor: false,
      message: "",
    });

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/svc-1")
      .send({ renderTextEditor: true, fileLogPath: "/tmp/monitor.log" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.renderTextEditor).toBe(true);
        expect(body.fileLogPath).toBe("/tmp/monitor.log");
      });

    await request(server.httpServer)
      .get("/runtimes/rt-1/services/svc-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.logToConsole).toBe(true);
        expect(body.renderTextEditor).toBe(true);
      });

    await request(server.httpServer)
      .get("/runtimes/rt-1/services/svc-1/property/logToConsole")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toBe(true);
      });

    await request(server.httpServer)
      .delete("/runtimes/rt-1/services/svc-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.services).toEqual([]);
      });
  });

  it("processes runtime input over websocket and broadcasts monitor notifications", async () => {
    const runtime = await createRuntime([
      {
        serviceId: monitorDescriptor.serviceId,
        uuid: "svc-1",
        state: { renderTextEditor: true },
      },
    ]);

    const messages = await new Promise<Array<any>>((resolve, reject) => {
      const socket = new WebSocket(runtime.outputUrl);
      const collected: Array<any> = [];

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for websocket events"));
      }, 5000);

      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "readwrite", id: "rt-1" }));
        socket.send(
          JSON.stringify({
            type: "processRuntime",
            params: { hello: "world" },
            context: null,
          }),
        );
      });

      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        collected.push(message);
        if (collected.some((entry) => entry.type === "notification") && collected.some((entry) => entry.type === "result")) {
          clearTimeout(timeout);
          socket.close();
          resolve(collected);
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const notification = messages.find((entry) => entry.type === "notification");
    const result = messages.find((entry) => entry.type === "result");

    expect(JSON.parse(notification.value)).toEqual({ hello: "world" });
    expect(notification.instanceId).toBe("svc-1");
    expect(result.data).toEqual({ hello: "world" });

    await request(server.httpServer)
      .get("/runtimes/rt-1/services/svc-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.message).toContain('"hello": "world"');
      });
  });

  async function createRuntime(services: Array<Record<string, unknown>> = []) {
    const response = await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node Runtime",
        services,
      })
      .expect(200);

    return response.body.runtimes[0];
  }
});