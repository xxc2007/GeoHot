// One bounded discovery run: search a handful of engines, group results by host, prove the site
// publishes a live feed, and stage only candidates that pass both the feed gate and the quality gate.
// Nothing here touches the live source pool; approving a candidate is a separate operator action.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { shortHash } from "../lib/ids.ts";
import { searchEngines, type EngineFailure, type SearchHit } from "./search-engines.ts";
import { resolveCandidate } from "./discovery-probe.ts";
import { formatReviewNote } from "../ingest/discovery.ts";

export interface DiscoveryInput {
  query: string;
  category?: string | null;
  engines?: string[];
  maxResults?: number;
  maxHosts?: number;
  /** The API creates the run row before returning the id so the page can poll immediately. */
  runId?: string;
}

export interface HostEvidence {
  host: string;
  hits: SearchHit[];
  engines: Map<string, SearchHit>;
}

const OFFICIAL = /(^|\.)(gov|gov\.cn|edu|edu\.cn|ac\.[a-z]{2}|int|mil)(\.|$)/i;
const RESEARCH = /(^|\.)(nature\.com|science\.org|wiley\.com|sciencedirect\.com|springer\.com|link\.springer\.com|tandfonline\.com|sagepub\.com|mdpi\.com|frontiersin\.org|copernicus\.org|agu\.org|geoscienceworld\.org|jstor\.org|arxiv\.org|biorxiv\.org|ssrn\.com)$/i;
const NEWS = /(^|\.)(reuters\.com|apnews\.com|bbc\.com|theguardian\.com|xinhuanet\.com|people\.com\.cn|cctv\.com|chinadaily\.com\.cn|scmp\.com|nytimes\.com|washingtonpost\.com|aljazeera\.com|ft\.com|economist\.com)$/i;
const BLOCKED = /(^|\.)(x\.com|twitter\.com|reddit\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|medium\.com|substack\.com|wikipedia\.org|news\.google\.com|bing\.com|baidu\.com|zhihu\.com|weibo\.com|douban\.com|bilibili\.com|quora\.com|pinterest\.com|t\.me)(\.|$)/i;

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Public-domain authority signal; blocked hosts return base -1 and are never staged. */
export function sourceHostQuality(host: string): { blocked: boolean; base: number; kind: string } {
  if (!host) return { blocked: true, base: -1, kind: "invalid" };
  if (BLOCKED.test(host)) return { blocked: true, base: -1, kind: "blocked" };
  if (OFFICIAL.test(host)) return { blocked: false, base: 4, kind: "official" };
  if (RESEARCH.test(host)) return { blocked: false, base: 3, kind: "research" };
  if (NEWS.test(host)) return { blocked: false, base: 1, kind: "news" };
  if (host.endsWith(".org")) return { blocked: false, base: 2, kind: "organization" };
  return { blocked: false, base: 0, kind: "other" };
}

export interface CandidateScore {
  quality: number;
  corroboration: number;
  base: number;
  kind: string;
  blocked: boolean;
  eligible: boolean;
}

export function scoreHostCandidate(host: string, engines: Map<string, SearchHit>, feedOk: boolean): CandidateScore {
  const { blocked, base, kind } = sourceHostQuality(host);
  const corroboration = engines.size;
  const bestRank = Math.min(...[...engines.values()].map((hit) => hit.rank));
  const rankBonus = bestRank <= 3 ? 2 : bestRank <= 10 ? 1 : 0;
  const quality = Math.max(0, Math.min(10, base + Math.min(corroboration, 3) + rankBonus + (feedOk ? 2 : 0)));
  return {
    quality, corroboration, base, kind, blocked,
    // One engine on a random blog is not enough. Official/research domains or multi-engine
    // corroboration clear the gate; everything else must also score well.
    eligible: feedOk && !blocked && (corroboration >= 2 || base >= 3 || quality >= 6),
  };
}

function nameForFeed(feedUrl: string): string {
  try {
    const u = new URL(feedUrl);
    const tail = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("-");
    return (tail ? `${u.hostname.replace(/^www\./, "")}/${tail}` : u.hostname.replace(/^www\./, "")).slice(0, 120);
  } catch {
    return "unknown-host";
  }
}

export function sourceIdForFeed(feedUrl: string): string {
  const name = nameForFeed(feedUrl).replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `discovered-${name}-${shortHash(feedUrl, 8)}`;
}

export interface DiscoveryResult {
  runId: string;
  status: "done" | "failed";
  stats: {
    query: string;
    queries: string[];
    engines: string[];
    hits: number;
    hosts: number;
    probed: number;
    staged: number;
    skipped: number;
    blocked: number;
    failures: EngineFailure[];
  };
}

export async function runSourceDiscovery(input: DiscoveryInput): Promise<DiscoveryResult> {
  const query = input.query.trim();
  if (!query) throw new Error("query is required");
  const runId = input.runId ?? randomUUID();
  const engines = input.engines?.filter(Boolean) ?? [];
  if (!input.runId) {
    await sql`INSERT INTO source_discovery_runs(id, query, category, engines, status)
              VALUES(${runId}, ${query}, ${input.category ?? null}, ${engines}, 'running')`;
  }
  const failures: EngineFailure[] = [];
  const stats = { query, queries: [] as string[], engines: [] as string[], hits: 0, hosts: 0, probed: 0, staged: 0, skipped: 0, blocked: 0, failures };
  try {
    // A plain topic query returns articles; the same topic plus "RSS feed" returns the publisher's
    // own feed page. Run both and merge: the first supplies corroboration, the second supplies feeds.
    const queries = [...new Set([query, /rss|feed|atom|订阅/i.test(query) ? null : `${query} RSS feed`].filter((value): value is string => Boolean(value)))];
    stats.queries = queries;
    const search = { hits: [] as SearchHit[], failures: [] as EngineFailure[], used: [] as string[] };
    for (const q of queries) {
      const one = await searchEngines(q, engines.length ? engines : undefined, { maxResults: input.maxResults ?? 10 });
      search.hits.push(...one.hits);
      search.failures.push(...one.failures);
      search.used.push(...one.used);
    }
    stats.engines = [...new Set(search.used)];
    stats.hits = search.hits.length;
    failures.push(...search.failures);

    const byHost = new Map<string, HostEvidence>();
    for (const hit of search.hits) {
      const host = hostOfUrl(hit.url);
      if (!host) continue;
      const row = byHost.get(host) ?? { host, hits: [], engines: new Map<string, SearchHit>() };
      row.hits.push(hit);
      const previous = row.engines.get(hit.engine);
      if (!previous || hit.rank < previous.rank) row.engines.set(hit.engine, hit);
      byHost.set(host, row);
    }
    stats.hosts = byHost.size;
    const ranked = [...byHost.values()].sort((a, b) =>
      b.engines.size - a.engines.size ||
      Math.min(...[...a.engines.values()].map((h) => h.rank)) - Math.min(...[...b.engines.values()].map((h) => h.rank)) ||
      a.host.localeCompare(b.host));
    const limit = Math.min(Math.max(input.maxHosts ?? 12, 1), 30);
    for (const row of ranked.slice(0, limit)) {
      if (sourceHostQuality(row.host).blocked) { stats.blocked += 1; continue; }
      stats.probed += 1;
      const best = [...row.hits].sort((a, b) => a.rank - b.rank)[0]!;
      const probe = await resolveCandidate(best.url);
      const score = scoreHostCandidate(row.host, row.engines, probe.verdict.ok);
      if (!probe.verdict.ok || !score.eligible) { stats.skipped += 1; continue; }
      const feedUrl = probe.feedUrl!;
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM sources WHERE coalesce(config->>'feedUrl', config->>'url') = ${feedUrl} LIMIT 1`;
      const pending = await sql<{ id: bigint }[]>`
        SELECT id FROM source_discovery_candidates WHERE feed_url = ${feedUrl} AND status = 'pending' LIMIT 1`;
      if (existing.length || pending.length) { stats.skipped += 1; continue; }
      const evidence = [...row.engines.entries()].map(([engine, hit]) => ({ engine, rank: hit.rank, url: hit.url, title: hit.title }));
      const verdict = {
        ...probe.verdict,
        latest: probe.verdict.latest ? probe.verdict.latest.toISOString() : null,
        feedUrl,
        quality: score.quality,
        corroboration: score.corroboration,
        hostKind: score.kind,
      };
      await sql`INSERT INTO source_discovery_candidates
        (run_id, address, feed_url, host, name, title, engines, corroboration, quality, verdict, review_note)
        VALUES(${runId}, ${best.url}, ${feedUrl}, ${row.host}, ${nameForFeed(feedUrl)}, ${best.title || nameForFeed(feedUrl)},
               ${sql.json(evidence)}, ${score.corroboration}, ${score.quality}, ${sql.json(verdict)}, ${formatReviewNote(probe.verdict)})`;
      stats.staged += 1;
    }
    await sql`UPDATE source_discovery_runs SET status='done', finished_at=now(), stats=${sql.json(stats as never)} WHERE id=${runId}`;
    return { runId, status: "done", stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`UPDATE source_discovery_runs SET status='failed', finished_at=now(), stats=${sql.json(stats as never)}, error=${message.slice(0, 500)} WHERE id=${runId}`.catch(() => {});
    return { runId, status: "failed", stats };
  }
}
