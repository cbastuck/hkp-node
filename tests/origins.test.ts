import { describe, expect, it } from "vitest";

import {
  admitsWithoutCredential,
  allowsOrigin,
  allowsOriginWithoutCredential,
  isKnownHost,
  isLoopbackOrigin,
  parseAllowedOrigins,
  type AllowedOrigins,
} from "../src/origins";

/**
 * Which pages may call a server, and when a request carrying no credential is
 * let in for where it comes from. See src/origins.ts.
 *
 * The same rows are pinned in every runtime server (hkp-node, hkp-python,
 * hkp-rt): a board's runtimes must be equally closed to a foreign page
 * whichever of them they run on.
 */

function admits(
  allowed: AllowedOrigins,
  origin?: string,
  secFetchSite?: string,
  host: string | undefined = "127.0.0.1:8080",
): boolean {
  return admitsWithoutCredential({ origin, secFetchSite, host }, allowed, []);
}

describe("origins", () => {
  it("a page served from this machine is a loopback origin, on any port", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost",
      "http://127.0.0.1:8555",
      "https://127.0.0.1:8443",
      "http://[::1]:3000",
      "HTTP://LOCALHOST:5173",
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
    }
  });

  it("a name that merely starts like a loopback one is somebody else's", () => {
    for (const origin of [
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://127.evil.example",
      "http://evil.example:8887",
      "http://localhost:5173@evil.example",
      "http://192.168.1.20:5173",
      "file://localhost",
      "null",
      "",
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(false);
    }
  });

  it("with nothing said, the apps and local pages may call, and no site may", () => {
    const allowed = parseAllowedOrigins(undefined);

    expect(admits(allowed, "saucer://embedded")).toBe(true);
    expect(admits(allowed, "hkp://app")).toBe(true);
    expect(admits(allowed, "https://appassets.androidplatform.net")).toBe(true);
    expect(admits(allowed, "http://localhost:5173")).toBe(true);

    expect(admits(allowed, "https://evil.example")).toBe(false);
    // The project's own website is a site like any other until somebody says so.
    expect(admits(allowed, "https://readymadeit.com")).toBe(false);
    // What a sandboxed frame, a file:// page and a data: URL all send.
    expect(admits(allowed, "null")).toBe(false);
  });

  it("a caller that is not a browser says nothing and is let in", () => {
    expect(admits(parseAllowedOrigins(""))).toBe(true);
    // No Host either: HTTP/1.0, or a client that left it off.
    expect(
      admitsWithoutCredential({}, parseAllowedOrigins(""), []),
    ).toBe(true);
  });

  it("a list names exactly who may call", () => {
    const allowed = parseAllowedOrigins(
      " https://app.example , https://readymadeit.com ",
    );

    expect(admits(allowed, "https://app.example")).toBe(true);
    expect(admits(allowed, "https://readymadeit.com")).toBe(true);
    expect(admits(allowed, "HTTPS://APP.EXAMPLE")).toBe(true);
    expect(admits(allowed, "https://evil.example")).toBe(false);
    // Replaced, not extended: what was allowed unasked is not, once a list is given.
    expect(admits(allowed, "http://localhost:5173")).toBe(false);
    expect(admits(allowed, "saucer://embedded")).toBe(false);
  });

  it("a star lets any page call with a credential, and none without", () => {
    const allowed = parseAllowedOrigins("*");

    expect(allowsOrigin("https://evil.example", allowed)).toBe(true);
    expect(allowsOriginWithoutCredential("https://evil.example", allowed)).toBe(
      false,
    );
    expect(admits(allowed, "https://evil.example")).toBe(false);
    // What it reads as for such a request: nothing was said.
    expect(admits(allowed, "http://localhost:5173")).toBe(true);
    expect(admits(allowed, "saucer://embedded")).toBe(true);
  });

  it("a request without an origin is refused when the browser says it is cross-site", () => {
    const allowed = parseAllowedOrigins("");

    expect(admits(allowed, undefined, "cross-site")).toBe(false);
    expect(admits(allowed, undefined, "Cross-Site")).toBe(false);
    // Typed into the address bar, or asked for by the server's own page.
    expect(admits(allowed, undefined, "none")).toBe(true);
    expect(admits(allowed, undefined, "same-origin")).toBe(true);
    // An allowed page is allowed however the browser classifies the request.
    expect(admits(allowed, "http://localhost:5173", "cross-site")).toBe(true);
  });

  it("a server is addressed by an address, localhost, or a name it was given", () => {
    expect(isKnownHost("127.0.0.1:8080", [])).toBe(true);
    expect(isKnownHost("localhost:8080", [])).toBe(true);
    expect(isKnownHost("localhost", [])).toBe(true);
    expect(isKnownHost("192.168.1.5:8080", [])).toBe(true);
    expect(isKnownHost("[::1]:8080", [])).toBe(true);
    expect(isKnownHost("[fe80::1]", [])).toBe(true);
    expect(isKnownHost("node.example.com:8080", ["node.example.com"])).toBe(true);
    expect(isKnownHost("Node.Example.com", ["node.example.com"])).toBe(true);
  });

  it("a name somebody else resolves to this machine is not one it answers to", () => {
    // DNS rebinding: the page is same-origin with the server as far as the
    // browser can tell, so there is no Origin to refuse — only this.
    for (const host of [
      "attacker.example:8080",
      "127.0.0.1.attacker.example:8080",
      "localhost.attacker.example",
      "999.1.1.1",
      "1.2.3",
      "localhost:80@attacker.example",
    ]) {
      expect(isKnownHost(host, []), host).toBe(false);
    }
    expect(isKnownHost("attacker.example", ["node.example.com"])).toBe(false);

    const allowed = parseAllowedOrigins("");
    expect(admits(allowed, undefined, "same-origin", "attacker.example:8080")).toBe(false);
    // An allowed page does not make up for it.
    expect(admits(allowed, "http://localhost:5173", undefined, "attacker.example:8080")).toBe(false);
  });
});
