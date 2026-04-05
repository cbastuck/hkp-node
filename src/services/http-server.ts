/**
 * Service Documentation
 * Service ID: http-server-subservices
 * Service Name: HttpServerSubservices
 * Runtime: hkp-node
 * Modes: session pipeline hosting
 * Key Config: host/port/routes/subservices
 * IO: in=request envelope -> out=response envelope
 * Arrays: not primary
 * Binary: depends on endpoint + nested services
 * MixedData: not native in runtime
 */
import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { HostedRuntime } from "../runtime";
import {
  HostedService,
  JsonRecord,
  RuntimeHost,
  ServiceConfiguration,
  ServiceCreator,
  ServiceRegistryEntry,
} from "../types";

export const httpServerSubservicesDescriptor: ServiceRegistryEntry = {
  serviceId: "http-server-subservices",
  serviceName: "HttpServerSubservices",
  capabilities: ["subservices"],
};

type HttpServerMode = "process_on_session" | "process_on_data";

type HttpServerSubservicesState = JsonRecord & {
  bypass: boolean;
  mode: HttpServerMode;
  port: number;
  pipeline: Array<{
    serviceId: string;
    instanceId: string;
    state: JsonRecord;
  }>;
};

export class HttpServerSubservicesService implements HostedService {
  readonly serviceId = httpServerSubservicesDescriptor.serviceId;
  readonly serviceName = httpServerSubservicesDescriptor.serviceName;
  readonly capabilities = httpServerSubservicesDescriptor.capabilities;
  readonly uuid: string;

  private bypass = true;
  private mode: HttpServerMode = "process_on_session";
  private port = 0;
  private latestData: unknown = null;

  private server: http.Server | null = null;
  private pipelineConfig: ServiceConfiguration[] = [];
  private pipeline: HostedRuntime | null = null;
  private readonly createService: ServiceCreator;
  private host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration, createService: ServiceCreator) {
    this.uuid = config.uuid;
    this.createService = createService;

    if (config.state) {
      this.configure(config.state);
    }
  }

  configure(config: JsonRecord): JsonRecord {
    const previousBypass = this.bypass;

    if (typeof config.port === "number" && Number.isInteger(config.port)) {
      if (
        config.port >= 0 &&
        config.port <= 65535 &&
        this.port !== config.port
      ) {
        this.port = config.port;
        if (this.server) {
          this.restartServer();
        }
      }
    }

    if (
      config.mode === "process_on_session" ||
      config.mode === "process_on_data"
    ) {
      this.mode = config.mode;
    }

    if (Array.isArray(config.pipeline)) {
      const nextPipeline = normalizePipelineArray(config.pipeline);
      if (!nextPipeline) {
        throw new Error("Invalid http-server-subservices pipeline format");
      }
      this.pipelineConfig = nextPipeline;
      this.rebuild();
    } else if (isJsonRecord(config.appendService)) {
      const appended = normalizePipelineEntry(config.appendService);
      if (!appended) {
        throw new Error("Invalid appendService payload");
      }
      this.syncStates();
      this.pipelineConfig.push(appended);
      this.rebuild();
    } else if (typeof config.removeService === "string") {
      this.syncStates();
      this.pipelineConfig = this.pipelineConfig.filter(
        (entry) => entry.uuid !== config.removeService,
      );
      this.rebuild();
    } else if (isJsonRecord(config.configureService)) {
      const payload = config.configureService;
      if (
        typeof payload.instanceId === "string" &&
        isJsonRecord(payload.state) &&
        this.pipeline
      ) {
        this.pipeline.configureService(payload.instanceId, payload.state);
        this.syncStates();
      }
    }

    if (typeof config.bypass === "boolean" && config.bypass !== this.bypass) {
      this.bypass = config.bypass;
      if (this.bypass) {
        this.stopServer();
      } else {
        this.startServer();
      }
    }

    if (previousBypass && !this.bypass && !this.server) {
      this.startServer();
    }

    return this.getState();
  }

  getState(): JsonRecord {
    const state: HttpServerSubservicesState = {
      bypass: this.bypass,
      mode: this.mode,
      port: this.port,
      pipeline: this.getPipelineState(),
    };
    return state;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  process(
    input: unknown,
    _notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    if (this.mode === "process_on_data") {
      this.latestData = input;
    }

    return input;
  }

  destroy(): void {
    this.stopServer();
    this.pipeline = null;
    this.pipelineConfig = [];
  }

  private restartServer(): void {
    this.stopServer();
    if (!this.bypass) {
      this.startServer();
    }
  }

  private startServer(): void {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    this.server.on("error", (error) => {
      console.error("http-server-subservices error", error);
    });

    this.server.listen(this.port, () => {
      const address = this.server?.address();
      if (address && typeof address !== "string") {
        this.port = address.port;
        this.notify({ port: this.port }, this.uuid);
      }
    });
  }

  private stopServer(): void {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }

    server.close((error) => {
      if (error) {
        console.error("http-server-subservices close error", error);
      }
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (this.bypass) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "http-server-subservices is bypassed" }));
      return;
    }

    let output: unknown;
    let processInput: unknown;
    if (this.mode === "process_on_data") {
      processInput = this.latestData;
      output = processInput;
    } else {
      const url = new URL(req.url ?? "/", "http://localhost");
      processInput = {
        path: url.pathname,
        method: req.method ?? "GET",
      };
      output = this.processSessionInput(processInput);
    }

    this.notify(
      {
        __internal: {
          state: "call-process",
          data: processInput,
        },
      },
      this.uuid,
    );

    if (this.host) {
      output = this.host.processFrom(this.uuid, output, (notification) => {
        this.notify(notification.payload, notification.instanceId);
      });
      this.host.emitResult(output);
    }

    this.notify(
      {
        __internal: {
          state: "call-process-finished",
          data: output,
        },
      },
      this.uuid,
    );

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    const json = JSON.stringify(output ?? null);
    res.end(json);
  }

  private processSessionInput(input: unknown): unknown {
    if (!this.pipeline || this.pipeline.listServices().length === 0) {
      return input;
    }

    return this.pipeline.process(input, (notification) => {
      this.notify(notification.payload, notification.instanceId);
    });
  }

  private notify(payload: unknown, instanceId?: string): void {
    this.host?.notify(payload, instanceId ?? this.uuid);
  }

  private syncStates(): void {
    if (!this.pipeline) {
      return;
    }

    const byId = new Map(
      this.pipeline
        .listServices()
        .map((service) => [service.uuid, service.state] as const),
    );

    this.pipelineConfig = this.pipelineConfig.map((entry) => {
      const state = byId.get(entry.uuid);
      if (!state || !isJsonRecord(state)) {
        return entry;
      }
      return { ...entry, state };
    });
  }

  private rebuild(): void {
    this.pipeline = new HostedRuntime(
      {
        id: `${this.uuid}:http-sub-runtime`,
        name: `${this.serviceName}-${this.uuid}`,
        boardName: "",
        services: this.pipelineConfig,
      },
      this.createService,
    );
  }

  private getPipelineState(): HttpServerSubservicesState["pipeline"] {
    if (!this.pipeline) {
      return this.pipelineConfig.map((entry) => ({
        serviceId: entry.serviceId,
        instanceId: entry.uuid,
        state: entry.state ?? {},
      }));
    }

    return this.pipeline.listServices().map((service) => ({
      serviceId: service.serviceId,
      instanceId: service.uuid,
      state: service.state,
    }));
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePipelineArray(
  value: unknown[],
): ServiceConfiguration[] | null {
  const result: ServiceConfiguration[] = [];
  for (const entry of value) {
    const normalized = normalizePipelineEntry(entry);
    if (!normalized) {
      return null;
    }
    result.push(normalized);
  }
  return result;
}

function normalizePipelineEntry(value: unknown): ServiceConfiguration | null {
  if (!isJsonRecord(value) || typeof value.serviceId !== "string") {
    return null;
  }

  const instanceId =
    typeof value.instanceId === "string" && value.instanceId.length > 0
      ? value.instanceId
      : typeof value.uuid === "string" && value.uuid.length > 0
        ? value.uuid
        : randomUUID();

  const state = value.state;
  if (state !== undefined && !isJsonRecord(state)) {
    return null;
  }

  return {
    serviceId: value.serviceId,
    uuid: instanceId,
    name: typeof value.name === "string" ? value.name : undefined,
    serviceName:
      typeof value.serviceName === "string" ? value.serviceName : undefined,
    state,
  };
}
