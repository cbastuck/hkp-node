import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";

/**
 * Whether a public endpoint keeps its address.
 *
 * A mount is reached by an outside party that was configured with its URL by
 * hand — a webhook in somebody else's product. So the address is part of the
 * contract with that party, and an address that changed whenever a board was
 * loaded meant reconfiguring them after every restart, which nobody would keep
 * doing. It is derived from what identifies the mount, keyed by a secret only
 * the server holds: stable for the same mount, unguessable without the key,
 * different for anything else.
 */

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

const SECRET = "test-secret";

async function serverOn(secret = SECRET): Promise<Server> {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
    mountSecret: secret,
  });
  servers.push(server);
  await server.start();
  return server;
}

async function mountOf(
  server: Server,
  options: {
    boardName?: string;
    runtimeId?: string;
    uuid?: string;
    mountName?: string;
  } = {},
): Promise<string> {
  const runtimeId = options.runtimeId ?? "node";
  const uuid = options.uuid ?? "http-1";
  await request(server.httpServer)
    .post("/runtimes")
    .send({
      id: runtimeId,
      name: "Node",
      boardName: options.boardName ?? "Offer Intake",
      services: [
        {
          serviceId: httpServerSubservicesDescriptor.serviceId,
          uuid,
          state: {
            bypass: false,
            mode: "process_on_session",
            ...(options.mountName ? { mountName: options.mountName } : {}),
          },
        },
      ],
    })
    .expect(200);

  const { body } = await request(server.httpServer)
    .get(`/runtimes/${runtimeId}/services/${uuid}`)
    .expect(200);
  return new URL(String(body.__hkpMount)).pathname;
}

describe("a public endpoint keeps its address", () => {
  it("across reloading the board", async () => {
    const server = await serverOn();

    const first = await mountOf(server);
    const second = await mountOf(server);

    expect(second).toBe(first);
  });

  it("across restarting the server", async () => {
    // The case that matters: the process the webhook was configured against is
    // gone, and a new one has to answer on the same URL.
    const first = await mountOf(await serverOn());
    const second = await mountOf(await serverOn());

    expect(second).toBe(first);
  });
});

describe("a public endpoint is not somebody else's", () => {
  it("differs between tenants", async () => {
    // Not observable through this server, which has auth off and therefore one
    // tenant, so it is asserted where the derivation happens.
    const { MountRegistry } = await import("../src/mounts");
    const registry = new MountRegistry(
      (path) => `http://host${path}`,
      SECRET,
    );
    const handlers = { request: () => {} };

    const mine = registry.register("auth0|alice", "node", "http-1", handlers, {
      boardName: "Offer Intake",
    });
    const theirs = registry.register("auth0|bob", "node", "http-1", handlers, {
      boardName: "Offer Intake",
    });

    expect(mine!.path).not.toBe(theirs!.path);
  });

  it("differs between boards", async () => {
    const server = await serverOn();

    const offers = await mountOf(server, { boardName: "Offer Intake" });
    const invoices = await mountOf(server, {
      boardName: "Invoices",
      runtimeId: "other",
    });

    expect(invoices).not.toBe(offers);
  });

  it("differs between two endpoints on one board", async () => {
    const server = await serverOn();

    const first = await mountOf(server, { uuid: "http-1" });
    const second = await mountOf(server, { uuid: "http-2", runtimeId: "n2" });

    expect(second).not.toBe(first);
  });

  it("cannot be worked out without the key", async () => {
    // The address is the capability to reach an unauthenticated endpoint, so
    // knowing the board, the runtime and the service must not be enough.
    const known = await mountOf(await serverOn("one-secret"));
    const elsewhere = await mountOf(await serverOn("another-secret"));

    expect(elsewhere).not.toBe(known);
  });
});

describe("naming an endpoint", () => {
  it("rotates that address and nothing else", async () => {
    // The deliberate lever: a board that wants a new URL for one endpoint
    // renames it, rather than having every address change underneath it.
    const server = await serverOn();

    const byUuid = await mountOf(server);
    const named = await mountOf(server, { mountName: "missive-intake" });

    expect(named).not.toBe(byUuid);
    // And the new name is as stable as the old identity was.
    expect(await mountOf(server, { mountName: "missive-intake" })).toBe(named);
  });

  it("stops answering on the address it left behind", async () => {
    const server = await serverOn();

    const before = await mountOf(server);
    const after = await mountOf(server, { mountName: "missive-intake" });

    expect((await fetch(`http://127.0.0.1:${port(server)}${before}`)).status)
      .toBe(404);
    expect((await fetch(`http://127.0.0.1:${port(server)}${after}`)).status)
      .toBe(200);
  });
});

function port(server: Server): number {
  const address = server.httpServer.address();
  return typeof address === "object" && address ? address.port : 0;
}
