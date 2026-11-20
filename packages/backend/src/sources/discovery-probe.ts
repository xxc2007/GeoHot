// Turn a search-result address into a feed we can actually collect. The probe reuses the collector's
// own RSS parser and robots policy; HTML is read only for its advertised <link rel="alternate">.
import { guardedFetch } from "../lib/http-fetch.ts";
import { fetchRss } from "./rss.ts";
import { evaluateCandidate, feedLinksFromHtml, type DiscoveryVerdict } from "../ingest/discovery.ts";
import type { SourceRow } from "./types.ts";

const UA = "Mozilla/5.0 (compatible; GeoHotSourceDiscovery/1.0; +https://xxc2007.me/geohot/)";
export const MAX_PROBES_PER_CANDIDATE = 6;

function probeRow(feedUrl: string): SourceRow {
  return {
    id: "discovery-probe",
    name: new URL(feedUrl).hostname.replace(/^www\./, "") || "discovery-probe",
    kind: "rss",
    config: { feedUrl, headers: { "user-agent": UA } },
    tier: "T2",
    participation_mode: "editorial",
    first_party: false,
    interval_minutes: 30,
    enabled: false,
    cursor: null,
    fail_count: 0,
  } as SourceRow;
}

export interface FeedProbe {
  address: string;
  feedUrl: string | null;
  verdict: DiscoveryVerdict;
  error: string | null;
}

async function probe(feedUrl: string): Promise<FeedProbe> {
  try {
    const read = await fetchRss(probeRow(feedUrl), { force: true });
    return { address: feedUrl, feedUrl, verdict: evaluateCandidate({ items: read.candidates, httpStatus: 200, now: new Date() }), error: null };
  } catch (error) {
    const status = (error as { status?: number })?.status ?? null;
    return { address: feedUrl, feedUrl: null, verdict: evaluateCandidate({ items: [], httpStatus: status, now: new Date() }), error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Feed-looking anchors in the page body. Publishers often list their feeds on a human page
 * (`/earthquakes/feed/v1.0/` links to `atom.php`, `/rss`, `format=rss`) without a
 * `<link rel="alternate">`; only following the advertised tag misses those official feeds.
 */
function feedAnchors(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!.replaceAll("&amp;", "&").trim();
    if (!/(\.(rss|atom|xml)(\?|$)|format=rss|\/rss(\/|\?|$)|\.php(\?|$))/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if ((url.protocol === "http:" || url.protocol === "https:") && !/\.(css|js|png|jpe?g|svg)(\?|$)/i.test(url.pathname)) found.add(url.toString());
    } catch { /* a broken href must not poison the page */ }
  }
  return [...found];
}

async function advertisedFeeds(address: string): Promise<string[]> {
  try {
    const res = await guardedFetch(address, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "user-agent": UA },
      timeoutMs: 15_000,
      maxBytes: 2_000_000,
    });
    if (res.status < 200 || res.status > 299) return [];
    const html = res.text();
    const base = res.url || address;
    return [...new Set([...feedLinksFromHtml(html, base), ...feedAnchors(html, base)])].slice(0, 5);
  } catch {
    return [];
  }
}

const COMMON_FEEDS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];

/**
 * Probe the address itself, then the page's advertised feeds, then the common feed paths.
 * The first passing feed wins; otherwise the probe with the most items is returned so the
 * review note can say why the candidate was rejected.
 */
export async function resolveCandidate(address: string): Promise<FeedProbe> {
  const probes: FeedProbe[] = [];
  let best = await probe(address);
  probes.push(best);
  if (best.verdict.ok) return best;

  const origin = (() => { try { const u = new URL(address); return `${u.protocol}//${u.host}`; } catch { return ""; } })();
  const queue = [...new Set([
    ...(await advertisedFeeds(address)),
    ...(origin ? COMMON_FEEDS.map((path) => `${origin}${path}`) : []),
  ])].filter((url) => url !== address).slice(0, MAX_PROBES_PER_CANDIDATE - 1);

  for (const feed of queue) {
    const next = await probe(feed);
    probes.push(next);
    if (next.verdict.ok) return next;
    if (next.verdict.itemCount > best.verdict.itemCount) best = next;
  }
  return best;
}
