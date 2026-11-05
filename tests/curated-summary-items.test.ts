// 「精选」的那道门：全文条目要有就绪凭据，摘要条目只在来源本来就不给全文时放行。
// 2026-11-05 生产现场：今天选中的 8 条里有 7 条来自 site_fulltext=false 的来源，被「只认全文」挡住，
// 于是「全部」在更新、「精选」一条也没有。
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedCondition } from "@aihot/backend/publication/items";

const T = tag();
const SUMMARY_SOURCE = `test-curated-summary-${T}`;
const FULL_SOURCE = `test-curated-full-${T}`;
const BODY = `完整的中文测试正文 CURATED-${T} `.repeat(30);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SUMMARY_SOURCE}, 'Curated summary source', 'rss', 'T1', 'editorial', false, false, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${FULL_SOURCE}, 'Curated full source', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id IN (${SUMMARY_SOURCE}, ${FULL_SOURCE})`;
  await sql`DELETE FROM sources WHERE id IN (${SUMMARY_SOURCE}, ${FULL_SOURCE})`;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

let n = 0;
async function published(sourceId: string, title: string): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${n}`, title,
    bodyText: `${BODY} ${n}`, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 120_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'natural', ${title}, ${`内容提要 ${T}-${n}`}, '两家信源同时报道', 80, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

test("一条摘要条目，只要来源本来就不提供全文，就能进精选", async () => {
  const id = await published(SUMMARY_SOURCE, `摘要条目 ${T}`);
  await sql`UPDATE publications SET body_mode = 'summary' WHERE article_id = ${id}`;
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p WHERE p.article_id = ${id} AND ${selectedCondition(new Date())}`;
  assert.equal(rows.length, 1, "来源不提供全文的摘要条目应当出现在精选里");
});

test("同样的摘要条目，如果来源其实能取全文，就仍然要等就绪凭据", async () => {
  const id = await published(FULL_SOURCE, `等全文 ${T}`);
  await sql`UPDATE publications SET body_mode = 'summary' WHERE article_id = ${id}`;
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p WHERE p.article_id = ${id} AND ${selectedCondition(new Date())}`;
  assert.equal(rows.length, 0, "能取全文的来源不该退化成摘要卡");
});

test("全文条目没有就绪凭据时仍然不进精选", async () => {
  const id = await published(FULL_SOURCE, `全文未就绪 ${T}`);
  await sql`DELETE FROM article_workflow_readiness WHERE article_id = ${id}`;
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p WHERE p.article_id = ${id} AND ${selectedCondition(new Date())}`;
  assert.equal(rows.length, 0);
});

test("没有摘要正文的摘要条目也不进精选（点进去是空的）", async () => {
  const id = await published(SUMMARY_SOURCE, `空摘要 ${T}`);
  await sql`UPDATE publications SET body_mode = 'summary', summary = '   ' WHERE article_id = ${id}`;
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p WHERE p.article_id = ${id} AND ${selectedCondition(new Date())}`;
  assert.equal(rows.length, 0);
});