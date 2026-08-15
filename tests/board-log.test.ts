import { describe, expect, it } from "vitest";

import { HostedRuntime } from "../src/runtime";
import { MonitorService, monitorDescriptor } from "../src/services/monitor";
import { SubService, subServiceDescriptor } from "../src/services/sub-service";
import {
  HostedService,
  JsonRecord,
  LogEntry,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/** Records one entry each time it is called, through the host. */
class Talker implements HostedService {
  readonly serviceId = "talker";
  readonly serviceName = "Talker";
  readonly uuid: string;

  private host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  configure(): JsonRecord {
    return {};
  }

  getState(): JsonRecord {
    return {};
  }

  process(input: unknown): unknown {
    this.host?.log("info", "handled", { secret: "shhh" });
    return input;
  }
}

/** Passes its input on, and records nothing itself. */
class Passthrough implements HostedService {
  readonly serviceId = "passthrough";
  readonly serviceName = "Passthrough";
  readonly uuid: string;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
  }

  setHost(): void {}
  configure(): JsonRecord {
    return {};
  }
  getState(): JsonRecord {
    return {};
  }
  process(input: unknown): unknown {
    return input;
  }
}

/** Stops the chain, the way a Filter with a failed predicate does. */
class Stopper extends Passthrough {
  process(): unknown {
    return null;
  }
}

function createService(config: ServiceConfiguration): HostedService {
  if (config.serviceId === monitorDescriptor.serviceId) {
    return new MonitorService(config);
  }
  if (config.serviceId === subServiceDescriptor.serviceId) {
    return new SubService(config, createService);
  }
  return new Talker(config);
}

function runtimeWith(services: ServiceConfiguration[]) {
  const runtime = new HostedRuntime(
    { id: "node-1", name: "node", logging: true, services },
    createService,
  );
  const entries: LogEntry[] = [];
  runtime.registerLogTarget((entry) => entries.push(entry));
  return { runtime, entries };
}

describe("board log", () => {
  it("records nothing at all until the board turns logging on", () => {
    // Off by default: a board nobody is looking into has no reason to be
    // writing a line per call to somebody's disk.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      { id: "node-1", name: "node", services: [{ serviceId: "talker", uuid: "a" }] },
      createService,
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({}, () => {});
    expect(entries).toEqual([]);

    runtime.setLogging(true);
    runtime.process({}, () => {});
    expect(entries).toHaveLength(1);
  });

  it("records the flow itself, so a board can be debugged without a probe", () => {
    // The point of a run log for a board author: what ran, in what order, with
    // what. No service has to cooperate for this to exist.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        logLevel: "debug",
        services: [
          { serviceId: "passthrough", uuid: "a" },
          { serviceId: "passthrough", uuid: "b" },
        ],
      },
      (config) => new Passthrough(config),
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({ hello: true }, () => {});

    expect(entries.map((e) => `${e.serviceUuid}:${e.event}`)).toEqual([
      "a:service.process",
      "a:service.processed",
      "b:service.process",
      "b:service.processed",
    ]);
    expect(typeof entries[1].durationMs).toBe("number");
  });

  it("says where a run stopped", () => {
    // The question a board author actually asks. The service that stopped the
    // chain is the one that logged nothing, so only the runtime can answer.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        services: [
          { serviceId: "passthrough", uuid: "a" },
          { serviceId: "stopper", uuid: "b" },
          { serviceId: "passthrough", uuid: "c" },
        ],
      },
      (config) =>
        config.serviceId === "stopper"
          ? new Stopper(config)
          : new Passthrough(config),
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({}, () => {});

    // At the default level the flow is not kept, but the outcome is.
    const stopped = entries.find((e) => e.event === "pipeline.stopped")!;
    expect(stopped).toBeDefined();
    expect(stopped.serviceUuid).toBe("b");
    expect(stopped.level).toBe("info");
  });

  it("keeps the flow out unless the board asks for debug", () => {
    // Recorded at debug, so a board that keeps only what matters is not paying
    // for an entry per service call.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        services: [{ serviceId: "passthrough", uuid: "a" }],
      },
      (config) => new Passthrough(config),
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({}, () => {});
    expect(entries).toEqual([]);

    runtime.setLogLevel("debug");
    runtime.process({}, () => {});
    expect(entries.map((e) => e.event)).toEqual([
      "service.process",
      "service.processed",
    ]);
  });

  it("names the run and the service that produced an entry", () => {
    const { runtime, entries } = runtimeWith([
      { serviceId: "talker", uuid: "svc-a" },
      { serviceId: "talker", uuid: "svc-b" },
    ]);

    runtime.process({}, () => {});

    expect(entries).toHaveLength(2);
    expect(entries[0].serviceUuid).toBe("svc-a");
    expect(entries[1].serviceUuid).toBe("svc-b");
    expect(entries[0].runtimeId).toBe("node-1");
    expect(entries[0].event).toBe("handled");
    expect(entries[0].level).toBe("info");
    // One pass is one run, so both entries answer to the same id.
    expect(entries[1].runId).toBe(entries[0].runId);
    expect(entries[0].ts).toBeTruthy();
  });

  it("keeps what a service chose to record with its entry", () => {
    // A service that passes data has decided to record it; that per-service
    // choice is the gate.
    const { runtime, entries } = runtimeWith([
      { serviceId: "talker", uuid: "svc-a" },
    ]);

    runtime.process({}, () => {});

    expect(entries[0].data).toEqual({ secret: "shhh" });
  });

  it("lets a board refuse payloads whatever its services do", () => {
    // The board-wide override, for a deployment that must never write them.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        logData: false,
        services: [{ serviceId: "talker", uuid: "svc-a" }],
      },
      createService,
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({}, () => {});

    expect(entries[0].event).toBe("handled");
    expect(entries[0].data).toBeUndefined();
  });

  it("never puts the values passing through into the flow it records", () => {
    // Turning the level up asks for more of the shape of a run, not for the
    // data moving through it. Only a service can put that in a log.
    const entries: LogEntry[] = [];
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        logLevel: "debug",
        // Even with payloads allowed board-wide.
        logData: true,
        services: [{ serviceId: "passthrough", uuid: "a" }],
      },
      (config) => new Passthrough(config),
    );
    runtime.registerLogTarget((entry) => entries.push(entry));

    runtime.process({ secret: "shhh" }, () => {});

    expect(entries.map((e) => e.event)).toEqual([
      "service.process",
      "service.processed",
    ]);
    expect(entries.every((e) => e.data === undefined)).toBe(true);
  });

  it("keeps a nested pipeline's entries and says which run they belong to", () => {
    const { runtime, entries } = runtimeWith([
      { serviceId: "talker", uuid: "outer" },
      {
        serviceId: "sub-service",
        uuid: "nest",
        state: { pipeline: [{ serviceId: "talker", instanceId: "inner" }] },
      },
    ]);

    runtime.process({}, () => {});

    const outer = entries.find((entry) => entry.serviceUuid === "outer")!;
    const inner = entries.find((entry) => entry.serviceUuid === "inner")!;

    expect(inner).toBeDefined();
    // The nested pipeline is its own run, descended from the one that called it,
    // so a reader can rebuild the nesting rather than seeing a flat list.
    expect(inner.runId).not.toBe(outer.runId);
    expect(inner.parentRunId).toBe(outer.runId);
    // A nested runtime has no route out of its own; the entry still arrived.
    expect(inner.runtimeId).toBe("nest:sub-runtime");
  });

  it("records nothing when nobody is collecting", () => {
    const runtime = new HostedRuntime(
      {
        id: "node-1",
        name: "node",
        logging: true,
        services: [{ serviceId: "talker", uuid: "a" }],
      },
      createService,
    );

    // No target registered: the call still runs, it simply produces no entries.
    expect(() => runtime.process({}, () => {})).not.toThrow();
  });

  it("lets a monitor feed the log without a second service", () => {
    const { runtime, entries } = runtimeWith([
      { serviceId: "monitor", uuid: "probe", state: { logToBoard: true } },
    ]);

    runtime.process({ value: 1 }, () => {});

    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe("monitor");
    expect(entries[0].serviceUuid).toBe("probe");
  });

  it("stays quiet when the monitor was not asked to log", () => {
    const { runtime, entries } = runtimeWith([
      { serviceId: "monitor", uuid: "probe" },
    ]);

    runtime.process({ value: 1 }, () => {});

    expect(entries).toEqual([]);
  });
});
