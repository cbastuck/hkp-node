/**
 * Mount vocabulary, for the coordinator side.
 *
 * A service that needs to be reachable from outside is assigned a path on its
 * runtime's server and publishes the resulting address in its own state. Both
 * sides use one reserved field:
 *
 *   __hkpMount says where a mount is.
 *
 * A service that *owns* a mount publishes its address there, as an absolute
 * `http(s)://` URL. A service that *consumes* one points at the owner there, as
 * `hkp-mount://<runtimeId>/<serviceUuid>`. The two forms are told apart by
 * scheme; a bare `<runtimeId>/<serviceUuid>` is not accepted, because it is
 * indistinguishable from a relative URL.
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
 * for it. References that resolve to null are left untouched rather than
 * blanked, so a service still describes what it wanted and can be resolved
 * later, once its owner publishes.
 *
 * Walks the whole value because services nest: a sub-service pipeline carries
 * its own services, each with their own state.
 */
export function substituteMounts<T>(
  value: T,
  resolve: (ref: string) => string | null,
): T {
  if (Array.isArray(value)) {
    return value.map((item) => substituteMounts(item, resolve)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === MOUNT_FIELD && typeof item === "string") {
      out[key] = parseMountRef(item) ? (resolve(item) ?? item) : item;
      continue;
    }
    out[key] = substituteMounts(item, resolve);
  }
  return out as T;
}

/**
 * Every mount reference in a value, as the references themselves. Used to find
 * out which services a board wants pointed at a mount before any of them have
 * been provisioned.
 */
export function collectMountRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMountRefs(item, into);
    }
    return into;
  }
  if (!value || typeof value !== "object") {
    return into;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === MOUNT_FIELD && typeof item === "string" && parseMountRef(item)) {
      into.add(item);
      continue;
    }
    collectMountRefs(item, into);
  }
  return into;
}
