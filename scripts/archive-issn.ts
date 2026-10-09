// Which Crossref journal is each registered source? The archive backfill needs an ISSN, and an ISSN that was
// guessed instead of read publishes one journal's articles under another source's name — an attribution error
// a reader cannot see. So: take the Latin title the pack itself carries, ask Crossref's journal registry for
// it, and accept only when the returned title is the same title. Anything else is reported, never stored.
//
//   node --env-file=.env scripts/archive-issn.ts --tier=T1,T1_5 > /tmp/issn.json
//
// Read-only. The JSON on stdout is what a human merges into industry/sources.json as `config.issn`.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { guardedFetch, DEFAULT_UA } from "@aihot/backend/lib/http-fetch";

const { values } = parseArgs({
  options: {
    tier: { type: "string", default: "" },
    ids: { type: "string", default: "" },
    limit: { type: "string", default: "" },
    detail: { type: "boolean", default: false },
  },
});
const tiers = values.tier!.split(",").map((s) => s.trim()).filter(Boolean);
const only = values.ids!.split(",").map((s) => s.trim()).filter(Boolean);
const cap = Number(values.limit || 0);

/** The pack names a source in Chinese with the venue's own title in brackets or at the end. That Latin run is
 * the title Crossref knows; a name with no Latin run cannot be matched without a human looking at the page. */
export function latinTitle(name: string): string | null {
  const runs = name.match(/[A-Za-z][A-Za-z0-9&,.;'’\-() ]{6,}/g) ?? [];
  const best = runs.map((r) => r.trim().replace(/^[([]|[)\]]$/g, "")).sort((a, b) => b.length - a.length)[0];
  return best && best.length >= 7 ? best : null;
}

/**
 * The venue's own title, from the feed it publishes. Most pack names are Chinese ("《大气科学进展》"), which
 * Crossref does not index, while the feed's channel title is the journal's own English name — the string its
 * ISSN record answers to. Discovery only: nothing here is stored as a reader-facing title.
 */
function channelTitle(xml: string): string | null {
  const rss = /<channel[\s>][\s\S]{0,600}?<title>(?:\s*<!\[CDATA\[)?([^{<\]]{4,200}?)(?:\]\]>\s*)?<\/title>/i.exec(xml);
  if (rss?.[1]) return rss[1].trim();
  const atom = /<feed[\s>][\s\S]{0,600}?<title[^>]*>(?:\s*<!\[CDATA\[)?([^{<\]]{4,200}?)(?:\]\]>\s*)?<\/title>/i.exec(xml);
  return atom?.[1]?.trim() ?? null;
}

const normalize = (s: string) =>
  s.toLowerCase().replace(/[.,;&]/g, " ").replace(/\b(the|of|and|international)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).join(" ");

interface JournalRow { title?: string; ISSN?: string[]; publisher?: string }

async function crossref(title: string): Promise<JournalRow[]> {
  const url = `https://api.crossref.org/journals?rows=4&query=${encodeURIComponent(title)}`;
  const res = await guardedFetch(url, { headers: { accept: "application/json", "user-agent": DEFAULT_UA }, timeoutMs: 20_000 });
  if (res.status !== 200) return [];
  try {
    return ((JSON.parse(res.text()) as { message?: { items?: JournalRow[] } }).message?.items ?? []);
  } catch {
    return [];
  }
}

const rows = await sql<{ id: string; name: string; tier: string; kind: string; enabled: boolean; config: Record<string, unknown> }[]>`
  SELECT id, name, tier, kind, enabled, config FROM sources ORDER BY tier, id`;

const report: Array<{ id: string; name: string; title: string | null; issn: string | null; status: string; candidates?: string[] }> = [];
let queue = rows.filter((r) => r.enabled && (only.length ? only.includes(r.id) : !tiers.length || tiers.includes(r.tier)));
if (cap > 0) queue = queue.slice(0, cap);
console.error(`checking ${queue.length} sources`);

for (const r of queue) {
  const existing = typeof r.config.issn === "string" ? r.config.issn : null;
  const feedUrl = typeof r.config.feedUrl === "string" ? r.config.feedUrl : null;
  const titles = [latinTitle(r.name)];
  if (feedUrl) {
    // 6 s, not the default 20 s: this loop runs over the whole pack, and a quarter of the hosts are Chinese
    // government or publisher domains that do not answer from this machine at all. 258 × 20 s is an hour of
    // waiting for nothing; 258 × 6 s is a few minutes, and an unanswered feed only costs us the Crossref
    // fallback on the pack's own Latin name.
    const res = await guardedFetch(feedUrl, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "user-agent": DEFAULT_UA }, timeoutMs: 6_000 }).catch(() => null);
    const fromFeed = res && res.status === 200 ? channelTitle(res.text()) : null;
    if (fromFeed) titles.unshift(fromFeed);
  }
  const unique = [...new Set(titles.filter((t): t is string => !!t))];
  if (unique.length === 0) {
    report.push({ id: r.id, name: r.name, title: null, issn: existing, status: "no-latin-title" });
    continue;
  }
  let matched: { title: string; issn: string } | null = null;
  let ambiguous: string[] = [];
  const near: string[] = [];
  for (const title of unique) {
    const items = await crossref(title);
    const want = normalize(title);
    const hits = items.filter((i) => i.ISSN?.length && normalize(i.title ?? "") === want);
    const issns = [...new Set(hits.flatMap((h) => h.ISSN ?? []))];
    if (issns.length >= 1 && !matched) {
      if (issns.length === 1) matched = { title, issn: issns[0]! };
      else ambiguous = issns;
    }
    near.push(...items.map((i) => `${i.title} ${i.ISSN?.[0] ?? ""}`));
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  if (matched) report.push({ id: r.id, name: r.name, title: matched.title, issn: matched.issn, status: existing && existing !== matched.issn ? "conflict" : "match" });
  else if (ambiguous.length) report.push({ id: r.id, name: r.name, title: unique[0]!, issn: existing, status: "ambiguous", candidates: ambiguous });
  else report.push({ id: r.id, name: r.name, title: unique[0]!, issn: existing, status: "no-match", candidates: near.slice(0, 3) });
  const done = report.length;
  console.error(`[${done}/${queue.length}] ${r.id} | ${unique[0] ?? "—"} -> ${report.at(-1)!.status} ${report.at(-1)!.issn ?? ""}`);
  if (values.detail && report.at(-1)!.status !== "match") console.error(`      候选：${(report.at(-1)!.candidates ?? []).slice(0, 3).join(" / ")}`);
}

const counts = report.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
console.error(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
console.log(JSON.stringify(report.filter((r) => r.status === "match"), null, values.detail ? 1 : 0));
await closeDb();
