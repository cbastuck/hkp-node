/**
 * Service Documentation
 * Service ID: rss
 * Service Name: RSS
 * Runtime: hkp-node
 * Modes: none
 * Key Config: feeds, limit, timeoutMs, summaryChars, __hkpMount (a feed named
 *             by reference); addFeed/removeFeed/refresh as commands
 * IO: in=any (ignored, a trigger) -> out=null immediately; the merged article
 *     list is pushed through the rest of the pipeline when the feeds answer
 * Arrays: emits an array of articles
 * Binary: not applicable
 *
 * Several feeds read as one list.
 *
 * A reader's unit is not the feed, it is the article: the question being asked
 * is "what is new", and the answer spans every feed subscribed to. So this
 * service fetches them together, reduces the three syndication formats to one
 * article shape (`rss-parse`), merges the results and sorts them newest first.
 * A board wanting one feed asks for one feed; nothing about the contract
 * changes.
 *
 * It lives on hkp-node rather than the browser because a feed is served by
 * whoever publishes it, and almost none of them send the CORS header a browser
 * would need. Reading feeds is therefore something a board can only do from a
 * runtime that is not a browser — not a preference.
 *
 * The feeds are **fetched concurrently and failures are kept apart**. One feed
 * that is down, slow or no longer a feed produces an entry in `errors` and the
 * others still arrive: a reader missing one source is still a reader, while one
 * that shows nothing because a single site is having a bad morning is not.
 */
import {
  HostedService,
  JsonRecord,
  ProcessContext,
  RuntimeHost,
  RuntimeNotification,
  ServiceConfiguration,
  ServiceRegistryEntry,
} from "../types";
import { FeedItem, parseFeed } from "./rss-parse";
import { MOUNT_FIELD, parseMountRef } from "../coordinator/mount";

export const rssDescriptor: ServiceRegistryEntry = {
  serviceId: "rss",
  serviceName: "RSS",
};

/** A feed as a board subscribes to it: where it is, and what to call it. */
type Feed = {
  url: string;
  /** What the list shows as the source. Empty until the feed says its own. */
  name: string;
};

/** An article, as it travels: a feed item that remembers where it came from. */
export type Article = FeedItem & {
  feed: string;
  feedUrl: string;
};

const DEFAULT_LIMIT = 60;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_SUMMARY_CHARS = 240;

/** A feed entry as it may be written: a bare URL, or a URL with a name. */
function readFeed(value: unknown): Feed | null {
  if (typeof value === "string") {
    return value.trim() ? { url: value.trim(), name: "" } : null;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    return url ? { url, name } : null;
  }
  return null;
}

function readFeedList(value: unknown): Feed[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const feeds: Feed[] = [];
  for (const entry of value) {
    const feed = readFeed(entry);
    // A feed already subscribed to is not added twice: the list is what a
    // person reads, and the same source listed twice doubles every article.
    if (feed && !feeds.some((existing) => existing.url === feed.url)) {
      feeds.push(feed);
    }
  }
  return feeds;
}

/** The host, as the name to show for a feed that did not offer one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export class RssService implements HostedService {
  readonly serviceId = rssDescriptor.serviceId;
  readonly serviceName = rssDescriptor.serviceName;
  readonly uuid: string;

  private host: RuntimeHost | null = null;
  private feeds: Feed[] = [];
  private limit = DEFAULT_LIMIT;
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private summaryChars = DEFAULT_SUMMARY_CHARS;
  private fetching = false;
  /**
   * The address a feed named by reference resolves to.
   *
   * A feed on this board rather than out on the web — one unit publishing what
   * another reads — has no address until the board loads, so it is named the
   * way every other endpoint is and resolved by the coordinator. One address,
   * so one feed of a list may be a reference; the rest are URLs, which is what
   * they are anyway.
   */
  private mount = "";

  constructor(config: ServiceConfiguration) {
    this.uuid = config.uuid;
    if (config.state) {
      this.configure(config.state);
    }
  }

  setHost(host: RuntimeHost): void {
    this.host = host;
  }

  /**
   * The address a feed's url stands for: itself when it is a URL, the resolved
   * mount when it is a reference, and nothing while a reference is unresolved.
   */
  private addressOf(url: string): string | null {
    if (!parseMountRef(url)) {
      return url;
    }
    return this.mount && !parseMountRef(this.mount) ? this.mount : null;
  }

  /**
   * What the service is configured as — and not what it last read.
   *
   * This is the state a board is saved with, so the articles stay out of it:
   * they are a fetch's result rather than a setting, they are large, and they
   * are stale the moment they are written. The list reaches a panel or a facade
   * as a notification, and a board that has just loaded gets one as soon as
   * something triggers it.
   */
  getState(): JsonRecord {
    return {
      feeds: this.feeds.map((feed) => ({ ...feed })),
      limit: this.limit,
      timeoutMs: this.timeoutMs,
      summaryChars: this.summaryChars,
      fetching: this.fetching,
      [MOUNT_FIELD]: this.mount,
    };
  }

  configure(config: JsonRecord): JsonRecord {
    const feeds = readFeedList(config.feeds);
    if (feeds) {
      this.feeds = feeds;
    }

    // Adding and removing are commands rather than settings: a facade has a
    // field and a button, not an editor for the whole list, and rewriting
    // `feeds` from a text input would mean the widget had to know the list it
    // was changing.
    const added = readFeed(config.addFeed);
    if (added && !this.feeds.some((feed) => feed.url === added.url)) {
      this.feeds = [...this.feeds, added];
    }

    const removed = readFeed(config.removeFeed);
    if (removed) {
      this.feeds = this.feeds.filter((feed) => feed.url !== removed.url);
    }

    // The list is announced whenever it changes, not only returned to whoever
    // changed it: a panel and a facade both render it, and only one of them
    // made the call.
    if (feeds || added || removed) {
      this._notify({ feeds: this.feeds.map((feed) => ({ ...feed })) });
    }

    if (typeof config.limit === "number" && config.limit > 0) {
      this.limit = Math.floor(config.limit);
    }
    if (typeof config.timeoutMs === "number" && config.timeoutMs > 0) {
      this.timeoutMs = config.timeoutMs;
    }
    if (typeof config.summaryChars === "number" && config.summaryChars >= 0) {
      this.summaryChars = Math.floor(config.summaryChars);
    }

    // Fetching now is a command here as well as the service's process(),
    // because a panel is the one caller that cannot use process(): a service on
    // a remote runtime has no local instance for its UI to call, so configure
    // is the only verb that reaches it. Same work either way — Injector's
    // `inject` is the same arrangement for the same reason.
    if (typeof config[MOUNT_FIELD] === "string") {
      this.mount = config[MOUNT_FIELD] as string;
    }

    if (config.refresh) {
      this.start((payload) => this._notify(payload as JsonRecord));
    }

    return this.getState();
  }

  /**
   * Starts the round of fetches and stops the synchronous push.
   *
   * Like every service whose answer is a response, the articles do not exist
   * when this returns — the rest of the pipeline is called with them once the
   * feeds have answered.
   */
  process(
    _input: unknown,
    notify: (payload: unknown, instanceId?: string) => void,
  ): unknown {
    this.start(notify);
    return null;
  }

  destroy(): void {
    this.host = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _notify(payload: JsonRecord, instanceId: string = this.uuid): void {
    this.host?.notify(payload, instanceId);
  }

  /** Begins a round, or says why there is nothing to fetch. */
  private start(notify: (payload: unknown, instanceId?: string) => void): void {
    if (this.feeds.length === 0) {
      notify({ fetching: false, error: "No feeds configured" });
      return;
    }
    void this.refresh(notify, this.host?.currentContext() ?? undefined);
  }

  private async refresh(
    notify: (payload: unknown, instanceId?: string) => void,
    context?: ProcessContext,
  ): Promise<void> {
    const feeds = this.feeds;
    this.fetching = true;
    notify({ fetching: true, error: "", sources: feeds.length });

    const results = await Promise.all(
      feeds.map((feed) => this.readFeed(feed)),
    );

    const articles: Article[] = [];
    const errors: { url: string; error: string }[] = [];
    for (const result of results) {
      if (result.error) {
        errors.push({ url: result.feed.url, error: result.error });
        continue;
      }
      articles.push(...result.articles);
    }

    // Newest first, across every feed — which is the whole point of reading
    // them together rather than one after another.
    articles.sort((a, b) => b.publishedMs - a.publishedMs);
    const items = articles.slice(0, this.limit);

    this.fetching = false;
    notify({
      fetching: false,
      fetchedAt: new Date().toISOString(),
      sources: feeds.length,
      count: items.length,
      // Said on every round, so a panel showing a failure shows this round's
      // and not one still standing from an earlier one.
      error: errors.length ? `${errors.length} of ${feeds.length} failed` : "",
      errors,
      items,
    });

    await this.push(items, notify, context);
  }

  private async readFeed(
    feed: Feed,
  ): Promise<{ feed: Feed; articles: Article[]; error?: string }> {
    const address = this.addressOf(feed.url);
    if (!address) {
      // A reference nobody has published yet: the unit that serves this feed is
      // still coming up. Not an error to act on, and not a URL to dial — the
      // next round tries again, by which time the coordinator has usually
      // handed the address over.
      return { feed, articles: [], error: `Waiting for ${feed.url}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(address, {
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          // Some publishers answer a request without one with a redirect to a
          // consent page, which is not a feed.
          "user-agent": "Readymade/1.0 (+https://readymadeit.com)",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          feed,
          articles: [],
          error: `HTTP ${response.status}`,
        };
      }
      const parsed = parseFeed(await response.text());
      const name = feed.name || parsed.title || hostOf(feed.url);
      return {
        feed,
        articles: parsed.items.map((item) => ({
          ...item,
          summary: this.summaryChars
            ? item.summary.slice(0, this.summaryChars)
            : "",
          feed: name,
          feedUrl: feed.url,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        feed,
        articles: [],
        // An abort is this service's own timeout, and says so — "This operation
        // was aborted" tells a reader nothing about which feed was slow.
        error: controller.signal.aborted
          ? `Timed out after ${this.timeoutMs}ms`
          : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async push(
    items: Article[],
    notify: (payload: unknown, instanceId?: string) => void,
    context?: ProcessContext,
  ): Promise<void> {
    if (!this.host) {
      return;
    }
    const output = await this.host.processFrom(
      this.uuid,
      items,
      (n: RuntimeNotification) => notify(n.payload, n.instanceId),
      context,
    );
    // A downstream service returning null means stop — honour it rather than
    // driving the next runtime with a dead result.
    if (output !== null && output !== undefined) {
      this.host.emitResult(output);
    }
  }
}
