// Backfill the scholarly archive between two dates from Crossref, one (source, month) slice at a time.
//
// Why Crossref and not the journals' own feeds: an RSS feed shows the last handful of items, which is exactly
// why the site only covers the current week. Crossref keys every registered journal by ISSN and filters its
// records by publication date, so it is the one door that reaches back to a chosen month. The records carry a
// DOI, a title, an abstract and a date — enough for the editorial pipeline to judge, and a landing page the
// reader can actually open.
//
// The material is stored with `backfill = "archive"`, which the existing timeline rule turns into
// `timeline_at = published_at`: a paper from March is filed in March rather than arriving as today's news,
// queues behind live work, and founds no event (it is history, not a development). The pipeline afterwards is
// the site's own — prefilter, two scores, writing, structure — nothing here judges anything.
//
//   node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-10                 # dry run
//   node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-03 --apply \
//     --database-url=postgres://…  --max-items=2000 --per-month=60
//
// Nothing is written without --apply. A Ctrl-C or a crash costs one slice, not the run: `archive_ingest`
// keeps the Crossref cursor and the counts, so the next start resumes where the pages stopped.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { looksZh } from "@aihot/backend/editorial/writing";
import { guardedFetch, DEFAULT_UA } from "@aihot/backend/lib/http-fetch";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-01" },
    to: { type: "string", default: "" },
    source: { type: "string", default: "" },
    "max-items": { type: "string", default: "2000" },
    "per-month": { type: "string", default: "60" },
    "per-page": { type: "string", default: "100" },
    sleep: { type: "string", default: "300" },
    apply: { type: "boolean", default: false },
  },
});

const fromMonth = values.from!;
const toMonth = values.to || fromMonth;
if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) {
  console.error("用法：--from=YYYY-MM --to=YYYY-MM [--apply --database-url=…] [--max-items=N] [--per-month=N]");
  process.exit(2);
}
const MAX_ITEMS = Number(values["max-items"]);
const PER_MONTH = Number(values["per-month"]);
const PER_PAGE = Math.min(500, Math.max(1, Number(values["per-page"])));
const SLEEP = Math.max(0, Number(values.sleep));
const onlyIds = values.source!.split(",").map((s) => s.trim()).filter(Boolean);

/** [fromMonth, toMonth] as calendar months. */
function months(): string[] {
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const end = toMonth.split("-").map(Number);
  for (let guard = 0; guard < 240; guard++) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    if (y === end[0] && m === end[1]) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const sliceRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
};

interface Work {
  DOI: string;
  title?: string[];
  "container-title"?: string[];
  abstract?: string;
  URL?: string;
  author?: Array<{ family?: string; given?: string; name?: string }>;
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
}

/** JATS markup comes inside the abstract, and the reader sees plain text. */
function plainText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A full date or none. Crossref often states only a year or a year-month for online-first papers, and
 * inventing a day would put a date on the reader's page that the publisher never claimed — so those records
 * are counted and skipped instead of guessed.
 */
function fullDate(w: Work): Date | null {
  for (const part of [w.published?.["date-parts"], w.issued?.["date-parts"]]) {
    const d = part?.[0];
    if (d && d.length >= 3 && d[0] > 1900) {
      const date = new Date(Date.UTC(d[0], d[1] - 1, d[2]));
      if (Number.isFinite(date.getTime())) return date;
    }
  }
  return null;
}

async function page(url: string): Promise<{ items: Work[]; next: string | null; total: number } | null> {
  const res = await guardedFetch(url, { headers: { accept: "application/json", "user-agent": DEFAULT_UA }, timeoutMs: 45_000 });
  if (res.status === 404 || res.status === 400) return { items: [], next: null, total: 0 };
  if (res.status === 429 || res.status >= 500) {
    console.error(`  crossref ${res.status}, backing off`);
    await new Promise((r) => setTimeout(r, 15_000));
    return null;
  }
  if (res.status !== 200) {
    console.error(`  crossref HTTP ${res.status}`);
    return null;
  }
  const message = (JSON.parse(res.text()) as { message?: { items?: Work[]; "next-cursor"?: string; total?: number } }).message;
  return { items: message?.items ?? [], next: message?.["next-cursor"] || null, total: message?.total ?? 0 };
}

const sources = (await sql<{ id: string; name: string; config: Record<string, unknown> }[]>`
  SELECT id, name, config FROM sources
  WHERE enabled AND coalesce(config->>'issn', '') <> ''
  ORDER BY id`).filter((s) => !onlyIds.length || onlyIds.includes(s.id));
// Crossref's polite pool wants a contact address; without one the requests still work, just in the shared
// anonymous pool. It is the operator's address to give, so it comes from the environment and is never invented.
const mailto = process.env.CROSSREF_MAILTO?.trim();
if (sources.length === 0) {
  console.error("没有一条信源带 config.issn — 先跑 scripts/archive-issn.ts 并把结果并进 industry/sources.json，再同步进库。");
  await closeDb();
  process.exit(1);
}
console.log(`${sources.length} 条带 ISSN 的信源，月份 ${fromMonth}..${toMonth}，本轮上限 ${MAX_ITEMS} 条${values.apply ? "" : "（DRY-RUN：不写库）"}`);

let stored = 0;
let seen = 0;
let skipped = 0;

for (const month of months()) {
  const { start, end } = sliceRange(month);
  for (const source of sources) {
    if (stored >= MAX_ITEMS) break;
    const issn = String(source.config.issn);
    const [ledger] = await sql<{ status: string; cursor: string | null }[]>`
      SELECT status, cursor FROM archive_ingest WHERE source_id = ${source.id} AND month = ${month}`;
    if (ledger?.status === "done") continue;

    let cursor = ledger?.cursor ?? "*";
    let localSeen = 0;
    let localNew = 0;
    let noDate = 0;
    if (values.apply) {
      await sql`INSERT INTO archive_ingest (source_id, month, status, updated_at) VALUES (${source.id}, ${month}, 'running', now())
                ON CONFLICT (source_id, month) DO UPDATE SET status = 'running', updated_at = now()`;
    }
    console.log(`${source.id} ${month} issn=${issn}${cursor !== "*" ? " (续)" : ""}`);
    let pages = 0;
    while (cursor && localSeen < PER_MONTH && stored < MAX_ITEMS && pages++ < 12) {
      const url = `https://api.crossref.org/works?rows=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
        + `&filter=type:journal-article,issn:${issn},from-pub-date:${start},until-pub-date:${end}`
        + `&select=DOI,title,abstract,URL,author,published,issued${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ""}`;
      const res = await page(url);
      if (!res) break;
      if (res.items.length === 0) { cursor = ""; break; }
      for (const w of res.items) {
        if (localSeen >= PER_MONTH || stored >= MAX_ITEMS) break;
        localSeen++;
        const title = (w.title?.[0] ?? "").trim();
        const at = fullDate(w);
        if (!title || !at) { noDate++; skipped++; continue; }
        const body = w.abstract ? plainText(w.abstract) : "";
        if (body.length < 80) { skipped++; continue; } // No abstract: there is nothing for the editors to judge.
        seen++;
        if (values.apply) {
          const first = w.author?.[0];
          const author = first?.family ?? first?.name ?? null;
          const { articleId, created } = await upsertMaterial({
            sourceId: source.id,
            url: w.URL || `https://doi.org/${w.DOI}`,
            title,
            identityKey: `doi:${w.DOI.toLowerCase()}`,
            author,
            language: looksZh(title) ? "zh" : "en",
            publishedAt: at,
            bodyText: body,
            bodyStatus: "ok",
            via: "import",
            backfill: "archive",
            raw: { crossref: { doi: w.DOI, container: w["container-title"]?.[0] ?? null } },
          });
          if (created) {
            stored++;
            localNew++;
            await queueProcessing(articleId);
          }
        } else {
          stored++;
          localNew++;
        }
      }
      cursor = res.next ?? "";
      if (SLEEP) await new Promise((r) => setTimeout(r, SLEEP));
    }
    if (!values.apply) continue;
    const finished = !cursor;
    await sql`UPDATE archive_ingest SET status = ${finished ? "done" : "pending"}, cursor = ${finished ? null : cursor},
              seen = seen + ${localSeen}, items = items + ${localNew},
              note = ${`no-date=${noDate}`}, updated_at = now()
              WHERE source_id = ${source.id} AND month = ${month}`;
    console.log(`  ${finished ? "done" : "停在游标"} 看了 ${localSeen} 条，入库 ${localNew} 条，无整日期 ${noDate} 条`);
  }
  if (stored >= MAX_ITEMS) console.log(`本轮到达上限 ${MAX_ITEMS} 条，剩下的下轮接着跑。`);
}

console.log(`${values.apply ? "已入库" : "DRY-RUN 将入库"} ${stored} 条（取到材料 ${seen} 条，跳过 ${skipped} 条）`);
await closeDb();
