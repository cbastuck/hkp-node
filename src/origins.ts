/**
 * Which browser pages may call this server, and when a request that carries no
 * credential is let in.
 *
 * Being reachable only from this machine is not the same as being called only
 * by this machine's owner: a page in their browser is a local caller too, and
 * any site can address `127.0.0.1`. So a request admitted without a credential
 * — a server running without auth — must also not come from a foreign page,
 * and must address the server by a name the server knows. A browser states the
 * first in `Origin` (or, on a request it sends without one, in
 * `Sec-Fetch-Site`) and the second in `Host`; a page cannot forge either.
 *
 * A caller that is not a browser sends none of these, and is let in as before:
 * another process on this machine is not what this guards against.
 *
 * The same rule, row for row, is in hkp-rt (`lib/include/origins.h`) and
 * hkp-python (`hkp/origins.py`).
 */

/**
 * The origins a server was told may call it, the way `ALLOWED_ORIGINS` gives
 * them:
 *
 * - `"default"` — nothing was said: the origins Readymade's own apps run from,
 *   and any page served from this machine;
 * - a list — exactly those;
 * - `"*"` — any origin, for a request that carries a credential. A request
 *   that carries none is never let in on the strength of `*`: for it, `*`
 *   reads as nothing was said.
 */
export type AllowedOrigins = "default" | "*" | string[];

/** Where the Readymade apps load their pages from: desktop, iOS, Android. */
const APP_ORIGINS = [
  "saucer://embedded",
  "hkp://app",
  "https://appassets.androidplatform.net",
];

/** Reads `ALLOWED_ORIGINS`. */
export function parseAllowedOrigins(value: string | undefined): AllowedOrigins {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "default";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .split(",")
    .map((origin) => origin.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Four dot-separated numbers and nothing else. Strict, because the names this
 * is asked about come from a request: `127.0.0.1.example.com` is a name
 * somebody else resolves, not an address.
 */
function isIPv4Literal(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isIPv6Literal(host: string): boolean {
  return /^\[[0-9a-f:.]*:[0-9a-f:.]*\]$/.test(host);
}

/** Splits `host[:port]` — a `Host` header, or what follows an origin's scheme. */
function splitHostPort(value: string): { host: string } | null {
  const match = /^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/.exec(value);
  return match ? { host: match[1].toLowerCase() } : null;
}

function isLoopbackName(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    (isIPv4Literal(host) && host.startsWith("127."))
  );
}

/** True for the origin of a page served from this machine, on any port. */
export function isLoopbackOrigin(origin: string): boolean {
  const match = /^https?:\/\/(.*)$/.exec(origin.toLowerCase());
  if (!match) {
    return false;
  }
  const parsed = splitHostPort(match[1]);
  return parsed !== null && isLoopbackName(parsed.host);
}

/**
 * True when a `Host` header names the server by something a page cannot have
 * arranged: an address, `localhost`, or a name the server was told is its own.
 *
 * A page that resolves its own name to this machine (DNS rebinding) is
 * same-origin with the server as far as the browser can tell, and sends no
 * `Origin` to refuse — but the name it used is still in `Host`. A request
 * without the header was not sent by a browser.
 */
export function isKnownHost(
  hostHeader: string | undefined,
  ownNames: string[],
): boolean {
  const value = hostHeader?.trim();
  if (!value) {
    return true;
  }
  const parsed = splitHostPort(value);
  if (!parsed) {
    return false;
  }
  const { host } = parsed;
  if (host === "localhost" || isIPv4Literal(host) || isIPv6Literal(host)) {
    return true;
  }
  return ownNames.some((name) => name !== "" && name.toLowerCase() === host);
}

/**
 * Whether a page at `origin` may call the server with nothing but where it is
 * calling from.
 */
export function allowsOriginWithoutCredential(
  origin: string | undefined,
  allowed: AllowedOrigins,
): boolean {
  const value = origin?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (Array.isArray(allowed)) {
    return allowed.includes(value);
  }
  return APP_ORIGINS.includes(value) || isLoopbackOrigin(value);
}

/**
 * Whether a page at `origin` may read what the server answers, and call it
 * with a credential.
 */
export function allowsOrigin(
  origin: string | undefined,
  allowed: AllowedOrigins,
): boolean {
  return allowed === "*" || allowsOriginWithoutCredential(origin, allowed);
}

/** What a request says about where it came from. */
export type RequestSource = {
  origin?: string;
  secFetchSite?: string;
  host?: string;
};

/**
 * Whether a request that carries no credential may be let in on the strength
 * of where it comes from. See the top of this file.
 */
export function admitsWithoutCredential(
  source: RequestSource,
  allowed: AllowedOrigins,
  ownNames: string[],
): boolean {
  if (source.origin?.trim()) {
    if (!allowsOriginWithoutCredential(source.origin, allowed)) {
      return false;
    }
  } else if (source.secFetchSite?.trim().toLowerCase() === "cross-site") {
    // A browser leaves `Origin` off a plain GET it makes for another site's
    // page — an image, a script — and says so here instead.
    return false;
  }
  return isKnownHost(source.host, ownNames);
}
