import { afterEach, describe, expect, it } from "vitest";

import { assetDescriptor } from "../src/services/asset";
import {
  CoordinatorHost,
  OWNER,
  RuntimeServer,
  deploy as deployBoard,
  startCoordinator,
  startRuntimeServer,
} from "./cloud";

/**
 * A deployed board's assets reach the runtimes a coordinator provisions.
 *
 * Deploying hands the board document over, descriptors included; the
 * coordinator sends each runtime the board's assets, as a browser provisioning
 * the board would — all of them unless an asset names the runtimes it is for,
 * because which asset a service uses can be decided while the board runs.
 */

const servers: RuntimeServer[] = [];
const hosts: CoordinatorHost[] = [];

afterEach(async () => {
  while (hosts.length) {
    await hosts.pop()?.stop();
  }
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

describe("a deployed board's assets", () => {
  async function deploy(config: {
    runtimes?: Array<Record<string, unknown>>;
    services?: Record<string, unknown[]>;
    assets: Array<Record<string, unknown>>;
  }) {
    const { server } = await startRuntimeServer();
    servers.push(server);
    const host = await startCoordinator();
    hosts.push(host);

    const runtimes = config.runtimes ?? [{ id: "rt-1", name: "Node" }];
    const session = await deployBoard(
      host,
      "user-1",
      {
        boardName: "board-1",
        runtimes: runtimes.map((runtime) => ({ type: "rest", ...runtime })),
        services:
          config.services ??
          Object.fromEntries(runtimes.map((runtime) => [runtime.id, []])),
        assets: config.assets,
      } as never,
      Object.fromEntries(runtimes.map((runtime) => [runtime.id, server])),
    );
    expect(session.getErrors()).toEqual([]);

    const runtimeOf = (runtimeId: string) =>
      server.runtimeApp.getRuntime(OWNER, runtimeId)!;
    /** The ids a runtime holds. */
    const held = (runtimeId: string): string[] =>
      [...runtimeOf(runtimeId).assets().ids()].sort();
    return { runtimeOf, held };
  }

  it("are all given to a runtime, named by one of its services or not", async () => {
    // Nothing on the runtime names `night`: which asset the service emits is
    // decided by what reaches it while the board runs.
    const { runtimeOf, held } = await deploy({
      services: {
        "rt-1": [
          {
            uuid: "a",
            serviceId: assetDescriptor.serviceId,
            state: { asset: "hkp-asset://day" },
          },
        ],
      },
      assets: [
        { id: "day", mediaType: "text/plain", text: "sun" },
        { id: "night", mediaType: "text/plain", text: "moon" },
      ],
    });

    expect(held("rt-1")).toEqual(["day", "night"]);
    const { asset } = await runtimeOf("rt-1").assets().resolve("hkp-asset://night");
    expect(asset?.mediaType).toBe("text/plain");
    expect(asset?.bytes.length).toBe(4);
  });

  it("are kept from a runtime they do not name", async () => {
    const { held } = await deploy({
      runtimes: [
        { id: "front", name: "Front" },
        { id: "back", name: "Back" },
      ],
      assets: [
        { id: "page", mediaType: "text/plain", text: "for all" },
        { id: "ledger", mediaType: "text/plain", text: "for one", runtimes: ["back"] },
        { id: "draft", mediaType: "text/plain", text: "for none", runtimes: [] },
      ],
    });

    expect(held("front")).toEqual(["page"]);
    expect(held("back")).toEqual(["ledger", "page"]);
  });

  it("are not given to a runtime a unit contributed, which has that unit's", async () => {
    const { held } = await deploy({
      runtimes: [
        { id: "rt-1", name: "Node" },
        { id: "shop.rt", name: "Shop", unit: "shop", unitRuntimeId: "rt" },
      ],
      assets: [{ id: "page", mediaType: "text/plain", text: "the board's" }],
    });

    expect(held("rt-1")).toEqual(["page"]);
    expect(held("shop.rt")).toEqual([]);
  });
});
