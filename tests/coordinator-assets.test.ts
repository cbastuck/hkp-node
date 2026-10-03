import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

// The runtimes in these tests are on loopback, which the SSRF guard blocks by
// default. Set before anything reads the policy (it is cached on first read).
process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { createRuntimeServer } from "../src/server";
import { BoardCoordinator } from "../src/coordinator/coordinator";
import { assetDescriptor } from "../src/services/asset";

/**
 * A deployed board's assets reach the runtimes a coordinator provisions.
 *
 * Deploying hands the board document over, descriptors included; the
 * coordinator sends each runtime the board's assets, as a browser provisioning
 * the board would — all of them unless an asset names the runtimes it is for,
 * because which asset a service uses can be decided while the board runs.
 */

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
const coordinators: BoardCoordinator[] = [];

afterEach(async () => {
  while (coordinators.length) {
    coordinators.pop()?.destroyAll();
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
    const server = createRuntimeServer({ externalHost: "127.0.0.1", auth: { mode: "none" } });
    servers.push(server);
    const { baseUrl } = await server.start();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    const runtimes = config.runtimes ?? [{ id: "rt-1", name: "Node" }];
    const session = await coordinator.registerBoard("user-1", {
      boardName: "board-1",
      runtimes: runtimes.map((runtime) => ({ type: "rest", url: baseUrl, ...runtime })),
      services:
        config.services ??
        Object.fromEntries(runtimes.map((runtime) => [runtime.id, []])),
      assets: config.assets,
    } as never);
    expect(session.getErrors()).toEqual([]);

    /** The ids a runtime holds: what a push answers with, here a push of nothing. */
    const held = async (runtimeId: string): Promise<string[]> => {
      const { body } = await request(server.httpServer)
        .post(`/runtimes/${runtimeId}/assets`)
        .send({})
        .expect(200);
      return [...body.ids].sort();
    };
    return { server, held };
  }

  it("are all given to a runtime, named by one of its services or not", async () => {
    // Nothing on the runtime names `night`: which asset the service emits is
    // decided by what reaches it while the board runs.
    const { server, held } = await deploy({
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

    expect(await held("rt-1")).toEqual(["day", "night"]);
    const night = await request(server.httpServer).get("/runtimes/rt-1/assets/night").expect(200);
    expect(night.body).toEqual({ ok: true, mediaType: "text/plain", size: 4 });
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

    expect(await held("front")).toEqual(["page"]);
    expect(await held("back")).toEqual(["ledger", "page"]);
  });

  it("are not given to a runtime a unit contributed, which has that unit's", async () => {
    const { held } = await deploy({
      runtimes: [
        { id: "rt-1", name: "Node" },
        { id: "shop.rt", name: "Shop", unit: "shop", unitRuntimeId: "rt" },
      ],
      assets: [{ id: "page", mediaType: "text/plain", text: "the board's" }],
    });

    expect(await held("rt-1")).toEqual(["page"]);
    expect(await held("shop.rt")).toEqual([]);
  });
});
