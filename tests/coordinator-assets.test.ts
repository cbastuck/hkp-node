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
 * coordinator sends each runtime the ones its services reference, as a browser
 * provisioning the board would. Without that a deployed endpoint would answer
 * every request with an unknown asset.
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
  it("are provisioned with the runtime that references them, and no others", async () => {
    const server = createRuntimeServer({ externalHost: "127.0.0.1", auth: { mode: "none" } });
    servers.push(server);
    const { baseUrl } = await server.start();
    const coordinator = new BoardCoordinator();
    coordinators.push(coordinator);

    const session = await coordinator.registerBoard("user-1", {
      boardName: "board-1",
      runtimes: [{ id: "rt-1", name: "Node", type: "rest", url: baseUrl }],
      services: {
        "rt-1": [
          {
            uuid: "a",
            serviceId: assetDescriptor.serviceId,
            state: { asset: "hkp-asset://page" },
          },
        ],
      },
      assets: [
        { id: "page", mediaType: "text/plain", text: "deployed" },
        { id: "unused", mediaType: "text/plain", text: "not referenced" },
      ],
    });
    expect(session.getErrors()).toEqual([]);

    const page = await request(server.httpServer).get("/runtimes/rt-1/assets/page").expect(200);
    expect(page.body).toEqual({ ok: true, mediaType: "text/plain", size: 8 });
    const unused = await request(server.httpServer).get("/runtimes/rt-1/assets/unused").expect(200);
    expect(unused.body.ok).toBe(false);
  });
});
