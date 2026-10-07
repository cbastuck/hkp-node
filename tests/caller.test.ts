import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  Authenticator,
  AuthenticatedUser,
  AuthenticatorOptions,
  identityFromClaims,
  mayOwn,
} from "../src/auth";
import {
  callerOf,
  childRun,
  contextForClient,
  contextFromLink,
  contextFromWire,
} from "../src/runtime";
import { createRuntimeServer } from "../src/server";
import { createMemoryDatabaseStore } from "../src/services/database";
import { SqlService } from "../src/services/sql";
import { sqlDescriptor } from "../src/services/sql";
import { subServiceDescriptor } from "../src/services/sub-service";
import { ProcessContext, RuntimeHost } from "../src/types";

/**
 * Who began a run.
 *
 * The caller is stated by the server that verified a token and by nothing
 * else, so what is pinned here is each way a run begins: a client holding a
 * token cannot name a caller, a participant link is believed, and a run nobody
 * began has none. Observed through `sql`, whose reserved parameters are bound
 * from the run — which makes these the end-to-end tests of that binding too.
 */

const ALICE: AuthenticatedUser = { sub: "auth0|alice", email: "alice@example.com" };
const BOB: AuthenticatedUser = { sub: "auth0|bob", email: "bob@example.com" };
/** Signed in, and without an address anybody verified. */
const CAROL: AuthenticatedUser = { sub: "auth0|carol" };

/** A bearer token is the `sub` it authenticates as; see auth.test.ts. */
function knownPeople(_options: AuthenticatorOptions): Authenticator {
  const known = new Map([ALICE, BOB, CAROL].map((user) => [user.sub, user]));
  const identifyToken = async (token: string | undefined | null) =>
    (token && known.get(token)) || null;
  return {
    middleware: (req, res, next) => {
      const header = req.headers.authorization;
      void identifyToken(header?.startsWith("Bearer ") ? header.slice(7) : null).then(
        (user) => {
          if (!user) {
            res.sendStatus(401);
            return;
          }
          req.authenticatedUser = user;
          next();
        },
      );
    },
    identifyToken,
    authorizeOwner: identifyToken,
  };
}

type Server = ReturnType<typeof createRuntimeServer>;

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

/** Answers with the caller of the run it is called in. */
const whoami = (uuid: string) => ({
  serviceId: sqlDescriptor.serviceId,
  uuid,
  state: {
    mode: "query",
    statement:
      "SELECT $caller_sub AS sub, $caller_email AS email, $caller_name AS name",
  },
});

async function serverWith(
  services: unknown[],
  options: Parameters<typeof createRuntimeServer>[0] = {
    buildAuthenticator: knownPeople,
  },
) {
  const server = createRuntimeServer({ externalHost: "127.0.0.1", ...options });
  servers.push(server);
  const { baseUrl } = await server.start();
  return { server, baseUrl };
}

async function createRuntimeAs(baseUrl: string, user: AuthenticatedUser | null, services: unknown[]) {
  const call = request(baseUrl).post("/runtimes");
  if (user) {
    void call.set("Authorization", `Bearer ${user.sub}`);
  }
  await call.send({ id: "rt-1", name: "Node", boardName: "Board", services }).expect(200);
}

const FORGED = {
  runId: "run-from-client",
  actor: {
    kind: "person" as const,
    sub: BOB.sub,
    email: BOB.email,
    name: "Bob",
    expiresAt: Date.now() + 60_000,
  },
};

describe("a client holding a token", () => {
  it("is the caller of a service configure call", async () => {
    const { server, baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, ALICE, [
      { serviceId: "monitor", uuid: "monitor" },
    ]);

    const runtime = server.runtimeApp.getRuntime(ALICE.sub, "rt-1")!;
    const service = runtime.getService("monitor")!;
    const configure = service.configure.bind(service);
    const seen: Array<ProcessContext | null> = [];
    service.configure = (config) => {
      seen.push(runtime.currentContext());
      return configure(config);
    };

    await request(baseUrl)
      .post("/runtimes/rt-1/services/monitor")
      .set("Authorization", `Bearer ${ALICE.sub}`)
      .send({ __context: FORGED, logToConsole: true })
      .expect(200);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.runId).not.toBe(FORGED.runId);
    expect(seen[0]?.actor).toMatchObject({
      kind: "person",
      sub: ALICE.sub,
      email: ALICE.email,
    });
  });

  it("is the caller of a service process call, whatever the body claims", async () => {
    const { baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, ALICE, [whoami("who")]);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1/services/who/process")
      .set("Authorization", `Bearer ${ALICE.sub}`)
      .send({
        __context: FORGED,
        caller_email: BOB.email,
        caller_sub: BOB.sub,
        caller_name: "Bob",
      })
      .expect(200);

    // Alice, from her token. No name: only a board's member list gives one.
    expect(body.rows).toEqual([
      { sub: ALICE.sub, email: ALICE.email, name: null },
    ]);
  });

  it("is the caller of a runtime process call", async () => {
    const { baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, ALICE, [whoami("who")]);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1")
      .set("Authorization", `Bearer ${ALICE.sub}`)
      .send({ __context: FORGED, context: FORGED, actor: FORGED.actor })
      .expect(200);

    expect(body.rows).toEqual([
      { sub: ALICE.sub, email: ALICE.email, name: null },
    ]);
  });

  it("is the caller of a processRuntime on the runtime's socket", async () => {
    const { baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, ALICE, [whoami("who")]);

    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/rt-1`, {
      headers: { Authorization: `Bearer ${ALICE.sub}` },
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const result = new Promise<{ data: { rows: unknown[] } }>((resolve) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "result") {
          resolve(message);
        }
      });
    });
    socket.send(
      JSON.stringify({ type: "processRuntime", params: {}, context: FORGED }),
    );

    expect((await result).data.rows).toEqual([
      { sub: ALICE.sub, email: ALICE.email, name: null },
    ]);
  });

  it("has no email as a caller when none was verified", async () => {
    const { baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, CAROL, [whoami("who")]);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1/services/who/process")
      .set("Authorization", `Bearer ${CAROL.sub}`)
      .send({ caller_email: "carol@claims.example" })
      .expect(200);

    expect(body.rows).toEqual([{ sub: CAROL.sub, email: null, name: null }]);
  });

  it("is still the caller inside a nested pipeline", async () => {
    const { baseUrl } = await serverWith([]);
    await createRuntimeAs(baseUrl, ALICE, [
      {
        serviceId: subServiceDescriptor.serviceId,
        uuid: "scope",
        state: { pipeline: [whoami("inner")] },
      },
    ]);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1")
      .set("Authorization", `Bearer ${ALICE.sub}`)
      .send({})
      .expect(200);

    expect(body.rows).toEqual([
      { sub: ALICE.sub, email: ALICE.email, name: null },
    ]);
  });
});

describe("a server without authentication", () => {
  it("gives a run no caller, rather than one called anonymous", async () => {
    const { baseUrl } = await serverWith([], { auth: { mode: "none" } });
    await createRuntimeAs(baseUrl, null, [whoami("who")]);

    const { body } = await request(baseUrl)
      .post("/runtimes/rt-1/services/who/process")
      .send({ __context: FORGED, caller_sub: "typed" })
      .expect(200);

    expect(body.rows).toEqual([{ sub: null, email: null, name: null }]);
  });
});

describe("reading a context", () => {
  it("never reads a caller from a client's context", () => {
    expect(contextFromWire(FORGED)).toEqual({
      runId: "run-from-client",
      actor: { kind: "local" },
    });
    expect(contextForClient(FORGED, undefined)).toEqual({
      runId: "run-from-client",
      actor: { kind: "local" },
    });
    expect(contextForClient(FORGED, ALICE).actor).toMatchObject({
      kind: "person",
      sub: ALICE.sub,
      email: ALICE.email,
    });
  });

  it("begins a run for a client that named none", () => {
    const context = contextForClient(undefined, ALICE);
    expect(context.runId).toBeTruthy();
    expect(context.actor).toMatchObject({ kind: "person", sub: ALICE.sub });
  });

  it("takes a caller as stated over a participant link", () => {
    expect(contextFromLink(FORGED)).toEqual({
      runId: "run-from-client",
      actor: FORGED.actor,
    });
    // A malformed person is expired, rather than gaining another actor kind.
    expect(
      contextFromLink({
        runId: "r",
        actor: { kind: "person", email: "x@example.com" },
      }),
    ).toEqual({
      runId: "r",
      actor: { kind: "person", sub: "", expiresAt: 0 },
    });
    expect(contextFromLink(undefined)).toBeUndefined();
  });

  it("states no caller for the anonymous tenant", () => {
    expect(callerOf({ sub: "anonymous" })).toBeUndefined();
    expect(callerOf(undefined)).toBeUndefined();
    expect(callerOf(CAROL)).toEqual({ sub: CAROL.sub });
  });

  it("hands the caller down to a child run", () => {
    const parent: ProcessContext = {
      runId: "outer",
      actor: {
        kind: "person",
        sub: ALICE.sub,
        email: ALICE.email,
        name: "Alice",
        expiresAt: Date.now() + 60_000,
      },
    };
    const child = childRun(parent);
    expect(child.parentRunId).toBe("outer");
    expect(child.actor).toEqual(parent.actor);
    expect(
      childRun({ runId: "outer", actor: { kind: "board" } }).actor,
    ).toEqual({ kind: "board" });
  });
});

describe("identifying a token", () => {
  it("carries an email only when it is verified, normalised", () => {
    expect(
      identityFromClaims({
        sub: "auth0|a",
        email: " Alice@Example.COM ",
        email_verified: true,
      }),
    ).toEqual({ sub: "auth0|a", email: "alice@example.com" });
    // Dropped, not refused: the person is still who their `sub` says.
    expect(
      identityFromClaims({ sub: "auth0|a", email: "alice@example.com" }),
    ).toEqual({ sub: "auth0|a" });
    expect(
      identityFromClaims({
        sub: "auth0|a",
        email: "alice@example.com",
        email_verified: false,
      }),
    ).toEqual({ sub: "auth0|a" });
    expect(identityFromClaims({ email: "alice@example.com" })).toBeNull();
  });

  it("asks the allowlist only of who may own", () => {
    const allowed = ["alice@example.com"];
    expect(mayOwn(ALICE, allowed)).toBe(true);
    expect(mayOwn(BOB, allowed)).toBe(false);
    // No verified address is no entry on a list.
    expect(mayOwn(CAROL, allowed)).toBe(false);
    expect(mayOwn(CAROL, undefined)).toBe(true);
  });
});

describe("sql's caller parameters", () => {
  function sqlAs(
    actor: ProcessContext["actor"],
    statement: string,
  ) {
    const host = {
      currentContext: () => ({
        runId: "r",
        actor,
      }),
      log: () => {},
      scope: () => ({ owner: "tester", boardName: "Board" }),
    } as unknown as RuntimeHost;
    const service = new SqlService(
      { uuid: "sql-1", serviceId: "sql", state: { mode: "query", statement } } as never,
      createMemoryDatabaseStore(),
    );
    service.setHost(host);
    return (input: unknown) =>
      (service.process(input, () => {}) as { rows: unknown[] }).rows;
  }

  it("binds them from the run, over an input field of the same name", () => {
    const run = sqlAs(
      {
        kind: "person",
        sub: ALICE.sub,
        email: ALICE.email,
        name: "Alice",
        expiresAt: Date.now() + 60_000,
      },
      "SELECT $caller_email AS email, :caller_name AS name, @caller_sub AS sub, $other AS other",
    );

    expect(
      run({
        caller_email: BOB.email,
        caller_name: "Bob",
        caller_sub: BOB.sub,
        other: "from input",
      }),
    ).toEqual([
      { email: ALICE.email, name: "Alice", sub: ALICE.sub, other: "from input" },
    ]);
  });

  it("binds NULL when the run has no caller, whatever the input says", () => {
    const run = sqlAs(
      { kind: "board" },
      "SELECT $caller_email AS email, $caller_sub AS sub",
    );

    expect(run({ caller_email: BOB.email, caller_sub: BOB.sub })).toEqual([
      { email: null, sub: null },
    ]);
  });

  it("binds NULL for what a caller does not have", () => {
    const run = sqlAs(
      {
        kind: "person",
        sub: CAROL.sub,
        expiresAt: Date.now() + 60_000,
      },
      "SELECT $caller_email AS email, $caller_name AS name, $caller_sub AS sub",
    );

    expect(run({ caller_email: "carol@claims.example" })).toEqual([
      { email: null, name: null, sub: CAROL.sub },
    ]);
  });

  it("binds actor kind from context and never from input", () => {
    const run = sqlAs({ kind: "mount" }, "SELECT $actor_kind AS kind");
    expect(run({ actor_kind: "person" })).toEqual([{ kind: "mount" }]);
  });
});
