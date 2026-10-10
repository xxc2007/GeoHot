// The archive rule: material ingested from the scholarly record belongs to the issue of the day it was
// published — and to no other issue. Both halves need a gate. Recomposing a January edition is the point of
// the backfill, but 20,000 January papers surfacing in tonight's daily because they were *released* tonight
// would be a silent rewrite of what "today's paper" means.
import { stub, tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { reportIndexRows } from "@aihot/backend/publication/reports";
import { candidates, composeDaily, composeMonthly, composeWeekly, DAILY_DEDUPE_DAYS, editionsAhead } from "@aihot/backend/reports/compose";
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";

const T = tag();
const SOURCE = `test-archive-paper-${T}`;
// A private six-day window in the past, so a rerun or another writer's leftovers cannot move these edges.
let windowSeed = 0;
for (const ch of T) windowSeed = (windowSeed * 31 + ch.charCodeAt(0)) % 1461;
const DAY0 = Date.UTC(2020, 0, 1 + windowSeed);
const at = (day: number, h = 12) => new Date(DAY0 + day * 86_400_000 + h * 3_600_000);
/** The archive arrives on day 5; its own day is day 0. */
const ARCHIVE_DAY = at(0);
const ARRIVED_DAY = at(5);
/**
 * The three editions that day's material belongs to. The moment matters: `composeDaily(D)` gathers
 * [D-1 08:00, D 08:00) Beijing, so a paper stamped 09:00 Beijing belongs to D+1's edition, not D's —
 * 23:00Z is 07:00 here, and it sits inside the paper named by the Beijing date it falls on.
 */
const ARCHIVE_MORNING = at(0, 23);
const DAY_KEY = beijingDate(ARCHIVE_MORNING);
const WEEK_KEY = isoWeekLabel(DAY_KEY);
const MONTH_KEY = DAY_KEY.slice(0, 7);
/** The next day's edition, printed first so the run already has a number. */
const NEXT_KEY = addDays(DAY_KEY, 1);

// Laying out an issue asks the editor for its 导语 / 总述 / 主题, so the stub answers in the shape both the
// daily and the period prompt ask for. Whether the prose is signed is a different test's business; here the
// question is whether the archived paper is in the printed edition at all.
const provider = await stub(() => ({
  id: `archive-paper-${T}`,
  choices: [{ message: { content: JSON.stringify({ title: "测试导语", leadParagraph: "测试本期摘要。".repeat(20), highlights: [1], headline: "测试期次", overview: "测试本期摘要。".repeat(20), themes: [{ heading: "学科", summary: "测试主题提要", refs: [1] }] }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.REPORT_MODEL = "deepseek-flash";

interface Seeded {
  articleId: string;
  backfill: boolean;
  reason: string | null;
  timeline: Date;
  visibleAfter: Date;
}

async function seed(label: string, publishedAt: Date | null, discoveredAt: Date, explicit: string | null): Promise<Seeded> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/archive-paper-${T}-${label}`,
    title: `Archive paper rule ${label}`,
    bodyText: `Abstract text for ${label}. `.repeat(6),
    bodyStatus: "ok",
    publishedAt,
    discoveredAt,
    via: "import",
    backfill: explicit,
  });
  const [row] = await sql<{ backfill_reason: string | null; timeline_at: Date }[]>`
    SELECT backfill_reason, timeline_at FROM articles WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'geotech', ${`标题 ${label}`}, ${`摘要 ${label} 的中文提要。`}, 90, true)`;
  const published = await publishArticle(articleId, { now: ARRIVED_DAY, releasedAt: ARRIVED_DAY });
  assert.equal(published?.selected, true, `${label} should have been selected`);
  const [pub] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${articleId}`;
  return { articleId, backfill, reason: row!.backfill_reason, timeline: row!.timeline_at, visibleAfter: pub!.visible_after };
}

/** The two editions `editionsAhead` is measured against: the last inside its window and the first outside. */
const AHEAD_IN = addDays(DAY_KEY, DAILY_DEDUPE_DAYS);
const AHEAD_OUT = addDays(DAY_KEY, DAILY_DEDUPE_DAYS + 1);

async function dropPeriods() {
  const keys = [DAY_KEY, NEXT_KEY, AHEAD_IN, AHEAD_OUT];
  await sql`DELETE FROM report_revisions WHERE report_id IN (
    SELECT id FROM reports WHERE (kind = 'daily' AND key = ANY(${keys}::text[])) OR (kind = 'weekly' AND key = ${WEEK_KEY}) OR (kind = 'monthly' AND key = ${MONTH_KEY}))`;
  await sql`DELETE FROM reports WHERE (kind = 'daily' AND key = ANY(${keys}::text[])) OR (kind = 'weekly' AND key = ${WEEK_KEY}) OR (kind = 'monthly' AND key = ${MONTH_KEY})`;
}

before(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE ${"test-archive-paper-%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${"test-archive-paper-%"}`;
  await dropPeriods();
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Archive paper test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await dropPeriods();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("archive material is filed under its own day, and never under the day it arrived", async () => {
  const archive = await seed("archive", ARCHIVE_DAY, ARRIVED_DAY, "archive");
  assert.equal(archive.backfill, true);
  assert.equal(archive.reason, "archive");
  assert.equal(archive.timeline.toISOString(), ARCHIVE_DAY.toISOString(), "an archive item keeps its own publication moment");
  assert.equal(archive.visibleAfter.toISOString(), ARRIVED_DAY.toISOString(), "…while being released only now");

  const own = (await candidates(at(0), at(1))).map((c) => c.itemId);
  assert.ok(own.includes(archive.articleId), "the January issue is made of January material");

  const arrival = (await candidates(at(5), at(6))).map((c) => c.itemId);
  assert.ok(!arrival.includes(archive.articleId), "tonight's issue must not fill up with backdated papers");
});

test("a back-dated issue really gets laid out — its day, its week and its month", async () => {
  // The candidate rule above only says the material is eligible. What the owner asked for is that the paper
  // for that day actually comes out, and that the weekly and monthly editions built on the same window carry
  // it too. An archive item whose issue was never composed is a row in a database, not a newspaper.
  const archive = await seed("compose-through", ARCHIVE_MORNING, ARRIVED_DAY, "archive");

  // The 期号 claim needs a printed run to compare against: an edition is numbered unless some already
  // numbered edition carries a later date (`nextIssueNo`), which is how a back-issue avoids renumbering a
  // series readers were already told. So print tomorrow's paper first, then reach back for yesterday's.
  const nextItem = await seed("numbered-edition", at(1, 23), ARRIVED_DAY, "archive");
  assert.ok(nextItem.articleId);
  await composeDaily(NEXT_KEY, "scheduled");
  const numbered = async (key: string) => {
    const rows = await sql<{ issue_no: number | null }[]>`SELECT issue_no FROM reports WHERE kind = 'daily' AND key = ${key}`;
    return rows.length ? rows[0]!.issue_no : "no such report";
  };
  assert.ok(await numbered(NEXT_KEY), "the edition that came out in order got a 期号");

  await composeDaily(DAY_KEY, "archive-backfill");
  await composeWeekly(WEEK_KEY, "archive-backfill");
  await composeMonthly(MONTH_KEY, "archive-backfill");

  const carries = async (kind: string, key: string) => {
    const [row] = await sql<{ content: unknown }[]>`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`;
    return row ? JSON.stringify(row.content).includes(archive.articleId) : false;
  };
  assert.ok(await carries("daily", DAY_KEY), `the ${DAY_KEY} edition should carry the archived paper`);
  assert.ok(await carries("weekly", WEEK_KEY), `${WEEK_KEY} 周报应该带上同一条`);
  assert.ok(await carries("monthly", MONTH_KEY), `${MONTH_KEY} 月报应该带上同一条`);
  assert.equal(await numbered(DAY_KEY), null, "the back-issue takes no 期号 instead of borrowing one out of order");
  assert.ok(await numbered(NEXT_KEY), "…and the numbered edition keeps the number it was printed with");

  // And the reader's archive reaches both, so "出刊" is a fact about the site, not only about a row.
  // A wide limit on purpose: the index page shows the most recent dozen, and a back-issue from a private
  // window in the past would never be among them — that is not the same thing as it not being published.
  const listed = await reportIndexRows("weekly", 5_000);
  assert.ok(listed.some((e) => e.key === WEEK_KEY), "the weekly archive must contain the back-issue");
});

test("ordinary late arrivals keep the attribution they had before the archive existed", async () => {
  // More than 48 h between source time and discovery is `stale-on-discovery`, not an archive import, and it
  // stays out of both windows — that is how today's paper has always behaved, and it must not change.
  const stale = await seed("stale", at(0), at(5), null);
  assert.equal(stale.reason, "stale-on-discovery");
  assert.ok(!(await candidates(at(0), at(1))).some((c) => c.itemId === stale.articleId), "stale material does not join the old issue");
  assert.ok(!(await candidates(at(5), at(6))).some((c) => c.itemId === stale.articleId), "…nor the issue of the day it was found");

  // Live news, found on its own day: unchanged by any of this.
  const live = await seed("live", at(5), at(5), null);
  assert.equal(live.backfill, false);
  assert.ok((await candidates(at(5), at(6))).some((c) => c.itemId === live.articleId), "today's news is still today's paper");
  assert.ok(!(await candidates(at(0), at(1))).some((c) => c.itemId === live.articleId));
});

test("回填补一个已出刊区间中间的空天时，点的就是日报去重那同一个七天窗口", async () => {
  // These four days are editions the tests above have already laid out; this one wants to know exactly which
  // report rows sit in the window, so it replaces them with dated stubs of its own.
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ANY(${[DAY_KEY, NEXT_KEY, AHEAD_IN, AHEAD_OUT]}::text[])`;
  for (const k of [DAY_KEY, NEXT_KEY, AHEAD_IN, AHEAD_OUT]) {
    await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
              VALUES ('daily', ${k}, ${at(0)}, ${at(1)}, ${sql.json({ sections: [], flashes: [] } as never)}, ${at(1)}, 'manual')`;
  }
  // `backfill-papers` walks old→new, so a hole it fills can still sit behind editions that are already out.
  // Which ones, is decided by the same `DAILY_DEDUPE_DAYS` the composition's own lookback uses: if the two
  // numbers ever drift apart the runner would warn about editions that cannot repeat anything, and stay
  // silent about the ones that can.
  assert.deepEqual(await editionsAhead("daily", DAY_KEY), [NEXT_KEY, AHEAD_IN].sort(), "窗口内的期次要点名，窗口外的不该算进来");
  assert.deepEqual(await editionsAhead("daily", AHEAD_OUT), [], "它后面七天没有期次，补它不需要重排谁");
});
