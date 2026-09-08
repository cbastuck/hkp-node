/**
 * Secrets a runtime was given, and the one way to a value.
 *
 * A board carries `{{secret.<alias>}}` references and never a value. The values
 * arrive separately — with the runtime's create payload, or on
 * `PUT /runtimes/:id/secrets` — and are held here, apart from every service's
 * state. Nothing reads them back out: there is no endpoint, they are not in a
 * runtime's serialized form, and a service obtains one only through `resolve`,
 * for one use, at the moment of that use.
 *
 * That is what keeps a board safe to save. A service holds a reference, reports
 * a reference from `getState`, and the board it is serialized into never holds
 * anything else.
 *
 * The format matches `hkp-frontend/src/core/secrets.ts` exactly: a board
 * written against one runtime has to open against another.
 */

const REFERENCE = /\{\{\s*secret\.([A-Za-z0-9_.-]+)\s*\}\}/g;

export type SecretEntry = {
  value: string;
  /**
   * The hosts this secret may be sent to. Absent, or empty, means
   * unconstrained — which is what an entry carrying no audience answers.
   */
  audience?: string[];
};

export type SecretRefusal = {
  alias: string;
  to: string;
  audience: string[];
};

export type Resolved<T> = {
  value: T;
  missing: string[];
  refused: SecretRefusal[];
};

/** Where a secret is about to be sent. */
export type SecretUse = {
  /** A URL or `host[:port]`; only the host is compared against an audience. */
  to: string;
};

export class SecretVault {
  private entries = new Map<string, SecretEntry>();

  /** Replaces everything held. */
  replace(entries: Record<string, SecretEntry>): void {
    this.entries = new Map(Object.entries(entries));
  }

  /** Adds or replaces individual entries, leaving the rest alone. */
  merge(entries: Record<string, SecretEntry>): void {
    for (const [alias, entry] of Object.entries(entries)) {
      this.entries.set(alias, entry);
    }
  }

  /**
   * The aliases held, for saying whether something is configured. Deliberately
   * the only thing this answers about its contents.
   */
  aliases(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * A value with its references resolved, for one use.
   *
   * The result is transient: what a service passes to the call it is making,
   * never something to assign back to its state. `to` is required and a caller
   * that cannot name a destination gets nothing — every caller can, because a
   * secret is used by sending it somewhere.
   *
   * An alias that is not held, or that may not go to this destination, becomes
   * an empty string and is reported by name. Empty is what "not configured"
   * already looks like to the code that takes a credential; the literal
   * reference would be sent as one and fail far away, naming nothing.
   */
  resolve<T>(value: T, use: SecretUse): Resolved<T> {
    const host = destinationHost(use?.to);
    if (!host) {
      throw new Error(
        "resolving a secret requires a destination: pass { to } naming the host it is sent to",
      );
    }

    const missing = new Set<string>();
    const refused = new Map<string, SecretRefusal>();

    const resolved = walk(value, (text) =>
      text.replace(REFERENCE, (_whole, alias: string) => {
        const entry = this.entries.get(alias);
        if (!entry) {
          missing.add(alias);
          return "";
        }
        if (!permits(entry.audience, host)) {
          refused.set(alias, {
            alias,
            to: host,
            audience: entry.audience ?? [],
          });
          return "";
        }
        return entry.value;
      }),
    );

    return {
      value: resolved as T,
      missing: [...missing],
      refused: [...refused.values()],
    };
  }
}

/**
 * One credential, resolved for one use, or the reason there is none.
 *
 * What a service holds is either a reference or a literal, and either may be
 * absent; the caller wants a value it can send or a sentence it can report.
 * Separating those two outcomes here keeps every service that takes a
 * credential from writing the same four branches.
 *
 * A literal is returned as it stands, which is what a runtime configured from
 * a file holds. A reference needs a vault, and without one it resolves to
 * nothing rather than being sent as its own text — a caller handed
 * `{{secret.…}}` would offer it as a credential and fail somewhere far away.
 *
 * Takes a whole structure as readily as one string, because a credential is
 * not always a field of its own: it can be one entry in a map of headers, or
 * part of a larger string around it.
 */
export function resolveCredential<T>(
  vault: SecretVault | null | undefined,
  held: T,
  to: string,
): { value: T; problem: string } {
  const references = referencedSecrets(held);
  if (!references.length) {
    return { value: held, problem: "" };
  }
  // Nothing resolved on a failure: the caller gets a problem to report, and
  // never a half-filled structure it might send anyway.
  const none = { value: undefined as unknown as T };
  if (!vault) {
    return {
      ...none,
      problem: `no secrets available to resolve ${references.join(", ")}`,
    };
  }

  const { value, missing, refused } = vault.resolve(held, { to });
  if (refused.length) {
    return {
      ...none,
      problem: `${refused[0].alias} may not be sent to ${refused[0].to}`,
    };
  }
  if (missing.length) {
    return { ...none, problem: `no value stored for ${missing.join(", ")}` };
  }
  return { value, problem: "" };
}

/** Every alias a value refers to, however deeply it is nested. */
export function referencedSecrets(value: unknown): string[] {
  const found = new Set<string>();
  walk(value, (text) => {
    for (const match of text.matchAll(REFERENCE)) {
      found.add(match[1]);
    }
    return text;
  });
  return [...found];
}

/**
 * The host part of a destination.
 *
 * Callers hold destinations in whatever shape their own API uses — a request
 * URL, a `host:port` pair, a bare hostname — and normalizing here keeps an
 * audience a list of hosts rather than a list of spellings.
 */
export function destinationHost(to: unknown): string | null {
  if (typeof to !== "string") {
    return null;
  }
  const trimmed = to.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `hkp://${trimmed}`;
  try {
    const { hostname } = new URL(candidate);
    return hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether an audience covers a host.
 *
 * An entry is a host, or a `*.` prefix standing for any subdomain of what
 * follows. The wildcard does not match the bare domain, so widening one to the
 * other stays a deliberate act.
 */
function permits(audience: string[] | undefined, host: string): boolean {
  if (!audience || !audience.length) {
    return true;
  }
  return audience.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    if (!allowed) {
      return false;
    }
    if (allowed.startsWith("*.")) {
      return host.endsWith(allowed.slice(1));
    }
    return host === allowed;
  });
}

/**
 * Reads a secrets payload off the wire.
 *
 * Tolerant of the short form — a bare string is a value with no audience —
 * because that is what a client with nothing to say about destinations sends.
 * Anything it cannot read is dropped rather than failing the request: a
 * malformed entry costs one credential, and the service referencing it will
 * report it as unavailable by name.
 */
export function readSecretsPayload(value: unknown): Record<string, SecretEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries: Record<string, SecretEntry> = {};
  for (const [alias, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      entries[alias] = { value: entry };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string") {
      continue;
    }
    const audience = Array.isArray(record.audience)
      ? record.audience.filter((host): host is string => typeof host === "string")
      : undefined;
    entries[alias] = audience?.length
      ? { value: record.value, audience }
      : { value: record.value };
  }
  return entries;
}

/**
 * Applies `visit` to every string in a structure, rebuilding it as it goes.
 *
 * Only plain objects and arrays are entered: state can carry things that are
 * not JSON, and rebuilding one of those field by field would change what it is.
 */
function walk(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === "string") {
    return visit(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, visit));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = walk(entry, visit);
  }
  return out;
}
