// 一批答坏不等于整篇作废，这条已经修过（#222）。这一支管的是它的下一层：批次折半以后，只有一半答回来时，
// 那一半算不算数。2026-10-16 在生产账上量到 9 条超长期刊论文正文里永久留着英文（可见切片内 89 块），
// 形状就是这里——要求"两半都成"，成着的那半被整批一起扔掉的代价。
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { translatePending } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-halfbatch-${T}`;
const URL_ = `https://example.com/halfbatch-${T}`;

// 四块一批：前两块正常答，后两块带 Poison 的一律交回非 JSON。批次折半以后，左半是成的那半。
const reply = (content: string) => ({ id: "stub", choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  if (segments.some((s) => s.includes("Poison"))) return reply("这一次模型没有交回 JSON");
  return reply(JSON.stringify({ t: segments.map((s) => (s.includes("Alpha") ? "阿尔法库水位读数已译。" : s.includes("Bravo") ? "布拉沃站流量已译。" : "译文")) }));
});
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test halfbatch', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
});
after(async () => {
  await purgeTagged(T);
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("the half of a batch that answered is kept, so one bad block cannot zero out the article", async () => {
  // 阀门是在 config 载入时定死的快照，测试体内改环境变量没用。关着跑这一腿，一块都不会入库，
  // 报出来的却是"坏块把整篇拖死"那句——先把前提钉住，红的时候才知道红在哪一层。
  assert.equal(config.modelCallsEnabled, true, "这一腿要真的走到模型：别带着 MODEL_CALLS_ENABLED=false 跑本文件");
  // 发现时间排在所有夹具之后，`translatePending({limit:1})` 才会挑这一条。
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: URL_, title: `Reservoir bulletin ${T}`, language: "en",
    bodyText: `Alpha and Bravo. ${T}`,
    bodyHtml:
      `<p>Alpha reservoir levels at Lake Volta ${T}.</p>` +
      `<p>Bravo discharge measured at Aswan gauge ${T}.</p>` +
      `<p>Poison block the model never answers cleanly ${T}.</p>` +
      `<p>Poison tail block right after it ${T}.</p>`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 5_400_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`水库公报-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const run = await translatePending({ limit: 1 });

  const [tr] = await sql<{ body_html: string; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.ok(tr, `成着的那一半被整批一起扔掉了：这篇一块都没入库（本轮结果 ${JSON.stringify(run.done)}）`);
  assert.ok(tr!.body_html.includes("阿尔法库水位读数已译") && tr!.body_html.includes("布拉沃站流量已译"), `好的那两块没有中文：\n${tr!.body_html}`);
  assert.ok(/never answers cleanly/.test(tr!.body_html), "答坏的那两块应当保留原文：\n" + tr!.body_html);
  assert.equal(tr!.complete, false, "还差两块，不能报成翻全了");

  const [attempt] = await sql<{ outcome: string; reason: string | null }[]>`SELECT outcome, reason FROM translation_attempts WHERE article_id = ${id}`;
  assert.equal(attempt!.outcome, "partial", "两块没答上是 partial（还会再来），不是 failed 一次就封顶");
  assert.match(attempt!.reason ?? "", /2 of 4 blocks kept in the original/, attempt!.reason ?? "");
});
