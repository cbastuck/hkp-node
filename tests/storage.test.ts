import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeServer } from "../src/server";
import { createMemoryFileStore } from "../src/services/fileStore";
import { FilesystemService } from "../src/services/filesystem";
import { StorageService } from "../src/services/storage";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { RuntimeHost, ServiceConfiguration } from "../src/types";

/**
 * The bytes a board keeps, and the endpoint that serves them.
 *
 * Two things are worth pinning here and are easy to get wrong later: that a
 * path a board writes cannot leave the volume it named, and that a read comes
 * back as something an HTTP answer can be made of — the content type and the
 * seek that a player takes for granted.
 */

function hostFor(scope = { owner: "tester", boardName: "Radio" }) {
  return {
    processFrom: (_uuid: string, data: unknown) => data,
    notify: () => {},
    currentContext: () => null,
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => scope,
    emitResult: () => {},
  } as unknown as RuntimeHost;
}

function filesystemWith(state: Record<string, unknown>, files = createMemoryFileStore()) {
  const service = new FilesystemService(
    { uuid: "fs-1", serviceId: "filesystem", state } as unknown as ServiceConfiguration,
    files,
  );
  service.setHost(hostFor());
  return { service, files };
}

/** Storage over one in-memory volume, with `filesystem` as its backend. */
function storageWith(state: Record<string, unknown>, files = createMemoryFileStore()) {
  const service = new StorageService(
    {
      uuid: "store-1",
      serviceId: "storage",
      state: {
        pipeline: [
          {
            instanceId: "backend",
            serviceId: "filesystem",
            serviceName: "Files",
            state: { volume: "radio" },
          },
        ],
        ...state,
      },
    } as unknown as ServiceConfiguration,
    (config) =>
      new FilesystemService(config as ServiceConfiguration, files) as never,
  );
  service.setHost(hostFor());
  return { service, files };
}

const noop = () => {};

describe("filesystem", () => {
  it("round-trips bytes, and says what they are", async () => {
    const { service } = filesystemWith({ volume: "radio" });

    const written = (await service.process(
      { op: "write", path: "episodes/one.mp3", binary: new Uint8Array([1, 2, 3]) },
      noop,
    )) as any;
    expect(written.body).toMatchObject({ written: true, path: "episodes/one.mp3", size: 3 });

    const read = (await service.process(
      { op: "read", path: "episodes/one.mp3" },
      noop,
    )) as any;
    expect(read.meta).toMatchObject({
      status: 200,
      path: "episodes/one.mp3",
      // What the extension means, which is what an HTTP answer declares.
      contentType: "audio/mpeg",
    });
    expect([...read.binary]).toEqual([1, 2, 3]);
  });

  it("answers a miss with a status rather than an exception", async () => {
    const { service } = filesystemWith({ volume: "radio" });

    const read = (await service.process({ op: "read", path: "nothing.mp3" }, noop)) as any;

    expect(read.meta.status).toBe(404);
    expect(read.body.error).toMatch(/no file/);
  });

  it("refuses a path that would leave the volume", async () => {
    const { service } = filesystemWith({ volume: "radio" });

    const written = (await service.process(
      { op: "write", path: "../../escaped.mp3", binary: new Uint8Array([1]) },
      noop,
    )) as any;

    expect(written.meta.status).toBe(400);
    expect(service.getState().error).toMatch(/path segment/);
  });

  it("stats without reading, which is how a board skips work it has done", async () => {
    const { service } = filesystemWith({ volume: "radio" });
    await service.process(
      { op: "write", path: "a.mp3", binary: new Uint8Array([1]) },
      noop,
    );

    const there = (await service.process({ op: "stat", path: "a.mp3" }, noop)) as any;
    const notThere = (await service.process({ op: "stat", path: "b.mp3" }, noop)) as any;

    // Absence is an answer, not a miss: both are 200 and differ in what they say.
    expect(there.meta).toMatchObject({ status: 200, exists: true });
    expect(notThere.meta).toMatchObject({ status: 200, exists: false });
  });

  it("lists a volume under a prefix", async () => {
    const { service } = filesystemWith({ volume: "radio" });
    for (const path of ["episodes/a.mp3", "episodes/b.mp3", "other/c.mp3"]) {
      await service.process({ op: "write", path, binary: new Uint8Array([1]) }, noop);
    }

    const listed = (await service.process({ op: "list", prefix: "episodes" }, noop)) as any;

    expect(listed.body.count).toBe(2);
    expect(listed.body.files.map((file: any) => file.path)).toEqual([
      "episodes/a.mp3",
      "episodes/b.mp3",
    ]);
  });
});

describe("storage", () => {
  it("passes a request to its backend and hands the answer back", async () => {
    const { service } = storageWith({});

    await service.process(
      { op: "write", path: "one.mp3", binary: new Uint8Array([9, 9]) },
      noop,
    );
    const read = (await service.process({ op: "read", path: "one.mp3" }, noop)) as any;

    expect([...read.binary]).toEqual([9, 9]);
  });

  it("confines every path to its prefix", async () => {
    const { service, files } = storageWith({ prefix: "episodes" });

    await service.process(
      { op: "write", path: "one.mp3", binary: new Uint8Array([1]) },
      noop,
    );

    const stored = await files.list(
      { owner: "tester", boardName: "Radio", volume: "radio" },
    );
    expect(stored.map((file) => file.path)).toEqual(["episodes/one.mp3"]);
  });

  it("answers in the caller's vocabulary, not the store's", async () => {
    // A prefix is confinement, not part of an address. A listing that answered
    // "episodes/one.mp3" would be naming a path that, asked for here, resolves
    // to episodes/episodes/one.mp3 — so anything following the listing gets a
    // 404 it can do nothing about.
    const { service } = storageWith({ prefix: "episodes" });
    await service.process(
      { op: "write", path: "one.mp3", binary: new Uint8Array([1]) },
      noop,
    );

    const listed = (await service.process({ op: "list" }, noop)) as any;
    expect(listed.body.files.map((file: any) => file.path)).toEqual(["one.mp3"]);

    // And what it said can be asked for again.
    const again = (await service.process(
      { meta: { method: "GET", path: `/${listed.body.files[0].path}` } },
      noop,
    )) as any;
    expect(again.meta.status).toBe(200);
    expect([...again.binary]).toEqual([1]);
  });

  it("strips the prefix from what a write and a stat report too", async () => {
    const { service } = storageWith({ prefix: "episodes" });

    const written = (await service.process(
      { op: "write", path: "two.mp3", binary: new Uint8Array([2]) },
      noop,
    )) as any;
    const stat = (await service.process({ op: "stat", path: "two.mp3" }, noop)) as any;

    expect(written.body.path).toBe("two.mp3");
    expect(written.meta.path).toBe("two.mp3");
    expect(stat.meta.path).toBe("two.mp3");
  });

  it("reads an HTTP request as the same thing", async () => {
    const { service } = storageWith({});
    await service.process(
      { op: "write", path: "one.mp3", binary: new Uint8Array([7]) },
      noop,
    );

    const answer = (await service.process(
      { meta: { method: "GET", path: "/one.mp3" } },
      noop,
    )) as any;

    expect(answer.meta.contentType).toBe("audio/mpeg");
    expect([...answer.binary]).toEqual([7]);
  });

  it("lists when the request names a directory rather than a file", async () => {
    const { service } = storageWith({});
    await service.process(
      { op: "write", path: "one.mp3", binary: new Uint8Array([1]) },
      noop,
    );

    const answer = (await service.process({ meta: { method: "GET", path: "/" } }, noop)) as any;

    expect(answer.body.count).toBe(1);
  });

  it("refuses to be written to when it is the public one", async () => {
    // A mount is unauthenticated by design, so the instance behind one answers
    // reads and nothing else.
    const { service, files } = storageWith({ readOnly: true });

    const answer = (await service.process(
      { meta: { method: "PUT", path: "/one.mp3" }, binary: new Uint8Array([1]) },
      noop,
    )) as any;

    expect(answer.meta.status).toBe(405);
    expect(await files.list({ owner: "tester", boardName: "Radio", volume: "radio" })).toEqual([]);
  });

  it("says so when no backend is configured", async () => {
    const { service } = storageWith({ pipeline: [] });

    const answer = (await service.process({ op: "read", path: "one.mp3" }, noop)) as any;

    expect(answer.meta.status).toBe(500);
    expect(answer.body.error).toMatch(/backend/);
  });
});

/**
 * An endpoint in front of a store: what a podcast client, a browser or curl
 * meets. The envelope a pipeline answers with is what decides the response, so
 * the checks are about the HTTP that reaches the caller.
 */
describe("a mounted store", () => {
  const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.stop();
    }
  });

  const startWith = async (storageState: Record<string, unknown>) => {
    const server = createRuntimeServer({
      externalHost: "127.0.0.1",
      auth: { mode: "none" },
    });
    servers.push(server);
    await server.start();

    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "endpoint",
            state: {
              bypass: false,
              mode: "process_on_session",
              pipeline: [
                {
                  instanceId: "store",
                  serviceId: "storage",
                  serviceName: "Library",
                  state: {
                    ...storageState,
                    pipeline: [
                      {
                        instanceId: "backend",
                        serviceId: "filesystem",
                        serviceName: "Files",
                        state: { volume: "radio" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      })
      .expect(200);

    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/endpoint")
      .expect(200);
    return body.__hkpMount as string;
  };

  it("serves a written file as what it is, and lets a player seek in it", async () => {
    const mount = await startWith({});
    const audio = new Uint8Array(Array.from({ length: 40 }, (_, i) => i));

    const written = await fetch(`${mount}/episodes/one.mp3`, {
      method: "PUT",
      headers: { "content-type": "audio/mpeg" },
      body: audio,
    });
    expect(written.status).toBe(200);

    const whole = await fetch(`${mount}/episodes/one.mp3`);
    expect(whole.headers.get("content-type")).toBe("audio/mpeg");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(audio);

    const part = await fetch(`${mount}/episodes/one.mp3`, {
      headers: { range: "bytes=10-19" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/40");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual(
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    );
  });

  it("answers a miss with 404, not with a 200 carrying an error", async () => {
    const mount = await startWith({});

    const missing = await fetch(`${mount}/episodes/nothing.mp3`);

    expect(missing.status).toBe(404);
  });

  it("keeps a read-only endpoint read-only", async () => {
    const mount = await startWith({ readOnly: true });

    const refused = await fetch(`${mount}/one.mp3`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });

    expect(refused.status).toBe(405);
  });
});
