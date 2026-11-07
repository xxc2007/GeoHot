// Find feeds worth adding to the registry, but do not turn them on: every row this writes is
// enabled=false, discovered_via='url:<host>' or 'search:<host>', and review_note carries the readings
// (item count, newest item, HTTP status) so scripts/review-sources.ts can be read without re-fetching.
//
// Run as: node --env-file-if-exists=.env tooling/discover-sources.ts candidates.txt
//         node --env-file-if-exists=.env tooling/discover-sources.ts --from-search "地理 期刊"
//         node --env-file-if-exists=.env tooling/discover-sources.ts --file=candidates.txt
//
// Feed parsing reuses sources/rss.ts (the same parser the collector runs); HTML is only consulted for
// the <link rel="alternate"> advertisement when the candidate itself is not a feed. The search endpoint
// is configured by GEOHOT_DISCOVER_ENDPOINT and GEOHOT_DISCOVER_KEY; the key is sent as a bearer token
// and never printed, stored or echoed by this file.
import process from "node:process";
import { readFileSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { shortHash } from "@aihot/backend/lib/ids";
import { fetchRss } from "@aihot/backend/sources/rss";
import { FetchError, type SourceRow } from "@aihot/backend/sources/types";
import {
  addressKey,
  candidateLines,
  candidateUrlsFromSearch,
  discoveredVia,
  evaluateCandidate,
  formatReviewNote,
  feedLinksFromHtml,
  hostOf,
  type DiscoveryVerdict,
} from "@aihot/backend/ingest/discovery";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const withEquals = args.find((a) => a.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** The first bare argument, skipping the value of a spaced value flag (`--from-search q`). */
function positional(): string | undefined {
  const valueFlags = new Set(["--from-search", "--file"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && valueFlags.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

const searchQuery = flag("--from-search");
const fileArg = flag("--file") ?? positional();
// Checked before DATABASE_URL: a search run without its endpoint is a configuration mistake, and the
// operator should see that sentence even on a machine with no .env at all.
const discoverEndpoint = process.env.GEOHOT_DISCOVER_ENDPOINT;
const discoverKey = process.env.GEOHOT_DISCOVER_KEY;
if (searchQuery && (!discoverEndpoint || !discoverKey)) {
  console.error("discovery endpoint not configured");
  process.exit(2);
}
const search = searchQuery && discoverEndpoint && discoverKey ? { query: searchQuery, endpoint: discoverEndpoint, key: discoverKey } : null;
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("需要 DATABASE_URL（--env-file-if-exists=.env 里的那一份，或显式导出）");
  process.exit(2);
}
if (!searchQuery && !fileArg) {
  console.error("给一个候选清单文件（每行一个站点或 feed），或 --from-search <查询词>");
  process.exit(2);
}

const now = new Date();

/** The collector's own row shape, minimally filled: fetchRss only reads config/cursor/participation_mode/id. */
function probeRow(feedUrl: string): SourceRow {
  return {
    id: "discovery-probe",
    name: hostOf(feedUrl) || "discovery-probe",
    kind: "rss",
    config: { feedUrl },
    tier: "T2",
    participation_mode: "editorial",
    first_party: false,
    interval_minutes: 30,
    enabled: false,
    cursor: null,
    fail_count: 0,
  };
}

interface Probe {
  feedUrl: string;
  verdict: DiscoveryVerdict;
  httpStatus: number | null;
  error: string | null;
}

async function probe(feedUrl: string): Promise<Probe> {
  try {
    const read = await fetchRss(probeRow(feedUrl), { force: true });
    // fetchRss only returns after a 200; 304 is impossible with force and no cursor.
    return {
      feedUrl,
      verdict: evaluateCandidate({ items: read.candidates, httpStatus: 200, now }),
      httpStatus: 200,
      error: null,
    };
  } catch (e) {
    const status = e instanceof FetchError ? e.status : null;
    return {
      feedUrl,
      verdict: evaluateCandidate({ items: [], httpStatus: status, now }),
      httpStatus: status,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function advertisedFeeds(address: string): Promise<string[]> {
  try {
    const res = await guardedFetch(address, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; GeoHotSourceDiscovery/1.0; +https://xxc2007.me/geohot/)" },
      timeoutMs: 20_000,
      maxBytes: 2_000_000,
    });
    if (res.status < 200 || res.status > 299) return [];
    return feedLinksFromHtml(res.text(), res.url || address).slice(0, 5);
  } catch {
    return [];
  }
}

/** The first feed that passes wins; otherwise keep the probe with the most items so the note says why. */
async function resolve(address: string): Promise<Probe> {
  let best = await probe(address);
  if (best.verdict.ok) return best;
  for (const feed of await advertisedFeeds(address)) {
    const next = await probe(feed);
    if (next.verdict.ok) return next;
    if (next.verdict.itemCount > best.verdict.itemCount) best = next;
  }
  return best;
}

async function candidatesFromSearch(search: { query: string; endpoint: string; key: string }): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(search.endpoint);
  } catch {
    console.error("discovery endpoint is not a valid URL");
    process.exit(2);
  }
  url.searchParams.set("q", search.query);
  const res = await guardedFetch(url.toString(), {
    headers: { accept: "application/json", authorization: `Bearer ${search.key}`, "user-agent": "Mozilla/5.0 (compatible; GeoHotSourceDiscovery/1.0; +https://xxc2007.me/geohot/)" },
    timeoutMs: 25_000,
    maxBytes: 2_000_000,
  });
  if (res.status < 200 || res.status > 299) {
    console.error(`discovery endpoint answered HTTP ${res.status}`);
    process.exit(1);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(res.text());
  } catch {
    console.error("discovery endpoint did not return JSON");
    process.exit(1);
  }
  return candidateUrlsFromSearch(payload);
}

function nameFor(feedUrl: string): string {
  return hostOf(feedUrl) || "unknown-host";
}

function idFor(feedUrl: string, address: string): string {
  const slug = nameFor(feedUrl).replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `discovered-${slug}-${shortHash(addressKey(address), 8)}`;
}

/**
 * Returns "inserted" | "skipped" | "failed". A duplicate and a candidate that parsed but missed the
 * gate are both skips; a fetch/parse/DB error is a failure, so the three numbers add up to candidates.
 */
async function store(address: string, feed: Probe, via: string): Promise<"inserted" | "skipped" | "failed"> {
  const name = nameFor(feed.feedUrl);
  const feedKey = addressKey(feed.feedUrl);
  const candidates = [feedKey, addressKey(address), feed.feedUrl, address];
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE name = ${name}
       OR coalesce(config->>'url', config->>'feedUrl') = ANY(${candidates}::text[])
    LIMIT 1`;
  if (existing.length) {
    console.error(`skip ${address}: 已存在 ${existing[0]!.id}`);
    return "skipped";
  }
  const id = idFor(feed.feedUrl, address);
  try {
    await sql`
      INSERT INTO sources (id, name, kind, config, enabled, discovered_via, review_note)
      VALUES (${id}, ${name}, 'rss', ${sql.json({ feedUrl: feed.feedUrl })}, false, ${via}, ${formatReviewNote(feed.verdict)})`;
    console.error(`insert ${address} → ${id}: ${formatReviewNote(feed.verdict)}`);
    return "inserted";
  } catch (e) {
    // 0090's target_total guard raises 23514 even for enabled=false rows; the pool is an operator decision.
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
    console.error(`fail ${address}: ${code === "23514" ? "source pool capacity exhausted" : e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

async function main(): Promise<void> {
  const addresses = search
    ? await candidatesFromSearch(search)
    : candidateLines(readFileSync(fileArg!, "utf8"));
  const summary = { candidates: addresses.length, inserted: 0, skipped: 0, failed: 0 };
  for (const address of addresses) {
    const feed = await resolve(address);
    if (!feed.verdict.ok) {
      if (feed.error) {
        console.error(`fail ${address}: ${feed.error}`);
        summary.failed++;
      } else {
        console.error(`skip ${address}: ${formatReviewNote(feed.verdict)}`);
        summary.skipped++;
      }
      continue;
    }
    const outcome = await store(address, feed, discoveredVia(searchQuery ? "search" : "url", nameFor(feed.feedUrl)));
    summary[outcome]++;
  }
  // One line on stdout; everything above is diagnostics on stderr, so the summary can be piped.
  console.log(JSON.stringify(summary));
}

try {
  await main();
} finally {
  await closeDb();
}
