import { describe, expect, it } from "vitest";

import {
  childRun,
  contextFromWire,
  detached,
  HostedRuntime,
  newRun,
} from "../src/runtime";
import { SubService } from "../src/services/sub-service";
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
  readonly configured: Array<ProcessContext | null> = [];

  private host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  configure(): JsonRecord {
    this.configured.push(this.host?.currentContext() ?? null);
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

/**
 * Emits by itself, a moment after whatever armed it: on being configured, or
 * on being called with `{ arm: "detached" | "attached" }`.
 */
class Emitter implements HostedService {
  readonly serviceId = "emitter";
  readonly serviceName = "Emitter";
  readonly uuid: string;
  readonly emitted: Array<Promise<unknown>> = [];

  private host: RuntimeHost | null = null;

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  private emit(): void {
    const done = this.host?.processFrom(this.uuid, { tick: true }, () => {});
    if (done) {
      this.emitted.push(done);
    }
  }

  configure(): JsonRecord {
    setTimeout(() => this.emit(), 1);
    return {};
  }

  getState(): JsonRecord {
    return {};
  }

  process(input: unknown): unknown {
    const arm = (input as { arm?: string } | null)?.arm;
    if (arm === "detached") {
      setTimeout(() => detached(() => this.emit()), 1);
    } else if (arm === "attached") {
      setTimeout(() => this.emit(), 1);
    }
    return null;
  }
}

const person = (sub = "auth0|member"): ProcessContext => ({
  runId: `run-of-${sub}`,
  actor: { kind: "person", sub, expiresAt: Date.now() + 60_000 },
});

const soon = () => new Promise((resolve) => setTimeout(resolve, 20));

function runtimeOf(
  services: Array<{ uuid: string; kind?: "spy" | "puller" | "emitter" }>,
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
      if (kind === "emitter") {
        return new Emitter(config);
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

    runtime.process({}, () => {}, {
      runId: "outer",
      actor: { kind: "board" },
    });

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
    const captured = { runId: "captured", actor: { kind: "board" } as const };

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

  it("gives configure the context supplied by the framework", () => {
    const { runtime, spies } = runtimeOf([{ uuid: "a" }]);
    const run = {
      runId: "configured-by-member",
      actor: {
        kind: "person" as const,
        sub: "auth0|member",
        expiresAt: Date.now() + 60_000,
      },
    };

    runtime.configureService("a", {}, run);
    runtime.configureService("a", {});

    expect(spies.get("a")!.configured).toEqual([run, null]);
    expect(runtime.currentContext()).toBeNull();
  });

  it("ends a configure's run when configure returns", async () => {
    // What a service arms while being configured outlives the call, and keeps
    // its async context. It must not keep the run: the tick is the board's,
    // and a person's run expires.
    const { runtime, spies } = runtimeOf([
      { uuid: "source", kind: "emitter" },
      { uuid: "after" },
    ]);
    const seenBefore = spies.get("after")!.seen.length;

    runtime.configureService("source", {}, person());
    await soon();

    const seen = spies.get("after")!.seen.slice(seenBefore);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.actor).toEqual({ kind: "board" });
    expect(seen[0]?.runId).not.toBe(person().runId);
  });

  it("begins a run for work detached from the call that armed it", async () => {
    const { runtime, spies } = runtimeOf([
      { uuid: "source", kind: "emitter" },
      { uuid: "after" },
    ]);
    await soon();
    const seenBefore = spies.get("after")!.seen.length;

    await runtime.processAt("source", { arm: "attached" }, () => {}, person());
    await soon();
    await runtime.processAt("source", { arm: "detached" }, () => {}, person());
    await soon();

    const [attached, detachedRun] = spies.get("after")!.seen.slice(seenBefore);
    // Left alone, a callback continues the run it was scheduled in — which is
    // what lets a late answer still be the caller's.
    expect(attached?.actor.kind).toBe("person");
    expect(detachedRun?.actor).toEqual({ kind: "board" });
  });

  it("reports no run inside a detachment, and its own runs within it", () => {
    const { runtime, spies } = runtimeOf([{ uuid: "a" }]);
    let inside: ProcessContext | null | undefined;

    runtime.configureService("a", {}, person());
    const spy = spies.get("a")!;
    // From inside a call: the detachment hides it, and a pass begun there is
    // seen by the services it runs.
    spy.process = function (this: ContextSpy, input: unknown) {
      detached(() => {
        inside = runtime.currentContext();
        runtime.configureService("a", {}, person("auth0|other"));
      });
      return input;
    };
    runtime.process({}, () => {}, person());

    expect(inside).toBeNull();
    expect(spy.configured.at(-1)?.actor).toMatchObject({ sub: "auth0|other" });
  });
});

describe("a nested pipeline entered at a scoped address", () => {
  function scoped() {
    const spies = new Map<string, ContextSpy>();
    const create = (config: ServiceConfiguration): HostedService => {
      if (config.serviceId === "sub-service") {
        return new SubService(config, create as never);
      }
      const spy = new ContextSpy(config);
      spies.set(config.uuid, spy);
      return spy;
    };
    const runtime = new HostedRuntime(
      {
        id: "test",
        name: "test",
        services: [
          {
            serviceId: "sub-service",
            uuid: "scope",
            state: { pipeline: [{ serviceId: "spy", uuid: "inner" }] },
          },
        ],
      },
      create,
    );
    return { runtime, spies };
  }

  it("reports what happens inside as the run that entered it", async () => {
    // The runtime around the scope is never in a call here, so only the
    // nested runtime knows whose run a report belongs to. Reported without
    // it, a member's answer reads as the board's and is sent to everybody.
    const { runtime } = scoped();
    const actors: unknown[] = [];
    runtime.registerNotificationTarget((notification) => {
      if (notification.instanceId === "scope.inner") {
        actors.push(notification.context?.actor);
      }
    });

    await runtime.processAt("scope.inner", { n: 1 }, () => {}, person());

    expect(actors.length).toBeGreaterThan(0);
    for (const actor of actors) {
      expect(actor).toMatchObject({ kind: "person", sub: "auth0|member" });
    }
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
