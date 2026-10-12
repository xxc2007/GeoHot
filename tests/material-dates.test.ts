// 时间水位：没有日期的材料不能占据「今天」。
// 2026-10-03 实测：首页与 /all 里有 49 张卡片用发现时间当成了内容时间，其中几条是 2019 年的页面内容；
// 原因是非首次导入、又没有日期的材料走 decideTimeline(claimed=null, …, explicitBackfill=null)，
// backfill=false、timelineAt=发现时刻。这里把规则钉下来：无日期 ⇒ 历史（可读可检索，不进今天、不成立事件），
// 而后来才拿到日期的条目必须把日期存住（coalesce），不能被下一次空值覆盖。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { decideTimeline, isHistorical, upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `${T}-dates`;
const HOUR = 3600_000;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, ${`时间水位源 ${T}`}, 'rss', '2100-01-01')`;
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("首轮导入里的无日期条目仍是首轮导入（规则不变）", () => {
  const now = new Date();
  const d = decideTimeline(null, now, "first-import");
  assert.equal(d.backfillReason, "first-import");
  assert.equal(d.timelineAt.getTime(), now.getTime());
});

test("之后的轮次里，无日期条目按历史处理", () => {
  const now = new Date();
  const d = decideTimeline(null, now, null);
  assert.equal(d.backfill, true, "无日期不能算今天的新料");
  assert.equal(d.backfillReason, "undated");
  assert.equal(isHistorical({ backfill: true, published_at: null, discovered_at: now }), true, "不进事件");
});

test("有日期的迟到条目照旧判 stale-on-discovery，正常条目不变", () => {
  const now = new Date();
  const late = new Date(now.getTime() - 72 * HOUR);
  const stale = decideTimeline(late, now, null);
  assert.equal(stale.backfillReason, "stale-on-discovery");
  assert.equal(stale.timelineAt.getTime(), late.getTime(), "迟到条目按来源时间入史");
  const fresh = new Date(now.getTime() - 2 * HOUR);
  const d = decideTimeline(fresh, now, null);
  assert.equal(d.backfill, false);
  // 非 backfill 的条目，timeline_at 记的是「我们把它放进时间线的那一刻」，这是既有设计（不是来源时间）。
  assert.equal(d.timelineAt.getTime(), now.getTime());
  assert.equal(d.publishedAt?.getTime(), fresh.getTime(), "而来源时间照原样保留");
});

test("后来才拿到的日期会被存住，且不被空值覆盖", async () => {
  const url = `https://example.com/${T}-late-date`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: `无日期材料 ${T}`, bodyText: "第一版。", via: "fetch" });
  const [before] = await sql<{ published_at: Date | null; backfill: boolean }[]>`SELECT published_at, backfill FROM articles WHERE id = ${first.articleId}`;
  assert.equal(before!.published_at, null);
  assert.equal(before!.backfill, true, "首次出现时无日期 ⇒ 历史");

  const seen = new Date(Date.now() - 5 * HOUR);
  await upsertMaterial({ sourceId: SOURCE, url, title: `无日期材料 ${T}`, bodyText: "第二版。", publishedAt: seen, via: "fetch" });
  const [after] = await sql<{ published_at: Date | null }[]>`SELECT published_at FROM articles WHERE id = ${first.articleId}`;
  assert.equal(after!.published_at?.getTime(), seen.getTime(), "发现日期要落库");

  await upsertMaterial({ sourceId: SOURCE, url, title: `无日期材料 ${T}`, bodyText: "第三版。", via: "fetch" });
  const [again] = await sql<{ published_at: Date | null }[]>`SELECT published_at FROM articles WHERE id = ${first.articleId}`;
  assert.equal(again!.published_at?.getTime(), seen.getTime(), "空值不能覆盖已知道的日期");
});

// 上面那条走的是"正文变了 ⇒ 新版本"那条路，所以它测不到真正漏掉的那一支：列表页**一字未改**、
// 只是这一次把日期给出来了。生产上这一支会永久卡死条目——`reports/compose.ts` 要求
// `published_at IS NOT NULL`，而这条既已付费判过，就再也进不了任何一天的报纸。
// （2026-10-12 实测：web-pric-news 60 行里 45 行、web-spacemapper-news 108 行里 76 行、
// web-chxb-toc 23 行里 20 行是 `undated`；库里那一行从 10-04 到 10-12 一直没被补上日期。）
test("内容一字未变、只是这次给了日期：日期要补上，且不起新版本、不改时间线、不再排队分析", async () => {
  const url = `https://example.com/${T}-unchanged-got-date`;
  const first0 = (await upsertMaterial({ sourceId: SOURCE, url, title: `一字未变 ${T}`, bodyText: "同一版正文。", via: "fetch" })).articleId;
  const [before] = await sql<{ published_at: Date | null; timeline_at: Date; backfill: boolean; revision: number; processing_state: string }[]>`
    SELECT published_at, timeline_at, backfill, revision, processing_state FROM articles WHERE id = ${first0}`;
  assert.equal(before!.published_at, null, "前置条件：首次没有日期");
  assert.equal(before!.backfill, true, "前置条件：无日期 ⇒ 归历史");

  const seen = new Date(Date.now() - 9 * HOUR);
  await upsertMaterial({ sourceId: SOURCE, url, title: `一字未变 ${T}`, bodyText: "同一版正文。", publishedAt: seen, via: "fetch" });
  const [after] = await sql<{ published_at: Date | null; timeline_at: Date; backfill: boolean; revision: number; processing_state: string }[]>`
    SELECT published_at, timeline_at, backfill, revision, processing_state FROM articles WHERE id = ${first0}`;
  assert.equal(after!.published_at?.getTime(), seen.getTime(), "补上的日期必须落库，否则这条永远进不了当日池子");
  assert.equal(after!.revision, before!.revision, "补日期不是新内容版本：不能把已判过的条目重新推回队列");
  assert.equal(after!.processing_state, before!.processing_state, "也不改判定状态");
  assert.equal(after!.timeline_at.getTime(), before!.timeline_at.getTime(), "归哪一天沿用既有决定，不在这里悄悄挪动历史");
});
