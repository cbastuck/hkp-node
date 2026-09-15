/**
 * Reading a syndication feed, without a dependency to do it.
 *
 * RSS 2.0, RSS 1.0 (RDF) and Atom are three documents that say the same few
 * things under different names, and this narrows them to one shape: an item has
 * a title, somewhere to read it, when it was published, and a line about what
 * it is. Everything else a feed carries is dropped here rather than downstream,
 * because a board that merges several feeds can only sort and show fields all
 * of them have.
 *
 * It is a scanner over the markup rather than a general XML parser. That is the
 * honest description of what it can do: it finds the element boundaries these
 * three formats use, unwraps CDATA, and decodes the entities that appear in
 * feed text. A document that would need a real parser to read — arbitrary
 * namespaces, nested elements of the same name — is out of its range, and the
 * answer for one is a proper parser, not more regular expressions.
 */

/** One article, in the vocabulary every feed format can be reduced to. */
export type FeedItem = {
  /** The feed's own identity for the item — guid, id, or the link. */
  id: string;
  title: string;
  /** Where to read it. Empty when the feed offered no readable address. */
  link: string;
  author: string;
  /** A line about the item, with its markup stripped. */
  summary: string;
  /** When it was published, ISO 8601, or "" when the feed did not say. */
  published: string;
  /**
   * The same instant as `YYYY-MM-DD HH:mm`, in UTC.
   *
   * A merged list shows a date on every row, so deriving one is work every
   * consumer would otherwise repeat — and a board has no date formatter to
   * repeat it with. UTC rather than a local zone because the formatting happens
   * wherever the runtime is, which is not where the reader is.
   */
  publishedLabel: string;
  /**
   * The same instant in epoch milliseconds, which is what sorting uses.
   * An item with no date sorts as 0 — last — rather than as now, so a feed
   * that omits dates cannot crowd out the ones that keep them.
   */
  publishedMs: number;
};

export type ParsedFeed = {
  /** What the feed calls itself, for a board that did not name it. */
  title: string;
  items: FeedItem[];
};

/**
 * `<item>` in RSS and RDF, `<entry>` in Atom.
 *
 * The opening tag is captured alongside the body because RDF puts the item's
 * address in an attribute of it (`rdf:about`) rather than in an element.
 */
const ITEM_BLOCK = /<(item|entry)((?:\s[^>]*)?)>([\s\S]*?)<\/\1\s*>/gi;

const COMMENT = /<!--[\s\S]*?-->/g;

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** One pass of entity decoding — the unit the two callers compose. */
function decodeOnce(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string): string => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    },
  );
}

/**
 * Decodes the entities feed text actually contains.
 *
 * Feeds are written by publishing systems escaping HTML into XML, so the same
 * title arrives as `&amp;amp;` from one and `&amp;` from another. Decoding runs
 * twice for that reason — a second pass turns what the first pass revealed as
 * `&amp;` into `&` — and no further, since a third would start rewriting text
 * that legitimately contains an ampersand followed by a word.
 */
function decodeEntities(text: string): string {
  return decodeOnce(decodeOnce(text));
}

/** Unwraps CDATA, decodes entities, and collapses the whitespace markup left. */
function text(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  const cdata = raw.match(CDATA);
  return decodeEntities(cdata ? cdata[1] : raw)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The same, for a value that arrived as HTML — a description, a summary.
 *
 * The markup may be escaped (`&lt;p&gt;`) or it may be markup (inside CDATA),
 * and a feed reader sees both. So the passes go decode, strip, decode: the
 * first reveals escaped tags as tags, the strip removes them whichever way they
 * arrived, and the second decodes the entities the text itself contains. Doing
 * it in the other order leaves a feed's `&lt;span&gt;` sitting in the summary as
 * visible markup.
 */
function plainText(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  const cdata = raw.match(CDATA);
  const body = decodeOnce(cdata ? cdata[1] : raw);
  return decodeOnce(
    body
      .replace(COMMENT, "")
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The content of the first of `names` that appears, with any namespace prefix
 * ignored — `dc:date` answers to "date" because what distinguishes the formats
 * is the prefix, and the prefix is exactly what does not matter here.
 */
function firstTag(block: string, names: string[]): string | undefined {
  for (const name of names) {
    const pattern = new RegExp(
      `<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}\\s*>`,
      "i",
    );
    const match = block.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

const ATTRIBUTE = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(ATTRIBUTE(name));
  if (!match) {
    return undefined;
  }
  return match[2] ?? match[3];
}

/**
 * Where to read the item.
 *
 * RSS puts the address in the element's text; Atom puts it in the `href` of a
 * `<link>` and may offer several. Of those, `alternate` is the human-readable
 * one, which is the only kind worth handing a reader — `self` points back at
 * the feed and `enclosure` at a media file.
 */
function itemLink(block: string, openTag: string): string {
  const inline = firstTag(block, ["link"]);
  if (inline && !/^\s*<|^\s*$/.test(inline)) {
    return text(inline);
  }

  const links = block.match(/<(?:[A-Za-z0-9_.-]+:)?link\b[^>]*\/?>/gi) ?? [];
  const usable = links.filter((tag) => {
    const rel = (attribute(tag, "rel") ?? "alternate").toLowerCase();
    return rel === "alternate";
  });
  const chosen = usable[0] ?? links[0];
  const href = chosen ? attribute(chosen, "href") : undefined;
  if (href) {
    return decodeEntities(href).trim();
  }

  // RDF names the item by its address, on the item's own tag, which is the
  // only place some 1.0 feeds put it at all.
  const about = attribute(openTag, "about");
  return about ? decodeEntities(about).trim() : "";
}

/**
 * When the item was published.
 *
 * The publication date is preferred over the update date wherever a feed
 * carries both: a list sorted by "last touched" reorders itself when a
 * publisher fixes a typo in something from last week, which is not what a
 * reader looking for what is new is asking to see.
 */
function itemDate(block: string): {
  published: string;
  publishedMs: number;
  publishedLabel: string;
} {
  const raw = text(
    firstTag(block, ["pubDate", "published", "date", "issued", "updated"]),
  );
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return { published: "", publishedMs: 0, publishedLabel: "" };
  }
  const iso = new Date(parsed).toISOString();
  return {
    published: iso,
    publishedMs: parsed,
    publishedLabel: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
  };
}

function itemAuthor(block: string): string {
  // Atom wraps the author in a <name>; RSS puts an address in <author> and a
  // display name in <dc:creator>.
  const author = firstTag(block, ["author"]);
  if (author && /<(?:[A-Za-z0-9_.-]+:)?name[\s>]/i.test(author)) {
    return text(firstTag(author, ["name"]));
  }
  return text(author ?? firstTag(block, ["creator"]));
}

/**
 * Reads a feed document into items.
 *
 * Nothing is rejected for being the wrong format: a document with no items
 * parses to none, which is what a board shows as a feed that said nothing
 * rather than as an error it cannot act on.
 */
export function parseFeed(xml: string): ParsedFeed {
  const document = xml.replace(COMMENT, "");

  const blocks: { open: string; body: string }[] = [];
  for (const match of document.matchAll(ITEM_BLOCK)) {
    blocks.push({ open: match[2], body: match[3] });
  }

  // The feed's own title is the first one outside any item, so the items are
  // taken out of the way before looking for it.
  const channel = document.replace(ITEM_BLOCK, "");
  const title = text(firstTag(channel, ["title"]));

  const items = blocks.map(({ open, body: block }): FeedItem => {
    const link = itemLink(block, open);
    const { published, publishedMs, publishedLabel } = itemDate(block);
    return {
      id: text(firstTag(block, ["guid", "id"])) || link,
      title: text(firstTag(block, ["title"])) || "(untitled)",
      link,
      author: itemAuthor(block),
      summary: plainText(
        firstTag(block, ["description", "summary", "content", "encoded"]),
      ),
      published,
      publishedMs,
      publishedLabel,
    };
  });

  return { title, items };
}
