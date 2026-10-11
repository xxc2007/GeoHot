// Read-only publisher probes for archives not yet supported by the generic HTML pages adapter.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import * as cheerio from "cheerio";
import { fromHtml } from "../packages/backend/src/sources/web-list.ts";
import { fetchRss } from "../packages/backend/src/sources/rss.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";
const root = resolve(import.meta.dirname, "..");
const sources: SourceRow[] = JSON.parse(await readFile(resolve(root, "industry/sources.json"), "utf8")).sources;
const archives = JSON.parse(await readFile(resolve(root, "industry/news-archives.json"), "utf8")).archives;
const loc = sources.find(s => s.id === "intl-loc-worlds-revealed")!;
const locConfig = archives.find((r: { sourceId: string }) => r.sourceId === loc.id).config;
const rows = [];
for (let month = 1; month <= 10; month++) {
  const url = `https://blogs.loc.gov/maps/2026/${String(month).padStart(2, "0")}/`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const $ = cheerio.load(html);
    const items = fromHtml(html, url, { ...loc, config: { ...loc.config, ...locConfig, url } });
    const next = $("a[rel='next'], .nav-links a, .pagination a").toArray().map(a => $(a).attr("href")).filter(h => h?.includes(`/2026/${String(month).padStart(2, "0")}/page/`));
    rows.push({ id: loc.id, url, parsed: items.length, dated: items.filter(c => c.publishedAt).length, paginationLinks: [...new Set(next)], earliest: items.map(c => c.publishedAt?.toISOString()).filter(Boolean).sort()[0] });
  } catch (e) { rows.push({ id: loc.id, url, error: (e as Error).message }); }
}
const itdp = sources.find(s => s.id === "rss-itdp-news")!;
for (let page = 1; page <= 5; page++) {
  const url = `https://www.itdp.org/feed/?paged=${page}`;
  try {
    const result = await fetchRss({ ...itdp, config: { ...itdp.config, feedUrl: url } }, { force: true });
    const items = result.candidates;
    const dates = items.map(c => c.publishedAt?.toISOString()).filter(Boolean).sort();
    rows.push({ id: itdp.id, url, parsed: items.length, dated: dates.length, earliest: dates[0], latest: dates.at(-1), eligible: dates.filter(d => d!.slice(0, 10) >= "2026-01-01" && d!.slice(0, 10) <= "2026-10-10").length });
  } catch (e) { rows.push({ id: itdp.id, url, error: (e as Error).message }); }
}
const result = { checkedAt: new Date().toISOString(), rows };
console.log(JSON.stringify(result, null, 2));
const output = resolve(root, "../.round11/archive-niche-probes.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
