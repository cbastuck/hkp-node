import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth", () => ({ ANONYMOUS_SUB: "anonymous" }));

import {
  ResourceBinding,
  ResourceStore,
  formatResourceRef,
  parseResourceRef,
  readResourceBinding,
  readResourcesPayload,
  referencedResources,
} from "../src/resources";
import { HostedRuntime } from "../src/runtime";
import { MonitorService, monitorDescriptor } from "../src/services/monitor";
import { SubService, subServiceDescriptor } from "../src/services/sub-service";
import { HostedService, ServiceConfiguration } from "../src/types";

const ollamaBinding: ResourceBinding = {
  id: "llm",
  kind: "ollama",
  url: "http://127.0.0.1:11434",
};

const pgBinding: ResourceBinding = {
  id: "db",
  kind: "postgres",
  url: "postgres://127.0.0.1:5432/app",
  user: "app",
  password: "secret",
  database: "app",
};

function createTestService(config: ServiceConfiguration): HostedService {
  if (config.serviceId === subServiceDescriptor.serviceId) {
    return new SubService(config, createTestService);
  }
  return new MonitorService(config);
}

describe("resource references and payloads", () => {
  it("parses whole-value references and finds mentions anywhere", () => {
    expect(parseResourceRef("hkp-resource://llm")).toBe("llm");
    expect(parseResourceRef(formatResourceRef("db.main"))).toBe("db.main");
    expect(parseResourceRef("http://hkp-resource://llm")).toBeNull();
    expect(
      referencedResources({
        a: "hkp-resource://llm",
        nested: [{ b: "x ? 'hkp-resource://db' : 'hkp-resource://llm'" }],
      }),
    ).toEqual(["llm", "db"]);
  });

  it("reads bindings and null removals off the wire", () => {
    expect(readResourceBinding(ollamaBinding)).toEqual(ollamaBinding);
    expect(readResourceBinding({ id: "bad", kind: "unknown" })).toBeNull();
    expect(
      readResourcesPayload({
        llm: ollamaBinding,
        db: pgBinding,
        gone: null,
        invalid: { kind: "ollama" },
      }),
    ).toEqual({
      llm: ollamaBinding,
      db: pgBinding,
      gone: null,
    });
  });
});

describe("ResourceStore", () => {
  it("resolves bindings, checks kinds, reports unreachable bindings, and notifies subscribers", () => {
    const store = new ResourceStore();
    const changed: string[] = [];
    store.subscribe("llm", (id) => changed.push(id));

    store.replace({ llm: ollamaBinding, db: pgBinding });
    expect(changed).toEqual(["llm"]);
    expect(store.resolve("hkp-resource://llm", "ollama")).toEqual({
      resource: ollamaBinding,
      problem: "",
    });
    expect(store.resolve("hkp-resource://llm", "postgres")).toEqual({
      resource: null,
      problem: 'resource "llm" is of kind "ollama", not "postgres"',
    });
    expect(store.resolve("hkp-resource://missing")).toEqual({
      resource: null,
      problem: 'resource "missing" is not bound',
    });

    store.merge({
      llm: {
        ...ollamaBinding,
        unreachable: 'resource "llm" is bound to 127.0.0.1 on another machine',
      },
    });
    expect(changed).toEqual(["llm", "llm"]);
    expect(store.resolve("hkp-resource://llm", "ollama")).toEqual({
      resource: null,
      problem: 'resource "llm" is bound to 127.0.0.1 on another machine',
    });

    store.merge({ llm: null });
    expect(store.ids()).toEqual(["db"]);
  });
});

describe("HostedRuntime resource store and nested pipeline delegation", () => {
  it("populates the store from RuntimeConfiguration, merges updates, and delegates to SubService", () => {
    const runtime = new HostedRuntime(
      {
        id: "rt-1",
        name: "Node",
        resources: { llm: ollamaBinding },
        services: [
          {
            uuid: "sub",
            serviceId: subServiceDescriptor.serviceId,
            state: {
              pipeline: [
                {
                  serviceId: monitorDescriptor.serviceId,
                  instanceId: "inner",
                  state: {},
                },
              ],
            },
          },
        ],
      },
      createTestService,
    );

    expect(runtime.resources().ids()).toEqual(["llm"]);
    expect(runtime.resources().resolve("hkp-resource://llm", "ollama")).toEqual({
      resource: ollamaBinding,
      problem: "",
    });

    const sub = runtime.getService("sub") as unknown as {
      pipeline: HostedRuntime;
    };
    expect(sub.pipeline.resources().resolve("hkp-resource://llm", "ollama")).toEqual({
      resource: ollamaBinding,
      problem: "",
    });

    runtime.setResources(
      readResourcesPayload({
        db: pgBinding,
        llm: null,
      }),
    );
    expect(runtime.resources().ids()).toEqual(["db"]);
    expect(sub.pipeline.resources().resolve("hkp-resource://db", "postgres")).toEqual({
      resource: pgBinding,
      problem: "",
    });
    expect(runtime.resources().resolve("hkp-resource://llm").resource).toBeNull();
  });
});
