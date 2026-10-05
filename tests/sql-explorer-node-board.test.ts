import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { AuthenticatedUser } from "../src/auth";
import { createRuntimeServer } from "../src/server";
import { peopleAuthenticator } from "./cloud";

/**
 * The SQL Explorer for hkp-node, run against a server two people use.
 *
 * The board lists and opens "your" databases, and what makes that true is not
 * the board: hkp-node files a database under the authenticated owner of the
 * runtime asking, so the same board, opened by somebody else, is looking at
 * somebody else's. What is pinned here is exactly that — and that the
 * explorer's statements, written for the browser's SQLite, read and change a
 * table on this one.
 *
 * The services are read out of the boards rather than repeated here.
 */

const BOARDS = path.join(__dirname, "../../boards");
const read = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(BOARDS, name), "utf8"));

const explorer = read("sql-explorer-node-board.json");
const browserExplorer = read("sql-explorer-board.json");
const courts = read("court-booking-demo-board.json");

const ALICE: AuthenticatedUser = { sub: "auth0|alice", email: "alice@example.com" };
const BOB: AuthenticatedUser = { sub: "auth0|bob", email: "bob@example.com" };

type Server = ReturnType<typeof createRuntimeServer>;
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

/** One hkp-node, keeping its databases in memory, that knows both people. */
async function sharedServer() {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    buildAuthenticator: () => peopleAuthenticator([ALICE, BOB]),
  });
  servers.push(server);
  await server.start();
  return server;
}

/** The board as one person has it open: its hkp-node runtimes, as theirs. */
async function open(server: Server, person: AuthenticatedUser) {
  const as = (call: request.Test) =>
    call.set("Authorization", `Bearer ${person.sub}`);
  for (const id of ["node", "dump"]) {
    await as(request(server.httpServer).post("/runtimes"))
      .send({
        id,
        name: id,
        boardName: explorer.boardName,
        services: explorer.services[id],
      })
      .expect(200);
  }

  /** What a facade's process action does: begin at a service, by address. */
  const ask = async (address: string, payload: unknown = {}) =>
    (
      await as(
        request(server.httpServer).post(
          `/runtimes/node/services/${address}/process`,
        ),
      )
        .send(payload as object)
        .expect(200)
    ).body;
  const configure = (runtime: string, address: string, config: object) =>
    as(
      request(server.httpServer).post(
        `/runtimes/${runtime}/services/${address}`,
      ),
    )
      .send(config)
      .expect(200);

  /** Picks a database, as its button in the first column does. */
  const pickDatabase = async (database: string) => {
    for (const address of ["tables.list", "rows.show", "rows.change-row", "rows.drop-rows"]) {
      await configure("node", address, { database });
    }
    return (await ask("tables.list", { database })).rows as Array<
      Record<string, string>
    >;
  };
  /** Picks a table, as its button in the second column does. */
  const pickTable = async (table: Record<string, string>) => {
    await configure("node", "rows.show", { statement: table.readRows });
    await configure("node", "rows.change-row", { statement: table.updateRow });
    await configure("node", "rows.drop-rows", { statement: table.deleteRows });
    return (await ask("rows.show")).rows as Array<Record<string, unknown>>;
  };
  /** The dump the browser is handed to save, for a database. */
  const exportDump = async (database: string) => {
    await configure("dump", "export", { database });
    return (
      await as(request(server.httpServer).post("/runtimes/dump"))
        .send({})
        .expect(200)
    ).body as string;
  };

  return { as, ask, pickDatabase, pickTable, exportDump };
}

/** Books a court as somebody, on a board of their own on the same server. */
async function bookCourt(server: Server, person: AuthenticatedUser) {
  const as = (call: request.Test) =>
    call.set("Authorization", `Bearer ${person.sub}`);
  await as(request(server.httpServer).post("/runtimes"))
    .send({
      id: "club",
      name: "Club",
      boardName: courts.boardName,
      services: courts.services.club,
    })
    .expect(200);
  await as(
    request(server.httpServer).post("/runtimes/club/services/give-back/process"),
  )
    .send({ state: "free", dayOffset: 0, court: 1, hour: 10 })
    .expect(200);
}

describe("the SQL Explorer on hkp-node", () => {
  it("is the browser's explorer with the runtime changed, and nothing else", () => {
    // The statements were written for SQLite, and both runtimes are SQLite:
    // what reads and changes a table is the same text on either.
    const scope = (board: { services: Record<string, Array<{ uuid: string }>> }, runtime: string, uuid: string) =>
      board.services[runtime].find((svc) => svc.uuid === uuid);
    for (const uuid of ["databases", "tables", "rows"]) {
      expect(scope(explorer, "node", uuid)).toEqual(
        scope(browserExplorer, "ui", uuid),
      );
    }
  });

  it("lists the databases its owner's boards made, with nothing of anybody else's", async () => {
    const server = await sharedServer();
    await bookCourt(server, ALICE);

    const alice = await open(server, ALICE);
    const bob = await open(server, BOB);

    const hers = (await alice.ask("databases.list")).rows;
    expect(hers.map((db: { name: string }) => db.name)).toEqual(["tennis"]);
    // The same board, the same server, another person: another tenant.
    expect((await bob.ask("databases.list")).rows).toEqual([]);
  });

  it("cannot be pointed at another owner's database by naming it", async () => {
    const server = await sharedServer();
    await bookCourt(server, ALICE);
    const bob = await open(server, BOB);

    // A name is looked up inside the tenant asking. `tennis` here is Bob's
    // own, which has nothing in it, and not the one Alice's board keeps.
    expect(await bob.pickDatabase("tennis")).toEqual([]);
    expect(await bob.exportDump("tennis")).not.toContain("court_booking");
  });

  it("shows a table's rows, changes a value and deletes a row", async () => {
    const server = await sharedServer();
    await bookCourt(server, ALICE);
    const alice = await open(server, ALICE);

    const tables = await alice.pickDatabase("tennis");
    const booking = tables.find((table) => table.name === "court_booking")!;
    expect(booking).toMatchObject({ database: "tennis", type: "table", editable: 1 });

    const rows = await alice.pickTable(booking);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ court: 1, hour: 10, member: ALICE.email });

    // A cell, changed in place: every service after the update runs too, so
    // what comes back is the table as it now stands.
    const changed = await alice.ask("rows.change-row", {
      action: "update",
      rowid: rows[0].rowid,
      column: "hour",
      value: 11,
    });
    expect(changed.rows[0]).toMatchObject({ court: 1, hour: 11 });

    const left = await alice.ask("rows.drop-rows", {
      action: "delete",
      rowids: [rows[0].rowid],
    });
    expect(left.rows).toEqual([]);
  });

  it("hands on a database as an ordinary SQL dump", async () => {
    const server = await sharedServer();
    await bookCourt(server, ALICE);
    const alice = await open(server, ALICE);

    const dump = await alice.exportDump("tennis");

    expect(dump).toMatch(/^PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n/);
    expect(dump).toContain("CREATE TABLE IF NOT EXISTS court_booking");
    expect(dump).toContain(ALICE.email);
    expect(dump.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("asks for a dump from the browser, so that the answer travels back to it", () => {
    // A process call at a service on hkp-node answers whoever made it and goes
    // no further. A dump has to reach the browser's Download, so the export is
    // begun in a browser runtime placed before it in the chain.
    const order = explorer.runtimes.map((rt: { id: string }) => rt.id);
    expect(order.indexOf("ask")).toBeLessThan(order.indexOf("dump"));
    expect(order.indexOf("dump")).toBeLessThan(order.indexOf("save"));
    const exportButton = JSON.stringify(explorer.facade).match(
      /"label":"Export \.sql","actions":(\[.*?\])\}/,
    )![1];
    expect(JSON.parse(exportButton).at(-1)).toEqual({
      type: "process",
      serviceUuid: "which",
      payload: {},
    });
  });
});
