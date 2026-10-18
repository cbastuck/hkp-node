import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";

/**
 * The Radio unit's ledger and library, run on hkp-node.
 *
 * Forgetting an episode is two places at once: its row in the ledger, which is
 * what the programme and the claim read, and its audio in the library volume.
 * What is pinned here is that the Forget runtime clears both, for the episode
 * named and no other — and that something arriving down the chain without a
 * name, as the published feed does every minute, forgets nothing.
 *
 * The services are read out of the board rather than repeated here.
 */

const BOARD = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../boards/rss-radio-unit-board.json"), "utf8"),
);
const PARAMS: Record<string, string> = BOARD.unit.params;

/** What a unit's loader does to its params: `{{param.x}}` becomes the value. */
function withParams<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(/\{\{param\.(\w+)\}\}/g, (_, name) => PARAMS[name] ?? ""),
  );
}

/** The ledger's schema, as the claim declares it. */
function schema(): string {
  const each = BOARD.services.radio.find((svc: { uuid: string }) => svc.uuid === "each");
  return each.state.pipeline.find((svc: { state?: { schema?: string } }) => svc.state?.schema)
    .state.schema;
}

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function radio() {
  const server = createRuntimeServer({ externalHost: "127.0.0.1" });
  servers.push(server);
  await server.start();
  const api = request(server.httpServer);

  const create = (id: string, services: unknown[]) =>
    api
      .post("/runtimes")
      .send({ id, name: id, boardName: BOARD.boardName, services: withParams(services) })
      .expect(200);

  await create("forget", BOARD.services.forget);
  // Runtimes of the test's own on the same database and volume, standing in
  // for the radio having rendered two episodes. One service each, because a
  // process runs from the service it names to the end of its runtime.
  await create("ledger", [
    {
      uuid: "ledger",
      serviceId: "sql",
      state: {
        mode: "exec",
        database: "{{param.database}}",
        statement:
          schema() +
          ";\nINSERT INTO episode (slug, title, rendered) VALUES" +
          " ('broken', 'Broken', datetime('now')), ('fine', 'Fine', datetime('now'))",
      },
    },
  ]);
  await create("rows", [
    {
      uuid: "rows",
      serviceId: "sql",
      state: {
        mode: "query",
        database: "{{param.database}}",
        statement: "SELECT slug FROM episode ORDER BY slug",
      },
    },
  ]);
  await create("files", [
    {
      uuid: "files",
      serviceId: "storage",
      state: { pipeline: [{ serviceId: "filesystem", state: { volume: "{{param.volume}}" } }] },
    },
  ]);

  const process = async (runtime: string, uuid: string, payload: object) =>
    (await api.post(`/runtimes/${runtime}/services/${uuid}/process`).send(payload).expect(200))
      .body;

  await process("ledger", "ledger", {});
  for (const slug of ["broken", "fine"]) {
    await process("files", "files", {
      op: "write",
      path: `episodes/${slug}.mp3`,
      body: "audio",
    });
  }

  return {
    forget: (payload: object) => process("forget", "forget-which", payload),
    slugs: async () =>
      ((await process("rows", "rows", {})).rows as Array<{ slug: string }>).map((r) => r.slug),
    files: async () =>
      (
        (await process("files", "files", { op: "list", prefix: "episodes" })).body.files as Array<{
          path: string;
        }>
      ).map((f) => f.path),
  };
}

describe("forgetting an episode", () => {
  it("takes it out of the ledger and its audio out of the library", async () => {
    const station = await radio();
    expect(await station.files()).toEqual(["episodes/broken.mp3", "episodes/fine.mp3"]);

    await station.forget({ slug: "broken" });

    expect(await station.slugs()).toEqual(["fine"]);
    expect(await station.files()).toEqual(["episodes/fine.mp3"]);
  });

  it("forgets nothing when no episode is named", async () => {
    const station = await radio();

    // What the published feed passes down the chain: a response, no slug.
    await station.forget({ meta: { status: 200 }, body: "<rss/>" });
    await station.forget({ slug: "" });
    await station.forget({ slug: "nobody" });

    expect(await station.slugs()).toEqual(["broken", "fine"]);
    expect(await station.files()).toEqual(["episodes/broken.mp3", "episodes/fine.mp3"]);
  });
});
