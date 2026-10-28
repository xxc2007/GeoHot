import { gate, purgeTagged, stub, tag } from "./setup.ts";
// A selected item released across the 08:00 boundary must appear in the next issue exactly once.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, publishArticleTx } from "@aihot/backend/publication/publish";
import { candidates, composeDaily } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `test-report-boundary-${T}`;
/**
 * Each run composes its own private seven-day window. These assertions read which items a section carried,
 * and two rules in reports/compose.ts make a section depend on everything else in the same Beijing day:
 * `list.length < 8` keeps the first eight items of a section and demotes the rest to flashes (compose.ts:150),
 * and `recentlyCovered` drops any fact key an earlier issue of that key already ran. So rows left in the
 * window — by a rerun, by a run aborted before its `after`, or by any other writer of those dates — push
 * this run's own boundary items out of the sections being read. Measured on `geohot_gate_test`: twelve
 * extra 精选 rows in the first day's window turn the first assertion below red. The deletes in `before`
 * still run (they keep a shared database from growing), but the window is what makes the result independent
 * of what a previous run left behind.
 */
let windowSeed = 0;
for (const ch of T) windowSeed = (windowSeed * 31 + ch.charCodeAt(0)) % 1461; // ~4 years of past days: 2020-01-01..2023-12-31
const DAY0 = Date.UTC(2020, 0, 1 + windowSeed);
/** A moment in the window: `day` days after its first day, at h:m:s UTC (00:00Z is the 08:00 Beijing issue boundary). */
const at = (day: number, h = 0, m = 0, s = 0) => new Date(DAY0 + day * 86_400_000 + h * 3_600_000 + m * 60_000 + s * 1_000);
/** The daily issue covering [day, day+1): it is named by its second day, the Beijing date it serves. */
const issue = (day: number) => at(day + 1).toISOString().slice(0, 10);
const ISSUES = [issue(0), issue(1), issue(2), issue(3), issue(4), issue(5)];
/** Facts this file creates by hand (the flash-suppression case needs one); `purgeTagged` cannot reach a fact with no story. */
const flashFacts: number[] = [];
const provider = await stub((hit) => ({
  id: `report-boundary-${T}-${hit}`,
  choices: [{ message: { content: JSON.stringify({ title: "测试导语", leadParagraph: "测试摘要", highlights: [1] }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}));
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";

before(async () => {
  // Clean this family's slate: a run aborted before its `after` leaves 精选 items and issues behind, and the
  // window above only isolates the days, not the source rows a repeat of this same tag would re-use.
  await sql`DELETE FROM articles WHERE source_id LIKE ${"test-report-boundary-%"}`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ANY(${ISSUES}::text[])`;
  await sql`DELETE FROM sources WHERE id LIKE ${"test-report-boundary-%"}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Report boundary test', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await purgeTagged(SOURCE);
  // 手工插入的事实没有 story，`purgeTagged` 顺着 stories 找不到它；报道行删掉了，事实本体要自己收走。
  if (flashFacts.length > 0) await sql`DELETE FROM facts WHERE id = ANY(${flashFacts}::bigint[])`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ANY(${ISSUES}::text[])`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function analyzed(label: string, timelineAt: Date): Promise<string> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/report-boundary-${T}-${label}`,
    title: `Report boundary ${label}`,
    bodyText: `完整的中文边界测试正文 ${label}`,
    bodyStatus: "ok",
    publishedAt: timelineAt,
    discoveredAt: timelineAt,
    via: "fetch",
  });
  assert.equal(backfill, false);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'geotech', ${`标题 ${label}`}, ${`摘要 ${label}`}, 90, true)`;
  return articleId;
}

async function selected(label: string, timelineAt: Date, releasedAt: Date): Promise<string> {
  const articleId = await analyzed(label, timelineAt);
  const published = await publishArticle(articleId, { now: new Date(releasedAt), releasedAt: new Date(releasedAt) });
  assert.equal(published?.selected, true);
  return articleId;
}

test("reports assign delayed and boundary releases to the period readers first see them", async () => {
  const onTime = await selected("on-time", at(0, 23, 58), at(0, 23, 59));
  const delayed = await selected("delayed", at(0, 23, 59), at(1, 0, 2));
  const atBoundary = await selected("at-boundary", at(0, 23, 59), at(1, 0, 0));
  const groupedBefore = await analyzed("grouped-before", at(0, 23, 58));
  await publishArticle(groupedBefore, { now: at(0, 23, 58) });
  await sql`UPDATE articles SET grouped_at = ${at(0, 23, 59)} WHERE id = ${groupedBefore}`;
  await publishArticle(groupedBefore, { now: at(0, 23, 59, 10) });
  const groupedLate = await analyzed("grouped-late", at(0, 23, 58));
  await publishArticle(groupedLate, { now: at(0, 23, 58) }); // gated until 08:01
  await sql`UPDATE articles SET grouped_at = ${at(0, 23, 59, 50)} WHERE id = ${groupedLate}`;
  const boundary = at(1); // 08:00 Beijing: the issue boundary the day before
  const previous = new Set((await candidates(at(0), boundary)).map((c) => c.itemId));

  assert.equal(previous.has(onTime), true);
  assert.equal(previous.has(groupedBefore), true);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(previous.has(id), false);

  await composeDaily(issue(0));
  await publishArticle(groupedLate, { now: at(1, 0, 0, 10) });
  const [release] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${groupedLate}`;
  assert.equal(release!.visible_after.toISOString(), at(1, 0, 0, 10).toISOString());
  const next = new Set((await candidates(boundary, at(2))).map((c) => c.itemId));
  assert.equal(next.has(onTime), false);
  assert.equal(next.has(groupedBefore), false);
  for (const id of [delayed, atBoundary, groupedLate]) assert.equal(next.has(id), true);
  await composeDaily(issue(1));
  const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key = ANY(${[issue(0), issue(1)]}::text[])`;
  const items = (key: string) => new Set(reports.find((r) => r.key === key)!.content.sections.flatMap((s) => s.items.map((i) => i.itemId)));
  assert.equal(items(issue(0)).has(onTime), true);
  assert.equal(items(issue(0)).has(groupedBefore), true);
  assert.equal(items(issue(0)).has(delayed), false);
  assert.equal(items(issue(0)).has(atBoundary), false);
  assert.equal(items(issue(0)).has(groupedLate), false);
  assert.equal(items(issue(1)).has(onTime), false);
  assert.equal(items(issue(1)).has(groupedBefore), false);
  assert.equal(items(issue(1)).has(delayed), true);
  assert.equal(items(issue(1)).has(atBoundary), true);
  assert.equal(items(issue(1)).has(groupedLate), true);
});

/** Observe an actual PostgreSQL lock wait before advancing the clock or releasing the transaction. */
async function waitForBlocked(blocker: number, operation: Promise<unknown>) {
  const deadline = performance.now() + 5_000;
  while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
    if (performance.now() >= deadline) assert.fail("operation did not wait for the held transaction");
    await Promise.race([operation.then(() => assert.fail("operation finished before the held transaction committed")), delay(10)]);
  }
}

for (const lock of ["article", "report snapshot"] as const) {
  test(`a release waiting for the ${lock} lock uses the time after the cutoff`, async (t) => {
    const id = await analyzed(`waiting-${lock}`, at(0, 23, 58));
    await publishArticle(id, { now: at(0, 23, 58) });
    await sql`UPDATE articles SET grouped_at = ${at(0, 23, 59)} WHERE id = ${id}`;
    const acquired = gate<number>();
    const release = gate();
    const holding = sql.begin(async (tx) => {
      if (lock === "article") await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
      else await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      acquired.open(row!.pid);
      await release.promise;
    });
    let publication: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([acquired.promise, holding.then(() => assert.fail("lock holder exited before acquiring its lock"))]);
      t.mock.timers.enable({ apis: ["Date"], now: at(0, 23, 59, 59) });
      publication = publishArticle(id);
      await waitForBlocked(pid, publication);
      t.mock.timers.setTime(at(1, 0, 0, 10).getTime());
      release.open();
      await holding;
      await publication;

      const [published] = await sql<{ visible_after: Date; visible_at: Date }[]>`
        SELECT p.visible_after, l.visible_at FROM publications p JOIN selected_ledger l ON l.article_id = p.article_id
        WHERE p.article_id = ${id} ORDER BY l.seq DESC LIMIT 1`;
      assert.equal(published!.visible_after.toISOString(), at(1, 0, 0, 10).toISOString());
      assert.equal(published!.visible_at.toISOString(), published!.visible_after.toISOString());
      const boundary = at(1);
      assert.equal((await candidates(at(0), boundary)).some((c) => c.itemId === id), false);
      assert.equal((await candidates(boundary, at(2))).some((c) => c.itemId === id), true);
    } finally {
      release.open();
      await Promise.allSettled([holding, publication]);
    }
  });
}

test("daily composition waits for a pre-cutoff release to commit instead of losing it between issues", async (t) => {
  const id = await analyzed("commit-after-cutoff", at(2, 23, 58));
  await publishArticle(id, { now: at(2, 23, 58) });
  await sql`UPDATE articles SET grouped_at = ${at(2, 23, 59)} WHERE id = ${id}`;
  t.mock.timers.enable({ apis: ["Date"], now: at(2, 23, 59, 59) });
  const written = gate<number>();
  const commit = gate();
  const publication = sql.begin(async (tx) => {
    await publishArticleTx(tx, id);
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    written.open(row!.pid);
    await commit.promise;
  });
  let report: ReturnType<typeof composeDaily> | undefined;
  try {
    const pid = await Promise.race([written.promise, publication.then(() => assert.fail("publication exited before the commit gate"))]);
    t.mock.timers.setTime(at(3, 0, 0, 10).getTime());
    report = composeDaily(issue(2));
    await waitForBlocked(pid, report);
    commit.open();
    await publication;
    await report;
    await composeDaily(issue(3));
    const reports = await sql<{ key: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
      SELECT key, content FROM reports WHERE kind = 'daily' AND key = ANY(${[issue(2), issue(3)]}::text[])`;
    const hasItem = (key: string) => reports.find((r) => r.key === key)!.content.sections.some((s) => s.items.some((item) => item.itemId === id));
    assert.equal(hasItem(issue(2)), true);
    assert.equal(hasItem(issue(3)), false);
  } finally {
    commit.open();
    await Promise.allSettled([publication, report]);
  }
});

/** The two lists a stored daily prints, read back from `reports.content`. */
type Edition = { sections: Array<{ items: Array<{ itemId: string }> }>; flashes: Array<{ itemId: string }> };

/**
 * A 快讯 line is something the reader saw, so it has to veto the next issue the way a section item does.
 * The section cap is eight: the day's ninth entry of a section is demoted to 快讯, and an event that only
 * got that line yesterday must not come back today as a full story under a *different* report of the same
 * fact — the day before remembered only the article id, so the archive backfill (283 issues of material in
 * which one event is covered on consecutive days, and a printed edition is not re-laid afterwards) would
 * print the same event twice. Day 1 fills the section so the shared-fact item lands in 快讯; day 2 carries
 * another report of that fact and must not print it.
 */
test("an event that only got a 快讯 line yesterday is not reprinted today as a section story", async () => {
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title) VALUES (${"f-report-flash-" + T}, NULL, ${`Report boundary flash ${T}`}) RETURNING id`;
  const factRow = fact!.id;
  flashFacts.push(factRow);
  // Eight same-category items fill the section (the cap is 8), all of them earlier than the ninth.
  for (let i = 0; i < 8; i++) await selected(`flash-section-${i}`, at(4, i), at(4, i));
  const flashed = await selected("flash-event", at(4, 23), at(4, 23));
  await sql`UPDATE publications SET fact_id = ${factRow} WHERE article_id = ${flashed}`;
  await composeDaily(issue(4));

  const stored = await sql<{ key: string; content: Edition }[]>`
    SELECT key, content FROM reports WHERE kind = 'daily' AND key = ANY(${[issue(4), issue(5)]}::text[])`;
  const read = (key: string) => stored.find((r) => r.key === key)?.content;
  const inSection = (edition: Edition | undefined, id: string) =>
    (edition?.sections ?? []).some((s) => (s.items ?? []).some((i) => i.itemId === id));
  const inFlash = (edition: Edition | undefined, id: string) => (edition?.flashes ?? []).some((f) => f.itemId === id);
  assert.equal(inSection(read(issue(4)), flashed), false, "板块已满 8 条，第九条不该还在板块里");
  assert.equal(inFlash(read(issue(4)), flashed), true, "第九条要作为读者看得见的一条落在快讯里");

  // The next day carries a different report of the same fact, and nothing else.
  const repeat = await selected("flash-event-repeat", at(5, 1), at(5, 1));
  await sql`UPDATE publications SET fact_id = ${factRow} WHERE article_id = ${repeat}`;
  await composeDaily(issue(5));

  const day2 = await sql<{ content: Edition }[]>`SELECT content FROM reports WHERE kind = 'daily' AND key = ${issue(5)}`;
  const printed = day2[0]!.content;
  assert.equal(inSection(printed, repeat), false, "同一个事件昨天只在快讯里露过一次面，今天不能以整篇重印");
  assert.equal(inFlash(printed, repeat), false, "重印也不许藏在快讯里");
});

// 存版导语标题里的指示代词时间词。线上实测过一份 2026-W40（窗口到 10-04）在 10-12 仍印着
// 「本周的 14 件地理大事」：标题是模型写的、存进 `reports.content`，而"本周"指向的是写它那一天。
// 版面自己会从期号算该说本期还是本周，所以存版里出现这类话就该被拒收，而不是等到下一周变成假话。
test("导语标题用了「本周/本月/今日」这一类话时整条拒收", async () => {
  const { unusableLead } = await import("@aihot/backend/reports/compose");
  const ok = { title: "青藏高原东缘滑坡阻断支流形成堰塞湖", leadParagraph: "这次滑坡堵住了岷江的一条支流，形成堰塞湖。" };
  assert.equal(unusableLead(ok), null, "正常标题不该被拒");
  for (const title of ["本周的 14 件地理大事", "本月地理要闻", "今日发生的一次强震", "上周的三条主线"]) {
    assert.match(String(unusableLead({ ...ok, title })), /本周|存版/, `${title} 应当被拒收`);
  }
  // 导语正文不在这条判据里：一段自然的中文里出现"当天"是叙述，不是一个会过期的标签。
  assert.equal(unusableLead({ ...ok, leadParagraph: "本周的救援仍在继续，这是当天最要紧的变化。" }), null);
});
