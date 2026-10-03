import { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { MountRegistry } from "../src/mounts";
import { boardSpace } from "../src/runtime";

/**
 * More than one claim to one address.
 *
 * A mount's address is derived from what the mount is called, so a board open
 * in a client and the same board deployed claim the same one, as does a
 * runtime rebuilt under its id before the one it replaces lets go. One claim
 * answers; releasing any of them leaves the address with whoever still holds
 * it.
 */

const OWNER = "user-1";
const BOARD = "doorbell";

function registry() {
  return new MountRegistry((path) => `http://h${path}`, "secret");
}

function claim(
  mounts: MountRegistry,
  answers: string[],
  name: string,
  space?: string,
) {
  return mounts.register(
    OWNER,
    "node",
    "hook",
    { request: () => void answers.push(name) },
    { boardName: BOARD, space },
  )!;
}

/** Who answers a request to the address, or nobody. */
function ask(mounts: MountRegistry, answers: string[], path: string): string {
  answers.length = 0;
  const served = mounts.handleRequest(
    { url: path } as IncomingMessage,
    {} as ServerResponse,
  );
  return served ? answers[0] : "nobody";
}

describe("an address more than one runtime claims", () => {
  it("is one address, whichever space the runtime is in", () => {
    const mounts = registry();
    const answers: string[] = [];

    const client = claim(mounts, answers, "client");
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));

    expect(deployed.url).toBe(client.url);
  });

  it("is answered by the deployed board, whoever claimed it last", () => {
    const mounts = registry();
    const answers: string[] = [];
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));

    claim(mounts, answers, "client");

    expect(ask(mounts, answers, deployed.path)).toBe("deployed");
  });

  it("stays the deployed board's when the client that opened it leaves", () => {
    // Opening a deployed board in the playground and closing it again must
    // not take its endpoint down.
    const mounts = registry();
    const answers: string[] = [];
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));
    const client = claim(mounts, answers, "client");

    client.release();

    expect(ask(mounts, answers, deployed.path)).toBe("deployed");
  });

  it("falls to the client's copy when the deployed board lets go", () => {
    const mounts = registry();
    const answers: string[] = [];
    const client = claim(mounts, answers, "client");
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));

    deployed.release();

    expect(ask(mounts, answers, client.path)).toBe("client");
  });

  it("is answered by the newer of two claims of a kind, and by the older again once that lets go", () => {
    const mounts = registry();
    const answers: string[] = [];
    const first = claim(mounts, answers, "first");
    const second = claim(mounts, answers, "second");
    expect(ask(mounts, answers, first.path)).toBe("second");

    second.release();

    expect(ask(mounts, answers, first.path)).toBe("first");
  });

  it("answers nobody once every claim is released, in either order", () => {
    const mounts = registry();
    const answers: string[] = [];
    const client = claim(mounts, answers, "client");
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));

    client.release();
    client.release();
    deployed.release();

    expect(ask(mounts, answers, client.path)).toBe("nobody");
    expect(mounts.size).toBe(0);
  });

  it("keeps a board's claim when the client's runtimes are all removed", () => {
    const mounts = registry();
    const answers: string[] = [];
    const deployed = claim(mounts, answers, "deployed", boardSpace(OWNER, BOARD));
    claim(mounts, answers, "client");

    mounts.releaseOwner(OWNER);
    mounts.releaseRuntime(OWNER, "node");

    expect(ask(mounts, answers, deployed.path)).toBe("deployed");
  });
});
