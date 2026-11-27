/**
 * Resources a runtime was given, and the one way to their bindings.
 *
 * A board declares what it needs from outside Readymade — an Ollama server, a
 * Postgres database, an S3 bucket — by kind (`ollama`, `postgres`, `s3`), and
 * service state names one by reference, `hkp-resource://<id>`, as a whole
 * field. `getState` echoes the reference, and saving a board writes back what
 * was configured: addresses and credentials never enter service state.
 *
 * The bindings arrive with the runtime's create payload, or on
 * `POST /runtimes/:id/resources` — and again whenever a binding changes, which
 * is the point: a service resolves its reference at the moment it uses it, so
 * the next use gets the new binding without anything being reconfigured.
 *
 * The format matches `hkp-frontend/src/runtime/board/resources.ts`,
 * `hkp-python/src/hkp/resources.py` and `hkp-rt/lib/include/resources.h`: a
 * board written against one runtime has to open against another.
 */

export const RESOURCE_SCHEME = "hkp-resource://";

export const RESOURCE_KINDS = ["ollama", "postgres", "s3"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const ID = "[A-Za-z0-9_.-]+";
const ID_PATTERN = new RegExp(`^${ID}$`);
const WHOLE_REFERENCE = new RegExp(`^${escape(RESOURCE_SCHEME)}(${ID})$`);
const ANY_REFERENCE = new RegExp(`${escape(RESOURCE_SCHEME)}(${ID})`, "g");

export type ResolvedOllamaResource = {
  id: string;
  kind: "ollama";
  url: string;
};

export type ResolvedPostgresResource = {
  id: string;
  kind: "postgres";
  url: string;
  user?: string;
  password?: string;
  database?: string;
};

export type ResolvedS3Resource = {
  id: string;
  kind: "s3";
  endpoint: string;
  region?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
};

export type ResolvedResource =
  | ResolvedOllamaResource
  | ResolvedPostgresResource
  | ResolvedS3Resource;

export type ResourceBinding = ResolvedResource & {
  unreachable?: string;
};

export type ResourceResolution<T extends ResolvedResource = ResolvedResource> =
  | { resource: T; problem: "" }
  | { resource: null; problem: string };

type Listener = (id: string) => void;

export class ResourceStore {
  private bindings = new Map<string, ResourceBinding>();
  private readonly listeners = new Map<string, Set<Listener>>();

  /** Replaces everything held. */
  replace(entries: Record<string, ResourceBinding>): void {
    const previous = this.bindings;
    this.bindings = new Map(Object.entries(entries));
    const touched = new Set([...previous.keys(), ...this.bindings.keys()]);
    for (const id of touched) {
      if (!sameBinding(previous.get(id), this.bindings.get(id))) {
        this.changed(id);
      }
    }
  }

  /**
   * Adds, replaces or removes (`null`) individual bindings, leaving the rest
   * alone.
   */
  merge(entries: Record<string, ResourceBinding | null>): void {
    for (const [id, entry] of Object.entries(entries)) {
      const previous = this.bindings.get(id);
      if (entry === null) {
        this.bindings.delete(id);
      } else {
        this.bindings.set(id, entry);
      }
      if (!sameBinding(previous, entry ?? undefined)) {
        this.changed(id);
      }
    }
  }

  /** The ids held, for saying what a runtime knows about. */
  ids(): string[] {
    return [...this.bindings.keys()];
  }

  binding(id: string): ResourceBinding | undefined {
    return this.bindings.get(id);
  }

  /**
   * Called with a resource's id whenever its binding changes or goes away.
   */
  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) {
        this.listeners.delete(id);
      }
    };
  }

  /**
   * Resolves a `hkp-resource://<id>` reference for one use, or answers with a
   * sentence saying why there is none: not a reference, not bound, wrong kind,
   * or unreachable from this runtime.
   */
  resolve<K extends ResourceKind = ResourceKind>(
    reference: string,
    expectedKind?: K,
  ): ResourceResolution<Extract<ResolvedResource, { kind: K }>> {
    const id = parseResourceRef(reference);
    if (!id) {
      return {
        resource: null,
        problem: `${JSON.stringify(reference)} is not a resource reference`,
      };
    }
    const binding = this.bindings.get(id);
    if (!binding) {
      return {
        resource: null,
        problem: `resource "${id}" is not bound`,
      };
    }
    if (expectedKind && binding.kind !== expectedKind) {
      return {
        resource: null,
        problem: `resource "${id}" is of kind "${binding.kind}", not "${expectedKind}"`,
      };
    }
    if (binding.unreachable) {
      return {
        resource: null,
        problem: binding.unreachable,
      };
    }
    const { unreachable: _unreachable, ...resolved } = binding;
    return {
      resource: resolved as Extract<ResolvedResource, { kind: K }>,
      problem: "",
    };
  }

  private changed(id: string): void {
    for (const listener of [...(this.listeners.get(id) ?? [])]) {
      try {
        listener(id);
      } catch (error) {
        console.error(`[resources] listener for "${id}" failed`, error);
      }
    }
  }
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The id a whole-value reference names, or null for anything else.
 */
export function parseResourceRef(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(WHOLE_REFERENCE);
  return match ? match[1] : null;
}

export function formatResourceRef(id: string): string {
  return `${RESOURCE_SCHEME}${id}`;
}

/**
 * Every resource id a value mentions, however deeply it is nested.
 */
export function referencedResources(value: unknown, into = new Set<string>()): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(ANY_REFERENCE)) {
      into.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      referencedResources(item, into);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      referencedResources(item, into);
    }
  }
  return [...into];
}

/**
 * One binding off the wire, or null when it is not one.
 */
export function readResourceBinding(
  value: unknown,
  fallbackId?: string,
): ResourceBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : fallbackId;
  if (!id || !ID_PATTERN.test(id) || !isResourceKind(record.kind)) {
    return null;
  }
  const unreachable =
    typeof record.unreachable === "string" && record.unreachable.trim()
      ? record.unreachable.trim()
      : undefined;

  switch (record.kind) {
    case "ollama": {
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url && !unreachable) {
        return null;
      }
      return {
        id,
        kind: "ollama",
        url,
        ...(unreachable ? { unreachable } : {}),
      };
    }
    case "postgres": {
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url && !unreachable) {
        return null;
      }
      return {
        id,
        kind: "postgres",
        url,
        ...(typeof record.user === "string" ? { user: record.user } : {}),
        ...(typeof record.password === "string" ? { password: record.password } : {}),
        ...(typeof record.database === "string" ? { database: record.database } : {}),
        ...(unreachable ? { unreachable } : {}),
      };
    }
    case "s3": {
      const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
      if (!endpoint && !unreachable) {
        return null;
      }
      return {
        id,
        kind: "s3",
        endpoint,
        ...(typeof record.region === "string" ? { region: record.region } : {}),
        ...(typeof record.bucket === "string" ? { bucket: record.bucket } : {}),
        ...(typeof record.accessKey === "string" ? { accessKey: record.accessKey } : {}),
        ...(typeof record.secretKey === "string" ? { secretKey: record.secretKey } : {}),
        ...(unreachable ? { unreachable } : {}),
      };
    }
  }
}

/**
 * Reads a resources payload off the wire: a map of id to binding, where `null`
 * removes one, or a list of bindings.
 */
export function readResourcesPayload(
  value: unknown,
): Record<string, ResourceBinding | null> {
  const entries: Record<string, ResourceBinding | null> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const binding = readResourceBinding(item);
      if (binding) {
        entries[binding.id] = binding;
      }
    }
    return entries;
  }
  if (!value || typeof value !== "object") {
    return entries;
  }
  for (const [id, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) {
      if (ID_PATTERN.test(id)) {
        entries[id] = null;
      }
      continue;
    }
    const binding = readResourceBinding(item, id);
    if (binding) {
      entries[id] = { ...binding, id };
    }
  }
  return entries;
}

function sameBinding(
  a: ResourceBinding | undefined,
  b: ResourceBinding | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
