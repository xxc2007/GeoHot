// RSS 2.0 / Atom / RDF feeds.
import { XMLParser } from "fast-xml-parser";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { DEFAULT_UTC_OFFSET, parsePublishedAt } from "./dates.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // XHTML is mixed content: keep its markup and text order for stripTags/sanitizeBody below.
  // Only XHTML stops parsing; escaped HTML and CDATA retain their existing entity handling.
  stopNodes: ["feed.entry.title[type=xhtml]", "feed.entry.summary[type=xhtml]", "feed.entry.content[type=xhtml]"],
});

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#cdata" in o) return text(o["#cdata"]);
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

/**
 * The words inside markup the publisher left unescaped — a Drupal feed whose `<title>` holds a literal
 * `<a href="…">`, which is legal XML, so the parser hands back structure and there is no text node to read.
 * `text()` deliberately does not do this: flattening *bodies* was worse than leaving them empty (a
 * multi-paragraph `content:encoded` collapses to its first element, images vanish, and the round then skips
 * the extraction fetch that would have got the real text — `feedText` treats a non-empty body as confirmed).
 * Only the fields that must be a single flat string — the title — read through this.
 */
function nestedText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return nestedText(v[0]);
  if (typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  return Object.entries(o)
    .filter(([k]) => !k.startsWith("@"))
    .map(([, child]) => text(child) || nestedText(child))
    .filter(Boolean)
    .join(" ");
}

/** A headline is a headline even when the feed wrapped it in markup: empty here means the item is dropped. */
function titleText(v: unknown): string {
  return text(v) || nestedText(v);
}

/**
 * A feed that offered items and yielded none is not an idle feed. Without this the round writes `found: 0`
 * and health `ok` — the same two numbers a quiet week produces — and the difference only shows up when
 * somebody reads the bytes. Both dialects check here, on the parser's own count, before our filters run.
 */
function assertReadable(items: unknown[], out: Candidate[]): void {
  if (items.length > 0 && out.length === 0) {
    throw new FetchError(`feed offered ${items.length} items and none could be read (no usable link or title)`);
  }
}

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * A feed's date, through the shared rule of sources/dates.ts: a value with no zone of its own is read in
 * the source's offset (publishedAtUtcOffset), never the host's, so the item lands on the day the source
 * meant. Date.parse alone read "2026-09-26 10:00" eight hours away between the container and a machine.
 */
function parseDate(v: string, utcOffset: string | null | undefined = DEFAULT_UTC_OFFSET): Date | null {
  return parsePublishedAt(v, { utcOffset });
}

function atomLink(links: unknown): string {
  const list = arr(links as Record<string, string> | Array<Record<string, string>>);
  const alt = list.find((l) => typeof l === "object" && (!l["@rel"] || l["@rel"] === "alternate"));
  if (alt && typeof alt === "object") return alt["@href"] ?? "";
  const first = list[0];
  return typeof first === "string" ? first : first?.["@href"] ?? "";
}

/**
 * The base a node's relative hrefs resolve against: its own `@xml:base` when it declares one, taken
 * against the base above it (a feed-level value is inherited by its entries).
 */
function baseOf(node: unknown, parent: string): string {
  const raw = String((node as Record<string, unknown> | undefined)?.["@xml:base"] ?? "").trim();
  if (!raw) return parent;
  try {
    return new URL(raw, parent).toString();
  } catch {
    return parent;
  }
}

/**
 * An href as an absolute address, or null when it is not one (a `urn:` guid, a malformed link). The
 * document's own address is the base, which after a redirect is where the bytes came from (`res.url`)
 * and not the configured feed URL: the two differ whenever a feed moved, and a relative href resolved
 * against the old address points somewhere the reader never lands.
 */
function resolveHref(href: string, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function imagesFrom(html: string, base: string): Array<{ kind: "image"; url: string }> {
  const out: Array<{ kind: "image"; url: string }> = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    try {
      out.push({ kind: "image", url: new URL(m[1]!, base).toString() });
    } catch {
      // ignore bad urls
    }
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * The MRSS (`media:*`) parts of a feed node: the description, the widest still, and whether this is a
 * video. Feeds bind the namespace to whatever prefix they like (`media:group`, `m:group`, or a
 * default-namespace `group`), and a producer may put the parts on the node instead of inside the group,
 * so both places are read and the `media:` spelling wins. A node carrying none of it yields nothing,
 * exactly as before this function existed. Both the RSS 2.0 item and the Atom entry use it, so a video
 * means the same thing in either dialect.
 */
function mrss(node: Record<string, unknown>): { description: string; thumb: Record<string, string> | null; videoId: string } {
  const at = (n: Record<string, unknown>, name: string): unknown => {
    const keys = Object.keys(n);
    const key = keys.find((k) => k === `media:${name}`) ?? keys.find((k) => k === name) ?? keys.find((k) => k.endsWith(`:${name}`));
    return key ? n[key] : undefined;
  };
  const groups = arr(at(node, "group") as Record<string, unknown> | Array<Record<string, unknown>>).filter(
    (g) => !!g && typeof g === "object" && (at(g, "description") !== undefined || at(g, "thumbnail") !== undefined || at(g, "videoId") !== undefined),
  ) as Array<Record<string, unknown>>;
  const scopes = [...groups, node];
  const description = scopes.map((s) => text(at(s, "description"))).find(Boolean) ?? "";
  const thumbs = scopes
    .flatMap((s) => arr(at(s, "thumbnail") as Record<string, string> | Array<Record<string, string>>))
    .filter((t) => !!t && typeof t === "object" && typeof t["@url"] === "string" && t["@url"]);
  const thumb = [...thumbs].sort((a, b) => (Number(b["@width"]) || 0) - (Number(a["@width"]) || 0))[0] ?? null;
  const videoId = scopes.map((s) => text(at(s, "videoId"))).find(Boolean) ?? "";
  return { description, thumb, videoId };
}

/**
 * The media a video-capable node lends: its widest still, and — when the node names a video id — that
 * still is booked as `kind: "video"` pointing at the item's own address, because the picture is a frame
 * of something the reader has to go and watch. Without an addressable still it is nothing at all.
 */
function mrssMedia(node: Record<string, unknown>, url: string): Array<{ kind: "image" | "video"; url: string; poster: string | null; width: number | null; height: number | null }> {
  const { thumb, videoId } = mrss(node);
  if (!thumb) return [];
  const still = resolveHref(String(thumb["@url"]), url);
  if (!still) return [];
  return [{ kind: videoId ? "video" : "image", url: videoId ? url : still, poster: videoId ? still : null, width: Number(thumb["@width"]) || null, height: Number(thumb["@height"]) || null }];
}

/**
 * Feed text of an editorial source that only teases the article: short and ending in a "read more"
 * mark (The Verge's "Read the full story at The Verge."). Treated as a summary, so extraction fetches
 * the page before the article is judged.
 */
const TEASER_BELOW = 1200;
const TEASER_MARKS = [
  /\bappeared first on\b/i,
  /\bread (?:the )?full (?:story|article)\b/i,
  /\bcontinue reading\b/i,
  /\bread more\b/i,
  /…\s*$/,
  /\[\s*(?:…|\.\.\.)\s*\]\s*$/,
];

export function isTeaser(text: string): boolean {
  const t = text.trim();
  return t.length < TEASER_BELOW && TEASER_MARKS.some((m) => m.test(t));
}

/**
 * The body and excerpt of a feed entry: its text when it is the article, else no body (a summary, or
 * a teaser that stands in as the excerpt when the entry has none).
 */
function feedText(bodyHtml: string | null, summaryHtml: string, source: SourceRow): Pick<Candidate, "excerpt" | "bodyHtml" | "bodyText" | "bodyStatus"> {
  const bodyText = bodyHtml ? stripTags(bodyHtml) : null;
  const teaser = !!bodyText && source.participation_mode === "editorial" && isTeaser(bodyText);
  const excerpt = summaryHtml ? collapseWhitespace(stripTags(summaryHtml)).slice(0, 2000) : teaser ? collapseWhitespace(bodyText!) : null;
  return bodyText && bodyText.length > 280 && !teaser
    ? { excerpt, bodyHtml, bodyText, bodyStatus: "ok" }
    : { excerpt, bodyHtml: null, bodyText: null, bodyStatus: "pending" };
}

interface RssValidator {
  configHash: string;
  responseUrl: string;
  etag: string | null;
  lastModified: string | null;
}

export interface RssRead {
  candidates: Candidate[];
  validator: RssValidator;
  notModified: boolean;
}

// Headers a publisher's gate wants (a reader-like `user-agent`) are per-source request data, but names
// are normalised before the wire: an `User-Agent` would sit next to the default one rather than replace
// it, so the publisher would still see the bot. The headers this fetcher owns are refused outright — a
// hand-written `if-none-match` makes the first request after a config change come back 304 with no
// validator to answer it, and that reads as a permanent HTTP 304 failure with a growing fail_count.
const FETCHER_OWNED = /^(if-none-match|if-modified-since|host|content-length|content-type|cookie|authorization|proxy-authorization|api-key|x-api-key|connection|transfer-encoding)$/;

function feedHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || FETCHER_OWNED.test(name) || value === null || value === undefined) continue;
    out[name] = String(value);
  }
  return out;
}

export async function fetchRss(source: SourceRow, opts: { force?: boolean } = {}): Promise<RssRead> {
  const url = String(source.config.feedUrl ?? "");
  if (!url) throw new FetchError("feedUrl missing");
  // Config changes can alter parsing/filtering even when the upstream bytes did not change.
  const configHash = sha256(stableJson(source.config));
  const previous = !opts.force && source.cursor?.rss?.configHash === configHash ? source.cursor.rss as RssValidator : null;
  // Some publishers serve their advertised feed only to a reader-like client: measured 2026-10-06 from
  // the collector, worldpoliticsreview.com answers the site UA with 403 and a browser UA with 10 items.
  // `json_list` already allows per-source `headers`; `rss` does the same now, so the fix lives in the
  // source's config rather than in a global UA change that would misrepresent every well-behaved feed.
  // unocha.org is not fixable this way — it returns 406 "Blocked due to bot activity" to every client
  // shape we send honestly, so it is registered disabled rather than fingerprint-matched around.
  const configured = feedHeaders(source.config.headers);
  const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8", ...configured };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  let res = await guardedFetch(url, { headers, timeoutMs: 25_000 });
  // A redirect may have changed destinations, whose ETag namespace is unrelated to the old one.
  if (res.status === 304 && previous && res.url !== previous.responseUrl) {
    res = await guardedFetch(url, { headers: { accept: headers.accept!, ...configured }, timeoutMs: 25_000 });
  }
  const validator: RssValidator = {
    configHash, responseUrl: res.url,
    etag: res.headers.get("etag") ?? (res.status === 304 ? previous?.etag ?? null : null),
    lastModified: res.headers.get("last-modified") ?? (res.status === 304 ? previous?.lastModified ?? null : null),
  };
  if (res.status === 304 && previous && (previous.etag || previous.lastModified) && res.url === previous.responseUrl) {
    return { candidates: [], validator, notModified: true };
  }
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  let doc: Record<string, any>;
  try {
    doc = parser.parse(res.text());
  } catch (e) {
    throw new FetchError(`feed parse error: ${String(e).slice(0, 200)}`);
  }
  const summaryIsBody = source.config.summaryIsBody === true;
  // Entries that are sections of one page (#september-24-2026 …) keep their fragment as identity.
  const identity = (link: string) =>
    source.config.preserveUrlFragment === true ? { identityKey: identityKeyForUrl(link, { keepFragment: true }) ?? undefined } : {};
  const out: Candidate[] = [];
  // A relative href resolves against the address the bytes came from, not the configured feed URL.
  const docUrl = res.url || url;
  const publishedAtUtcOffset = source.config.publishedAtUtcOffset as string | null | undefined;

  const channel = doc.rss?.channel ?? doc["rdf:RDF"];
  if (channel) {
    const items = arr(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    const channelBase = baseOf(channel, docUrl);
    for (const it of items) {
      const itemBase = baseOf(it, channelBase);
      const link = resolveHref(text(it.link), itemBase) ?? resolveHref(text(it.guid), itemBase);
      const title = collapseWhitespace(stripTags(titleText(it.title)));
      if (!link || !title) continue;
      const contentEncoded = text(it["content:encoded"]);
      // Wiley's table-of-contents feeds carry the volume line in `<description>` ("Antipode, Volume 58,
      // Issue 6, November 2026.") and the abstract in `<dc:description>`. Reading only the first handed the
      // model a 22-92 character stub for every one of the pack's 36 Wiley sources — measured on production:
      // 0 of 190 recent items passed the relevance gate — while sources that put the abstract in
      // `<description>` or `<content:encoded>` deliver 300-800 characters. The abstract is the longer one.
      const plainSummary = text(it.description);
      const dcSummary = text(it["dc:description"]);
      const description = dcSummary.length > plainSummary.length ? dcSummary : plainSummary;
      const bodyHtmlRaw = contentEncoded || (summaryIsBody ? description : "");
      const bodyHtml = bodyHtmlRaw ? sanitizeBody(bodyHtmlRaw, link) : null;
      const enclosure = arr(it.enclosure as Record<string, string> | Array<Record<string, string>>).find((e) => /^image\//.test(e?.["@type"] ?? ""));
      const enclosureUrl = enclosure ? resolveHref(String(enclosure["@url"] ?? ""), link) : null;
      const media = [
        ...(enclosureUrl ? [{ kind: "image" as const, url: enclosureUrl }] : []),
        ...(bodyHtmlRaw ? imagesFrom(bodyHtmlRaw, link) : []),
        // An RSS 2.0 item with neither enclosure nor body HTML can still be a video: the same MRSS parts
        // the Atom branch reads, so "this is a video with this still" means one thing in both dialects.
        ...(enclosureUrl || bodyHtmlRaw ? [] : mrssMedia(it, link)),
      ];
      out.push({
        url: link,
        ...identity(link),
        title,
        author: text(it["dc:creator"]) || text(it.author) || null,
        // Frontiers writes `<pubdate>` and the RFC-822 spelling is `<pubDate>`; the parser keeps tag case,
        // so reading only one of the two silently loses the source date — and a dateless item is filed under
        // its discovery time, which turns last month's paper into today's news on the timeline.
        publishedAt: parseDate(text(it.pubDate) || text(it.pubdate) || text(it["dc:date"]) || text(it.published), publishedAtUtcOffset),
        ...feedText(bodyHtml, description || mrss(it).description, source),
        media: media.slice(0, 6),
        categories: arr(it.category).map((c) => text(c)).filter(Boolean),
        raw: { guid: text(it.guid) || null },
      });
    }
    assertReadable(items, out);
    return { candidates: out, validator, notModified: false };
  }

  const feed = doc.feed;
  if (feed) {
    // A feed-level @xml:base is inherited by its entries; an entry's own replaces it for that entry.
    const feedBase = baseOf(feed, docUrl);
    const entries = arr(feed.entry);
    for (const e of entries) {
      const link = atomLink(e.link);
      const title = collapseWhitespace(stripTags(titleText(e.title)));
      const entryUrl = resolveHref(link, baseOf(e, feedBase));
      if (!entryUrl || !title) continue;
      const content = text(e.content);
      const summary = text(e.summary);
      // A video feed (YouTube and other MRSS Atom feeds) has no `<content>` and no `<summary>`: its
      // description and still live in the media namespace, and the still is the only picture a reader
      // gets here. The Atom `<summary>` wins when a feed has both — it is what the publisher wrote for
      // the feed itself.
      const mediaText = mrss(e).description;
      // The body and its images resolve against the entry's own resolved address, the one the reader opens.
      const bodyHtml = content ? sanitizeBody(content, entryUrl) : null;
      out.push({
        url: entryUrl,
        ...identity(entryUrl),
        title,
        author: text(arr(e.author)[0]?.name) || null,
        publishedAt: parseDate(text(e.published) || text(e.updated), publishedAtUtcOffset),
        sourceUpdatedAt: parseDate(text(e.updated), publishedAtUtcOffset),
        ...feedText(bodyHtml, summary || mediaText, source),
        media: content ? imagesFrom(content, entryUrl) : mrssMedia(e, entryUrl),
        categories: arr(e.category).map((c: any) => c?.["@term"] ?? text(c)).filter(Boolean),
        raw: { id: text(e.id) || null },
      });
    }
    assertReadable(entries, out);
    return { candidates: out, validator, notModified: false };
  }
  throw new FetchError("not an RSS/Atom document");
}
