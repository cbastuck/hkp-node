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
   * The facade as a member is shown it: the board's, without what it keeps for
   * its owner. Everything below is read from this, so an item kept for the
   * owner grants a member nothing, and is not sent to them either.
   */
  facade: unknown;
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
  const shown = facadeForMembers(facade);
  const access: FacadeAccess = {
    facade: shown,
    processTargets: new Set(),
    sources: new Map(),
    named: new Set(),
  };
  walk(shown, access);
  return access;
}

/** Whether an entry is one a facade keeps for the board's owner. */
function isOwners(value: unknown): boolean {
  return isRecord(value) && value.visibleTo === "owner";
}

/** A value with every entry kept for the owner left out, at any depth. */
function withoutOwners(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => !isOwners(entry)).map(withoutOwners);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isOwners(entry)) {
      out[name] = withoutOwners(entry);
    }
  }
  return out;
}

/**
 * The facade without the panels only an owner's tab names. A panel no tab
 * names is on screen whatever tab is chosen, so leaving out the tab alone
 * would put its panels in front of a member rather than keep them from one.
 */
function withoutOwnersPanels(facade: unknown): unknown {
  if (!isRecord(facade) || !Array.isArray(facade.tabs) || !Array.isArray(facade.panels)) {
    return facade;
  }
  const named = (owners: boolean) =>
    new Set(
      (facade.tabs as unknown[])
        .filter((tab) => isRecord(tab) && isOwners(tab) === owners)
        .flatMap((tab) => (isRecord(tab) && Array.isArray(tab.panels) ? tab.panels : [])),
    );
  const everybodys = named(false);
  const owners = named(true);
  return {
    ...facade,
    panels: facade.panels.filter(
      (panel) =>
        !isRecord(panel) || !owners.has(panel.id) || everybodys.has(panel.id),
    ),
  };
}

/**
 * The facade without what `visibleTo: "owner"` keeps for the board's owner —
 * a widget, a container, a panel, a tab, a notice.
 *
 * Left out of what a member is sent rather than hidden by the page they are
 * shown it on: a control a member cannot see but is sent still names its
 * service and what it would send there, and a value only the owner reads
 * would still be projected to them. A tab left with none of its panels goes
 * with them, a panel only an owner's tab names goes with that tab, and so does
 * a default naming a tab that went.
 */
export function facadeForMembers(facade: unknown): unknown {
  const shown = withoutOwners(withoutOwnersPanels(facade));
  if (!isRecord(shown) || !Array.isArray(shown.tabs)) {
    return shown;
  }
  const panels = new Set(
    (Array.isArray(shown.panels) ? shown.panels : [])
      .map((panel) => (isRecord(panel) ? panel.id : undefined))
      .filter((id): id is string => typeof id === "string"),
  );
  const tabs = shown.tabs.flatMap((tab) => {
    if (!isRecord(tab) || !Array.isArray(tab.panels)) {
      return [tab];
    }
    const kept = tab.panels.filter((id) => panels.has(id as string));
    // A tab that never named a panel is the board's to have; one that lost
    // all of them to the owner is the owner's.
    return kept.length === 0 && tab.panels.length > 0 ? [] : [{ ...tab, panels: kept }];
  });
  const result: Record<string, unknown> = { ...shown, tabs };
  if (!tabs.some((tab) => isRecord(tab) && tab.id === shown.defaultTab)) {
    delete result.defaultTab;
  }
  return result;
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
    facade: access.facade,
  };
}
