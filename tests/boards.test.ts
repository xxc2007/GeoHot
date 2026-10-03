// The four boards (考研 / 地理信息系统 / 地理与政治 / 地理与历史) are views over taxonomy categories, and
// their whole value is that the two lanes never mix: 本站精选 is the human-curated set, 来源原文 is what the
// read layer already publishes on its own. This file pins that separation, the per-source flood control, and
// the paging contract. Measured 2026-10-03 (why the flood control exists): 100/100 of the freshest published
// items came from a single 气象台预警 source, so an ungrouped lane would be one source's ticker.
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { BOARD_INDEX_PER_SOURCE, listBoardDefinitions, viewBoard } from "@aihot/backend/publication/boards";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const HIST = `${T}-hist`;
const GIS = `${T}-gis`;
const articles: string[] = [];

async function publish(sourceId: string, suffix: string, selected: boolean) {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${suffix}`, title: `板块材料 ${T} ${suffix}`,
    bodyText: "测试正文。", bodyStatus: "ok", via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', ${selected ? "histgeo" : "histgeo"}, ${`板块标题 ${T} ${suffix}`}, ${`${T} 的提要 ${suffix}`}, 70, ${selected}, ${sql.json({ fact: null })})`;
  await publishArticle(articleId);
  articles.push(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, default_category) VALUES
            (${HIST}, ${`历史源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', 'histgeo'),
            (${GIS}, ${`GIS 源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', 'geotech')`;
  for (let i = 0; i < 24; i++) await publish(HIST, `i${i}`, false);
  await publish(GIS, "c0", true);
});

after(async () => {
  await sql`DELETE FROM publications WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

test("four boards with the agreed slugs and a plate mark each", async () => {
  const boards = await listBoardDefinitions();
  assert.deepEqual(boards.map((b) => b.slug).sort(), ["geopolitics", "gis", "histgeo", "kaoyan-geo"]);
  // 2026-10-03：站长把「地理信息技术」与「地理信息系统」并成一个区域——板块名与分类 key 都要对上，
  // 免得筛选栏里又出现两个并排的同类区域。
  const gis = boards.find((b) => b.slug === "gis")!;
  assert.equal(gis.name, "地理信息系统");
  assert.deepEqual(gis.categories, ["geotech"], "合并后只挂一个分类");
  for (const b of boards) assert.ok(b.description.length > 20, `${b.slug} 要有一句人话说明`);
});

test("index-lane rows keep their source and are capped per source (flood control)", async () => {
  const view = await viewBoard("histgeo", 1);
  assert.ok(view);
  assert.equal(view.curated.items.length, 0, "没有精选就是空，不拿来源原文顶替");
  assert.equal(view.index.items.length, BOARD_INDEX_PER_SOURCE, `一个来源在一页里最多 ${BOARD_INDEX_PER_SOURCE} 条`);
  assert.equal(view.index.collapsed.length, 1);
  assert.equal(view.index.collapsed[0]!.count, 20 - BOARD_INDEX_PER_SOURCE, "其余折叠成计数");
  assert.equal(view.index.collapsed[0]!.sourceName, `历史源 ${T}`);
});

test("the two lanes never mix", async () => {
  const view = await viewBoard("histgeo", 1);
  assert.ok(view);
  assert.ok(view.index.items.every((i) => i.selected === false), "来源原文里不能出现已精选的条目");
  const gis = await viewBoard("gis", 1);
  assert.ok(gis);
  assert.ok(gis.curated.items.every((i) => i.selected === true), "精选里不能混入未精选条目");
  assert.equal(gis.index.items.length, 0);
});

test("paging continues where the previous window ended", async () => {
  const first = await viewBoard("histgeo", 1);
  const second = await viewBoard("histgeo", 2);
  assert.ok(first && second);
  assert.equal(second.page, 2);
  const seen = new Set(first.index.items.map((i) => i.id));
  assert.ok(second.index.items.every((i) => !seen.has(i.id)), "第二页不能重复第一页的条目");
});

test("an unknown board and an out-of-range page are not pages", async () => {
  assert.equal(await viewBoard("no-such-board", 1), null);
  assert.equal(await viewBoard("histgeo", 0), null);
  assert.equal(await viewBoard("histgeo", 99), null);
});

test("a non-editorial source's rows never reach a board", async () => {
  // 独立审计（AUDIT-r8 m2）抓到的缺口：板块的两条线原本少了 `p.eligible` 这道与 /all、v1 相同的过滤，
  // 而 mode !== editorial 的条目没有条目页（rules.ts 的 hasItemPage）——列出来就是给读者一条 404 的链接。
  const signal = `${T}-sig`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, default_category)
            VALUES (${signal}, ${`信号源 ${T}`}, 'rss', 'T2', 'hot_signal', true, '2100-01-01', 'histgeo')`;
  const { articleId } = await upsertMaterial({
    sourceId: signal, url: `https://example.com/${T}-signal`, title: `信号材料 ${T}`,
    bodyText: "测试正文。", bodyStatus: "ok", via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'histgeo', ${`信号标题 ${T}`}, ${`${T} 的信号提要`}, 60, false, ${sql.json({ fact: null })})`;
  await publishArticle(articleId);
  articles.push(articleId);
  const [row] = await sql<{ eligible: boolean }[]>`SELECT eligible FROM publications WHERE article_id = ${articleId}`;
  assert.equal(row?.eligible, false, "hot_signal 源不该进公开池");

  const view = await viewBoard("histgeo", 1);
  assert.ok(view);
  assert.ok(!view.index.items.some((i) => i.id === articleId), "板块的『来源原文』不能出现没有条目页的行");
  assert.ok(!view.curated.items.some((i) => i.id === articleId));
  assert.equal(view.counts.index, 24, "计数与渲染同一条门槛：这条不计入");
});
