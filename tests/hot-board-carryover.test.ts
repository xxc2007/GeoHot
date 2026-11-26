import {supportStory,cleanupReaderFixtures} from "./complete-reader-fixture.ts";
// The homepage board survives an empty recompute.
//
// The ranking job runs every five minutes (`hot.rank`). When a recompute finds no event that reached two
// independent participants, `computeHotRanking` used to insert that empty board with `published = true`, and
// `latestHotRanking` reads published rows only — so the block went blank the moment the last qualifying story
// aged out of the 48-hour window, and came back hours later. Measured on production 2026-10-04: 400 boards in
// 72 hours, 127 of them with events in them, and the newest empty one was hiding a board with 4 events behind
// it: the last non-empty board was 10-03 14:55 +0800 with 4 entries, and the 277 boards computed between
// then and this fix going out (10-04 14:06 +0800) were all empty.
//
// Two rules are pinned here:
//  · an empty board is still written (it is the evidence for why nothing qualified) but never published, and
//    the reader keeps the newest board that has events in it;
//  · an entry whose event has since been merged into another one drops out of the board, and the ranks close
//    up — a stale board must not hand the reader a rank pointing at a page that is no longer there.
//
// The read horizon (24 hours, `MAX_BOARD_AGE_HOURS`) is pinned against the source text instead of behaviour:
// the query is global over `hot_rankings`, and a shared development database always holds some fresh row, so
// no fixture can honestly claim "the only board left is this stale one".
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { latestHotRanking, loadHotStrip, type HotEntry } from "@aihot/backend/events/hot-read";
import { loadHot } from "@aihot/backend/publication/stories";

const T = tag();
/** Ahead of every real board, so the shared table cannot pick another row over the fixtures below. */
const AHEAD = new Date("2099-01-01T00:00:00Z");

const storyIds: number[] = [];
const rankingIds: number[] = [];

async function addStory(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, ${AHEAD}, ${AHEAD}) RETURNING id`;
  storyIds.push(row!.id);
  await supportStory(row!.id,T);
  return { id: row!.id, publicId };
}

function entryOf(story: { id: number; publicId: string }, rank: number): HotEntry {
  return {
    rank, storyId: story.id, storyPublicId: story.publicId, title: `热榜承载测试${T}事件${rank}`, heat: 90 - rank,
    trend: "flat", trendPct: 0, badges: [], participantCount: 3, sourceCount: 2, signalCount: 1, reportCount: 4,
    sourceNames: [`测试源${T}A`, `测试源${T}B`, `测试源${T}C`],
    latestAt: AHEAD.toISOString(), firstReportAt: AHEAD.toISOString(),
    representativeItemId: null, representativeUrl: null, representativeSource: null,
    participants: [{ name: `测试源${T}A`, kind: "editorial", tier: "T1" }, { name: `测试源${T}B`, kind: "editorial", tier: "T2" }],
  };
}

/** A board as the reader would see it: stored verbatim, with its own cut-off time. */
async function saveBoard(at: Date, entries: HotEntry[]): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO hot_rankings (computed_at, rule_version, entries, evidence, published)
    VALUES (${at}, 'test-carryover', ${sql.json(entries as never)}, ${sql.json({} as never)}, true) RETURNING id`;
  rankingIds.push(row!.id);
  return row!.id;
}

after(async () => {
  await cleanupReaderFixtures(T);
  if (rankingIds.length) await sql`DELETE FROM hot_rankings WHERE id = ANY(${rankingIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM story_signals WHERE story_id = ANY(${storyIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id = ANY(${storyIds}::bigint[])`;
  await closeDb();
});

test("一张空榜不顶掉最近一张有事件的榜，首页还带上它的截止时间", async () => {
  const stories = [await addStory(`热榜承载测试${T}一`), await addStory(`热榜承载测试${T}二`), await addStory(`热榜承载测试${T}三`)];
  const boardAt = new Date(AHEAD.getTime() - 3600_000);
  await saveBoard(boardAt, stories.map((s, i) => entryOf(s, i + 1)));

  // A far-future `at` puts every signal outside the 48-hour window on any database, so the board comes out
  // empty for the right reason rather than because the fixture beat the real data to a rank.
  const empty = await computeHotRanking(AHEAD);
  rankingIds.push(empty.id);
  const [row] = await sql<{ published: boolean; len: number; evidence: { candidates: number } }[]>`
    SELECT published, jsonb_array_length(entries) AS len, evidence FROM hot_rankings WHERE id = ${empty.id}`;
  assert.equal(Number(row!.len), 0, "空榜照样写库：它是这一小时为什么没事件的证据");
  assert.equal(row!.published, false, "空榜不能成为读者看到的那张榜");
  assert.equal(typeof row!.evidence.candidates, "number", "evidence 里的候选数不能因为改成不发布就丢了");

  const strip = await loadHotStrip();
  assert.ok(strip, "榜还在，块就必须在");
  assert.deepEqual(strip!.entries.map((e) => e.rank), [1, 2, 3], "读者看到的还是上一张有事件的榜");
  assert.equal(strip!.asOf, boardAt.toISOString(), "首页要能说出这张榜截止到几点（页面据此停掉“正在刷新”的那颗点）");
  const hot = await loadHot();
  assert.equal(hot.computedAt, boardAt.toISOString(), "完整榜单页与首页读的是同一张榜");
  assert.equal(hot.entries.length, 3, "两处条数一致");
});

test("榜单里已被归并走、页面已不在、标题还没有中文的事件都不上榜，名次接着排", async () => {
  const kept = await addStory(`热榜承载测试${T}留下`);
  const gone = await addStory(`热榜承载测试${T}被并走`);
  const latin = await addStory(`Hot board carry-over ${T} latin heading`);
  const last = await addStory(`热榜承载测试${T}最后`);
  await saveBoard(AHEAD, [entryOf(kept, 1), entryOf(gone, 2), entryOf(latin, 3), entryOf(last, 4)]);
  // What the grouping step does to a story it folds into another one.
  const [target] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id = ${kept.id}`;
  await sql`UPDATE stories SET merged_into = ${target!.id} WHERE id = ${gone.id}`;

  const ranking = await latestHotRanking();
  assert.ok(ranking);
  assert.deepEqual(ranking!.entries.map((e) => e.storyId), [kept.id, last.id], "指向已被并走的事件、以及标题没有中文的事件都不能再上榜");
  assert.deepEqual(ranking!.entries.map((e) => e.rank), [1, 2], "掉出去之后名次要连着排，不能留下 1、4");

  const strip = await loadHotStrip();
  assert.deepEqual(strip!.entries.map((e) => e.storyPublicId), [kept.publicId, last.publicId], "首页同样不链到打不开的页面");
  // The Latin heading is the one this file exists to keep off: heat is computed from `stories.title`, and
  // 482 of the 4025 events on production still carry a Latin-only heading. Every other reader exit applies
  // the Chinese gate; the ranking path was the exception (see `publishableStories` in hot-read.ts).
  assert.equal(JSON.stringify(strip!.entries.map((e) => e.title)).includes("latin"), false, "英文标题不能出现在首页热点条里");
});

test("读侧的两条口径写在源码里：空榜跳过与 24 小时截止", () => {
  const read = readFileSync(new URL("../packages/backend/src/events/hot-read.ts", import.meta.url), "utf8");
  assert.ok(read.includes("const MAX_BOARD_AGE_HOURS = 24;"), "读侧截止时长改了：本文件的说明要跟着改，别只改数字");
  assert.ok(read.includes("WHERE published AND jsonb_array_length(entries) > 0"), "读侧必须跳过空榜（含改动之前发布过的空榜行）");
  assert.ok(read.includes("computed_at > now() - make_interval(hours => ${MAX_BOARD_AGE_HOURS})"), "榜不能无限期挂着：超过一天就回到诚实空态");
  const write = readFileSync(new URL("../packages/backend/src/events/hot.ts", import.meta.url), "utf8");
  assert.ok(write.includes("${entries.length > 0})"), "hot.ts 又无条件发布空榜了：空榜不该顶掉有事件的榜");
});

// 2026-11-27 站长截图：/en 的 Trending 与 /en/hot 里排着中文事件名。当时 228 个事件里 222 个
// 没有 title_en，而 `rankingExtras.text()` 写的是 `t?.titleEn ?? e.title`——英文页每一行都退回中文。
// 现在 strict 的 /en 在 hot / hot-strip 两处都只保留真有英文标题的事件；中文页照旧。
test("英文页的热榜只放真有英文标题的事件，中文页不受影响", async () => {
  const zhOnly = await addStory(`热榜英文口径测试${T}中文事件`);
  const enStory = await addStory(`Hot board English policy ${T}`);
  await sql`UPDATE stories SET title_en = ${`Hot board English policy ${T}`} WHERE id = ${enStory.id}`;
  // 本文件所有榜都写在同一时刻，`ORDER BY computed_at DESC LIMIT 1` 遇到并列会随机挑一张；
  // 这张榜单独晚一分钟，读到的才是它自己。
  await saveBoard(new Date(AHEAD.getTime() + 60_000), [entryOf(zhOnly, 1), entryOf(enStory, 2)]);

  const hotEn = await loadHot("en");
  assert.deepEqual(hotEn.entries.map((e) => e.story.publicId), [enStory.publicId], "没有英文标题的事件不能出现在 /en/hot");
  assert.equal(JSON.stringify(hotEn.entries).includes("中文事件"), false, "/en/hot 的载荷里不该出现中文事件名");
  // 榜单读侧（`publishableStories`）先剔掉缺英文的事件，名次接着排——与本文件另一条「名次要连着排」同口径。
  assert.deepEqual(hotEn.entries.map((e) => e.rank), [1], "剔掉之后名次从 1 重新连着排");

  const hotZh = await loadHot("zh");
  // 中文页的成员门要求事件名带中文（`publishableStories` 的 zh 口径），所以只留中文那条；
  // 英文事件不在中文榜上，这条与 `/en` 只留英文是同一对口径。
  assert.deepEqual(hotZh.entries.map((e) => e.story.publicId), [zhOnly.publicId], "中文页照旧只放中文事件");

  const stripEn = await loadHotStrip("en");
  assert.deepEqual(stripEn!.entries.map((e) => e.storyPublicId), [enStory.publicId], "首页热点条同样只放英文事件");
  assert.equal(JSON.stringify(stripEn!.entries).includes("中文事件"), false, "首页英文板上不能混进中文事件名");
});
