import { describe, expect, it } from "vitest";

import { fetchWithCredentials } from "../src/credentialedFetch";
import { SecretVault } from "../src/secrets";

/**
 * A secret in a header reaches only the hosts its audience allows.
 *
 * `fetch` follows a redirect with the headers it was given, which were resolved
 * for the address first called. What is pinned here: redirects are followed
 * with the headers resolved again for each address, a header that may not go on
 * is left out rather than failing the request, and what `fetch` withholds from
 * another origin is withheld here too.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A `fetch` that answers from a table and records what it was sent. */
function web(pages: Record<string, { status?: number; location?: string; body?: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    });
    expect(init.redirect).toBe("manual");
    const page = pages[url];
    if (!page) {
      return new Response("not found", { status: 404 });
    }
    return new Response(page.location ? null : (page.body ?? ""), {
      status: page.status ?? (page.location ? 302 : 200),
      headers: page.location ? { location: page.location } : {},
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function vaultWith(audience?: string[]) {
  const vault = new SecretVault();
  vault.replace({ key: { value: "s3cret", audience } });
  return vault;
}

async function bodyOf(sent: Awaited<ReturnType<typeof fetchWithCredentials>>) {
  return "response" in sent ? sent.response.text() : `problem: ${sent.problem}`;
}

describe("a request with a secret in a header", () => {
  it("leaves the secret out of a redirect to a host outside its audience, and goes on", async () => {
    const { calls, fetchImpl } = web({
      "https://api.example/model": { location: "https://storage.example/signed?x=1" },
      "https://storage.example/signed?x=1": { body: "weights" },
    });

    const sent = await fetchWithCredentials(
      vaultWith(["api.example"]),
      "https://api.example/model",
      { headers: { "x-api-key": "{{secret.key}}", accept: "application/octet-stream" } },
      fetchImpl,
    );

    expect(await bodyOf(sent)).toBe("weights");
    expect(calls.map((call) => call.headers)).toEqual([
      { "x-api-key": "s3cret", accept: "application/octet-stream" },
      { accept: "application/octet-stream" },
    ]);
  });

  it("keeps it on a redirect its audience allows", async () => {
    const { calls, fetchImpl } = web({
      "https://api.example/a": { location: "/b" },
      "https://api.example/b": { body: "ok" },
    });

    await fetchWithCredentials(
      vaultWith(["api.example"]),
      "https://api.example/a",
      { headers: { "x-api-key": "{{secret.key}}" } },
      fetchImpl,
    );

    expect(calls[1]).toMatchObject({
      url: "https://api.example/b",
      headers: { "x-api-key": "s3cret" },
    });
  });

  it("does not bring it back when a later redirect returns to an allowed host", async () => {
    const { calls, fetchImpl } = web({
      "https://api.example/a": { location: "https://elsewhere.example/hop" },
      "https://elsewhere.example/hop": { location: "https://api.example/admin" },
      "https://api.example/admin": { body: "ok" },
    });

    await fetchWithCredentials(
      vaultWith(["api.example"]),
      "https://api.example/a",
      { headers: { "x-api-key": "{{secret.key}}" } },
      fetchImpl,
    );

    expect(calls.map((call) => call.headers)).toEqual([{ "x-api-key": "s3cret" }, {}, {}]);
  });

  it("refuses the address called when the secret may not go there", async () => {
    const { calls, fetchImpl } = web({});

    const sent = await fetchWithCredentials(
      vaultWith(["api.example"]),
      "https://elsewhere.example/a",
      { headers: { "x-api-key": "{{secret.key}}" } },
      fetchImpl,
    );

    expect(sent).toEqual({ problem: "key may not be sent to elsewhere.example" });
    expect(calls).toEqual([]);
  });
});

describe("a redirect", () => {
  it("to another origin goes without authorization, as fetch sends it", async () => {
    const { calls, fetchImpl } = web({
      "https://api.example/a": { location: "https://storage.example/b" },
      "https://storage.example/b": { body: "ok" },
    });

    await fetchWithCredentials(
      // No audience: nothing but the origin says where this may go.
      vaultWith(undefined),
      "https://api.example/a",
      { headers: { Authorization: "Bearer {{secret.key}}", cookie: "a=b", accept: "*/*" } },
      fetchImpl,
    );

    expect(calls[0].headers.Authorization).toBe("Bearer s3cret");
    expect(calls[1].headers).toEqual({ accept: "*/*" });
  });

  it("turns a POST into a GET without its body on a 302, and repeats it on a 307", async () => {
    const pages = {
      "https://api.example/moved": { status: 302, location: "/fetched" },
      "https://api.example/fetched": { body: "ok" },
      "https://api.example/again": { status: 307, location: "/repeated" },
      "https://api.example/repeated": { body: "ok" },
    };
    const request = {
      method: "post",
      headers: { "content-type": "application/json", accept: "*/*" },
      body: "{}",
    };

    const moved = web(pages);
    await fetchWithCredentials(null, "https://api.example/moved", request, moved.fetchImpl);
    expect(moved.calls[1]).toEqual({
      url: "https://api.example/fetched",
      method: "GET",
      headers: { accept: "*/*" },
      body: undefined,
    });

    const again = web(pages);
    await fetchWithCredentials(null, "https://api.example/again", request, again.fetchImpl);
    expect(again.calls[1]).toMatchObject({ method: "POST", body: "{}", headers: request.headers });
  });

  it("is not followed out of http(s), nor for ever", async () => {
    const elsewhere = web({ "https://api.example/a": { location: "file:///etc/passwd" } });
    expect(
      await fetchWithCredentials(null, "https://api.example/a", {}, elsewhere.fetchImpl),
    ).toEqual({ problem: "https://api.example/a redirected to a file:// address" });

    const loop = web({ "https://api.example/a": { location: "/a" } });
    expect(await fetchWithCredentials(null, "https://api.example/a", {}, loop.fetchImpl)).toEqual({
      problem: "https://api.example/a redirected more than 10 times",
    });
    expect(loop.calls).toHaveLength(11);
  });

  it("is handed back as it is when it names nowhere to go", async () => {
    const { calls, fetchImpl } = web({ "https://api.example/a": { status: 302 } });
    const sent = await fetchWithCredentials(null, "https://api.example/a", {}, fetchImpl);
    expect("response" in sent && sent.response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });
});
