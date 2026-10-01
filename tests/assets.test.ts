import { createHash } from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";

import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AssetStore,
  parseAssetRef,
  readAssetsPayload,
  referencedAssets,
} from "../src/assets";
import { HostedRuntime } from "../src/runtime";
import { SecretVault } from "../src/secrets";
import { createRuntimeServer } from "../src/server";
import { createMemoryFileStore } from "../src/services/fileStore";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { SubService, subServiceDescriptor } from "../src/services/sub-service";
import { AssetService, assetDescriptor } from "../src/services/asset";
import { ServiceConfiguration } from "../src/types";

/**
 * Content a board declares once and names by reference.
 *
 * A runtime is handed descriptors and resolves a reference when a service uses
 * it. What is pinned here: the store resolves each source and says why when it
 * cannot, an edit reaches the next use without anything being reconfigured,
 * nested pipelines see their host's assets, and an endpoint serves an asset
 * named as its response body.
 */

const text = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString("utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("references", () => {
  it("are whole values", () => {
    expect(parseAssetRef("hkp-asset://player")).toBe("player");
    expect(parseAssetRef("<script>hkp-asset://player</script>")).toBeNull();
    expect(parseAssetRef("hkp-asset://")).toBeNull();
    expect(parseAssetRef(42)).toBeNull();
  });

  it("are found anywhere a string mentions one, however nested", () => {
    const state = {
      body: "hkp-asset://page",
      pipeline: [
        { state: { "body=": "path == '/app.js' ? 'hkp-asset://app' : 'hkp-asset://page'" } },
      ],
    };
    expect(referencedAssets(state).sort()).toEqual(["app", "page"]);
  });
});

describe("the payload", () => {
  it("keeps descriptors with exactly one source and drops the rest", () => {
    const entries = readAssetsPayload({
      page: { mediaType: "text/html", text: "<p>hi</p>" },
      both: { mediaType: "text/plain", text: "a", url: "https://example.com" },
      none: { mediaType: "text/plain" },
      gone: null,
    });
    expect(Object.keys(entries).sort()).toEqual(["gone", "page"]);
    expect(entries.page).toEqual({ id: "page", mediaType: "text/html", text: "<p>hi</p>" });
    expect(entries.gone).toBeNull();
  });

  it("reads a list as readily as a map", () => {
    const entries = readAssetsPayload([{ id: "a", mediaType: "text/plain", text: "x" }]);
    expect(Object.keys(entries)).toEqual(["a"]);
  });
});

describe("the store", () => {
  it("resolves inline text and base64", async () => {
    const store = new AssetStore();
    store.replace({
      page: { id: "page", mediaType: "text/html", text: "<p>hi</p>" },
      logo: { id: "logo", mediaType: "image/png", base64: Buffer.from([1, 2, 3]).toString("base64") },
    });

    const page = await store.resolve("hkp-asset://page");
    expect(page.problem).toBe("");
    expect(page.asset?.mediaType).toBe("text/html");
    expect(text(page.asset?.bytes)).toBe("<p>hi</p>");

    const logo = await store.resolve("hkp-asset://logo");
    expect([...(logo.asset?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it("says why an asset does not resolve", async () => {
    const store = new AssetStore();
    store.replace({
      pinned: { id: "pinned", mediaType: "text/plain", text: "changed", sha256: sha256("original") },
      ftp: { id: "ftp", mediaType: "text/plain", url: "ftp://example.com/a.txt" },
      local: { id: "local", mediaType: "text/plain", url: "file:///etc/passwd" },
    });

    expect((await store.resolve("hkp-asset://missing")).problem).toMatch(/not known/);
    expect((await store.resolve("hkp-asset://pinned")).problem).toMatch(/sha256/);
    expect((await store.resolve("hkp-asset://ftp")).problem).toMatch(/not supported/);
    expect((await store.resolve("hkp-asset://local")).problem).toMatch(/file:\/\/ sources cannot be read/);
    expect((await store.resolve("not a reference")).problem).toMatch(/not an asset reference/);
  });

  it("serves an edit on the next use, and tells whoever subscribed", async () => {
    const store = new AssetStore();
    store.replace({ page: { id: "page", mediaType: "text/html", text: "v1" } });
    const changed: string[] = [];
    store.subscribe("page", (id) => changed.push(id));

    expect(text((await store.resolve("hkp-asset://page")).asset?.bytes)).toBe("v1");
    store.merge({ page: { id: "page", mediaType: "text/html", text: "v2" } });
    expect(text((await store.resolve("hkp-asset://page")).asset?.bytes)).toBe("v2");

    store.merge({ page: null });
    expect((await store.resolve("hkp-asset://page")).problem).toMatch(/not known/);
    expect(changed).toEqual(["page", "page"]);
  });

  it("does not notify for a push that changes nothing", () => {
    const store = new AssetStore();
    const descriptor = { id: "page", mediaType: "text/html", text: "v1" };
    store.replace({ page: descriptor });
    const changed: string[] = [];
    store.subscribe("page", (id) => changed.push(id));
    store.merge({ page: { ...descriptor } });
    expect(changed).toEqual([]);
  });

  it("refuses content larger than it may hold", async () => {
    const store = new AssetStore({}, () => null, { maxBytes: 4 });
    store.replace({ big: { id: "big", mediaType: "text/plain", text: "too large" } });
    expect((await store.resolve("hkp-asset://big")).problem).toMatch(/larger than 4 bytes/);
  });

  describe("with a URL source", () => {
    let server: http.Server;
    let base = "";
    let requests: Array<Record<string, string | string[] | undefined>> = [];
    let body = "remote v1";

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        requests.push(req.headers);
        const etag = `"${sha256(body)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader("etag", etag);
        res.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    afterEach(() => {
      requests = [];
      body = "remote v1";
    });

    it("fetches it, and revalidates with its ETag rather than downloading again", async () => {
      const store = new AssetStore();
      store.replace({ remote: { id: "remote", mediaType: "text/plain", url: `${base}/a.txt` } });

      expect(text((await store.resolve("hkp-asset://remote")).asset?.bytes)).toBe("remote v1");
      expect(text((await store.resolve("hkp-asset://remote")).asset?.bytes)).toBe("remote v1");
      expect(requests[1]["if-none-match"]).toBeTruthy();

      body = "remote v2";
      expect(text((await store.resolve("hkp-asset://remote")).asset?.bytes)).toBe("remote v2");
    });

    it("does not ask again for content pinned by its hash", async () => {
      const store = new AssetStore();
      store.replace({
        remote: { id: "remote", mediaType: "text/plain", url: `${base}/a.txt`, sha256: sha256("remote v1") },
      });
      await store.resolve("hkp-asset://remote");
      await store.resolve("hkp-asset://remote");
      expect(requests).toHaveLength(1);
    });

    it("sends a header's secret only where its audience allows", async () => {
      const vault = new SecretVault();
      vault.replace({ token: { value: "s3cret", audience: ["127.0.0.1"] } });
      const store = new AssetStore({}, () => vault);
      store.replace({
        remote: {
          id: "remote",
          mediaType: "text/plain",
          url: `${base}/a.txt`,
          headers: { authorization: "Bearer {{secret.token}}" },
        },
      });
      await store.resolve("hkp-asset://remote");
      expect(requests[0].authorization).toBe("Bearer s3cret");

      vault.replace({ token: { value: "s3cret", audience: ["elsewhere.example"] } });
      expect((await store.resolve("hkp-asset://remote")).problem).toMatch(/may not be sent/);
    });
  });
});

describe("a nested pipeline", () => {
  it("resolves against the runtime around it, including what is pushed later", async () => {
    const createService = (config: ServiceConfiguration) =>
      config.serviceId === subServiceDescriptor.serviceId
        ? new SubService(config, createService)
        : new AssetService(config);

    const runtime = new HostedRuntime(
      {
        id: "outer",
        name: "Outer",
        services: [
          {
            serviceId: subServiceDescriptor.serviceId,
            uuid: "scope",
            state: {
              pipeline: [
                {
                  serviceId: assetDescriptor.serviceId,
                  instanceId: "inner",
                  state: { asset: "hkp-asset://page" },
                },
              ],
            },
          },
        ],
        assets: { page: { id: "page", mediaType: "text/plain", text: "v1" } },
      },
      createService,
    );

    const first = (await runtime.processAt("scope", null, () => {})) as { body: string };
    expect(first.body).toBe("v1");

    runtime.setAssets({ page: { id: "page", mediaType: "text/plain", text: "v2" } });
    const second = (await runtime.processAt("scope", null, () => {})) as { body: string };
    expect(second.body).toBe("v2");
  });
});

describe("the asset service", () => {
  const runtimeWith = (assets: Record<string, { id: string; mediaType: string; text?: string; base64?: string }>) =>
    new HostedRuntime(
      {
        id: "rt",
        name: "Rt",
        services: [{ serviceId: "asset", uuid: "a", state: { asset: "hkp-asset://page" } }],
        assets: assets as never,
      },
      (config) => new AssetService(config),
    );

  it("emits text as a body, with the media type in its meta", async () => {
    const runtime = runtimeWith({ page: { id: "page", mediaType: "text/html", text: "<p>hi</p>" } });
    expect(await runtime.processAt("a", null, () => {})).toEqual({
      meta: { status: 200, contentType: "text/html", asset: "page", size: 9 },
      body: "<p>hi</p>",
    });
  });

  it("emits anything else as bytes", async () => {
    const runtime = runtimeWith({
      page: { id: "page", mediaType: "image/png", base64: Buffer.from([9, 8]).toString("base64") },
    });
    const out = (await runtime.processAt("a", null, () => {})) as { binary: Uint8Array };
    expect([...out.binary]).toEqual([9, 8]);
  });

  it("takes the asset its input names", async () => {
    const runtime = runtimeWith({
      page: { id: "page", mediaType: "text/plain", text: "page" },
      other: { id: "other", mediaType: "text/plain", text: "other" },
    });
    const out = (await runtime.processAt("a", { asset: "hkp-asset://other" }, () => {})) as { body: string };
    expect(out.body).toBe("other");
  });

  it("answers an unknown asset with an error, not its reference", async () => {
    const runtime = runtimeWith({});
    const out = (await runtime.processAt("a", null, () => {})) as { meta: { status: number }; body: { error: string } };
    expect(out.meta.status).toBe(404);
    expect(out.body.error).toMatch(/not known/);
    expect(runtime.getService("a")?.getState().error).toMatch(/not known/);
  });
});

describe("over the wire", () => {
  const servers: Array<ReturnType<typeof createRuntimeServer>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.stop();
    }
  });

  async function serve(assets: unknown, template: Record<string, unknown>) {
    const files = createMemoryFileStore();
    const server = createRuntimeServer({ externalHost: "127.0.0.1", files });
    servers.push(server);
    await server.start();
    await request(server.httpServer)
      .post("/runtimes")
      .send({
        id: "rt-1",
        name: "Node",
        boardName: "Radio",
        assets,
        services: [
          {
            serviceId: httpServerSubservicesDescriptor.serviceId,
            uuid: "http-1",
            state: {
              bypass: false,
              onRequest: [
                {
                  instanceId: "answer",
                  serviceId: "map",
                  state: { mode: "replace", template },
                },
              ],
            },
          },
        ],
      })
      .expect(200);
    const { body } = await request(server.httpServer)
      .get("/runtimes/rt-1/services/http-1")
      .expect(200);
    return { server, files, mount: body.__hkpMount as string };
  }

  it("serves an asset named as the response body, and an edit on the next request", async () => {
    const { server, mount } = await serve(
      { player: { mediaType: "text/html; charset=utf-8", text: "<h1>v1</h1>" } },
      { meta: { status: 200 }, body: "hkp-asset://player" },
    );

    let res = await fetch(mount);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<h1>v1</h1>");

    const pushed = await request(server.httpServer)
      .post("/runtimes/rt-1/assets")
      .send({ player: { mediaType: "text/html; charset=utf-8", text: "<h1>v2</h1>" } })
      .expect(200);
    expect(pushed.body).toEqual({ ids: ["player"] });

    res = await fetch(mount);
    expect(await res.text()).toBe("<h1>v2</h1>");
  });

  it("serves whichever asset an expression picked", async () => {
    const { mount } = await serve(
      {
        page: { mediaType: "text/html", text: "<script src=app.js></script>" },
        app: { mediaType: "text/javascript", text: "console.log(1)" },
      },
      {
        meta: { status: 200 },
        "body=": "params.meta.path == '/app.js' ? 'hkp-asset://app' : 'hkp-asset://page'",
      },
    );

    const script = await fetch(`${mount}/app.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript");
    expect(await script.text()).toBe("console.log(1)");
    expect(await (await fetch(mount)).text()).toBe("<script src=app.js></script>");
  });

  it("keeps a content type the envelope declared", async () => {
    const { mount } = await serve(
      { page: { mediaType: "text/html", text: "x" } },
      { meta: { status: 200, contentType: "text/plain" }, body: "hkp-asset://page" },
    );
    expect((await fetch(mount)).headers.get("content-type")).toBe("text/plain");
  });

  it("fails loudly for an asset it does not have", async () => {
    const { mount } = await serve({}, { meta: { status: 200 }, body: "hkp-asset://missing" });
    const res = await fetch(mount);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/"missing" is not known/);
  });

  it("reads a file:// source inside the tenant's volume, and nothing outside it", async () => {
    const { server, files } = await serve(
      {
        kit: { mediaType: "audio/wav", url: "file:///samples/kit.wav" },
        escape: { mediaType: "text/plain", url: "file:///samples/../../etc/passwd" },
        remote: { mediaType: "text/plain", url: "file://host/samples/kit.wav" },
      },
      { meta: { status: 200 }, body: "x" },
    );
    await files.write(
      { owner: "anonymous", boardName: "Radio", volume: "samples" },
      "kit.wav",
      new Uint8Array([1, 2]),
    );

    const check = (id: string) =>
      request(server.httpServer).get(`/runtimes/rt-1/assets/${id}`).expect(200);
    expect((await check("kit")).body).toEqual({ ok: true, mediaType: "audio/wav", size: 2 });
    expect((await check("escape")).body.ok).toBe(false);
    expect((await check("remote")).body.ok).toBe(false);
    expect((await check("missing")).body.problem).toMatch(/not known/);
  });

  it("answers 404 for a runtime that does not exist", async () => {
    const { server } = await serve({}, { meta: { status: 200 }, body: "x" });
    await request(server.httpServer).post("/runtimes/nope/assets").send({}).expect(404);
  });
});
