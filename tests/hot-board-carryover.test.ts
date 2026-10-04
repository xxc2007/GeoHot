// The homepage board survives an empty recompute.
//
// The ranking job runs every five minutes (`hot.rank`). When a recompute finds no event that reached two
// independent participants, `computeHotRanking` used to insert that empty board with `published = true`, and
// `latestHotRanking` reads published rows only — so the block went blank the moment the last qualifying story
// aged out of the 48-hour window, and came back hours later. Measured on production 2026-10-04: 400 boards in
// 72 hours, 127 of them with events in them, and the newest empty one was hiding a board with 4 events behind
// it: the last non-empty board was 10-03 14:55 +0800 with 4 entries, and all 277 boards computed after it,
// at a five-minute cadence, were empty.
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

test("榜单里已被归并走的事件先掉出榜，名次接着排", async () => {
  const kept = await addStory(`热榜承载测试${T}留下`);
  const gone = await addStory(`热榜承载测试${T}被并走`);
  const last = await addStory(`热榜承载测试${T}最后`);
  await saveBoard(AHEAD, [entryOf(kept, 1), entryOf(gone, 2), entryOf(last, 3)]);
  // What the grouping step does to a story it folds into another one.
  const [target] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id = ${kept.id}`;
  await sql`UPDATE stories SET merged_into = ${target!.id} WHERE id = ${gone.id}`;

  const ranking = await latestHotRanking();
  assert.ok(ranking);
  assert.deepEqual(ranking!.entries.map((e) => e.storyId), [kept.id, last.id], "指向已被并走的事件的条目不能再上榜");
  assert.deepEqual(ranking!.entries.map((e) => e.rank), [1, 2], "掉出去之后名次要连着排，不能留下 1、3");

  const strip = await loadHotStrip();
  assert.deepEqual(strip!.entries.map((e) => e.storyPublicId), [kept.publicId, last.publicId], "首页同样不链到打不开的页面");
});

test("读侧的两条口径写在源码里：空榜跳过与 24 小时截止", () => {
  const read = readFileSync(new URL("../packages/backend/src/events/hot-read.ts", import.meta.url), "utf8");
  assert.ok(read.includes("const MAX_BOARD_AGE_HOURS = 24;"), "读侧截止时长改了：本文件的说明要跟着改，别只改数字");
  assert.ok(read.includes("WHERE published AND jsonb_array_length(entries) > 0"), "读侧必须跳过空榜（含改动之前发布过的空榜行）");
  assert.ok(read.includes("computed_at > now() - make_interval(hours => ${MAX_BOARD_AGE_HOURS})"), "榜不能无限期挂着：超过一天就回到诚实空态");
  const write = readFileSync(new URL("../packages/backend/src/events/hot.ts", import.meta.url), "utf8");
  assert.ok(write.includes("${entries.length > 0})"), "hot.ts 又无条件发布空榜了：空榜不该顶掉有事件的榜");
});
