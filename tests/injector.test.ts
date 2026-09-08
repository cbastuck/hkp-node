import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { collectState } from "./collectState";
import { InjectorService, injectorDescriptor } from "../src/services/injector";
import { monitorDescriptor } from "../src/services/monitor";
import { RuntimeHost } from "../src/types";

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function startServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

function makeInjector(state: Record<string, unknown> = {}) {
  return new InjectorService({
    uuid: "injector-1",
    serviceId: injectorDescriptor.serviceId,
    state,
  } as never);
}

/** A host that only records whether inject/injectBinary pushed downstream. */
function fakeHost() {
  const processFromCalls: unknown[] = [];
  const host = {
    processFrom: (_uuid: string, data: unknown) => {
      processFromCalls.push(data);
      return Promise.resolve(data);
    },
    emitResult: () => {},
    notify: () => {},
    currentContext: () => null,
  } as unknown as RuntimeHost;
  return { host, processFromCalls };
}

describe("injector", () => {
  it("passes input through while nothing has been injected", () => {
    const injector = makeInjector();
    expect(injector.process({ a: 1 }, () => {})).toEqual({ a: 1 });
    expect(injector.getState()).toEqual({ plainText: false });
  });

  it("returns the stored injection instead of the input once set", () => {
    const injector = makeInjector();
    injector.configure({ inject: { hello: "world" } });
    expect(injector.process({ a: 1 }, () => {})).toEqual({ hello: "world" });
  });

  it("keeps returning the stored injection on falsy values", () => {
    // A regression guard: falling back to the input on a falsy injection
    // (0, "", false) would make those values unreachable.
    const injector = makeInjector();
    injector.configure({ inject: 0 });
    expect(injector.process("anything", () => {})).toBe(0);

    injector.configure({ inject: "" });
    expect(injector.process("anything", () => {})).toBe("");

    injector.configure({ inject: false });
    expect(injector.process("anything", () => {})).toBe(false);
  });

  it("reports a text injection as recentInjection", () => {
    const injector = makeInjector();
    injector.configure({ inject: "plain text" });
    expect(injector.getState()).toMatchObject({
      recentInjection: "plain text",
    });
  });

  it("reports a binary injection by size, not by content", () => {
    const injector = makeInjector();
    const payload = Buffer.from("hello").toString("base64");
    injector.configure({ injectBinary: payload });
    expect(injector.getState()).toEqual({
      plainText: false,
      recentInjectionSize: 5,
    });
    expect(injector.process(undefined, () => {})).toEqual(Buffer.from("hello"));
  });

  it("restores a prior injection from recentInjection without re-emitting", () => {
    const injector = makeInjector();
    const { host, processFromCalls } = fakeHost();
    injector.setHost(host);

    injector.configure({ recentInjection: { restored: true } });
    expect(processFromCalls).toEqual([]);
    expect(injector.process("input", () => {})).toEqual({ restored: true });
    expect(injector.getState()).toMatchObject({
      recentInjection: { restored: true },
    });
  });

  it("pushes inject and injectBinary downstream immediately, unlike recentInjection", () => {
    const injector = makeInjector();
    const { host, processFromCalls } = fakeHost();
    injector.setHost(host);

    injector.configure({ inject: "now" });
    expect(processFromCalls).toEqual(["now"]);

    injector.configure({
      injectBinary: Buffer.from("bin").toString("base64"),
    });
    expect(processFromCalls).toEqual(["now", Buffer.from("bin")]);

    injector.configure({ recentInjection: "restored, not pushed" });
    expect(processFromCalls).toEqual(["now", Buffer.from("bin")]);
  });

  it("hydrates from persisted state on construction", () => {
    const injector = makeInjector({ recentInjection: "saved", plainText: true });
    expect(injector.process("input", () => {})).toBe("saved");
    expect(injector.getState()).toEqual({
      plainText: true,
      recentInjection: "saved",
    });
  });

  it("reports plainText changes", () => {
    const injector = makeInjector();
    injector.configure({ plainText: true });
    expect(injector.getState()).toEqual({ plainText: true });
  });
});

describe("injector behind a runtime", () => {
  it("pushes an injected value through the rest of the pipeline immediately", async () => {
    const { server, baseUrl } = await startServer();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          { serviceId: injectorDescriptor.serviceId, uuid: "injector-1" },
          { serviceId: monitorDescriptor.serviceId, uuid: "monitor-1" },
        ],
      })
      .expect(200);

    const wsUrl = `${baseUrl.replace("http", "ws")}/rt-1`;
    const seen = await collectState(
      wsUrl,
      "monitor-1",
      (states) => states.length > 0,
      async () => {
        await request(server.httpServer)
          .post("/runtimes/rt-1/services/injector-1")
          .send({ inject: "hello" })
          .expect(200);
      },
    );

    expect(seen[0]).toBe("hello");
  });
});
