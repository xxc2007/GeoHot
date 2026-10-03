// The 热度 trend on the hot list: the number six hours earlier has to be a real snapshot of that hour.
// heatRows used to derive `heat_prev` from the same window it uses for `heat` (only signals newer than
// at-48h), so the earlier reading saw at most 42 hours of evidence: `prev` came out low, trendPct grew, and
// a story that was cooling printed 热度 +N% ↑ with a rising badge. snapshotHeat already computed each hour
// over its own 48 hours — the ranking must agree with it.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const HOUR = 3600_000;
/** An exact hour, so the hourly snapshot and the ranking read the same instant. */
const at = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const prev = new Date(at.getTime() - 6 * HOUR);

const sources = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${T}-s${n}`);
const articles: string[] = [];
let storyId = 0;

/** One report from one outlet, seen by the site at `observedAt` (the source's own time, as heat reads it). */
async function signal(which: string, suffix: string, observedAt: Date) {
  const { articleId } = await upsertMaterial({
    sourceId: which, url: `https://example.com/${T}-${suffix}`, title: `Bulletin ${T} ${suffix}`,
    bodyText: "A field bulletin.", bodyStatus: "ok", via: "fetch", publishedAt: observedAt,
  });
  const titleZh = `测试热榜${T}的报道`;
  const summaryZh = `${which} 测定 5.2 级，深度 32 千米。`;
  const key = `source:${which}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${titleZh}, ${summaryZh}, 60, false, ${sql.json({ fact: null })})`;
  await publishArticle(articleId);
  const [fact] = await sql<{ id: number }[]>`SELECT id FROM facts WHERE story_id = ${storyId} ORDER BY id LIMIT 1`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${storyId}, ${articleId}, ${key}, ${which}, 'editorial', ${observedAt})`;
  articles.push(articleId);
  return articleId;
}

const entryOf = async (rankingId: number) =>
  (await sql<{ entries: Array<{ storyId: number; heat: number; trend: string; trendPct: number | null; badges: string[] }> }[]>`
    SELECT entries FROM hot_rankings WHERE id = ${rankingId}`)[0]!.entries.find((e) => e.storyId === storyId) ?? null;

before(async () => {
  for (const s of sources) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, last_ok_at)
              VALUES (${s}, ${`热榜测试${s}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', ${new Date(at.getTime() + HOUR)})`;
  }
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`测试热榜事件${T}`}, ${at}, ${at}) RETURNING id`;
  storyId = story!.id;
  await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${'f' + T}, ${storyId}, ${`测试热榜事件${T}`})`;
});

after(async () => {
  await sql`DELETE FROM story_heat_hourly WHERE story_id = ${storyId}`;
  await sql`DELETE FROM story_signals WHERE story_id = ${storyId}`;
  await sql`DELETE FROM fact_articles WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await sql`DELETE FROM facts WHERE story_id = ${storyId}`;
  await sql`DELETE FROM stories WHERE id = ${storyId}`;
  await sql`DELETE FROM sources WHERE id = ANY(${sources})`;
  await stopBoss();
  await closeDb();
});

test("evidence the earlier hour still had, and the current one has lost, counts in prev", async () => {
  // Four outlets last spoke 50 hours ago: each is outside the current 48-hour window but inside the window
  // the six-hour-earlier snapshot had. Six reported 4 hours ago: they are the whole current heat.
  // The board keeps ten stories (computeHotRanking), so the fixture is built to be first on it rather than
  // merely qualified — six independent participants put its heat above anything another file's rows can
  // produce, and the assertions below then read a real entry instead of `null` on a shared database.
  // The old reading computed prev from the *current* window's rows, so it saw none of those four and read
  // prev as 0 — which turned a cooling story into 「new」 with a rising badge. This fixture fails that way.
  await signal(sources[0]!, "old-a", new Date(at.getTime() - 50 * HOUR));
  await signal(sources[1]!, "old-b", new Date(at.getTime() - 50 * HOUR));
  await signal(sources[2]!, "old-c", new Date(at.getTime() - 50 * HOUR));
  await signal(sources[0]!, "old-d", new Date(at.getTime() - 50 * HOUR));
  await signal(sources[0]!, "now-a", new Date(at.getTime() - 4 * HOUR));
  await signal(sources[1]!, "now-b", new Date(at.getTime() - 4 * HOUR));
  for (const [n, src] of sources.slice(2).entries()) {
    await signal(src, `now-${n + 2}`, new Date(at.getTime() - 4 * HOUR));
  }

  const ranking = await computeHotRanking(at);
  try {
    const entry = await entryOf(ranking.id);
    assert.ok(entry, "八个独立参与就该进榜");
    // The bug's signature is not the arrow's direction (that depends on how the decay weights land) but
    // `prev` being read as zero: with no earlier evidence at all a story is reported as brand new, and the
    // rising badge goes on a story that four outlets were already covering six hours ago.
    assert.notEqual(entry.trend, "new", `六小时前就有四条独立证据，不该被读成全新事件：trend=${entry.trend}, trendPct=${entry.trendPct}`);
    assert.ok(entry.trendPct !== null, "有可比历史，趋势要能算出来");
    // 「↑」徽章的前提是趋势真的在涨；反过来不成立——涨得够快的事件拿的是 surge（两者互斥，见 hot.ts 的
    // badges），所以这里只断言单向：出现 rising 的时候趋势必须是 up。
    if (entry.badges.includes("rising")) assert.equal(entry.trend, "up", `热度 ↑ 只能挂在真的在涨的事件上：trend=${entry.trend}, trendPct=${entry.trendPct}`);
  } finally {
    await sql`DELETE FROM hot_rankings WHERE id = ${ranking.id}`;
  }
});

test("the trend's earlier number is the same hour the heat chart stores", async () => {
  await snapshotHeat(prev);
  const [snap] = await sql<{ heat: number }[]>`
    SELECT heat FROM story_heat_hourly WHERE story_id = ${storyId} AND hour = ${prev}`;
  assert.ok(snap, "snapshotHeat 写过这一小时（它本来就按整点自己的 48 小时窗口计算）");
  const ranking = await computeHotRanking(at);
  try {
    const entry = await entryOf(ranking.id);
    assert.ok(entry);
    const expected = Math.round(((entry.heat - Number(snap!.heat)) / Number(snap!.heat)) * 1000) / 10;
    assert.equal(entry.trendPct, expected, `榜单的 prev 与快照的同一小时读数对不上：${entry.trendPct} vs ${expected}`);
  } finally {
    await sql`DELETE FROM hot_rankings WHERE id = ${ranking.id}`;
  }
});
