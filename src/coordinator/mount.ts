/**
 * Mount vocabulary, for the coordinator side.
 *
 * A service that needs to be reachable from outside is assigned a path on its
 * runtime's server and publishes the resulting address in its own state, in
 * `__hkpMount`.
 *
 * A service that *consumes* a mount names the owner with a
 * `hkp-mount://<runtimeId>/<serviceUuid>` reference, written in whatever field
 * that service calls its target. References are found by their scheme, wherever
 * they appear: a bare `<runtimeId>/<serviceUuid>` is not accepted, because it is
 * indistinguishable from a relative URL.
 *
 * The coordinator resolves a reference and configures the consumer's
 * `__hkpMount` with the address — never the field the reference was found in.
 * One job each: the reference is what a person wrote and what the board keeps,
 * the address is only true of this run.
 *
 * Resolving one form into the other needs a view of the whole board, which is
 * the coordinator's job — see `session.ts`. This module is only the vocabulary,
 * and mirrors `hkp-frontend/src/runtime/board/mount.ts`; the two must agree,
 * since they read and write the same board.
 */

/** State field holding a mount address, on both the owner and the consumer. */
export const MOUNT_FIELD = "__hkpMount";

/** Scheme marking a value as a reference to a mount-owning service. */
export const MOUNT_SCHEME = "hkp-mount://";

export type MountRef = {
  runtimeId: string;
  serviceUuid: string;
};

/**
 * Parses a `hkp-mount://<runtimeId>/<serviceUuid>` reference. Returns null for
 * anything that is not one — an address, a blank, a legacy value — so callers
 * can treat "not a reference" as "nothing to resolve".
 *
 * Split by hand rather than through `URL`, which would subject the runtime id
 * to host syntax; both parts here are opaque board identifiers.
 */
export function parseMountRef(
  value: string | null | undefined,
): MountRef | null {
  if (!value || !value.startsWith(MOUNT_SCHEME)) {
    return null;
  }
  const target = value.slice(MOUNT_SCHEME.length);
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) {
    return null;
  }
  return {
    runtimeId: target.slice(0, slash),
    serviceUuid: target.slice(slash + 1),
  };
}

export function formatMountRef(ref: MountRef): string {
  return `${MOUNT_SCHEME}${ref.runtimeId}/${ref.serviceUuid}`;
}

/**
 * Every mount reference in a value, replaced by the address `resolve` returns
 * for it — in whatever field held it. References that resolve to null are left
 * untouched rather than blanked, so a service still describes what it wanted and
 * can be resolved later, once its owner publishes.
 *
 * Used where a board is being handed somewhere that has no coordinator to ask
 * (an export). Configuring a running consumer does *not* go through this: that
 * writes the address to `__hkpMount` and leaves what the board says alone.
 *
 * Walks the whole value because services nest: a sub-service pipeline carries
 * its own services, each with their own state.
 */
export function substituteMounts<T>(
  value: T,
  resolve: (ref: string) => string | null,
): T {
  if (typeof value === "string") {
    return (parseMountRef(value) ? (resolve(value) ?? value) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteMounts(item, resolve)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = substituteMounts(item, resolve);
  }
  return out as T;
}

/**
 * Every mount reference in a value, as the references themselves, found by
 * scheme wherever they appear. Used to find out which services a board wants
 * pointed at a mount before any of them have been provisioned.
 */
export function collectMountRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (parseMountRef(value)) {
      into.add(value);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMountRefs(item, into);
    }
    return into;
  }
  if (!value || typeof value !== "object") {
    return into;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectMountRefs(item, into);
  }
  return into;
}
