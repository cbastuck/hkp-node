import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF protection for coordinator → runtime calls.
 *
 * The coordinator dials `runtime.url` straight from a (potentially shared /
 * imported) board config, from inside whatever network it runs in. Without a
 * guard, a crafted board makes the coordinator a confused deputy: reaching cloud
 * metadata, internal admin panels, or scanning private hosts. This validates the
 * URL — resolving the host and checking *every* resolved address, which also
 * defeats a hostname that points at a blocked range.
 *
 * Policy:
 * - Always blocked: link-local (incl. the 169.254.169.254 cloud-metadata
 *   endpoint) and the unspecified address — never a legitimate runtime.
 * - Loopback / private (RFC1918, IPv6 ULA): blocked by default. Self-hosted /
 *   local runtimes are common, so allow them via HKP_ALLOW_PRIVATE_RUNTIMES=true
 *   or by listing the host in HKP_RUNTIME_URL_ALLOWLIST.
 * - HKP_RUNTIME_URL_ALLOWLIST (comma-separated host or host:port): when set,
 *   only listed hosts are permitted at all. Listed hosts may resolve to
 *   loopback/private (the operator vouched for them); link-local stays blocked.
 *
 * Residual risk: there is a TOCTOU window between this resolve-and-check and the
 * actual connection (DNS rebinding). Pinning the connection to the validated IP
 * would close it and is a sensible follow-up.
 */
export class BlockedRuntimeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRuntimeUrlError";
  }
}

export type UrlGuardPolicy = {
  /** Lower-cased host or host:port entries; when present, acts as a strict allowlist. */
  allowlist?: string[];
  /** Permit loopback/private targets globally. */
  allowPrivate: boolean;
};

let cachedPolicy: UrlGuardPolicy | null = null;

export function readUrlGuardPolicy(): UrlGuardPolicy {
  if (cachedPolicy) {
    return cachedPolicy;
  }
  const raw = process.env.HKP_RUNTIME_URL_ALLOWLIST;
  const allowlist = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : [];
  cachedPolicy = {
    allowlist: allowlist.length ? allowlist : undefined,
    allowPrivate: process.env.HKP_ALLOW_PRIVATE_RUNTIMES === "true",
  };
  return cachedPolicy;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

type AddressKind = "link-local" | "loopback" | "private" | "public";

function classifyIpv4(ip: string): AddressKind {
  const o = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (o[0] === 0) return "link-local"; // 0.0.0.0/8 "this network" / unspecified
  if (o[0] === 127) return "loopback"; // 127.0.0.0/8
  if (o[0] === 169 && o[1] === 254) return "link-local"; // 169.254.0.0/16 incl. metadata
  if (o[0] === 10) return "private"; // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private"; // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return "private"; // 192.168.0.0/16
  return "public";
}

function classifyIpv6(ip: string): AddressKind {
  const v = ip.toLowerCase();
  if (v === "::") return "link-local"; // unspecified
  if (v === "::1") return "loopback";
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return classifyIpv4(mapped[1]);
  const firstHextet = Number.parseInt(v.split(":")[0] || "", 16);
  if (!Number.isNaN(firstHextet)) {
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return "link-local"; // fe80::/10
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return "private"; // fc00::/7 ULA
  }
  return "public";
}

function classify(ip: string): AddressKind {
  return isIP(ip) === 6 ? classifyIpv6(ip) : classifyIpv4(ip);
}

async function resolveAddresses(host: string): Promise<string[]> {
  if (isIP(host)) {
    return [host];
  }
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * Throw BlockedRuntimeUrlError if `rawUrl` is not a safe coordinator target.
 */
export async function assertRuntimeUrlAllowed(
  rawUrl: string,
  policy: UrlGuardPolicy = readUrlGuardPolicy(),
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedRuntimeUrlError(`Invalid runtime URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedRuntimeUrlError(
      `Unsupported runtime URL scheme "${url.protocol}" in ${rawUrl}`,
    );
  }

  // URL.hostname keeps the brackets on IPv6 literals ("[::1]"); strip them so
  // isIP / DNS see a bare address.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  let explicitlyAllowed = false;
  if (policy.allowlist) {
    const hostPort = url.port ? `${host}:${url.port}` : host;
    explicitlyAllowed =
      policy.allowlist.includes(host) || policy.allowlist.includes(hostPort);
    if (!explicitlyAllowed) {
      throw new BlockedRuntimeUrlError(
        `Runtime URL host "${host}" is not in HKP_RUNTIME_URL_ALLOWLIST`,
      );
    }
  }

  let addresses: string[];
  try {
    addresses = await resolveAddresses(host);
  } catch (err) {
    throw new BlockedRuntimeUrlError(
      `Could not resolve runtime URL host "${host}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  for (const address of addresses) {
    const kind = classify(address);
    if (kind === "link-local") {
      throw new BlockedRuntimeUrlError(
        `Runtime URL "${rawUrl}" resolves to a blocked link-local/metadata address (${address})`,
      );
    }
    if (
      (kind === "loopback" || kind === "private") &&
      !policy.allowPrivate &&
      !explicitlyAllowed
    ) {
      throw new BlockedRuntimeUrlError(
        `Runtime URL "${rawUrl}" resolves to a ${kind} address (${address}); ` +
          `set HKP_ALLOW_PRIVATE_RUNTIMES=true or add the host to HKP_RUNTIME_URL_ALLOWLIST to permit it`,
      );
    }
  }
}
