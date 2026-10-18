/**
 * Where a board may make this server connect to.
 *
 * A board names destinations — an HTTP Client's URL, a feed, a mail server, a
 * model's base URL — and the server dials them. On a person's own machine that
 * is the point: a board talks to the printer, the NAS, a model on the LAN. On
 * a server several people's boards run on it is not: a destination on the
 * server's loopback, its private network or a cloud provider's metadata
 * endpoint (`169.254.169.254`, which hands out the instance's credentials) is
 * something the server can reach and the board's author should not.
 *
 * So a server can be told it is hosted: with `HKP_EGRESS=public`, a destination
 * is reached only when every address its name resolves to is a public internet
 * address. Unset, nothing is refused.
 *
 * **Judged where the socket opens, on the address it opens to.** Not on the
 * name a board wrote: a name is whatever its owner points it at, and a name
 * that resolved to a public address when it was checked may resolve to
 * `127.0.0.1` when it is dialled. Checking at the connection covers that, every
 * hop of a redirect, and every spelling of an address (`2130706433`, `0x7f.1`),
 * which are addresses by then.
 *
 * Every `fetch` in the process goes through a dispatcher installed here, so a
 * service written later is covered without doing anything. A service that
 * opens its own socket — IMAP, SMTP — asks `reachableAddress` first and
 * connects to what it answers. `tests/egress-sources.test.ts` fails on any
 * other way out.
 *
 * Connections the operator configured rather than a board — the coordinator
 * link, the token issuer's keys — are not a board's destinations and are not
 * judged here.
 */
import dns from "node:dns";
import net from "node:net";

// Types only at the top: importing undici installs a dispatcher of its own as
// the process's when none is set, and an open server is to keep the one it
// had. It is loaded when a policy is set that needs it.
import type { Dispatcher } from "undici";

/** An address range: the address as bytes, and how many leading bits count. */
type Range = { bytes: number[]; bits: number };

export type EgressPolicy =
  | { mode: "open" }
  | {
      mode: "public";
      /** Addresses and ranges reached anyway, as the operator listed them. */
      allow: Range[];
    };

/**
 * What is not the public internet: this host, private networks, link-local
 * (where the metadata endpoints are), shared address space, and what is not
 * an address one connects to at all.
 */
const NOT_PUBLIC = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "fc00::/7",
  "ff00::/8",
].map(parseRange);

/**
 * IPv6 forms that carry an IPv4 address, and where it sits. An address in one
 * of them is the IPv4 address inside it — `::ffff:127.0.0.1` is loopback — and
 * is judged as that.
 */
const CARRY_IPV4: Array<{ range: Range; at: number }> = [
  { range: parseRange("::ffff:0:0/96"), at: 12 },
  { range: parseRange("64:ff9b::/96"), at: 12 },
  { range: parseRange("2002::/16"), at: 2 },
];

/** An address as bytes: 4 for IPv4, 16 for IPv6. Null when it is neither. */
function toBytes(address: string): number[] | null {
  const plain = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = net.isIP(plain);
  if (kind === 4) {
    return plain.split(".").map(Number);
  }
  if (kind !== 6) {
    return null;
  }
  // A dotted IPv4 tail ("::ffff:127.0.0.1") becomes the two groups it is.
  let text = plain;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const groupsOf = (part: string | undefined) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const left = groupsOf(head);
  const right = groupsOf(rest);
  const groups =
    rest === undefined
      ? left
      : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function parseRange(text: string): Range {
  const [address, bits] = text.split("/");
  const bytes = toBytes(address);
  if (!bytes) {
    throw new Error(`Not an address or a range: ${text}`);
  }
  return { bytes, bits: bits === undefined ? bytes.length * 8 : Number(bits) };
}

function inRange(bytes: number[], range: Range): boolean {
  if (bytes.length !== range.bytes.length) {
    return false;
  }
  for (let bit = 0; bit < range.bits; bit += 1) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte] & mask) !== (range.bytes[byte] & mask)) {
      return false;
    }
  }
  return true;
}

/** Whether `address` is a public internet address. Not an address: false. */
export function isPublicAddress(address: string): boolean {
  const bytes = toBytes(address);
  if (!bytes) {
    return false;
  }
  for (const { range, at } of CARRY_IPV4) {
    if (inRange(bytes, range)) {
      return isPublicAddress(bytes.slice(at, at + 4).join("."));
    }
  }
  return !NOT_PUBLIC.some((range) => inRange(bytes, range));
}

/**
 * Reads `HKP_EGRESS` and `HKP_EGRESS_ALLOW`. An entry of the list that is not
 * an address or a range is an error rather than skipped: an operator who
 * meant to allow something should learn now that nothing was.
 */
export function readEgressPolicy(env: NodeJS.ProcessEnv): EgressPolicy {
  const mode = (env.HKP_EGRESS ?? "").trim().toLowerCase();
  if (!mode || mode === "open") {
    return { mode: "open" };
  }
  if (mode !== "public") {
    throw new Error(`HKP_EGRESS must be "public" or unset, not "${env.HKP_EGRESS}"`);
  }
  const allow = (env.HKP_EGRESS_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return parseRange(entry);
      } catch {
        throw new Error(
          `HKP_EGRESS_ALLOW: "${entry}" is not an address or a range (names are not accepted: an allowed name could be repointed)`,
        );
      }
    });
  return { mode: "public", allow };
}

/** Whether a destination at `address` may be reached under `policy`. */
export function mayReach(policy: EgressPolicy, address: string): boolean {
  if (policy.mode === "open") {
    return true;
  }
  const bytes = toBytes(address);
  if (bytes && policy.allow.some((range) => inRange(bytes, range))) {
    return true;
  }
  return isPublicAddress(address);
}

/** A destination this server will not connect to, and why. */
export class EgressRefused extends Error {
  readonly code = "EHKPEGRESS";

  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(
      host === address
        ? `This server does not reach private addresses (${address})`
        : `This server does not reach private addresses (${host} is ${address})`,
    );
    this.name = "EgressRefused";
  }
}

let active: EgressPolicy = { mode: "open" };
let before: Dispatcher | null = null;

export function egressPolicy(): EgressPolicy {
  return active;
}

/**
 * `dns.lookup`, refusing a name any of whose addresses may not be reached.
 *
 * All of them, not the one that would be used: a name answering with a public
 * address and a private one is a name somebody arranged, and which of the two
 * a connection ends up on is not this function's to promise.
 */
export const egressLookup = ((
  hostname: string,
  options: dns.LookupOptions | number | ((...args: unknown[]) => void),
  callback?: (...args: unknown[]) => void,
) => {
  const done = (typeof options === "function" ? options : callback)!;
  const asked: dns.LookupOptions =
    typeof options === "object" ? options : typeof options === "number" ? { family: options } : {};
  dns.lookup(hostname, { ...asked, all: true }, (err, addresses) => {
    if (err) {
      done(err);
      return;
    }
    const refused = addresses.find(({ address }) => !mayReach(active, address));
    if (refused) {
      done(new EgressRefused(hostname, refused.address));
      return;
    }
    if (asked.all) {
      done(null, addresses);
      return;
    }
    done(null, addresses[0].address, addresses[0].family);
  });
}) as typeof dns.lookup;

/** Resolves `host` through `egressLookup`: every address, or the refusal. */
function lookupAll(host: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    egressLookup(host, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses as unknown as dns.LookupAddress[]),
    );
  });
}

/**
 * Where a service that opens its own socket should connect, for `host`.
 *
 * Open: `host` itself, as before. Hosted: the address the guard checked, with
 * `host` as the name to verify the certificate against — connecting to the
 * name instead would resolve it again, and the second answer is not the one
 * that was judged.
 */
export async function reachableAddress(
  host: string,
): Promise<{ host: string; servername?: string }> {
  if (active.mode === "open") {
    return { host };
  }
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) {
    if (!mayReach(active, host)) {
      throw new EgressRefused(host, host);
    }
    return { host };
  }
  const [first] = await lookupAll(host);
  return { host: first.address, servername: host };
}

/**
 * Makes `policy` the process's. Hosted, every `fetch` is dispatched through a
 * connector that refuses what may not be reached; open, the dispatcher that
 * was there before is put back.
 *
 * The connector judges an address literal itself: a socket opened to one is
 * never looked up, so `egressLookup` alone would let `http://127.0.0.1/`
 * through.
 */
export async function setEgressPolicy(policy: EgressPolicy): Promise<void> {
  active = policy;
  if (policy.mode === "open" && !before) {
    return;
  }
  const { Agent, buildConnector, getGlobalDispatcher, setGlobalDispatcher } =
    await import("undici");
  if (policy.mode === "open") {
    setGlobalDispatcher(before!);
    before = null;
    return;
  }
  before ??= getGlobalDispatcher();
  const connect = buildConnector({ lookup: egressLookup });
  setGlobalDispatcher(
    new Agent({
      connect: (options, callback) => {
        const host = (options.hostname ?? "").replace(/^\[|\]$/g, "");
        if (net.isIP(host) && !mayReach(active, host)) {
          callback(new EgressRefused(host, host), null);
          return;
        }
        connect(options, callback);
      },
    }),
  );
}

/**
 * What to say about a failed request: the refusal when this was one. `fetch`
 * reports every connection failure as "fetch failed" and keeps the reason as
 * its cause.
 */
export function failureReason(err: unknown): string {
  return refusalIn(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

/** The refusal an error is, or was caused by. */
export function refusalIn(err: unknown): EgressRefused | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof EgressRefused) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
