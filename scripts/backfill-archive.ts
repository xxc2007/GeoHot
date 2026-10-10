// Backfill the scholarly archive between two dates, one (source, month) slice at a time, through two doors.
//
// Why not the journals' feeds: an RSS feed shows the last handful of items, which is exactly why the site only
// covers the current week. The first door is Crossref, which keys every registered journal by ISSN and filters
// its records by publication date, so it reaches back to a chosen month. The records carry a DOI, a title, an
// abstract and a date — enough for the editorial pipeline to judge, and a landing page the reader can open.
//
// The second door is the journal's own back-issue index (sources/archive-site.ts), taken because Crossref has
// a hole rather than as a nicer crawl: the Chinese geography journals in the pack are `web_list` sources with no
// ISSN, and Crossref does not carry them — 6 of the 8 ISSNs they print are unregistered there. Measured before
// this route existed, the archive this script built was 1,927 items with **zero** Chinese titles, while the rest
// of the site is 55% Chinese. `config.issn` decides which door a source uses; both doors write through the same
// timeline rule, the same ledger and the same queue.
//
// The material is stored with `backfill = "archive"`, which the existing timeline rule turns into
// `timeline_at = published_at`: a paper from March is filed in March rather than arriving as today's news,
// queues behind live work, and founds no event (it is history, not a development). That last clause has one
// exception the site already owns: an item dated within 48 hours of discovery is news (`isHistorical`), so a
// journal issue that came out this morning is treated as today's material — including its priority, which is
// why the current month is walked too. The pipeline afterwards is the site's own — prefilter, two scores,
// writing, structure — nothing here judges anything. The site door stores the title and the issue's date and
// leaves `body_status` at `pending`: jobs/content.ts fetches the article page, because that step already
// knows how to read this journal. It does that only while `COLLECT_ENABLED` is on; with the valve off these
// rows are judged on title alone (the Crossref door at least carries the publisher's abstract).
//
//   node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-10                 # dry run
//   node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-03 --apply \
//     --database-url=postgres://…  --max-items=2000 --per-month=60
//
// Nothing is written without --apply. The ledger keeps the Crossref cursor **after every page**, because the
// useful definition of "resumable" is that a kill -9 costs at most one page, not one slice: the alternative
// writes the cursor only when the loop ends, so any crash, timeout or Ctrl-C restarts the month from zero and
// re-presents work the pipeline has already been paid for.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { looksZh } from "@aihot/backend/editorial/writing";
import { guardedFetch, DEFAULT_UA } from "@aihot/backend/lib/http-fetch";
import { backIssues, issueArticles, type SiteIssue } from "@aihot/backend/sources/archive-site";
import { daysInMonth } from "@aihot/backend/sources/dates";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";
import { beijingDate } from "@aihot/contracts/time";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-01" },
    to: { type: "string", default: "" },
    source: { type: "string", default: "" },
    "max-items": { type: "string", default: "2000" },
    "per-month": { type: "string", default: "60" },
    "per-page": { type: "string", default: "100" },
    // Crossref rate-limits the anonymous pool hard (429 within a couple of requests at 300 ms). One second
    // per page is what the polite-pool guidance asks for without a contact address; set CROSSREF_MAILTO and
    // lower --sleep if the operator gives one.
    sleep: { type: "string", default: "1200" },
    apply: { type: "boolean", default: false },
    "database-url": { type: "string", default: "" },
  },
});

const fromMonth = values.from!;
const toMonth = values.to || fromMonth;
if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) {
  console.error("用法：--from=YYYY-MM --to=YYYY-MM [--apply --database-url=…] [--max-items=N] [--per-month=N]");
  process.exit(2);
}
// Same guard every other operator script carries: the pool reads DATABASE_URL from the environment, so the
// parameter cannot redirect anything — it exists to catch "you aimed --apply at the wrong database".
const target = String(process.env.DATABASE_URL ?? "");
const sameTarget = (u: string) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
if (values.apply && !values["database-url"]) {
  console.error("--apply 必须同时显式给出 --database-url=（与进程 DATABASE_URL 同一个库）");
  await closeDb();
  process.exit(2);
}
if (values.apply && sameTarget(values["database-url"]!) !== sameTarget(target)) {
  console.error(`--apply 拒绝执行：--database-url 指向 ${sameTarget(values["database-url"]!)}，环境里的 DATABASE_URL 是 ${sameTarget(target)}`);
  await closeDb();
  process.exit(2);
}
// 三个数字参数都要是**正有限数**：`--max-items=abc` 会静默变成 NaN，而 NaN 的每一次比较都是 false——
// 站点门会当成"没有上限"（跑到天荒地老），Crossref 门的内层判据 `localSeen < NaN` 也恒 false，切片
// 一条不写还永远停在 pending。这种"参数打错字=进程静默走错路"的入口，宁可当场拒绝。
const positive = (raw: string | undefined, fallback: number, flag: string) => {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} 需要一个正数（给的是「${raw}」）。`);
    process.exit(2);
  }
  return n;
};
const MAX_ITEMS = positive(values["max-items"], 2000, "--max-items");
const PER_MONTH = positive(values["per-month"], 60, "--per-month");
const PER_PAGE = Math.min(500, positive(values["per-page"], 100, "--per-page"));
const SLEEP = Math.max(0, Number(values.sleep));
const onlyIds = values.source!.split(",").map((s) => s.trim()).filter(Boolean);

function months(): string[] {
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ey, em] = toMonth.split("-").map(Number);
  for (let guard = 0; guard < 240; guard++) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    if (y === ey && m === em) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const sliceRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(y!, m!)).padStart(2, "0")}` };
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
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A date the publisher actually stated, or none. Two things are refused here, and both are about honesty
 * rather than tidiness:
 *  - year-only or year-month records: a day would be invented, and the reader sees it as the paper's date;
 *  - impossible days (2026-04-31, month 13). `new Date(Date.UTC(…))` silently *rolls* those into the next
 *    month, and a rolled date past today makes decideTimeline drop publishedAt altogether — which leaves
 *    timeline_at at the discovery moment, i.e. an "archive" item that surfaces in today's paper.
 */
function statedDate(w: Work): Date | null {
  for (const parts of [w.published?.["date-parts"], w.issued?.["date-parts"]]) {
    const [y, mo, d] = parts?.[0] ?? [];
    if (!y || !mo || !d || y < 1900 || mo < 1 || mo > 12) continue;
    const lastDay = daysInMonth(y, mo);
    if (d < 1 || d > lastDay) continue;
    const date = new Date(Date.UTC(y, mo - 1, d, 12));
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

/** `null` means "do not advance this slice": an error, a timeout or anything we cannot read. */
async function page(url: string): Promise<{ items: Work[]; next: string | null } | null> {
  let res;
  try {
    res = await guardedFetch(url, { headers: { accept: "application/json", "user-agent": DEFAULT_UA }, timeoutMs: 45_000 });
  } catch (error) {
    console.error(`  crossref request failed: ${(error as Error).name} ${(error as Error).message?.slice(0, 80)}`);
    return null;
  }
  if (res.status === 429 || res.status >= 500) {
    console.error(`  crossref ${res.status}, backing off`);
    await new Promise((r) => setTimeout(r, 15_000));
    return null;
  }
  // A 400 is Crossref refusing the query, not an empty month. Reading it as "nothing more here" would mark
  // the slice done and retire it from every future run.
  if (res.status !== 200) {
    console.error(`  crossref HTTP ${res.status} — 这片保持 pending`);
    return null;
  }
  let message: { items?: Work[]; "next-cursor"?: string } | undefined;
  try {
    message = (JSON.parse(res.text()) as { message?: typeof message }).message;
  } catch {
    console.error("  crossref 返回的不是 JSON");
    return null;
  }
  return { items: message?.items ?? [], next: message?.["next-cursor"] ?? null };
}

const sources = (await sql<SourceRow[]>`
  SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count FROM sources
  WHERE enabled AND (coalesce(config->>'issn', '') <> '' OR coalesce(config->>'archiveIndexUrl', '') <> '')
  ORDER BY id`).filter((s) => !onlyIds.length || onlyIds.includes(s.id));
if (sources.length === 0) {
  console.error("没有一条信源带 config.issn 或 config.archiveIndexUrl — 前者跑 scripts/archive-issn.ts 并把结果并进 industry/sources.json，后者见 sources/archive-site.ts。改完再同步进库。");
  await closeDb();
  process.exit(1);
}
// Crossref's polite pool wants a contact address; without one the requests still work, just in the shared
// anonymous pool. It is the operator's address to give, so it comes from the environment and is never invented.
const mailto = process.env.CROSSREF_MAILTO?.trim();
const siteCount = sources.filter((s) => !s.config.issn).length;
console.log(`${sources.length} 条带档案门的信源（Crossref ${sources.length - siteCount} 条｜期刊自己的过刊索引 ${siteCount} 条），月份 ${fromMonth}..${toMonth}，本轮上限 ${MAX_ITEMS} 条${values.apply ? "" : "（DRY-RUN：不写库）"}`);

let stored = 0;
let judged = 0;
let noDate = 0;
let thin = 0;
let duplicate = 0;

/**
 * A journal's back-issue index, read once per run. It lists every issue the journal has ever published
 * (measured: 331 for 《地理研究》, 1982 onward) and the month loop visits ten of them, so re-reading it per
 * month would cost ten fetches of the same page. `null` is kept in the cache too: an index that could not be
 * read stays unread for the rest of the run rather than being dialed once per month.
 */
const issueIndex = new Map<string, SiteIssue[] | null>();

async function siteIndex(source: SourceRow): Promise<SiteIssue[] | null> {
  if (issueIndex.has(source.id)) return issueIndex.get(source.id)!;
  let issues: SiteIssue[];
  try {
    issues = await backIssues(source);
  } catch (error) {
    console.error(`  ${(error as Error).message.slice(0, 140)}`);
    issueIndex.set(source.id, null);
    return null;
  }
  const undated = issues.filter((i) => !i.at).length;
  console.log(`  过刊索引 ${issues.length} 期${undated ? `，其中 ${undated} 期在索引上没有日期，跳过` : ""}`);
  issueIndex.set(source.id, issues);
  return issues;
}

/**
 * One (source, month) slice read off the journal's own index. The Crossref door's rules apply unchanged — the
 * timeline comes from the issue's date, an article the live collector already stored is not stored twice, and
 * the pipeline is handed the work rather than this script judging anything.
 *
 * The slice only closes for a month the calendar has left. The index lists an issue as soon as the journal
 * posts it, so marking the month this run falls in `done` would freeze the month at whatever had been
 * published so far and retire it from every later run.
 */
/**
 * Give an already-stored row the date its own issue states, when it has none.
 *
 * The live table-of-contents of these journals prints no per-article date, so the first import files each
 * item as `undated` — `decideTimeline` sets `published_at` NULL and `backfill_reason = 'undated'`, and
 * `candidates()` keeps every non-archive backfill out of the papers. The archive walk is the only writer
 * that knows the issue's date, and it meets those rows as duplicates (`identity_key` is the URL), so without
 * this they would stay dateless and unpublishable for good (measured 2026-10-10: the twelve 地理学报 items
 * the live poll had already taken were exactly that). Only a row with `published_at IS NULL` is touched: a
 * date the journal already stated is never overwritten.
 *
 * `publications` carries its own copy of `published_at`/`timeline_at` and is what `candidates()` reads — an
 * article-only update left the projection dateless, so a row stamped *after* it had been published still
 * could not enter its own day's paper until something re-projected it (measured 2026-10-10: 0 rows were in
 * that state, the twelve having been stamped before their first projection, but the gap was one ordering
 * away from biting). Both tables move together here.
 */
async function stampIssueDate(articleId: string, at: Date): Promise<number> {
  if (!values.apply) {
    const rows = await sql<{ id: string }[]>`SELECT id FROM articles WHERE id = ${articleId} AND published_at IS NULL`;
    return rows.length;
  }
  return await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE articles SET published_at = ${at}, timeline_at = ${at}, backfill_reason = 'archive', updated_at = now()
       WHERE id = ${articleId} AND published_at IS NULL RETURNING id`;
    if (rows.length === 0) return 0;
    await tx`UPDATE publications SET published_at = ${at}, timeline_at = ${at}, updated_at = now()
              WHERE article_id = ${articleId} AND published_at IS NULL`;
    return rows.length;
  });
}

async function runSiteSlice(source: SourceRow, month: string): Promise<void> {
  const [ledger] = await sql<{ status: string }[]>`SELECT status FROM archive_ingest WHERE source_id = ${source.id} AND month = ${month}`;
  if (ledger?.status === "done") return;
  console.log(`${source.id} ${month} 过刊 ${String(source.config.archiveIndexUrl)}`);
  if (values.apply) {
    await sql`INSERT INTO archive_ingest (source_id, month, status, updated_at) VALUES (${source.id}, ${month}, 'running', now())
              ON CONFLICT (source_id, month) DO UPDATE SET status = 'running', updated_at = now()`;
  }
  const issues = await siteIndex(source);
  const dated = (i: SiteIssue): i is SiteIssue & { at: Date } => !!i.at;
  const slice = (issues ?? []).filter(dated).filter((i) => beijingDate(i.at).slice(0, 7) === month);
  let localSeen = 0;
  let localNew = 0;
  let localDup = 0;
  let localFixed = 0;
  // "a page we could not read" and "a page with nothing on it" are different answers, and only the first may
  // close a slice — the same rule the Crossref door runs on. `cut` is the third way a slice is not finished:
  // --max-items or --per-month stopped us before the last issue (or the last item of one). Without it a
  // truncated month would be written `done`, and the issues it never read would be retired forever — the
  // Crossref door cannot make that mistake because its `done` requires an exhausted cursor.
  //
  // The budget counts items **stored**, not items read. Counting reads made a monthly slice unclosable and
  // hid the back half of every issue: a 16–21-article issue hits a 12-item cap mid-issue, the month stays
  // pending, and the rerun spends the same 12 slots on the very items it stored last time (measured
  // 2026-10-10 against the seven Chinese journals — 12 of 19 read, the rest unreachable forever).
  let failed = issues === null;
  let cut = false;
  // An issue whose cover date has not arrived yet is not this run's to file: `decideTimeline` discards a
  // published date more than an hour ahead, and an archive row with no date is excluded from every paper by
  // the read layer's archive branch. Reading it next month, when the date has come, is the whole point of
  // leaving the slice open.
  const now = new Date();
  let aheadOfClock = false;
  for (const issue of slice) {
    if (localNew >= PER_MONTH || stored >= MAX_ITEMS) { cut = true; break; }
    if (issue.at.getTime() > now.getTime()) { aheadOfClock = true; continue; }
    let items: Array<Candidate & { publishedAt: Date }>;
    try {
      items = await issueArticles(source, issue);
    } catch (error) {
      console.error(`  ${issue.url} 读不到：${(error as Error).message.slice(0, 100)} — 这一期不算跑完`);
      failed = true;
      continue;
    }
    if (SLEEP) await new Promise((r) => setTimeout(r, SLEEP));
    for (const [n, c] of items.entries()) {
      if (localNew >= PER_MONTH || stored >= MAX_ITEMS) { if (n < items.length) cut = true; break; }
      localSeen++;
      const urlKey = identityKeyForUrl(c.url);
      if (urlKey) {
        // 只认本来源自己的那一行：同一个 URL 也可能先被别的来源收进来（Crossref 门与站点门就错开 `doi:` 与
        // URL 两种身份），给别人的行盖章等于拿这本刊的刊期去改另一条来源的日期。Crossref 门那处**不能**这样收窄：
        // 它查的是"这个 URL 是否已经以另一种身份在库里"，收窄了就会把同一篇存两遍。
        const [twin] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${urlKey} AND source_id = ${source.id}`;
        if (twin) { duplicate++; localDup++; localFixed += await stampIssueDate(twin.id, c.publishedAt); continue; }
      }
      if (values.apply) {
        const { articleId, created } = await upsertMaterial({
          sourceId: source.id,
          url: c.url,
          title: c.title,
          language: looksZh(c.title) ? "zh" : "en",
          publishedAt: c.publishedAt,
          bodyStatus: "pending",
          via: "import",
          backfill: "archive",
          raw: { _geohot: { site: { issue: issue.url } } },
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
  }
  if (!values.apply) {
    if (cut || aheadOfClock) console.log(`  （这一片还没读完：${cut ? "被上限截断" : ""}${aheadOfClock ? "有期次的刊日期尚未到来" : ""}）`);
    console.log(`  （DRY-RUN：会入库 ${localNew} 条${localFixed ? `、给 ${localFixed} 条已存在但没有日期的条目补上刊期` : ""}）`);
    return;
  }
  const closed = month < beijingDate(new Date()).slice(0, 7);
  const finished = !failed && !cut && !aheadOfClock && closed;
  // `no-date` belongs in the ledger, not only in the log line: an index that stopped printing dates yields an
  // empty month that looks exactly like a month the journal did not publish, and `done` would then be a lie
  // written once and never revisited.
  const undated = (issues ?? []).filter((i) => !i.at).length;
  await sql`UPDATE archive_ingest SET status = ${finished ? "done" : "pending"},
            note = ${`issues=${slice.length} dup=${localDup} fixed=${localFixed} no-date=${undated}${cut ? " cut" : ""}${aheadOfClock ? " ahead" : ""}`},
            items = ${localNew}, seen = ${localSeen}, updated_at = now()
            WHERE source_id = ${source.id} AND month = ${month}`;
  console.log(`  ${finished ? "done" : closed ? `停在原地${cut ? "（被上限截断）" : ""}${aheadOfClock ? "（有期次未到刊日期）" : ""}` : "本月未过完，下次再跑"} 看了 ${localSeen} 条，入库 ${localNew} 条${localFixed ? `，补日期 ${localFixed} 条` : ""}`);
}

for (const month of months()) {
  if (stored >= MAX_ITEMS) break;
  const { start, end } = sliceRange(month);
  for (const source of sources) {
    if (stored >= MAX_ITEMS) break;
    const issn = String(source.config.issn ?? "");
    if (!issn) {
      await runSiteSlice(source, month);
      continue;
    }
    const [ledger] = await sql<{ status: string; cursor: string | null }[]>`
      SELECT status, cursor FROM archive_ingest WHERE source_id = ${source.id} AND month = ${month}`;
    if (ledger?.status === "done") continue;
    let cursor = ledger?.cursor ?? "*";
    let localSeen = 0;
    let localNew = 0;
    let localNoDate = 0;
    let localThin = 0;
    let localDup = 0;
    if (values.apply) {
      await sql`INSERT INTO archive_ingest (source_id, month, cursor, status, updated_at) VALUES (${source.id}, ${month}, ${cursor === "*" ? null : cursor}, 'running', now())
                ON CONFLICT (source_id, month) DO UPDATE SET status = 'running', updated_at = now()`;
    }
    console.log(`${source.id} ${month} issn=${issn}${cursor !== "*" ? " (续)" : ""}`);
    // stopped_on_error keeps "no more pages" apart from "we could not read this page"; only the first one
    // may mark a slice done.
    let stoppedOnError = false;
    // 预算（--per-month / --max-items）在游标耗尽前先停，这一片同样不算跑完。**游标只有整页读完才往前推**：
    // 以前内层 break 之后照样写 `next`，于是被截断那一页的尾部（默认 --per-page=100、--per-month=60 时是
    // 40 条）永远不会被再读——切片还会判 `done`，那批条目就永久丢了。停在本页重读时，已入库的条目按重复
    // 跳过、不再吃 --per-month（与站点门同一条规矩），所以下一轮会接着这条缝往下走。
    let cut = false;
    for (let pages = 0; cursor && localNew < PER_MONTH && stored < MAX_ITEMS && pages < 12; pages++) {
      const url = `https://api.crossref.org/works?rows=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
        + `&filter=type:journal-article,issn:${issn},from-pub-date:${start},until-pub-date:${end}`
        + `&select=DOI,title,container-title,abstract,URL,author,published,issued${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ""}`;
      const res = await page(url);
      if (!res) { stoppedOnError = true; break; }
      // 空页是 Crossref 说"没有了"的正常方式——**前提是它同时也没给 next-cursor**。给了游标却一条不给
      // 是一次读坏了的答案，按"停在这一页"处理：否则一个 200 的空壳就把这个月剩下的都退休掉。
      if (res.items.length === 0) {
        if (res.next) { console.error("  这一页一条都没给却带着 next-cursor，停在原地而不是判它跑完"); stoppedOnError = true; break; }
        cursor = "";
        break;
      }
      // A page without a next cursor is a Crossref answer we cannot resume from, not an exhausted slice.
      const next = res.next;
      if (!next && res.items.length >= PER_PAGE) {
        console.error("  这一页没有 next-cursor，停在原地而不是判它跑完");
        stoppedOnError = true;
        break;
      }
      let wholePage = true;
      for (const w of res.items) {
        if (localNew >= PER_MONTH || stored >= MAX_ITEMS) { wholePage = false; break; }
        localSeen++;
        const title = (w.title?.[0] ?? "").trim();
        const at = statedDate(w);
        if (!title || !at) { noDate++; localNoDate++; continue; }
        const body = w.abstract ? plainText(w.abstract) : "";
        // An abstract under ~80 characters is a heading, not something an editor can judge; those records
        // stay out rather than being written up from a title.
        if (body.length < 80) { thin++; localThin++; continue; }
        judged++;
        // A paper this journal already sent through its own feed has a URL identity, not a `doi:` one, so
        // upsertMaterial would not see it as the same article. Check the URL form first and skip: the live
        // record is the one with the full text.
        const urlKey = identityKeyForUrl(w.URL || `https://doi.org/${w.DOI}`);
        if (urlKey) {
          const [twin] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${urlKey}`;
          if (twin) { duplicate++; localDup++; continue; }
        }
        if (values.apply) {
          const first = w.author?.[0];
          const { articleId, created } = await upsertMaterial({
            sourceId: source.id,
            url: w.URL || `https://doi.org/${w.DOI}`,
            title,
            identityKey: `doi:${w.DOI.toLowerCase()}`,
            author: first?.family ?? first?.name ?? null,
            language: looksZh(title) ? "zh" : "en",
            publishedAt: at,
            bodyText: body,
            bodyStatus: "ok",
            via: "import",
            backfill: "archive",
            raw: { _geohot: { crossref: { doi: w.DOI, container: w["container-title"]?.[0] ?? null } } },
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
      if (!wholePage) { cut = true; break; }
      cursor = next ?? "";
      // Persist after every page: a kill -9 costs this page, not the month.
      if (values.apply) {
        await sql`UPDATE archive_ingest SET cursor = ${cursor || null}, seen = ${localSeen}, items = ${localNew}, updated_at = now()
                  WHERE source_id = ${source.id} AND month = ${month}`;
      }
      if (SLEEP) await new Promise((r) => setTimeout(r, SLEEP));
    }
    if (!values.apply) continue;
    // 循环因预算或页数上限退出而游标还在 = 没跑完（两种都不写 done）。
    if (cursor && !stoppedOnError) cut = true;
    const finished = !cursor && !stoppedOnError && !cut;
    // Per-slice, not cumulative: this string is written into the ledger row, and the cumulative version
    // printed the same 18 on every source after the first one that had skipped anything.
    const note = `no-date=${localNoDate} thin=${localThin} dup=${localDup}${cut ? " cut" : ""}`;
    await sql`UPDATE archive_ingest SET status = ${finished ? "done" : "pending"}, cursor = ${finished ? null : cursor || null},
              note = ${note}, updated_at = now()
              WHERE source_id = ${source.id} AND month = ${month}`;
    console.log(`  ${finished ? "done" : `停在原地${cut ? "（被上限截断）" : ""}`} 看了 ${localSeen} 条，入库 ${localNew} 条`);
  }
}

if (stored >= MAX_ITEMS) console.log(`本轮到达上限 ${MAX_ITEMS} 条，剩下的下轮接着跑。`);
console.log(`${values.apply ? "已入库" : "DRY-RUN 将入库"} ${stored} 条（可判 ${judged} 条｜无整日期 ${noDate}｜摘要过短 ${thin}｜与实时重复 ${duplicate}）`);
await closeDb();
