import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

describe("a radio nothing has been spoken on yet", () => {
  it("publishes its feed and its playlist without a ledger to read", async () => {
    // Only the claim used to create the ledger, and the claim runs once an
    // article arrives — so on a fresh board, or one whose feed is still empty,
    // the feed and the playlist failed with "no such table: episode".
    const server = createRuntimeServer({ externalHost: "127.0.0.1" });
    servers.push(server);
    await server.start();
    const api = request(server.httpServer);

    for (const [runtime, uuid] of [
      ["publish", "pub-doc"],
      ["playlist", "pl-rows"],
    ]) {
      await api
        .post("/runtimes")
        .send({
          id: runtime,
          name: runtime,
          boardName: BOARD.boardName,
          services: withParams(BOARD.services[runtime]),
        })
        .expect(200);
      await api.post(`/runtimes/${runtime}/services/${uuid}/process`).send({});
      const state = (await api.get(`/runtimes/${runtime}/services/${uuid}`).expect(200)).body;
      expect(state.error ?? "", `${runtime}/${uuid}`).toBe("");
    }
  });
});

/**
 * A round, against a feed and a voice of the test's own: what is spoken is
 * kept, and what the voice cannot speak is recorded with the reason and left
 * for a person, who retries it.
 */
describe("voicing what the feed brings", () => {
  async function serveOn(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${port}`;
  }

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) {
      await closers.pop()?.();
    }
  });

  async function station() {
    const feed = await serveOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>` +
          ["Spoken", "Refused"]
            .map(
              (title) =>
                `<item><title>${title}</title><link>https://a.example/${title}</link>` +
                `<guid>https://a.example/${title}</guid><description>About ${title}.</description></item>`,
            )
            .join("") +
          `</channel></rss>`,
      );
    });
    const refusing = new Set(["Refused"]);
    const voice = await serveOn((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if ([...refusing].some((title) => body.text.startsWith(title))) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("busy");
          return;
        }
        res.writeHead(200, { "content-type": "audio/mpeg", "x-episode-path": body.path });
        res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      });
    });

    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const params: Record<string, string> = {
      ...PARAMS,
      feedUrl: `${feed}/feed.xml`,
      voiceMount: `${voice}/render`,
      database: `rss-radio-test-${run}`,
      volume: `radio-test-${run}`,
    };
    const fill = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value).replace(/\{\{param\.(\w+)\}\}/g, (_, name) => params[name] ?? ""),
      );

    const server = createRuntimeServer({ externalHost: "127.0.0.1", auth: { mode: "none" } });
    servers.push(server);
    await server.start();
    const api = request(server.httpServer);
    for (const id of ["radio", "pending"]) {
      await api
        .post("/runtimes")
        .send({ id, name: id, boardName: BOARD.boardName, services: fill(BOARD.services[id]) })
        .expect(200);
    }
    // The ledger itself, read by a runtime of the test's own.
    await api
      .post("/runtimes")
      .send({
        id: "probe",
        name: "probe",
        boardName: BOARD.boardName,
        services: [
          {
            uuid: "probe",
            serviceId: "sql",
            state: {
              mode: "query",
              database: params.database,
              statement: "SELECT title, bytes FROM episode WHERE rendered IS NOT NULL ORDER BY title",
            },
          },
        ],
      })
      .expect(200);
    const process = async (runtime: string, uuid: string, payload: object = {}) =>
      (await api.post(`/runtimes/${runtime}/services/${uuid}/process`).send(payload).expect(200))
        .body;

    type Pending = { title: string; status: string; settled: number } & Record<string, string>;
    const pending = async (): Promise<Record<string, Pending>> =>
      Object.fromEntries(
        (((await process("pending", "pending-rows")).rows ?? []) as Pending[]).map((row) => [
          row.title,
          row,
        ]),
      );
    const until = async (done: (rows: Record<string, Pending>) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const rows = await pending();
        if (done(rows)) return rows;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`never settled: ${JSON.stringify(await pending())}`);
    };

    const onAir = async () => (await process("probe", "probe")).rows;

    return { process, pending, until, refusing, onAir };
  }

  it("keeps what the voice speaks and records why it did not speak the rest", async () => {
    const radio = await station();

    await radio.process("radio", "feed");
    const rows = await radio.until(
      (rows) => !rows.Spoken && !!rows.Refused?.status.startsWith("Failed:"),
    );

    // Spoken is on air, so no longer waiting; Refused says why it is not.
    expect(rows.Refused.status).toBe("Failed: the voice answered HTTP 503");
    expect(rows.Refused.settled).toBe(0);
    expect(await radio.onAir()).toEqual([{ title: "Spoken", bytes: 4 }]);
  });

  it("leaves a failure alone until somebody retries it, then voices it", async () => {
    const radio = await station();

    await radio.process("radio", "feed");
    let rows = await radio.until((rows) => !!rows.Refused?.status.startsWith("Failed:"));

    // Another round does not take it again by itself.
    await radio.process("radio", "feed");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await radio.pending()).Refused.status).toBe("Failed: the voice answered HTTP 503");

    radio.refusing.clear();
    const refused = rows.Refused;
    await radio.process("radio", "each.name", {
      id: refused.guid,
      link: refused.link,
      title: refused.title,
      summary: refused.summary,
      retry: 1,
    });
    rows = await radio.until((rows) => !rows.Refused);
    expect(rows).toEqual({});
    expect(await radio.onAir()).toEqual([
      { title: "Refused", bytes: 4 },
      { title: "Spoken", bytes: 4 },
    ]);
  });
});
