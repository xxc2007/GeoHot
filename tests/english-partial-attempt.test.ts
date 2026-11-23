// 正文分批翻译“部分成功”要记 partial_attempts（迁移 0132）：条数对、有一块坏答案时仍然只丢
// 那一块，但整篇没完成必须以 stale 记一笔 partial，sweep 才能按上限停排，而不是每 10 分钟无限重试。
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translateArticleBodyEn } from "@aihot/backend/editorial/english";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-english-partial-${T}`;
let articleId = "";

const provider = await stub(() => ({
  id: "stub-partial",
  choices: [{
    message: {
      content: JSON.stringify({
        blocks: [
          "The first paragraph is translated into English with enough words to pass the ratio guard and finish a sentence.",
          "",
        ],
      }),
    },
  }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}));
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true",
});
delete process.env.MODEL_POOL;
delete process.env.ENGLISH_MODEL;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
            VALUES (${SOURCE}, ${`英文部分成功源 ${T}`}, 'rss', 'T1', 'editorial', true, true, true, '2100-01-01')`;
});

after(async () => {
  if (articleId) await sql`DELETE FROM english_attempts WHERE subject = ${articleId}`;
  await purgeTagged(T);
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("一块坏答案只丢自己，整篇未完成记 stale 并累加 partial_attempts", async () => {
  const material = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.org/${T}/partial`,
    title: `英文部分成功 ${T}`,
    bodyText: "第一段中文正文，给出地点、测量数据与事件经过，内容足以单独成段。\n\n第二段中文正文，补充影响范围、后续应对与数据来源，同样足以单独成段。",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  articleId = material.articleId;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'physical', ${["地震"]}, ${`英文部分成功 ${T}`}, '中文摘要。', '中文理由。', 90, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 1000) });

  const result = await translateArticleBodyEn(articleId);
  assert.equal(result.outcome, "stale", `部分成功应记 stale，实际：${result.outcome} / ${result.reason}`);
  assert.match(result.reason ?? "", /partial: 1 of 2 blocks/);

  const [attempt] = await sql<{ attempts: number; partial_attempts: number; outcome: string }[]>`
    SELECT attempts, partial_attempts, outcome FROM english_attempts WHERE kind = 'body' AND subject = ${articleId}`;
  assert.ok(attempt, "应留下一条正文翻译记账");
  assert.equal(attempt.outcome, "stale");
  assert.equal(attempt.attempts, 0, "stale 不应消耗 failed 的 3 次预算");
  assert.equal(attempt.partial_attempts, 1, "部分成功要单独计数");
});