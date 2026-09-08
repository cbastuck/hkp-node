import { describe, expect, it } from "vitest";

import {
  childRun,
  contextFromWire,
  HostedRuntime,
  newRun,
} from "../src/runtime";
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  ServiceConfiguration,
} from "../src/types";

/**
 * Records the context it was running under each time it is called, which is the
 * only way to observe attribution from outside: the context travels with the
 * call rather than with the data, so nothing about the input reveals it.
 */
class ContextSpy implements HostedService {
  readonly serviceId = "context-spy";
  readonly serviceName = "ContextSpy";
  readonly uuid: string;
  readonly seen: Array<ProcessContext | null> = [];

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
    this.seen.push(this.host?.currentContext() ?? null);
    return input;
  }
}

/** Calls the services after it from inside its own call — the pull pattern. */
class Puller implements HostedService {
  readonly serviceId = "puller";
  readonly serviceName = "Puller";
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
    this.host?.processFrom(this.uuid, input, () => {});
    return null;
  }
}

function runtimeOf(
  services: Array<{ uuid: string; kind?: "spy" | "puller" }>,
): { runtime: HostedRuntime; spies: Map<string, ContextSpy> } {
  const spies = new Map<string, ContextSpy>();
  const runtime = new HostedRuntime(
    {
      id: "test",
      name: "test",
      services: services.map(({ uuid }) => ({ serviceId: "spy", uuid })),
    },
    (config) => {
      const kind = services.find((s) => s.uuid === config.uuid)?.kind ?? "spy";
      if (kind === "puller") {
        return new Puller(config);
      }
      const spy = new ContextSpy(config);
      spies.set(config.uuid, spy);
      return spy;
    },
  );
  return { runtime, spies };
}

describe("process context", () => {
  it("gives every service in one pass the same run", () => {
    const { runtime, spies } = runtimeOf([{ uuid: "a" }, { uuid: "b" }]);

    runtime.process({}, () => {});

    const a = spies.get("a")!.seen[0];
    const b = spies.get("b")!.seen[0];
    expect(a?.runId).toBeTruthy();
    expect(b?.runId).toBe(a?.runId);
    expect(a?.parentRunId).toBeUndefined();
  });

  it("gives separate passes separate runs", () => {
    const { runtime, spies } = runtimeOf([{ uuid: "a" }]);

    runtime.process({}, () => {});
    runtime.process({}, () => {});

    const [first, second] = spies.get("a")!.seen;
    expect(first?.runId).toBeTruthy();
    expect(second?.runId).toBeTruthy();
    expect(second?.runId).not.toBe(first?.runId);
  });

  it("honours a context supplied by the caller", () => {
    const { runtime, spies } = runtimeOf([{ uuid: "a" }]);
    const context = newRun();

    runtime.process({}, () => {}, context);

    expect(spies.get("a")!.seen[0]?.runId).toBe(context.runId);
  });

  it("keeps a pulled call inside the run that pulled it", () => {
    // The pull is the inversion-of-control path: a service running the services
    // after it rather than returning to them. It is one run, not two.
    const { runtime, spies } = runtimeOf([
      { uuid: "before" },
      { uuid: "puller", kind: "puller" },
      { uuid: "after" },
    ]);

    runtime.process({}, () => {});

    const before = spies.get("before")!.seen[0];
    const after = spies.get("after")!.seen[0];
    expect(after?.runId).toBe(before?.runId);
  });

  it("restores the outer run once a nested call returns", () => {
    // A pull re-enters the runtime mid-pass. The services after the puller must
    // still see the run the outer pass was running under, not a leftover.
    const { runtime, spies } = runtimeOf([
      { uuid: "before" },
      { uuid: "puller", kind: "puller" },
      { uuid: "after" },
    ]);

    runtime.process({}, () => {}, { runId: "outer" });

    expect(spies.get("before")!.seen[0]?.runId).toBe("outer");
    expect(spies.get("after")!.seen[0]?.runId).toBe("outer");
  });

  it("starts a run when processFrom names none", () => {
    // A timer tick or an arriving message: nothing was in flight, so there is
    // nothing to continue.
    const { runtime, spies } = runtimeOf([{ uuid: "a" }, { uuid: "b" }]);

    runtime.processFrom("a", {}, () => {});

    const b = spies.get("b")!.seen[0];
    expect(b?.runId).toBeTruthy();
    expect(b?.parentRunId).toBeUndefined();
    // "a" pushed from itself, so it was never called.
    expect(spies.get("a")!.seen).toHaveLength(0);
  });

  it("continues the named run when processFrom is given one", () => {
    // What a service captured before leaving its call and handed back on
    // returning — an HTTP response, a delayed emit.
    const { runtime, spies } = runtimeOf([{ uuid: "a" }, { uuid: "b" }]);
    const captured = { runId: "captured" };

    runtime.processFrom("a", {}, () => {}, captured);

    expect(spies.get("b")!.seen[0]?.runId).toBe("captured");
  });

  it("reports no context outside a call", () => {
    const { runtime } = runtimeOf([{ uuid: "a" }]);

    expect(runtime.currentContext()).toBeNull();

    runtime.process({}, () => {});

    // The pass has returned; nothing is running.
    expect(runtime.currentContext()).toBeNull();
  });
});

describe("contextFromWire", () => {
  it("continues the run a peer named", () => {
    const context = contextFromWire({ runId: "from-peer", parentRunId: "its-parent" });

    expect(context?.runId).toBe("from-peer");
    expect(context?.parentRunId).toBe("its-parent");
  });

  it("begins a run when the peer named none", () => {
    // Work that cannot be attributed to anything is worse than work attributed
    // to a run of its own.
    const context = contextFromWire({ requestId: "reply-here" });

    expect(context?.runId).toBeTruthy();
    expect(context?.requestId).toBe("reply-here");
  });

  it("reports no context at all rather than inventing one", () => {
    expect(contextFromWire(undefined)).toBeUndefined();
    expect(contextFromWire(null)).toBeUndefined();
    expect(contextFromWire("not-an-object")).toBeUndefined();
  });

  it("ignores fields that are not strings", () => {
    const context = contextFromWire({ runId: 42, parentRunId: {} });

    expect(context?.runId).toBeTruthy();
    expect(context?.runId).not.toBe(42);
    expect(context?.parentRunId).toBeUndefined();
  });
});

describe("childRun", () => {
  it("descends from its parent", () => {
    const parent = newRun();
    const child = childRun(parent);

    expect(child.parentRunId).toBe(parent.runId);
    expect(child.runId).not.toBe(parent.runId);
  });

  it("starts a run of its own when there is no parent", () => {
    const child = childRun(null);

    expect(child.runId).toBeTruthy();
    expect(child.parentRunId).toBeUndefined();
  });
});
