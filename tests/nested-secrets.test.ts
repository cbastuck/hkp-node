import { describe, expect, it } from "vitest";

import { HostedRuntime } from "../src/runtime";
import { SubService, subServiceDescriptor } from "../src/services/sub-service";
import {
  HostedService,
  RuntimeHost,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../src/types";

/**
 * A service inside a pipeline resolves the same references as one outside it.
 *
 * Nothing provisions a nested runtime — no create payload reaches it — so its
 * own vault is always empty. It has to reach the runtime around it, however
 * deep it sits, or a credential-taking service could only ever be used at the
 * top level.
 */

/** Reports what it was able to resolve, so a test can see what it got. */
class Credentialed implements HostedService {
  readonly uuid: string;
  readonly serviceId = "credentialed";
  readonly serviceName = "Credentialed";
  private host: RuntimeHost | null = null;
  private secret = "";
  /** What the last call resolved, and where it said it was sending it. */
  resolved = "";

  static descriptor: ServiceRegistryEntry = {
    serviceId: "credentialed",
    serviceName: "Credentialed",
  };

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    this.secret = (config.state?.secret as string) ?? "";
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  getState() {
    return { secret: this.secret, resolved: this.resolved };
  }

  configure(config: Record<string, unknown>) {
    if (typeof config.secret === "string") {
      this.secret = config.secret;
    }
    return this.getState();
  }

  process(input: unknown): unknown {
    const vault = this.host?.secrets?.();
    this.resolved = vault
      ? vault.resolve(this.secret, { to: "api.example.com" }).value
      : "";
    return input;
  }
}

function createService(config: ServiceConfiguration): HostedService {
  if (config.serviceId === subServiceDescriptor.serviceId) {
    return new SubService(config, createService);
  }
  return new Credentialed(config);
}

function runtimeWith(services: ServiceConfiguration[]) {
  return new HostedRuntime(
    {
      id: "node-1",
      name: "node",
      services,
      secrets: { api: { value: "sk-1" } },
    },
    createService,
  );
}

/** The nested service, wherever it ended up. */
function found(runtime: HostedRuntime, uuid: string): Credentialed {
  const direct = runtime.getService(uuid) as unknown as Credentialed;
  if (direct) {
    return direct;
  }
  throw new Error(`no service ${uuid}`);
}

describe("secrets inside a nested pipeline", () => {
  it("resolves a reference held by a service one level down", async () => {
    const runtime = runtimeWith([
      {
        serviceId: "sub-service",
        uuid: "nest",
        state: {
          pipeline: [
            {
              serviceId: "credentialed",
              instanceId: "inner",
              state: { secret: "{{secret.api}}" },
            },
          ],
        },
      },
    ]);

    await runtime.process({}, () => {});

    const nest = found(runtime, "nest").getState() as Record<string, unknown>;
    const pipeline = (nest.pipeline ?? []) as Array<Record<string, any>>;
    expect(pipeline[0].state.resolved).toBe("sk-1");
  });

  it("resolves one two levels down, so nesting composes", async () => {
    const runtime = runtimeWith([
      {
        serviceId: "sub-service",
        uuid: "outer-nest",
        state: {
          pipeline: [
            {
              serviceId: "sub-service",
              instanceId: "inner-nest",
              state: {
                pipeline: [
                  {
                    serviceId: "credentialed",
                    instanceId: "deep",
                    state: { secret: "{{secret.api}}" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    await runtime.process({}, () => {});

    const outer = found(runtime, "outer-nest").getState() as Record<string, any>;
    const inner = outer.pipeline[0].state;
    expect(inner.pipeline[0].state.resolved).toBe("sk-1");
  });

  it("sees a value pushed after the board was already running", async () => {
    const runtime = runtimeWith([
      {
        serviceId: "sub-service",
        uuid: "nest",
        state: {
          pipeline: [
            {
              serviceId: "credentialed",
              instanceId: "inner",
              state: { secret: "{{secret.later}}" },
            },
          ],
        },
      },
    ]);

    await runtime.process({}, () => {});
    let nest = found(runtime, "nest").getState() as Record<string, any>;
    expect(nest.pipeline[0].state.resolved).toBe("");

    runtime.setSecrets({ later: { value: "arrived" } });
    await runtime.process({}, () => {});

    nest = found(runtime, "nest").getState() as Record<string, any>;
    expect(nest.pipeline[0].state.resolved).toBe("arrived");
  });
});
