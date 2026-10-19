import http from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { fetchWithCredentials } from "../src/credentialedFetch";
import {
  EgressRefused,
  failureReason,
  isPublicAddress,
  readEgressPolicy,
  reachableAddress,
  setEgressPolicy,
} from "../src/egress";

/**
 * Where a board may make a hosted server connect to.
 *
 * A server several people's boards run on must not dial its own loopback, its
 * private network or the cloud metadata endpoint on a board's say-so. What is
 * pinned here is that, with `HKP_EGRESS=public`, those are refused at the
 * connection — whatever name led there, however many redirects it took — and
 * that without it nothing changes.
 */

const servers: http.Server[] = [];

afterEach(async () => {
  await setEgressPolicy({ mode: "open" });
  while (servers.length) {
    await new Promise((resolve) => servers.pop()!.close(resolve));
  }
});

async function serve(
  host: string,
  handler: http.RequestListener = (_req, res) => res.end("reached"),
): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

const hosted = (allow = "") =>
  setEgressPolicy(readEgressPolicy({ HKP_EGRESS: "public", HKP_EGRESS_ALLOW: allow }));

describe("what counts as the public internet", () => {
  it("is everything that is not this host, a private network or reserved", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.0", "100.128.0.0", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("is not this host, a private network, link-local or reserved", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "100.100.100.200",
      "169.254.169.254",
      "169.254.170.2",
      "192.0.0.192",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254",
      "ff02::1",
      "::127.0.0.1",
      "64:ff9b:1::a9fe:a9fe",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("judges an IPv6 address that carries an IPv4 one by the IPv4 inside", () => {
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("2002:7f00:1::")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("is not something that is not an address", () => {
    expect(isPublicAddress("localhost")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("the policy a server is given", () => {
  it("is open unless it is told otherwise", () => {
    expect(readEgressPolicy({})).toEqual({ mode: "open" });
    expect(readEgressPolicy({ HKP_EGRESS: "open" })).toEqual({ mode: "open" });
  });

  it("refuses to start on a setting it does not understand", () => {
    expect(() => readEgressPolicy({ HKP_EGRESS: "private" })).toThrow(/HKP_EGRESS/);
    // A name could be repointed at anything once allowed.
    expect(() =>
      readEgressPolicy({ HKP_EGRESS: "public", HKP_EGRESS_ALLOW: "ollama.internal" }),
    ).toThrow(/not an address or a range/);
  });
});

describe("a hosted server's fetch", () => {
  it("does not reach a private address, named or literal", async () => {
    const port = await serve("127.0.0.1");
    await hosted();

    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
      const failure = await fetch(url).catch((err) => err);
      expect(failureReason(failure), url).toMatch(/does not reach private addresses/);
    }
  });

  it("does not reach one by another spelling of it", async () => {
    const port = await serve("127.0.0.1");
    await hosted();

    // 2130706433 and 0x7f.1 are 127.0.0.1 by the time anything connects.
    for (const url of [`http://2130706433:${port}/`, `http://0x7f.1:${port}/`]) {
      const failure = await fetch(url).catch((err) => err);
      expect(failureReason(failure), url).toMatch(/does not reach private addresses/);
    }
  });

  it("reaches what the operator allowed", async () => {
    const port = await serve("127.0.0.1");
    await hosted("127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("reached");
  });

  it("is refused at the hop a redirect leads somewhere private", async () => {
    // Allowed to the first host, which sends the request on to one that is
    // not: the second connection is judged on its own.
    const inside = await serve("::1");
    const outside = await serve("127.0.0.1", (_req, res) => {
      res.writeHead(302, { location: `http://[::1]:${inside}/` }).end();
    });
    await hosted("127.0.0.1");

    const followed = await fetch(`http://127.0.0.1:${outside}/`).catch((err) => err);
    expect(failureReason(followed)).toMatch(/does not reach private addresses \(::1\)/);

    // The HTTP Client follows redirects itself, to resolve credentials per
    // hop; it goes through the same dispatcher.
    const credentialed = await fetchWithCredentials(
      undefined,
      `http://127.0.0.1:${outside}/`,
      {},
    ).catch((err) => err);
    expect(failureReason(credentialed)).toMatch(/does not reach private addresses/);
  });

  it("changes nothing on a server that was not told it is hosted", async () => {
    const port = await serve("127.0.0.1");

    const response = await fetch(`http://localhost:${port}/`);
    expect(await response.text()).toBe("reached");
  });
});

describe("a service that opens its own socket", () => {
  it("connects to the address that was checked, keeping the name for TLS", async () => {
    // Both of localhost's addresses: a name is reached only when all of them
    // may be.
    await hosted("127.0.0.0/8,::1");
    const dial = await reachableAddress("localhost");
    expect(["127.0.0.1", "::1"]).toContain(dial.host);
    expect(dial.servername).toBe("localhost");
  });

  it("is told no before it connects anywhere", async () => {
    await hosted();
    await expect(reachableAddress("127.0.0.1")).rejects.toBeInstanceOf(EgressRefused);
    await expect(reachableAddress("localhost")).rejects.toThrow(
      /localhost is (127\.0\.0\.1|::1)/,
    );
  });

  it("dials the name as given on an open server", async () => {
    await expect(reachableAddress("imap.example.com")).resolves.toEqual({
      host: "imap.example.com",
    });
  });
});
