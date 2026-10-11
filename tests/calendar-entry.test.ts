// 日历入口的两条判据：`/all?date=` 只给那一天的内容，`monthMarks` 说得出哪几天真的有内容。
//
// 为什么要单独钉：`/all` 的翻页上限是 2,000 条，而站上可列的条目早已过万（2026-10-11 实测可列 7,867 条、
// 第 50 页最早只到 10 月 7 日）。日历是"一月到九月那些内容"唯一的按日期入口，所以"点 3 月 14 日就只该看到
// 3 月 14 日"必须是用例跑过的，而不是注释里的一句话。
// 第二组断言看着多余（`total` 不同是显然的），但它钉的是缓存键：`poolCount` 按 filterKey 存 30 秒，
// 日期不进键的话，第二次查就会把第一次的总数原样还回来——共享测试库里这种错只会以"数字对不上"的形式浮现。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tag } from "./setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadPool } from "@aihot/backend/publication/pool";
import { isDay, isMonth, monthMarks } from "@aihot/backend/publication/calendar";
import { beijingDate } from "@aihot/contracts/time";

const T = tag();
const SOURCE = `test-calendar-${T}`;
const TAG = `calendar-${T}`;
const BODY = `BODY-${T} `.repeat(40);
const filters = { channel: "all" as const, category: null, tag: TAG, topic: null };

/** 一条已发布、已过释放闸门的中文条目，`publishedAt` 由用例给（投影会据此算 timeline_at）。 */
async function item(daysAgo: number, label = String(daysAgo)): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${label}`, title: `日历测试条目 ${T}-${label}`,
    bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'natural', ${[TAG]}, ${`日历测试条目 ${T}-${label}`}, ${`那一天有一条内容 ${T}-${label}。`}, '测试夹具', 90, false)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const timelineOf = async (articleId: string) => beijingDate(
  one(await sql<{ timeline_at: Date }[]>`SELECT timeline_at FROM publications WHERE article_id = ${articleId}`).timeline_at);
const one = <T2,>(rows: T2[]) => rows[0]!;

let recent = "";
let older = "";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Calendar test', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  recent = await item(0);
  older = await item(40);
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("日历点某一天，列表就只给那一天；两天的总数各算各的", async () => {
  const recentDay = await timelineOf(recent);
  const olderDay = await timelineOf(older);
  assert.notEqual(recentDay, olderDay, "夹具本身要真的横跨两天，否则这条判据什么都没钉住");
  // 近处那天再放一条：两天的数不一样，缓存键漏掉日期时才会露出来（两边都是 1 的话，借了别人的数也看不出来）。
  const second = await item(0, "today-2");
  const onRecent = await loadPool({ ...filters, q: null, tab: "time", page: 1, date: recentDay });
  const onOlder = await loadPool({ ...filters, q: null, tab: "time", page: 1, date: olderDay });
  assert.deepEqual(onRecent.items.map((i) => i.id).sort(), [recent, second].sort(), "选了近处那天却列出了别的日子");
  assert.deepEqual(onOlder.items.map((i) => i.id), [older], "选了远处那天却列出了别的日子");
  // 缓存键必须含日期：30 秒的总数缓存按 filterKey 存，日期不进键就会把上一天的数还回来。
  assert.equal(onRecent.total, 2);
  assert.equal(onOlder.total, 1);
  const all = await loadPool({ ...filters, q: null, tab: "time", page: 1, date: null });
  assert.equal(all.total, 3, "不带日期时三条都该在");
});

test("月历只把真有内容的日子画成点，日期与筛选用的是同一套成员条件", async () => {
  const recentDay = await timelineOf(recent);
  const marks = await monthMarks(recentDay.slice(0, 7));
  const mine = marks.filter((m) => m.date === recentDay);
  assert.equal(mine.length, 1, "那一天必须出现在月历的有内容名单里");
  assert.ok(mine[0]!.items >= 1, "有内容才画点");
  assert.ok(marks.every((m) => m.items > 0 || m.issue !== null), "回出来的每一天都得真的有东西，空格由前端补");
});

test("月与日的参数不认形状，还要回读对得上（2026-02-30 不能变成 3 月 2 日）", () => {
  assert.equal(isDay("2026-03-07"), true);
  assert.equal(isDay("2026-02-30"), false, "形状对但不存在的日子会被 Date 滚成下一天");
  assert.equal(isDay("2026-1-05"), false);
  assert.equal(isDay("2026-01-05T00:00"), false);
  assert.equal(isMonth("2026-03"), true);
  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("2026-00"), false);
  assert.equal(isMonth(null), false);
});
