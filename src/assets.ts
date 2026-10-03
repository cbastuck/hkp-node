/**
 * Assets a runtime was given, and the one way to their content.
 *
 * A board declares content once — a page, a script, an image, a model — as an
 * asset *descriptor*: an id, a media type and exactly one source. Service state
 * names one by reference, `hkp-asset://<id>`, as a whole field, and never holds
 * the content itself. `getState` therefore echoes the reference, and saving a
 * board writes back what was configured: there is no round trip to undo.
 *
 * The descriptors arrive with the runtime's create payload, or on
 * `POST /runtimes/:id/assets` — and again whenever an asset is edited, which is
 * the point: a service resolves its reference at the moment it uses it, so the
 * next use gets the new content without anything being reconfigured. A runtime
 * is given every asset of its board that is not kept to other runtimes, named
 * by its services or not: which one a service uses can be decided as it runs.
 *
 * Where the content comes from depends on the source:
 *
 *   `text`, `base64`   already in the descriptor, up to the inline limit: a
 *                      descriptor travels in the requests that configure a
 *                      runtime, so content past that size is named by URL
 *   `http(s)://`       fetched by this runtime as anyone would fetch it,
 *                      cached by `sha256` or ETag
 *   `file://`          read only through the host's file store, which keeps it
 *                      inside the tenant's volumes; refused where there is none
 *
 * Anything else is refused by name rather than guessed at.
 *
 * An asset carries no request headers and names no secret. It is resolved
 * without anyone looking, by every runtime holding it, which is no place for a
 * credential; content that needs one is fetched by a service that says where
 * it sends it.
 *
 * The format matches `hkp-frontend/src/runtime/board/assets.ts`: a board
 * written against one runtime has to open against another.
 */
import { createHash } from "node:crypto";


export const ASSET_SCHEME = "hkp-asset://";

/** Letters, digits, dot, dash and underscore — what an id may be made of. */
const ID = "[A-Za-z0-9_.-]+";
const WHOLE_REFERENCE = new RegExp(`^${escape(ASSET_SCHEME)}(${ID})$`);
const ANY_REFERENCE = new RegExp(`${escape(ASSET_SCHEME)}(${ID})`, "g");

export type AssetSource = { text: string } | { base64: string } | { url: string };

export type AssetDescriptor = {
  id: string;
  name?: string;
  mediaType: string;
  /** Identity of the version: cache key and integrity check. */
  sha256?: string;
  size?: number;
  /**
   * The runtimes that are given this asset, by their id in the board declaring
   * it. Absent: every one. Read by whoever provisions a board's runtimes; a
   * runtime holding the descriptor has no use for it.
   */
  runtimes?: string[];
} & AssetSource;

/** An asset's content, for one use. */
export type ResolvedAsset = {
  id: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type AssetResolution =
  | { asset: ResolvedAsset; problem: "" }
  | { asset: null; problem: string };

/**
 * What a runtime can reach beyond the descriptor itself. Supplied by the
 * server, which owns the file store and knows whose runtime this is.
 */
export type AssetSources = {
  /**
   * Reads a `file://` source. Absent where the host has no files a board may
   * name, which refuses every `file://` source.
   */
  readFile?: (url: URL) => Promise<Uint8Array | null>;
  fetch?: typeof fetch;
};

export type AssetStoreOptions = {
  /** Upper bound on one asset's content, in bytes. */
  maxBytes?: number;
  /**
   * Upper bound on content a descriptor carries itself (`text`, `base64`), in
   * bytes. Smaller than `maxBytes`, which is what a runtime will fetch or
   * read: inline content rides in control requests, whose size the server
   * derives from this.
   */
  maxInlineBytes?: number;
  /** Upper bound on everything held in the cache, in bytes. */
  maxCacheBytes?: number;
  /** How long a URL source may take to answer. */
  timeoutMs?: number;
};

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type CacheEntry = {
  /** The descriptor this was resolved from, as JSON; a changed one misses. */
  version: string;
  asset: ResolvedAsset;
  /** For a URL source without a hash: what to revalidate with. */
  etag?: string;
};

type Listener = (id: string) => void;

export class AssetStore {
  private descriptors = new Map<string, AssetDescriptor>();
  private readonly cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly sources: AssetSources = {},
    private readonly options: AssetStoreOptions = {},
  ) {}

  /** Replaces everything held. */
  replace(entries: Record<string, AssetDescriptor>): void {
    const previous = this.descriptors;
    this.descriptors = new Map(Object.entries(entries));
    const touched = new Set([...previous.keys(), ...this.descriptors.keys()]);
    for (const id of touched) {
      if (!sameDescriptor(previous.get(id), this.descriptors.get(id))) {
        this.changed(id);
      }
    }
  }

  /**
   * Adds, replaces or removes individual descriptors, leaving the rest alone.
   * `null` removes one: an asset deleted from the board is gone from every
   * runtime that was told about it, rather than served on from a stale copy.
   */
  merge(entries: Record<string, AssetDescriptor | null>): void {
    for (const [id, entry] of Object.entries(entries)) {
      const previous = this.descriptors.get(id);
      if (entry === null) {
        this.descriptors.delete(id);
      } else {
        this.descriptors.set(id, entry);
      }
      if (!sameDescriptor(previous, entry ?? undefined)) {
        this.changed(id);
      }
    }
  }

  /** The ids held, for saying what a runtime knows about. */
  ids(): string[] {
    return [...this.descriptors.keys()];
  }

  descriptor(id: string): AssetDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /**
   * Called with an asset's id whenever its descriptor changes or goes away.
   * Only a service that loads something once needs it — one that resolves on
   * every use already gets the new content.
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
   * An asset's content for one use, or a sentence saying why there is none:
   * not a reference, an unknown id, a refused source, a failed fetch, a hash
   * that does not match.
   */
  async resolve(reference: string): Promise<AssetResolution> {
    const id = parseAssetRef(reference);
    if (!id) {
      return fail(`${JSON.stringify(reference)} is not an asset reference`);
    }
    const descriptor = this.descriptors.get(id);
    if (!descriptor) {
      return fail(`asset "${id}" is not known to this runtime`);
    }

    const version = JSON.stringify(descriptor);
    const cached = this.cache.get(id);
    if (cached && cached.version === version && !needsRevalidation(descriptor, cached)) {
      this.touch(id, cached);
      return { asset: cached.asset, problem: "" };
    }

    try {
      const loaded = await this.load(descriptor, cached?.version === version ? cached : undefined);
      if ("problem" in loaded) {
        return fail(`asset "${id}": ${loaded.problem}`);
      }
      const problem = this.check(descriptor, loaded.bytes);
      if (problem) {
        return fail(`asset "${id}": ${problem}`);
      }
      const asset: ResolvedAsset = {
        id,
        mediaType: descriptor.mediaType,
        bytes: loaded.bytes,
      };
      // Only if the descriptor is still the one this was loaded for: an edit
      // that arrived while a fetch was in flight must not be shadowed by it.
      if (JSON.stringify(this.descriptors.get(id)) === version) {
        this.remember(id, { version, asset, etag: loaded.etag });
      }
      return { asset, problem: "" };
    } catch (error) {
      return fail(`asset "${id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async load(
    descriptor: AssetDescriptor,
    cached: CacheEntry | undefined,
  ): Promise<{ bytes: Uint8Array; etag?: string } | { problem: string }> {
    if ("text" in descriptor) {
      return this.inline(new Uint8Array(Buffer.from(descriptor.text, "utf8")));
    }
    if ("base64" in descriptor) {
      const bytes = decodeBase64(descriptor.base64);
      return bytes ? this.inline(bytes) : { problem: "its content is not base64" };
    }

    let url: URL;
    try {
      url = new URL(descriptor.url);
    } catch {
      return { problem: `${JSON.stringify(descriptor.url)} is not a URL` };
    }

    switch (url.protocol) {
      case "http:":
      case "https:":
        return this.fetchUrl(url, cached);
      case "file:": {
        if (!this.sources.readFile) {
          return { problem: "file:// sources cannot be read by this runtime" };
        }
        const bytes = await this.sources.readFile(url);
        return bytes ? { bytes } : { problem: `no file at ${url.href}` };
      }
      default:
        return { problem: `${url.protocol}// sources are not supported by this runtime` };
    }
  }

  /** Inline content, or why it is not taken: it is past what a descriptor may carry. */
  private inline(bytes: Uint8Array): { bytes: Uint8Array } | { problem: string } {
    const limit = Math.min(
      this.options.maxInlineBytes ?? DEFAULT_MAX_INLINE_ASSET_BYTES,
      this.maxBytes(),
    );
    return bytes.length > limit
      ? { problem: `inline content is larger than ${limit} bytes; host it and name it by url` }
      : { bytes };
  }

  private async fetchUrl(
    url: URL,
    cached: CacheEntry | undefined,
  ): Promise<{ bytes: Uint8Array; etag?: string } | { problem: string }> {
    const headers: Record<string, string> = cached?.etag
      ? { "if-none-match": cached.etag }
      : {};

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await (this.sources.fetch ?? fetch)(url.href, {
        headers,
        signal: controller.signal,
      });
      if (response.status === 304 && cached) {
        return { bytes: cached.asset.bytes, etag: cached.etag };
      }
      if (!response.ok) {
        return { problem: `${url.href} answered ${response.status}` };
      }
      const bytes = await readLimited(response, this.maxBytes());
      if (!bytes) {
        return { problem: `${url.href} is larger than ${this.maxBytes()} bytes` };
      }
      return { bytes, etag: response.headers.get("etag") ?? undefined };
    } catch (error) {
      if (controller.signal.aborted) {
        return { problem: `${url.href} did not answer in time` };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What is wrong with content the descriptor promised something about. */
  private check(descriptor: AssetDescriptor, bytes: Uint8Array): string {
    if (bytes.length > this.maxBytes()) {
      return `larger than ${this.maxBytes()} bytes`;
    }
    if (descriptor.sha256) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== descriptor.sha256.toLowerCase()) {
        return `content does not match its sha256 (got ${actual})`;
      }
    }
    return "";
  }

  private maxBytes(): number {
    return this.options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private remember(id: string, entry: CacheEntry): void {
    this.forget(id);
    const limit = this.options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    if (entry.asset.bytes.length > limit) {
      return;
    }
    // Oldest first: a Map iterates in insertion order and `touch` re-inserts.
    for (const [oldest] of this.cache) {
      if (this.cachedBytes + entry.asset.bytes.length <= limit) {
        break;
      }
      this.forget(oldest);
    }
    this.cache.set(id, entry);
    this.cachedBytes += entry.asset.bytes.length;
  }

  private touch(id: string, entry: CacheEntry): void {
    this.cache.delete(id);
    this.cache.set(id, entry);
  }

  private forget(id: string): void {
    const entry = this.cache.get(id);
    if (entry) {
      this.cachedBytes -= entry.asset.bytes.length;
      this.cache.delete(id);
    }
  }

  private changed(id: string): void {
    this.forget(id);
    for (const listener of [...(this.listeners.get(id) ?? [])]) {
      try {
        listener(id);
      } catch (error) {
        console.error(`[assets] listener for "${id}" failed`, error);
      }
    }
  }
}

/**
 * Whether a cached URL source has to be asked again. One with a hash never
 * does — the hash is the version. One without is asked on each use: with the
 * ETag it came with when it had one, so an unchanged source costs a 304, and
 * otherwise in full, because nothing says what it returned is still what it
 * returns.
 */
function needsRevalidation(descriptor: AssetDescriptor, _cached: CacheEntry): boolean {
  return "url" in descriptor && !descriptor.sha256;
}

/**
 * The bytes base64 text stands for, or null when it is not base64.
 *
 * `Buffer.from(…, "base64")` skips what it does not recognise and decodes the
 * rest, so text that is not base64 would come out as some other bytes. What is
 * taken here is what a browser's `atob` takes — ASCII whitespace ignored, the
 * standard alphabet, padding optional — so that a descriptor resolves to the
 * same content, or the same refusal, on every runtime.
 */
export function decodeBase64(value: string): Uint8Array | null {
  let text = value.replace(/[\t\n\f\r ]+/g, "");
  if (text.length % 4 === 0) {
    text = text.replace(/={1,2}$/, "");
  }
  if (text.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(text)) {
    return null;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function fail(problem: string): AssetResolution {
  return { asset: null, problem };
}

function sameDescriptor(a: AssetDescriptor | undefined, b: AssetDescriptor | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The id a whole-value reference names, or null for anything else. A reference
 * inside a longer string is not one: nothing is spliced into text.
 */
export function parseAssetRef(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(WHOLE_REFERENCE);
  return match ? match[1] : null;
}

export function formatAssetRef(id: string): string {
  return `${ASSET_SCHEME}${id}`;
}

/**
 * Every asset id a value mentions, however deeply it is nested.
 *
 * Found anywhere in a string, not only as a whole value, so that a reference an
 * expression produces (`path == '/app.js' ? 'hkp-asset://app' : …`) is still
 * one this runtime is told about. Finding is generous; resolving is not.
 */
export function referencedAssets(value: unknown, into = new Set<string>()): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(ANY_REFERENCE)) {
      into.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      referencedAssets(item, into);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      referencedAssets(item, into);
    }
  }
  return [...into];
}

const ID_PATTERN = new RegExp(`^${ID}$`);

/**
 * One descriptor off the wire, or null when it is not one. Exactly one source,
 * or it is not an asset: two would leave a runtime choosing between them.
 */
export function readAssetDescriptor(value: unknown, fallbackId?: string): AssetDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : fallbackId;
  if (!id || !ID_PATTERN.test(id)) {
    return null;
  }
  const sources = ["text", "base64", "url"].filter((key) => typeof record[key] === "string");
  if (sources.length !== 1) {
    return null;
  }

  const descriptor: Record<string, unknown> = {
    id,
    mediaType:
      typeof record.mediaType === "string" && record.mediaType
        ? record.mediaType
        : "application/octet-stream",
  };
  if (typeof record.name === "string") {
    descriptor.name = record.name;
  }
  if (typeof record.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(record.sha256)) {
    descriptor.sha256 = record.sha256.toLowerCase();
  }
  if (typeof record.size === "number" && Number.isFinite(record.size)) {
    descriptor.size = record.size;
  }
  if (Array.isArray(record.runtimes)) {
    descriptor.runtimes = record.runtimes.filter((id) => typeof id === "string");
  }
  const source = sources[0];
  descriptor[source] = record[source];
  return descriptor as AssetDescriptor;
}

/**
 * Reads an assets payload off the wire: a map of id to descriptor, where
 * `null` removes one, or a list of descriptors. Anything it cannot read is
 * dropped rather than failing the request — a malformed entry costs one asset,
 * and the service referencing it says so by name.
 */
export function readAssetsPayload(value: unknown): Record<string, AssetDescriptor | null> {
  const entries: Record<string, AssetDescriptor | null> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const descriptor = readAssetDescriptor(item);
      if (descriptor) {
        entries[descriptor.id] = descriptor;
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
    const descriptor = readAssetDescriptor(item, id);
    if (descriptor) {
      // Keyed by what the payload named, so the id inside cannot disagree.
      entries[id] = { ...descriptor, id };
    }
  }
  return entries;
}

/** Whether a media type is text a pipeline can carry as a string. */
export function isTextMediaType(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type.endsWith("+xml")
  );
}
