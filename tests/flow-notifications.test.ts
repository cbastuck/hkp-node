import WebSocket from "ws";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";

type Server = ReturnType<typeof createRuntimeServer>;
const servers: Server[] = [];

async function startServer() {
  const server = createRuntimeServer({
    auth: { mode: "none" },
    externalHost: "127.0.0.1",
  });
  servers.push(server);
  const address = await server.start();
  return { server, baseUrl: address.baseUrl };
}

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

type Notification = { instanceId: string; state: string; data: unknown };

/** Collect __internal flow notifications until `done` is satisfied. */
function collectFlow(
  wsUrl: string,
  done: (seen: Notification[]) => boolean,
  onOpen?: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<Notification[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const seen: Notification[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `timed out; saw ${JSON.stringify(seen.map((s) => `${s.instanceId}:${s.state}`))}`,
        ),
      );
    }, timeoutMs);

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "notification") return;
      let payload: any;
      try {
        payload = JSON.parse(message.value);
      } catch {
        return;
      }
      if (!payload?.__internal) return;
      seen.push({
        instanceId: message.instanceId,
        state: payload.__internal.state,
        data: payload.__internal.data,
      });
      if (done(seen)) {
        clearTimeout(timer);
        socket.close();
        resolve(seen);
      }
    });

    socket.on("open", () => {
      void onOpen?.();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("flow notifications for self-emitting services", () => {
  it("reports a Timer's own output, not just the services after it", async () => {
    // Regression: a service that pushes from itself is never called by the
    // runtime loop, so the loop never reported it. The UI then showed a Timer
    // producing nothing while the Monitor right after it plainly received ticks.
    const { server, baseUrl } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: "timer",
            uuid: "timer-1",
            state: {
              periodic: true,
              periodicValue: 20,
              periodicUnit: "ms",
              running: true,
              start: true,
            },
          },
          { serviceId: "monitor", uuid: "mon-1" },
        ],
      })
      .expect(200);

    const seen = await collectFlow(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      (all) =>
        all.some(
          (n) => n.instanceId === "timer-1" && n.state === "call-process-finished",
        ),
    );

    const timerOutput = seen.find(
      (n) => n.instanceId === "timer-1" && n.state === "call-process-finished",
    );
    // The payload the Timer emitted is what the inspector displays.
    expect(timerOutput?.data).toMatchObject({ triggerCount: expect.any(Number) });

    // The service after it is still reported, as it always was.
    expect(
      seen.some((n) => n.instanceId === "mon-1" && n.state === "call-process"),
    ).toBe(true);
  });

  it("reports each service exactly once per tick", async () => {
    // http-server used to emit its own pair on top of the runtime's; a duplicate
    // would show every request twice in the UI.
    const { server, baseUrl } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        // A one-shot timer, started only once the socket is listening, so the
        // tick cannot be missed and the counts describe exactly one pass.
        services: [
          { serviceId: "timer", uuid: "timer-1", state: { periodic: false } },
          { serviceId: "monitor", uuid: "mon-1" },
        ],
      })
      .expect(200);

    const seen = await collectFlow(
      `${baseUrl.replace("http", "ws")}/rt-1`,
      (all) =>
        all.some(
          (n) => n.instanceId === "mon-1" && n.state === "call-process-finished",
        ),
      async () => {
        await request(server.httpServer)
          .post("/runtimes/rt-1/services/timer-1")
          .send({ start: true, immediate: true });
      },
    );

    const count = (instanceId: string, state: string) =>
      seen.filter((n) => n.instanceId === instanceId && n.state === state).length;

    expect(count("timer-1", "call-process")).toBe(1);
    expect(count("timer-1", "call-process-finished")).toBe(1);
    expect(count("mon-1", "call-process")).toBe(1);
  });
});
