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

export async function fetchRss(source: SourceRow, opts: { force?: boolean } = {}): Promise<RssRead> {
  const url = String(source.config.feedUrl ?? "");
  if (!url) throw new FetchError("feedUrl missing");
  // Config changes can alter parsing/filtering even when the upstream bytes did not change.
  const configHash = sha256(stableJson(source.config));
  const previous = !opts.force && source.cursor?.rss?.configHash === configHash ? source.cursor.rss as RssValidator : null;
  const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  let res = await guardedFetch(url, { headers, timeoutMs: 25_000 });
  // A redirect may have changed destinations, whose ETag namespace is unrelated to the old one.
  if (res.status === 304 && previous && res.url !== previous.responseUrl) {
    res = await guardedFetch(url, { headers: { accept: headers.accept! }, timeoutMs: 25_000 });
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
      const title = collapseWhitespace(stripTags(text(it.title)));
      if (!link || !title) continue;
      const contentEncoded = text(it["content:encoded"]);
      const description = text(it.description);
      const bodyHtmlRaw = contentEncoded || (summaryIsBody ? description : "");
      const bodyHtml = bodyHtmlRaw ? sanitizeBody(bodyHtmlRaw, link) : null;
      const enclosure = arr(it.enclosure as Record<string, string> | Array<Record<string, string>>).find((e) => /^image\//.test(e?.["@type"] ?? ""));
      const enclosureUrl = enclosure ? resolveHref(String(enclosure["@url"] ?? ""), link) : null;
      const media = [
        ...(enclosureUrl ? [{ kind: "image" as const, url: enclosureUrl }] : []),
        ...(bodyHtmlRaw ? imagesFrom(bodyHtmlRaw, link) : []),
      ];
      out.push({
        url: link,
        ...identity(link),
        title,
        author: text(it["dc:creator"]) || text(it.author) || null,
        publishedAt: parseDate(text(it.pubDate) || text(it["dc:date"]) || text(it.published), publishedAtUtcOffset),
        ...feedText(bodyHtml, description, source),
        media: media.slice(0, 6),
        categories: arr(it.category).map((c) => text(c)).filter(Boolean),
        raw: { guid: text(it.guid) || null },
      });
    }
    return { candidates: out, validator, notModified: false };
  }

  const feed = doc.feed;
  if (feed) {
    // A feed-level @xml:base is inherited by its entries; an entry's own replaces it for that entry.
    const feedBase = baseOf(feed, docUrl);
    for (const e of arr(feed.entry)) {
      const link = atomLink(e.link);
      const title = collapseWhitespace(stripTags(text(e.title)));
      const entryUrl = resolveHref(link, baseOf(e, feedBase));
      if (!entryUrl || !title) continue;
      const content = text(e.content);
      const summary = text(e.summary);
      // The body and its images resolve against the entry's own resolved address, the one the reader opens.
      const bodyHtml = content ? sanitizeBody(content, entryUrl) : null;
      out.push({
        url: entryUrl,
        ...identity(entryUrl),
        title,
        author: text(arr(e.author)[0]?.name) || null,
        publishedAt: parseDate(text(e.published) || text(e.updated), publishedAtUtcOffset),
        sourceUpdatedAt: parseDate(text(e.updated), publishedAtUtcOffset),
        ...feedText(bodyHtml, summary, source),
        media: content ? imagesFrom(content, entryUrl) : [],
        categories: arr(e.category).map((c: any) => c?.["@term"] ?? text(c)).filter(Boolean),
        raw: { id: text(e.id) || null },
      });
    }
    return { candidates: out, validator, notModified: false };
  }
  throw new FetchError("not an RSS/Atom document");
}
