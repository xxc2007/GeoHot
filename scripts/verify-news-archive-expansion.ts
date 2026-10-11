// Public publisher HTML only: no environment file, database or model provider.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fromHtml } from "../packages/backend/src/sources/web-list.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";

const root = resolve(import.meta.dirname, "..");
const sources: SourceRow[] = JSON.parse(await readFile(resolve(root, "industry/sources.json"), "utf8")).sources;
const plans = [
  { id: "cn-web-shanghai-news", template: "https://www.shanghai.gov.cn/nw4411/index_{page}.html", first: 1, last: 150 },
  { id: "cn-web-guangzhou-government", template: "https://www.gz.gov.cn/xw/zwlb/index_{page}.html", first: 1, last: 14 },
  { id: "cn-web-shanghai-statistics", template: "https://tjj.sh.gov.cn/sjxx/index_{page}.html", first: 1, last: 5 },
  { id: "web-unfpa-news", template: "https://www.unfpa.org/news?page={page}", first: 0, last: 4 },
  { id: "web-iom-news", template: "https://www.iom.int/news?page={page}", first: 0, last: 9 },
  { id: "web-adb-news", template: "https://www.adb.org/news/releases?page={page}", first: 0, last: 12 },
  { id: "web-eclac-news", template: "https://www.cepal.org/en/list/cepal_pr?page={page}", first: 0, last: 2 },
];
const quick = process.argv.includes("--quick");
const rows: unknown[] = [];
for (const plan of plans) {
  const source = sources.find(s => s.id === plan.id)!;
  const pages = quick ? [...new Set([plan.first, plan.first + 1, plan.last])] : Array.from({ length: plan.last - plan.first + 1 }, (_, i) => i + plan.first);
  const seen = new Set<string>();
  const eligibleDates: string[] = [];
  const probes = [];
  let prior = "";
  for (const page of pages) {
    const url = page === 1 && plan.id.startsWith("cn-") ? source.config.url : plan.template.replace("{page}", String(page));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const items = fromHtml(html, url, source);
      const dated = items.filter(c => c.publishedAt);
      const dates = dated.map(c => c.publishedAt!.toISOString()).sort();
      const signature = items.map(c => c.url).join("\n");
      const repeated = signature === prior;
      prior = signature;
      let eligible = 0;
      for (const c of dated) {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(c.publishedAt!);
        if (day >= "2026-01-01" && day <= "2026-10-10" && !seen.has(c.url)) { eligible++; seen.add(c.url); eligibleDates.push(day); }
      }
      probes.push({ page, url, status: response.status, parsed: items.length, dated: dated.length, eligible, earliest: dates[0], latest: dates.at(-1), repeated, sample: dated.slice(0, 1).map(c => ({ title: c.title, url: c.url, publishedAt: c.publishedAt!.toISOString() })) });
      if (!quick && (repeated || dated.length === items.length && dated.length && dates.at(-1)! < "2026-01-01")) break;
    } catch (error) { probes.push({ page, url, error: (error as Error).message }); if (!quick) break; }
  }
  const monthCounts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => { const month = `2026-${String(i + 1).padStart(2, "0")}`; return [month, eligibleDates.filter(d => d.startsWith(month)).length]; }));
  const result = { id: plan.id, template: plan.template, first: plan.first, uniqueEligible: seen.size, earliestEligible: eligibleDates.sort()[0], monthCounts, probes };
  rows.push(result);
  console.log(JSON.stringify({ ...result, probes: undefined, pages: probes.length, errors: probes.filter(p => "error" in p), tail: probes.at(-1) }));
}
const out = process.argv.find(a => a.startsWith("--output="))?.slice(9);
if (out) { const target = resolve(root, out); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify({ checkedAt: new Date().toISOString(), mode: quick ? "boundary-probes" : "read-only-full-pages", rows }, null, 2) + "\n"); }
