import { CloudBoardConfig, isRemoteRuntime } from "./types";

/**
 * What a board's facade lets a member of the board do and see.
 *
 * A member is not handed the board. They are handed its facade, and the facade
 * is therefore the whole of their reach: the services it asks to process are
 * the ones a member may ask, and the services it reads from are the ones a
 * member hears. Everything else on the board — its other services, their
 * configuration, whatever credentials that configuration names — stays with
 * the owner.
 *
 * Read here from the facade document itself rather than from a list a board
 * author keeps beside it, so that what a member can do is exactly what the
 * facade they are shown does.
 *
 * The vocabulary is the frontend's (`hkp-frontend/src/facade/types.ts`). Found
 * by shape, the way `widgetServices.ts` finds references there, so a widget
 * added later is covered without this being edited.
 */

export type FacadeAccess = {
  /**
   * Services a `process` action names. Naming one makes it callable by a
   * member with *any* payload — the entry point is the capability, not what
   * the widget would have sent — so whatever matters is checked behind it.
   */
  processTargets: Set<string>;
  /**
   * Services a widget or a notice reads, with the paths read from each. An
   * empty string stands for a source with no path: the whole notification.
   */
  sources: Map<string, Set<string>>;
  /** Every service the facade names, for whatever reason. */
  named: Set<string>;
};

/**
 * What an action carries to its service. A uuid in there is a value being
 * sent, not an address this facade dials.
 */
const PAYLOADS = new Set(["configure", "payload"]);

function isReference(name: string): boolean {
  return name === "serviceUuid" || name.endsWith("ServiceUuid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An address a template has yet to fill in names nothing a member may call. */
function isLiteral(address: string): boolean {
  return !!address && !address.includes("{{");
}

/** Where a facade says what it reads: a widget's or a notice's source, and a
 *  fold's live count. */
const SOURCES = new Set(["source", "summary"]);

function walk(value: unknown, access: FacadeAccess, under = ""): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, access, under);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const uuid = value.serviceUuid;
  if (typeof uuid === "string" && isLiteral(uuid)) {
    if (value.type === "process") {
      access.processTargets.add(uuid);
    } else if (SOURCES.has(under)) {
      const paths = access.sources.get(uuid) ?? new Set<string>();
      paths.add(typeof value.path === "string" ? value.path : "");
      access.sources.set(uuid, paths);
    }
  }

  for (const [name, entry] of Object.entries(value)) {
    if (PAYLOADS.has(name)) {
      continue;
    }
    if (typeof entry === "string") {
      if (isReference(name) && isLiteral(entry)) {
        access.named.add(entry);
      }
      continue;
    }
    walk(entry, access, name);
  }
}

export function readFacadeAccess(facade: unknown): FacadeAccess {
  const access: FacadeAccess = {
    processTargets: new Set(),
    sources: new Map(),
    named: new Set(),
  };
  walk(facade, access);
  return access;
}

/** The first segment of an address: the service a board lists. */
function rootOf(address: string): string {
  const dot = address.indexOf(".");
  return dot < 0 ? address : address.slice(0, dot);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function writePath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (!isRecord(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Of a service's state, only what the facade's sources read from it.
 *
 * A source without a path reads whatever the service next says, which is a
 * notification and not its state; nothing of the state is given for it. So a
 * service the facade only acts on, or only listens to, has an empty state
 * here — its statement, its address, its credentials' names are not a
 * member's to see.
 */
export function projectState(
  access: FacadeAccess,
  serviceUuid: string,
  state: unknown,
): Record<string, unknown> {
  return pick(state, access.sources.get(serviceUuid) ?? []);
}

/**
 * Of what a service said, only what the facade's sources read from it.
 *
 * A source without a path reads the notification whole, so the whole of it is
 * given. Otherwise it is cut down to the paths read: each of them resolves in
 * what is returned to exactly what it resolved to in what was said, and
 * nothing beside them is there. A notification holding none of them is not a
 * notification for this facade: forwarding an empty object would reveal that
 * the service spoke but would not clear a widget, since none of its source
 * paths changed. A service clears a value explicitly (`rows: []`, for example).
 */
export function projectNotification(
  access: FacadeAccess,
  serviceUuid: string,
  payload: unknown,
): unknown | undefined {
  const paths = access.sources.get(serviceUuid) ?? new Set<string>();
  if (paths.has("")) {
    return payload;
  }
  const projected = pick(payload, paths);
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** The values at `paths` in `value`, at the same paths in an object of their
 *  own. A pathless entry names no part of it and picks nothing. */
function pick(value: unknown, paths: Iterable<string>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    if (!path) {
      continue;
    }
    const found = readPath(value, path);
    if (found !== undefined) {
      writePath(picked, path, found);
    }
  }
  return picked;
}

/**
 * The runtime a facade's service is on: the first of the board's remote
 * runtimes listing it, which is how a facade's bare uuid is resolved
 * everywhere. A browser runtime's services are not a member's to reach — that
 * runtime runs in its owner's browser.
 */
export function runtimeHolding(
  config: CloudBoardConfig,
  serviceUuid: string,
): string | undefined {
  const root = rootOf(serviceUuid);
  for (const runtime of config.runtimes) {
    if (!isRemoteRuntime(runtime)) {
      continue;
    }
    if ((config.services[runtime.id] ?? []).some((svc) => svc.uuid === root)) {
      return runtime.id;
    }
  }
  return undefined;
}

/**
 * The board as a member is sent it: the facade, and of the board only the
 * services the facade names — what each one is, never how it is configured.
 *
 * Shaped as a board, so a client renders the facade from it the way it would
 * from the real one. There is no board underneath: the runtimes carry no
 * address and no settings, and a service nobody named is not there at all.
 */
export function projectConfig(
  config: CloudBoardConfig,
  access: FacadeAccess,
  stateOf: (runtimeId: string, serviceUuid: string) => unknown,
): CloudBoardConfig {
  const services: CloudBoardConfig["services"] = {};
  for (const address of access.named) {
    const runtimeId = runtimeHolding(config, address);
    if (!runtimeId) {
      continue;
    }
    const uuid = rootOf(address);
    const listed = services[runtimeId] ?? [];
    if (listed.some((svc) => svc.uuid === uuid)) {
      continue;
    }
    const svc = (config.services[runtimeId] ?? []).find(
      (entry) => entry.uuid === uuid,
    );
    if (!svc) {
      continue;
    }
    listed.push({
      uuid,
      serviceId: svc.serviceId,
      serviceName: svc.serviceName ?? svc.name ?? svc.serviceId,
      state: projectState(access, uuid, stateOf(runtimeId, uuid)),
    });
    services[runtimeId] = listed;
  }

  return {
    boardName: config.boardName,
    runtimes: config.runtimes
      .filter((runtime) => runtime.id in services)
      .map(({ id, name, type }) => ({ id, name, type })),
    services,
    facade: config.facade,
  };
}
