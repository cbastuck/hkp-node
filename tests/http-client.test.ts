import http from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HttpClientService } from "../src/services/http-client";
import { RuntimeHost, RuntimeNotification } from "../src/types";

type Recorded = {
  method: string;
  path: string;
  contentType?: string;
  userAgent?: string;
  body: Buffer;
};

type Endpoint = {
  url: string;
  received: Recorded[];
  close: () => Promise<void>;
};

/** A server that records what it was sent and answers with what it was told to. */
async function startEndpoint(
  reply: (path: string) => { status?: number; contentType?: string; body?: Buffer | string },
): Promise<Endpoint> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        userAgent: req.headers["user-agent"],
        body: Buffer.concat(chunks),
      });
      const answer = reply(req.url ?? "");
      res.writeHead(answer.status ?? 200,
        answer.contentType ? { "content-type": answer.contentType } : undefined);
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Captures what the service pushes through the rest of the pipeline. */
function hostSpy() {
  const pushed: unknown[] = [];
  const emitted: unknown[] = [];
  const host: RuntimeHost = {
    processFrom: (_uuid, data, _onNotification) => {
      pushed.push(data);
      return data;
    },
    notify: () => {},
    emitResult: (output) => {
      emitted.push(output);
    },
  };
  return { host, pushed, emitted };
}

/** Resolves once the service has pushed a result, or throws on timeout. */
async function nextPush(pushed: unknown[]): Promise<any> {
  const deadline = Date.now() + 2000;
  while (pushed.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("service pushed no result");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pushed[0];
}

const endpoints: Endpoint[] = [];

afterEach(async () => {
  while (endpoints.length) {
    await endpoints.pop()?.close();
  }
});

async function endpoint(
  reply: Parameters<typeof startEndpoint>[0],
): Promise<Endpoint> {
  const created = await startEndpoint(reply);
  endpoints.push(created);
  return created;
}

describe("http-client target", () => {
  it("calls the address it was configured with", async () => {
    const target = await endpoint(() => ({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }));
    const { host, pushed, emitted } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: target.url, path: "/hello" },
    } as any);
    service.setHost(host);

    // The pipeline is synchronous, so the response cannot be returned from
    // process — it does not exist yet. It arrives through processFrom instead.
    expect(service.process(undefined, () => {})).toBeNull();

    const result = await nextPush(pushed);
    expect(target.received[0].path).toBe("/hello");
    expect(result.meta.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    // Nothing downstream stopped, so the runtime's result is emitted onward.
    expect(emitted).toHaveLength(1);
  });

  it("waits rather than calling anything while a reference is unresolved", async () => {
    const { host, pushed } = hostSpy();
    const notifications: any[] = [];

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: "hkp-mount://other/peer-1" },
    } as any);
    service.setHost(host);

    // Only the coordinator can turn a reference into an address. Until it does,
    // there is nothing to call — a normal state while a board comes up.
    expect(service.process(undefined, (n) => notifications.push(n))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toEqual([]);
    expect(notifications[0].error).toContain("hkp-mount://other/peer-1");
  });

  it("calls the address once the coordinator hands it over", async () => {
    const target = await endpoint(() => ({ contentType: "text/plain", body: "live" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: "hkp-mount://other/peer-1" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});

    // This is what a coordinator does once the owner publishes its address.
    const state = service.configure({ __hkpMount: target.url });
    expect(state.__hkpMount).toBe(target.url);

    service.process(undefined, () => {});
    expect((await nextPush(pushed)).body).toBe("live");
  });

  it("joins the path to the address without doubling the slash", async () => {
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: `${target.url}/`, path: "/x" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await nextPush(pushed);

    expect(target.received[0].path).toBe("/x");
  });
});

describe("http-client request body", () => {
  it("sends a string as text and an object as JSON", async () => {
    const target = await endpoint(() => ({ body: "ok" }));

    const send = async (input: unknown) => {
      const { host, pushed } = hostSpy();
      const service = new HttpClientService({
        uuid: "client-1",
        serviceId: "http-client",
        state: { __hkpMount: target.url, method: "post" },
      } as any);
      service.setHost(host);
      service.process(input, () => {});
      await nextPush(pushed);
    };

    await send("plain text");
    expect(target.received[0].contentType).toContain("text/plain");
    expect(target.received[0].body.toString()).toBe("plain text");

    await send({ a: 1 });
    expect(target.received[1].contentType).toBe("application/json");
    expect(JSON.parse(target.received[1].body.toString())).toEqual({ a: 1 });
  });

  it("forwards a request received by an http-server unchanged", async () => {
    // {meta, body} is what http-server-subservices produces, so a request taken
    // in on one runtime can be sent on from another without reshaping it.
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: target.url, method: "post" },
    } as any);
    service.setHost(host);
    service.process(
      { meta: { contentType: "application/json" }, body: { forwarded: true } },
      () => {},
    );
    await nextPush(pushed);

    expect(target.received[0].contentType).toBe("application/json");
    expect(JSON.parse(target.received[0].body.toString())).toEqual({
      forwarded: true,
    });
  });

  it("sends no body on GET", async () => {
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: target.url },
    } as any);
    service.setHost(host);
    service.process({ ignored: true }, () => {});
    await nextPush(pushed);

    expect(target.received[0].body.byteLength).toBe(0);
  });
});

describe("http-client response", () => {
  it("decodes what the content type explains and keeps the rest as bytes", async () => {
    const target = await endpoint((path) =>
      path === "/json"
        ? { contentType: "application/json", body: '{"n":1}' }
        : { contentType: "application/octet-stream", body: Buffer.from([1, 2, 3]) },
    );

    const call = async (path: string) => {
      const { host, pushed } = hostSpy();
      const service = new HttpClientService({
        uuid: "client-1",
        serviceId: "http-client",
        state: { __hkpMount: target.url, path },
      } as any);
      service.setHost(host);
      service.process(undefined, () => {});
      return nextPush(pushed);
    };

    const json = await call("/json");
    expect(json.body).toEqual({ n: 1 });
    expect(json.binary).toBeUndefined();

    const bytes = await call("/blob");
    expect(bytes.body).toBeUndefined();
    expect([...bytes.binary]).toEqual([1, 2, 3]);
  });

  it("passes a failure status on as a result rather than an error", async () => {
    // The request completed; what the server said is the pipeline's business.
    const target = await endpoint(() => ({ status: 404, body: "nope" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: target.url },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});

    expect((await nextPush(pushed)).meta.status).toBe(404);
  });

  it("pushes nothing when the request itself fails", async () => {
    const { host, pushed } = hostSpy();
    const notifications: any[] = [];

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      // Nothing is listening here: the port was closed before the call.
      state: { __hkpMount: "http://127.0.0.1:1/", timeoutMs: 500 },
    } as any);
    service.setHost(host);
    service.process(undefined, (n) => notifications.push(n));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No fabricated result travels down the pipeline.
    expect(pushed).toEqual([]);
    expect(notifications.some((n) => n.error)).toBe(true);
  });
});

describe("http-client and the shared http-client contract", () => {
  it("calls the url the shared UI configures when no mount is set", async () => {
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { url: target.url, path: "/plain" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await nextPush(pushed);

    expect(target.received[0].path).toBe("/plain");
  });

  it("lets a mount win over a typed url", async () => {
    // Naming a service is the more specific instruction, and its address is not
    // knowable when the board is written.
    const mounted = await endpoint(() => ({ body: "mounted" }));
    const typed = await endpoint(() => ({ body: "typed" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { url: typed.url, __hkpMount: mounted.url },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await nextPush(pushed);

    expect(mounted.received).toHaveLength(1);
    expect(typed.received).toEqual([]);
  });

  it("waits on an unresolved mount instead of falling back to url", async () => {
    // Falling back would silently call something the board did not ask for.
    const typed = await endpoint(() => ({ body: "typed" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { url: typed.url, __hkpMount: "hkp-mount://other/svc" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(typed.received).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("sends the configured body when the pipeline provides none", async () => {
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { url: target.url, method: "post", body: "from state" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await nextPush(pushed);

    expect(target.received[0].body.toString()).toBe("from state");
  });

  it("sends the configured user agent", async () => {
    const target = await endpoint(() => ({ body: "ok" }));
    const { host, pushed } = hostSpy();

    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { url: target.url, userAgent: "hkp-test/1.0" },
    } as any);
    service.setHost(host);
    service.process(undefined, () => {});
    await nextPush(pushed);

    expect(target.received[0].userAgent).toBe("hkp-test/1.0");
  });
});

describe("http-client configuration", () => {
  it("passes input through when bypassed", async () => {
    const { host } = hostSpy();
    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: { __hkpMount: "http://127.0.0.1:1/", bypass: true },
    } as any);
    service.setHost(host);
    expect(service.process({ untouched: true }, () => {})).toEqual({
      untouched: true,
    });
  });

  it("reports its target and settings in state", () => {
    const service = new HttpClientService({
      uuid: "client-1",
      serviceId: "http-client",
      state: {
        __hkpMount: "hkp-mount://node/http-1",
        method: "POST",
        path: "/upload",
        headers: { "x-token": "abc", dropped: 1 },
      },
    } as any);

    expect(service.getState()).toEqual({
      url: "",
      __hkpMount: "hkp-mount://node/http-1",
      path: "/upload",
      // Stored lower case, as hkp-rt's http-client does and the shared UI expects.
      method: "post",
      headers: { "x-token": "abc" },
      userAgent: "",
      body: "",
      timeoutMs: 10000,
      bypass: false,
    });
  });
});
