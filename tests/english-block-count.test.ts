// 正文翻译的 blocks 数组没有 id：少答/多答一块时，第 i 块不再对应原文第 i 块。整批必须拒绝，
// 不能把 answer.blocks[i] 按数组下标写进 batch[i]——否则相邻段落会永久错位存进 translations，
// 而比例闸只比较长度比例，认不出错位。这里让模型对 2 个原文块只回 1 块，断言没有写回任何译文。
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translateArticleBodyEn } from "@aihot/backend/editorial/english";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-english-block-count-${T}`;
let articleId = "";

const provider = await stub(() => ({
  id: "stub-block-count",
  choices: [{ message: { content: JSON.stringify({ blocks: ["Only one block was translated."] }) } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}));
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true",
});
delete process.env.MODEL_POOL;
delete process.env.ENGLISH_MODEL;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
            VALUES (${SOURCE}, ${`英文块计数源 ${T}`}, 'rss', 'T1', 'editorial', true, true, true, '2100-01-01')`;
});

after(async () => {
  if (articleId) await sql`DELETE FROM english_attempts WHERE subject = ${articleId}`;
  await purgeTagged(T);
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("模型少答一块时整批拒绝，不按数组下标写回相邻段落", async () => {
  const material = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.org/${T}/block-count`,
    title: `英文块计数 ${T}`,
    bodyText: "第一段中文正文，给出地点、测量数据与事件经过，内容足以单独成段。\n\n第二段中文正文，补充影响范围、后续应对与数据来源，同样足以单独成段。",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  articleId = material.articleId;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'physical', ${["地震"]}, ${`英文块计数 ${T}`}, '中文摘要。', '中文理由。', 90, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 1000) });

  const result = await translateArticleBodyEn(articleId);
  assert.equal(result.outcome, "failed", `少答一块必须整批拒绝，实际：${result.outcome} / ${result.reason}`);
  assert.match(result.reason ?? "", /answered 1 of 2 blocks/, `拒绝原因应点名少答：${result.reason}`);

  const rows = await sql<{ article_id: string }[]>`SELECT article_id FROM translations WHERE article_id = ${articleId} AND lang = 'en'`;
  assert.equal(rows.length, 0, "错位的块一块都不许写进 translations");
});