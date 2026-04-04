import http from "node:http";
import { AddressInfo } from "node:net";

import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";

import { MapService, mapDescriptor } from "./services/map";
import { MonitorService, monitorDescriptor } from "./services/monitor";
import { SubService, subServiceDescriptor } from "./services/sub-service";
import {
  HttpServerSubservicesService,
  httpServerSubservicesDescriptor,
} from "./services/http-server";
import { TimerService, timerDescriptor } from "./services/timer";
import { HostedRuntime, RuntimeApp } from "./runtime";
import {
  HostedServiceFactory,
  JsonRecord,
  RuntimeConfiguration,
  RuntimeNotification,
  ServiceConfiguration,
} from "./types";

type CreateRuntimeServerOptions = {
  allowedOrigins?: string;
  externalHost?: string;
  host?: string;
  name?: string;
};

type WsInboundMessage = {
  type?: string;
  params?: JsonRecord;
};

export function createRuntimeServer(options: CreateRuntimeServerOptions = {}) {
  const allowedOrigins = options.allowedOrigins ?? "*";
  const externalHost = options.externalHost ?? options.host ?? "127.0.0.1";
  const factories = new Map<string, HostedServiceFactory>([
    [
      monitorDescriptor.serviceId,
      {
        descriptor: monitorDescriptor,
        create: (config, _createService) => new MonitorService(config),
      },
    ],
    [
      mapDescriptor.serviceId,
      {
        descriptor: mapDescriptor,
        create: (config, _createService) => new MapService(config),
      },
    ],
    [
      subServiceDescriptor.serviceId,
      {
        descriptor: subServiceDescriptor,
        create: (config, createService) =>
          new SubService(config, createService),
      },
    ],
    [
      httpServerSubservicesDescriptor.serviceId,
      {
        descriptor: httpServerSubservicesDescriptor,
        create: (config, createService) =>
          new HttpServerSubservicesService(config, createService),
      },
    ],
    [
      timerDescriptor.serviceId,
      {
        descriptor: timerDescriptor,
        create: (config, _createService) => new TimerService(config),
      },
    ],
  ]);

  const runtimeApp = new RuntimeApp(factories);
  const expressApp = express();
  expressApp.use(
    cors({
      origin: allowedOrigins === "*" ? true : allowedOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    }),
  );
  expressApp.use(express.json());

  const httpServer = http.createServer(expressApp);
  const webSocketServer = new WebSocketServer({ noServer: true });
  const runtimeSockets = new Map<string, Set<WebSocket>>();

  function runtimeOutputUrl(runtimeId: string): string | undefined {
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    return `ws://${externalHost}:${address.port}/${runtimeId}`;
  }

  function serializeRuntime(runtime: HostedRuntime) {
    return runtime.serialize(runtimeOutputUrl(runtime.id));
  }

  function sendJsonNotification(
    runtimeId: string,
    notification: RuntimeNotification,
  ) {
    const sockets = runtimeSockets.get(runtimeId);
    if (!sockets || sockets.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: "notification",
      instanceId: notification.instanceId,
      value: JSON.stringify(notification.payload),
    });

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }

  function sendJsonResult(socket: WebSocket, result: unknown) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "result", data: result }));
  }

  function getRuntimeOr404(
    res: Response,
    runtimeId: string,
  ): HostedRuntime | null {
    const runtime = runtimeApp.getRuntime(runtimeId);
    if (!runtime) {
      res.sendStatus(404);
      return null;
    }
    return runtime;
  }

  expressApp.get("/runtimes", (_req, res) => {
    res.json({
      runtimes: runtimeApp
        .getRuntimes()
        .map((runtime) => serializeRuntime(runtime)),
      registry: runtimeApp.getRegistry(),
    });
  });

  expressApp.delete("/runtimes", (_req, res) => {
    runtimeApp.removeAllRuntimes();
    res.sendStatus(200);
  });

  expressApp.post("/runtimes", (req, res) => {
    if (
      !req.body ||
      (typeof req.body !== "object" && !Array.isArray(req.body))
    ) {
      res.sendStatus(400);
      return;
    }

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const runtimes: ReturnType<typeof serializeRuntime>[] = [];

    for (const payload of payloads) {
      const config = validateRuntimeConfiguration(payload);
      if (!config) {
        res.sendStatus(400);
        return;
      }

      const runtime = runtimeApp.createRuntime(config);
      runtime.registerNotificationTarget((notification) => {
        sendJsonNotification(runtime.id, notification);
      });
      runtime.registerResultTarget((result) => {
        const sockets = runtimeSockets.get(runtime.id);
        if (!sockets) return;
        for (const socket of sockets) {
          sendJsonResult(socket, result);
        }
      });
      runtimes.push(serializeRuntime(runtime));
    }

    res.json({ runtimes, registry: runtimeApp.getRegistry() });
  });

  expressApp.get("/runtimes/:runtimeId", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.delete("/runtimes/:runtimeId", (req, res) => {
    const removed = runtimeApp.removeRuntime(req.params.runtimeId);
    if (!removed) {
      res.sendStatus(404);
      return;
    }
    res.json({ id: req.params.runtimeId });
  });

  expressApp.post("/runtimes/:runtimeId/rearrange", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (
      !Array.isArray(req.body) ||
      !req.body.every((entry) => typeof entry === "string")
    ) {
      res.sendStatus(400);
      return;
    }
    if (!runtime.rearrangeServices(req.body)) {
      res.sendStatus(400);
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.post("/runtimes/:runtimeId", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (!isJsonRecord(req.body)) {
      res.sendStatus(400);
      return;
    }

    const result = runtime.process(req.body, () => {
      // Notifications are broadcast through runtime notification targets.
    });
    res.json(result);
  });

  expressApp.get("/runtimes/:runtimeId/inputs", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(serializeRuntime(runtime).inputs);
  });

  expressApp.get("/runtimes/:runtimeId/inputs/:inputId", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const input = serializeRuntime(runtime).inputs.find(
      (entry) => entry.id === req.params.inputId,
    );
    if (!input) {
      res.sendStatus(404);
      return;
    }
    res.json(input);
  });

  expressApp.get("/runtimes/:runtimeId/services", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    res.json(runtime.listServices());
  });

  expressApp.post("/runtimes/:runtimeId/services", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const config = validateServiceConfiguration(req.body);
    if (!config) {
      res.sendStatus(400);
      return;
    }

    try {
      const state = runtime.addService(config);
      res.json(state);
    } catch {
      res.sendStatus(400);
    }
  });

  expressApp.delete("/runtimes/:runtimeId/services/:instanceId", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    if (!runtime.removeService(req.params.instanceId)) {
      res.sendStatus(404);
      return;
    }
    res.json(serializeRuntime(runtime));
  });

  expressApp.post(
    "/runtimes/:runtimeId/services/:instanceId",
    async (req, res) => {
      const runtime = getRuntimeOr404(res, req.params.runtimeId);
      if (!runtime) {
        return;
      }
      if (!isJsonRecord(req.body)) {
        res.sendStatus(400);
        return;
      }

      let state = runtime.configureService(req.params.instanceId, req.body);
      if (!state) {
        res.sendStatus(404);
        return;
      }

      // Some services (for example http-server-subservices with port 0)
      // transition asynchronously and update state shortly after configure().
      state = await waitForServiceActivationState(
        runtime,
        req.params.instanceId,
      );

      res.json(state);
    },
  );

  expressApp.get("/runtimes/:runtimeId/services/:instanceId", (req, res) => {
    const runtime = getRuntimeOr404(res, req.params.runtimeId);
    if (!runtime) {
      return;
    }
    const service = runtime.getService(req.params.instanceId);
    if (!service) {
      res.sendStatus(404);
      return;
    }
    res.json(service.getState());
  });

  expressApp.get(
    "/runtimes/:runtimeId/services/:instanceId/property/:propertyId",
    (req, res) => {
      const runtime = getRuntimeOr404(res, req.params.runtimeId);
      if (!runtime) {
        return;
      }
      const service = runtime.getService(req.params.instanceId);
      if (!service) {
        res.sendStatus(404);
        return;
      }

      const state = service.getState();
      const property = state[req.params.propertyId];
      if (property === undefined) {
        res.sendStatus(404);
        return;
      }
      res.json(property);
    },
  );

  expressApp.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof SyntaxError) {
        res.sendStatus(400);
        return;
      }
      res.status(500).json({ error: err.message });
    },
  );

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const runtimeId = url.pathname.slice(1);
    if (!runtimeId || !runtimeApp.getRuntime(runtimeId)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      webSocketServer.emit("connection", websocket, request, runtimeId);
    });
  });

  webSocketServer.on(
    "connection",
    (socket: WebSocket, _request: http.IncomingMessage, runtimeId: string) => {
      const sockets = runtimeSockets.get(runtimeId) ?? new Set<WebSocket>();
      sockets.add(socket);
      runtimeSockets.set(runtimeId, sockets);

      socket.on("close", () => {
        const current = runtimeSockets.get(runtimeId);
        current?.delete(socket);
        if (current && current.size === 0) {
          runtimeSockets.delete(runtimeId);
        }
      });

      socket.on("message", (raw) => {
        let message: WsInboundMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (message.type === "readwrite") {
          return;
        }

        if (message.type === "processRuntime" && isJsonRecord(message.params)) {
          const runtime = runtimeApp.getRuntime(runtimeId);
          if (!runtime) {
            return;
          }
          const result = runtime.process(message.params, () => {
            // Notifications are broadcast through runtime notification targets.
          });
          sendJsonResult(socket, result);
        }
      });
    },
  );

  return {
    expressApp,
    httpServer,
    runtimeApp,
    async start(port = 0, host = options.host ?? "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });

      const address = httpServer.address() as AddressInfo;
      return {
        host,
        port: address.port,
        baseUrl: `http://${host}:${address.port}`,
      };
    },
    async stop() {
      for (const sockets of runtimeSockets.values()) {
        for (const socket of sockets) {
          socket.close();
        }
      }
      runtimeSockets.clear();

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRuntimeConfiguration(
  value: unknown,
): RuntimeConfiguration | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (!Array.isArray(value.services)) {
    return null;
  }

  const services: ServiceConfiguration[] = [];
  for (const entry of value.services) {
    const config = validateServiceConfiguration(entry);
    if (!config) {
      return null;
    }
    services.push(config);
  }

  return {
    id: value.id,
    name: value.name,
    boardName:
      typeof value.boardName === "string" ? value.boardName : undefined,
    services,
  };
}

function validateServiceConfiguration(
  value: unknown,
): ServiceConfiguration | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  if (typeof value.serviceId !== "string" || typeof value.uuid !== "string") {
    return null;
  }
  if (value.state !== undefined && !isJsonRecord(value.state)) {
    return null;
  }

  return {
    serviceId: value.serviceId,
    uuid: value.uuid,
    name: typeof value.name === "string" ? value.name : undefined,
    serviceName:
      typeof value.serviceName === "string" ? value.serviceName : undefined,
    state: value.state,
  };
}

async function waitForServiceActivationState(
  runtime: HostedRuntime,
  instanceId: string,
): Promise<JsonRecord> {
  const maxAttempts = 20;
  const delayMs = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const service = runtime.getService(instanceId);
    if (!service) {
      return {};
    }

    const state = service.getState();
    const bypass = state.bypass;
    const port = state.port;

    if (
      typeof bypass === "boolean" &&
      bypass === false &&
      typeof port === "number" &&
      port === 0
    ) {
      await sleep(delayMs);
      continue;
    }

    return state;
  }

  const service = runtime.getService(instanceId);
  return service?.getState() ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
