import WebSocket from "ws";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { mapDescriptor } from "../src/services/map";
import { monitorDescriptor } from "../src/services/monitor";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { subServiceDescriptor } from "../src/services/sub-service";
import { timerDescriptor } from "../src/services/timer";
import { peerServerDescriptor } from "../src/services/peer-server";
import { imapEmailDescriptor } from "../src/services/imap-email";
import { telegramListenerDescriptor } from "../src/services/telegram-listener";
import { telegramSenderDescriptor } from "../src/services/telegram-sender";

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

    expect(response.body.registry).toEqual([
      monitorDescriptor,
      mapDescriptor,
      subServiceDescriptor,
      httpServerSubservicesDescriptor,
      timerDescriptor,
      peerServerDescriptor,
      imapEmailDescriptor,
      telegramListenerDescriptor,
      telegramSenderDescriptor,
    ]);
    expect(response.body.runtimes).toHaveLength(1);
    expect(response.body.runtimes[0]).toMatchObject({
      id: "rt-1",
      name: "Node Runtime",
      boardName: "Board A",
      services: [],
      inputs: [],
    });
    expect(response.body.runtimes[0].outputUrl).toBe(
      `${baseUrl.replace("http", "ws")}/rt-1`,
    );
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
        const notifications = collected.filter(
          (entry) => entry.type === "notification",
        );
        const hasProcessStart = notifications.some((entry) => {
          try {
            return (
              JSON.parse(entry.value)?.__internal?.state === "call-process"
            );
          } catch {
            return false;
          }
        });
        const hasProcessDone = notifications.some((entry) => {
          try {
            return (
              JSON.parse(entry.value)?.__internal?.state ===
              "call-process-finished"
            );
          } catch {
            return false;
          }
        });
        const hasPayloadNotification = notifications.some((entry) => {
          try {
            const parsed = JSON.parse(entry.value);
            return parsed?.hello === "world";
          } catch {
            return false;
          }
        });

        if (
          hasProcessStart &&
          hasProcessDone &&
          hasPayloadNotification &&
          collected.some((entry) => entry.type === "result")
        ) {
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

    const notifications = messages.filter(
      (entry) => entry.type === "notification",
    );
    const payloadNotification = notifications.find((entry) => {
      try {
        const parsed = JSON.parse(entry.value);
        return parsed?.hello === "world";
      } catch {
        return false;
      }
    });
    const startNotification = notifications.find((entry) => {
      try {
        return JSON.parse(entry.value)?.__internal?.state === "call-process";
      } catch {
        return false;
      }
    });
    const finishNotification = notifications.find((entry) => {
      try {
        return (
          JSON.parse(entry.value)?.__internal?.state === "call-process-finished"
        );
      } catch {
        return false;
      }
    });
    const result = messages.find((entry) => entry.type === "result");

    expect(startNotification).toBeDefined();
    expect(finishNotification).toBeDefined();
    expect(payloadNotification).toBeDefined();
    expect(JSON.parse(payloadNotification.value)).toEqual({ hello: "world" });
    expect(payloadNotification.instanceId).toBe("svc-1");
    expect(result.data).toEqual({ hello: "world" });

    await request(server.httpServer)
      .get("/runtimes/rt-1/services/svc-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.message).toBeUndefined();
      });
  });

  it("maps runtime payloads using map templates and mode semantics", async () => {
    await createRuntime([
      {
        serviceId: mapDescriptor.serviceId,
        uuid: "map-1",
        state: {
          mode: "overwrite",
          template: {
            greeting: "hello",
            "count=": "params.count + 1",
            "meta.kind": "mapped",
          },
        },
      },
    ]);

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ count: 3, preserved: true })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          count: 4,
          preserved: true,
          greeting: "hello",
          meta: { kind: "mapped" },
        });
      });

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/map-1")
      .send({ mode: "add", template: { "count=": "42" } })
      .expect(200);

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ count: 10 })
      .expect(200)
      .expect(({ body }) => {
        expect(body.count).toBe(10);
      });
  });

  it("supports sub-service pipelines with append/remove/configure operations", async () => {
    await createRuntime([
      {
        serviceId: subServiceDescriptor.serviceId,
        uuid: "sub-1",
        state: {
          pipeline: [
            {
              serviceId: monitorDescriptor.serviceId,
              instanceId: "sub-monitor-1",
              state: { logToConsole: false },
            },
          ],
        },
      },
    ]);

    const afterAppend = await request(server.httpServer)
      .post("/runtimes/rt-1/services/sub-1")
      .send({
        appendService: {
          serviceId: mapDescriptor.serviceId,
          state: {
            mode: "replace",
            template: {
              "count=": "params.count + 1",
            },
          },
        },
      })
      .expect(200);

    expect(afterAppend.body.pipeline).toHaveLength(2);
    const appendedMap = afterAppend.body.pipeline.find(
      (entry: any) => entry.serviceId === mapDescriptor.serviceId,
    );
    expect(typeof appendedMap.instanceId).toBe("string");
    expect(appendedMap.instanceId.length).toBeGreaterThan(0);

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ count: 3 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ count: 4 });
      });

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/sub-1")
      .send({
        configureService: {
          instanceId: appendedMap.instanceId,
          state: {
            mode: "add",
            template: {
              tag: "ok",
            },
          },
        },
      })
      .expect(200)
      .expect(({ body }) => {
        const mapEntry = body.pipeline.find(
          (entry: any) => entry.instanceId === appendedMap.instanceId,
        );
        expect(mapEntry.state.mode).toBe("add");
      });

    await request(server.httpServer)
      .post("/runtimes/rt-1")
      .send({ count: 3 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ tag: "ok", count: 3 });
      });

    await request(server.httpServer)
      .post("/runtimes/rt-1/services/sub-1")
      .send({ removeService: "sub-monitor-1" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.pipeline).toHaveLength(1);
        expect(body.pipeline[0].serviceId).toBe(mapDescriptor.serviceId);
      });
  });

  it("injects HTTP subservice output into downstream outer runtime services", async () => {
    await createRuntime([
      {
        serviceId: httpServerSubservicesDescriptor.serviceId,
        uuid: "http-sub-1",
        state: {
          bypass: false,
          mode: "process_on_session",
          port: 0,
          pipeline: [
            {
              serviceId: mapDescriptor.serviceId,
              instanceId: "inner-map-1",
              state: {
                mode: "replace",
                template: {
                  source: "http",
                  "path=": "params.path",
                  "method=": "params.method",
                },
              },
            },
          ],
        },
      },
      {
        serviceId: monitorDescriptor.serviceId,
        uuid: "outer-monitor-1",
      },
    ]);

    const configureResponse = await request(server.httpServer)
      .post("/runtimes/rt-1/services/http-sub-1")
      .send({ bypass: false })
      .expect(200);

    const port = configureResponse.body.port;
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);

    const curlLifecycleSeen = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${new URL(baseUrl).port}/rt-1`,
      );
      let sawStart = false;
      let sawFinish = false;
      let sawOuterMonitorPayload = false;
      const timeout = setTimeout(() => {
        socket.close();
        reject(
          new Error("Timed out waiting for curl process lifecycle events"),
        );
      }, 5000);

      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "notification") {
          return;
        }

        const payload = JSON.parse(message.value);
        if (
          message.instanceId === "http-sub-1" &&
          payload?.__internal?.state === "call-process"
        ) {
          sawStart = true;
        }
        if (
          message.instanceId === "http-sub-1" &&
          payload?.__internal?.state === "call-process-finished"
        ) {
          sawFinish = true;
        }

        if (
          message.instanceId === "outer-monitor-1" &&
          payload?.source === "http" &&
          payload?.path === "/hello" &&
          payload?.method === "GET"
        ) {
          sawOuterMonitorPayload = true;
        }

        if (sawStart && sawFinish && sawOuterMonitorPayload) {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      });

      socket.on("open", async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/hello`);
          expect(response.status).toBe(200);
        } catch (error) {
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    await expect(curlLifecycleSeen).resolves.toBeUndefined();

    const innerResponse = await fetch(`http://127.0.0.1:${port}/hello`);
    expect(innerResponse.status).toBe(200);
    const payload = await innerResponse.json();
    expect(payload).toEqual({ source: "http", path: "/hello", method: "GET" });
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
