import { afterEach, describe, expect, it } from "vitest";

// The runtimes in these tests are on loopback, which the SSRF guard blocks by
// default. Set before anything reads the policy (it is cached on first read).
process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { createRuntimeServer } from "../src/server";
import { BoardSession } from "../src/coordinator/session";
import { peerServerDescriptor } from "../src/services/peer-server";
import { monitorDescriptor } from "../src/services/monitor";
import { startStubRuntime } from "./stubRuntime";
import {
  collectMountRefs,
  formatMountRef,
  parseMountRef,
  substituteMounts,
} from "../src/coordinator/mount";

describe("mount vocabulary", () => {
  it("parses a reference and rejects anything without the scheme", () => {
    expect(parseMountRef("hkp-mount://node/peer-1")).toEqual({
      runtimeId: "node",
      serviceUuid: "peer-1",
    });
    // An address is the other form of the same field, never a reference.
    expect(parseMountRef("http://127.0.0.1:8080/hosted/abc")).toBeNull();
    // A bare pair is indistinguishable from a relative URL, so it is not one.
    expect(parseMountRef("node/peer-1")).toBeNull();
    expect(parseMountRef("")).toBeNull();
  });

  it("round-trips through formatMountRef", () => {
    const ref = { runtimeId: "chat-node", serviceUuid: "peer-1" };
    expect(parseMountRef(formatMountRef(ref))).toEqual(ref);
  });

  it("substitutes references anywhere in a service state", () => {
    const state = {
      mode: "Receive",
      __hkpMount: "hkp-mount://node/peer-1",
      pipeline: [{ instanceId: "inner", state: { __hkpMount: "hkp-mount://node/peer-1" } }],
    };
    const resolved = substituteMounts(state, () => "http://h:8080/hosted/abc");
    expect(resolved.__hkpMount).toBe("http://h:8080/hosted/abc");
    expect(resolved.pipeline[0].state.__hkpMount).toBe("http://h:8080/hosted/abc");
    expect(resolved.mode).toBe("Receive");
  });

  it("leaves a reference alone when it does not resolve", () => {
    // Keep what the board asked for: the owner may publish later.
    const state = { __hkpMount: "hkp-mount://node/peer-1" };
    expect(substituteMounts(state, () => null)).toEqual(state);
  });

  it("leaves an address alone", () => {
    const state = { __hkpMount: "http://h:8080/hosted/abc" };
    expect(substituteMounts(state, () => "http://other/x")).toEqual(state);
  });

  it("collects the references a board wants resolved", () => {
    expect([
      ...collectMountRefs({
        services: {
          ui: [{ state: { __hkpMount: "hkp-mount://node/peer-1" } }],
          node: [{ state: { __hkpMount: "http://already/resolved" } }],
        },
      }),
    ]).toEqual(["hkp-mount://node/peer-1"]);
  });
});

describe("coordinator mount resolution", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  async function startOwnerRuntime() {
    const server = createRuntimeServer({
      externalHost: "127.0.0.1",
      auth: { mode: "none" },
    });
    cleanups.push(() => server.stop());
    const { baseUrl } = await server.start();
    return baseUrl;
  }

  it("hands a consumer the address of a mount on another runtime", async () => {
    const ownerUrl = await startOwnerRuntime();
    const consumer = await startStubRuntime("rt-consumer");
    cleanups.push(consumer.close);

    const session = new BoardSession("board-1", "user-1", {
      boardName: "board-1",
      runtimes: [
        { id: "rt-owner", name: "Owner", type: "rest", url: ownerUrl },
        { id: "rt-consumer", name: "Consumer", type: "rest", url: consumer.url },
      ],
      services: {
        "rt-owner": [
          {
            uuid: "peer-1",
            serviceId: peerServerDescriptor.serviceId,
            state: { bypass: false },
          },
        ],
        "rt-consumer": [
          {
            uuid: "consumer-1",
            serviceId: monitorDescriptor.serviceId,
            state: {
              logToConsole: false,
              __hkpMount: "hkp-mount://rt-owner/peer-1",
            },
          },
        ],
      },
    });
    cleanups.push(() => session.destroy());

    await session.start();

    // A runtime cannot resolve this for itself: the reference names a service
    // on a different runtime, which only the coordinator can see.
    expect(consumer.configured).toHaveLength(1);
    const [call] = consumer.configured;
    expect(call.serviceUuid).toBe("consumer-1");
    expect(call.state.__hkpMount).toMatch(
      new RegExp(`^${ownerUrl}/hosted/[0-9a-f]{32}$`),
    );
    // Untouched fields travel with it, since the whole state is re-sent.
    expect(call.state.logToConsole).toBe(false);
  });

  it("leaves a reference alone when nothing on the board owns it", async () => {
    const consumer = await startStubRuntime("rt-consumer");
    cleanups.push(consumer.close);

    const session = new BoardSession("board-2", "user-1", {
      boardName: "board-2",
      runtimes: [
        { id: "rt-consumer", name: "Consumer", type: "rest", url: consumer.url },
      ],
      services: {
        "rt-consumer": [
          {
            uuid: "consumer-1",
            serviceId: monitorDescriptor.serviceId,
            state: { __hkpMount: "hkp-mount://rt-gone/peer-1" },
          },
        ],
      },
    });
    cleanups.push(() => session.destroy());

    await session.start();

    // Nothing to hand over, so nothing is sent — the board keeps describing
    // what it wanted rather than being blanked into an unconfigured service.
    expect(consumer.configured).toEqual([]);
  });
});
