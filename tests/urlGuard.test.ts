import { describe, expect, it } from "vitest";

import {
  assertRuntimeUrlAllowed,
  BlockedRuntimeUrlError,
  type UrlGuardPolicy,
} from "../src/coordinator/urlGuard";

const DEFAULT: UrlGuardPolicy = { allowPrivate: false };
const ALLOW_PRIVATE: UrlGuardPolicy = { allowPrivate: true };

// IP literals are checked without a DNS lookup, so these stay offline.
async function blocked(url: string, policy: UrlGuardPolicy): Promise<boolean> {
  try {
    await assertRuntimeUrlAllowed(url, policy);
    return false;
  } catch (err) {
    expect(err).toBeInstanceOf(BlockedRuntimeUrlError);
    return true;
  }
}

describe("coordinator runtime URL guard", () => {
  it("always blocks link-local / cloud-metadata, even with allowPrivate", async () => {
    expect(await blocked("http://169.254.169.254/latest/meta-data", DEFAULT)).toBe(true);
    expect(await blocked("http://169.254.169.254/", ALLOW_PRIVATE)).toBe(true);
    expect(await blocked("http://[fe80::1]/", ALLOW_PRIVATE)).toBe(true);
    expect(await blocked("http://0.0.0.0/", ALLOW_PRIVATE)).toBe(true);
  });

  it("blocks loopback and private ranges by default", async () => {
    expect(await blocked("http://127.0.0.1:8080/", DEFAULT)).toBe(true);
    expect(await blocked("http://10.0.0.5/", DEFAULT)).toBe(true);
    expect(await blocked("http://192.168.1.10/", DEFAULT)).toBe(true);
    expect(await blocked("http://172.16.4.4/", DEFAULT)).toBe(true);
    expect(await blocked("http://[::1]:8080/", DEFAULT)).toBe(true);
    expect(await blocked("http://[fd00::1]/", DEFAULT)).toBe(true);
  });

  it("permits loopback/private when allowPrivate is set", async () => {
    expect(await blocked("http://127.0.0.1:8080/", ALLOW_PRIVATE)).toBe(false);
    expect(await blocked("http://192.168.1.10/", ALLOW_PRIVATE)).toBe(false);
    expect(await blocked("http://[::1]:8080/", ALLOW_PRIVATE)).toBe(false);
  });

  it("permits public addresses by default", async () => {
    expect(await blocked("http://8.8.8.8/", DEFAULT)).toBe(false);
    expect(await blocked("https://1.1.1.1:443/", DEFAULT)).toBe(false);
  });

  it("rejects non-http(s)/ws(s) schemes", async () => {
    expect(await blocked("ftp://8.8.8.8/", DEFAULT)).toBe(true);
    expect(await blocked("file:///etc/passwd", DEFAULT)).toBe(true);
    expect(await blocked("not a url", DEFAULT)).toBe(true);
  });

  it("enforces a strict allowlist when configured", async () => {
    const policy: UrlGuardPolicy = {
      allowPrivate: false,
      allowlist: ["8.8.8.8", "10.0.0.5:8080"],
    };
    // Allowlisted public host.
    expect(await blocked("http://8.8.8.8/", policy)).toBe(false);
    // Allowlisted host:port that resolves private — operator vouched for it.
    expect(await blocked("http://10.0.0.5:8080/", policy)).toBe(false);
    // Same host, wrong port → not in allowlist.
    expect(await blocked("http://10.0.0.5:9999/", policy)).toBe(true);
    // Not listed at all.
    expect(await blocked("http://1.1.1.1/", policy)).toBe(true);
    // Listed but link-local still always blocked (defense in depth).
    const metadataPolicy: UrlGuardPolicy = {
      allowPrivate: true,
      allowlist: ["169.254.169.254"],
    };
    expect(await blocked("http://169.254.169.254/", metadataPolicy)).toBe(true);
  });
});
