// 正文污染 hotfix：统一公开资格 + 安全导读页 + 回流日志 + 缓存失效。
//
// 覆盖：
//  · 正常政策文章、短地震公告、政府新闻 → 合格，完整页；
//  · 英文媒体（无中文译文）→ 流水线未完成，404 留后台；
//  · 正文是同意墙/模板壳 → classifier 判 defect，详情开"安全导读"受限页（标题+摘要+原文入口，不出脏正文），
//    且不进 pool/精选/RSS；
//  · 应急下拉 visibility='summary-only' → 仍然 404，直到回流合格才恢复；
//  · driveRepair dry-run 不写库、write 写日志且不伪造完成；
//  · purgePublicationCaches 触发进程缓存监听。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { driveRepair, listRepairCandidates } from "@aihot/backend/publication/body-repair";
import { onPublicationPurge, purgePublicationCaches } from "@aihot/backend/publication/cache-purge";
import { workflowReadyCondition } from "@aihot/backend/publication/readiness";

const T = tag();
const SOURCE = `test-body-guard-${T}`;
let n = 0;

async function fullSource() {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
    VALUES (${SOURCE}, ${`正文守护源 ${SOURCE}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
}

async function make(opts: { body: string; title?: string; bodyStatus?: "ok" | "pending" }): Promise<string> {
  n += 1;
  const title = opts.title ?? `测试标题 ${n} ${T}：地理热点事件观察`;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-${n}`,
    title,
    bodyText: opts.body,
    bodyHtml: `<p>${opts.body}</p>`,
    bodyStatus: opts.bodyStatus ?? "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', ${`中文标题-${n}-${T}`}, ${`这是第 ${n} 条测试摘要，讲一条地理热点事件，内容充分。`}, 85, false)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const NORMAL_PRIVACY = "欧盟新隐私法规对新闻网站的影响。2026年11月，欧盟正式实施新版隐私保护法规，要求所有新闻网站明确告知用户 Cookie 的使用范围。本文分析了该法规对欧洲媒体行业的实际影响，包括合规成本、用户体验变化和广告收入波动。据报道，超过七成的新闻网站已经在首页添加了 Cookie 同意弹窗，但只有不到三成提供了拒绝全部的选项。这一变化推动了行业自律，也让读者更清楚自己的数据去向。";
const SHORT_BULLETIN = "中国地震台网正式测定：11月16日10时23分在云南德宏州盈江县（北纬24.75度，东经97.93度）发生5.1级地震，震源深度10千米。当地震感明显，暂未接到重大伤亡报告，相关部门已赶赴现场核查。";
const GOV_NEWS = "国务院部署今冬明春农田水利建设。新华社北京11月15日电，国务院办公厅近日印发关于切实做好今冬明春农田水利建设的通知，要求各地抢抓施工窗口期，加快推进重大水利工程建设，确保明年春耕生产用水需求。通知强调，要聚焦水利薄弱环节，补齐防汛抗旱短板，提升水资源集约节约利用水平。";
const CONSENT_WALL = "我们使用 Cookie 来改善您的浏览体验。继续浏览即表示您同意我们使用 Cookie 政策。查看隐私政策。同意并继续。";
const TEMPLATE_SHELL = "{{article.title}} {{article.author}} 作者信息 + {{article.date}} {{article.zuoZhe_CN}} PDF(8989 KB)";

let purged = 0;
before(async () => {
  await fullSource();
  onPublicationPurge(() => { purged += 1; });
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("正常政策文章/短公告/政府新闻：body 合格，详情给完整页", async () => {
  const cases: Array<[string, string]> = [
    [NORMAL_PRIVACY, "欧盟新隐私法规对新闻网站的影响"],
    [SHORT_BULLETIN, "云南德宏州盈江县发生5.1级地震"],
    [GOV_NEWS, "国务院部署今冬明春农田水利建设"],
  ];
  for (const [body, title] of cases) {
    const id = await make({ body, title });
    const d = await loadItemDetail(id);
    assert.equal(d.kind, "found", `应给完整页：${body.slice(0, 20)}`);
    if (d.kind === "found") {
      assert.equal(d.detail.readingMode, "full", `合格正文应是完整阅读模式：${body.slice(0, 20)}`);
      assert.ok(d.detail.body, "完整页应带正文");
    }
  }
});

test("同意墙正文：详情开安全导读受限页，不渲染脏正文，不进公开列表", async () => {
  const id = await make({ body: CONSENT_WALL });
  // 流水线已落定、正文被判 defect → ready=false, body_quality_status='defect'
  const [r] = await sql<{ ready: boolean; status: string; reasons: string[]; rule: string }[]>`
    SELECT ready, body_quality_status AS status, body_quality_reasons AS reasons, body_quality_rule_version AS rule
    FROM article_workflow_readiness WHERE article_id=${id}`;
  assert.equal(r.ready, false, "同意墙正文不应就绪");
  assert.equal(r.status, "defect", "应标 defect");
  assert.ok(r.reasons.includes("consent-wall-only") || r.reasons.length > 0, "应带 reasons");
  assert.ok(r.rule, "应带 ruleVersion");

  const d = await loadItemDetail(id);
  assert.equal(d.kind, "found", "defect 行不再 404：开安全导读受限页");
  if (d.kind === "found") {
    assert.equal(d.detail.readingMode, "summary-licence", "安全导读应为受限模式");
    assert.equal(d.detail.body, null, "受限页一个字的脏正文都不给");
    assert.ok(d.detail.title.includes("中文标题"), "标题就是引用过的那一个");
    assert.equal(d.detail.indexable, false, "受限页 noindex");
  }
  assert.equal((await itemAvailability([id]))[id], "summary-only", "收藏页按仅摘要提示");
});

test("模板壳正文：同样落安全导读页；英文媒体无译文：404 留后台", async () => {
  const shell = await make({ body: TEMPLATE_SHELL });
  const sd = await loadItemDetail(shell);
  assert.equal(sd.kind, "found");
  if (sd.kind === "found") assert.equal(sd.detail.body, null, "模板壳不渲染正文");

  // 英文媒体：language=en 且没有中文译文 → 流水线未完成，404
  n += 1;
  const { articleId: enId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/${T}-en`,
    title: "A strong earthquake strikes Yunnan",
    bodyText: "A 5.1 magnitude earthquake struck Yingjiang, Yunnan, this morning, the China Earthquake Networks Center reported. There are no immediate reports of casualties.",
    bodyHtml: "<p>A 5.1 magnitude earthquake struck Yingjiang, Yunnan.</p>",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`UPDATE articles SET language='en' WHERE id=${enId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, score, selected)
    VALUES (${enId}, 1, 'rule', 'pass', ${`云南地震 ${T}`}, ${`云南发生5.1级地震 ${T}`}, 85, false)`;
  await publishArticle(enId, { releasedAt: new Date(Date.now() - 60_000) });
  const ed = await loadItemDetail(enId);
  assert.equal(ed.kind, "not_found", "英文正文无中文译文时流水线未完成，留后台 404");
});

test("应急下拉 visibility='summary-only'：仍 404，直到回流合格", async () => {
  const id = await make({ body: GOV_NEWS });
  await sql`UPDATE publications SET visibility='summary-only' WHERE article_id=${id}`;
  await sql`DELETE FROM article_workflow_readiness WHERE article_id=${id}`;
  assert.equal((await loadItemDetail(id)).kind, "not_found", "应急下拉行仍然 404");
});

test("driveRepair：dry-run 不写库；write 记日志且不伪造完成", async () => {
  const id = await make({ body: TEMPLATE_SHELL });
  const dry = await driveRepair(id, false);
  assert.equal(dry.action, "still-defective");
  const [logBefore] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publication_body_repair_log WHERE article_id=${id}`;
  assert.equal(logBefore.n, 0, "dry-run 不应写日志");

  const wr = await driveRepair(id, true);
  assert.equal(wr.action, "still-defective", "模板壳重跑仍不合格，不应假装恢复");
  const [logAfter] = await sql<{ n: number; event: string }[]>`SELECT event, count(*)::int AS n FROM publication_body_repair_log WHERE article_id=${id} GROUP BY event`;
  assert.equal(logAfter.n, 1);
  assert.equal(logAfter.event, "reprocessed");
});

test("purgePublicationCaches 触发进程缓存监听", async () => {
  const before = purged;
  purgePublicationCaches("some-id");
  assert.ok(purged > before, "应触发至少一次监听");
  const cands = await listRepairCandidates({ summaryOnly: true, defective: true, limit: 10 });
  assert.ok(Array.isArray(cands));
});

// 无空窗滚动发布：公开条件不绑 policy_version，只看 ready + body_quality_status='ok'。
test("滚动发布：policy3+quality null 不公开；policy3+quality ok 公开；policy4+defect 不公开", async () => {
  const id = await make({ body: NORMAL_PRIVACY, title: "欧盟新隐私法规对新闻网站的影响" });
  const cond = () => sql<{ ready: boolean }[]>`SELECT ${workflowReadyCondition()} AS ready
    FROM publications p WHERE p.article_id=${id}`;

  // 1. 模拟旧 policy3 行、尚未打标（body_quality_status IS NULL）：新 API 不公开。
  await sql`UPDATE article_workflow_readiness SET policy_version=3, body_quality_status=NULL, body_quality_reasons='{}', ready=true WHERE article_id=${id}`;
  assert.equal((await cond())[0].ready, false, "旧 policy3 且未打标（quality null）不应公开");

  // 2. 同一行打上 quality=ok（预回填完成）：新 API 公开，policy_version 仍是 3。
  await sql`UPDATE article_workflow_readiness SET body_quality_status='ok' WHERE article_id=${id}`;
  assert.equal((await cond())[0].ready, true, "旧 policy3 + quality ok 应公开（无空窗）");

  // 3. policy4 写入但判 defect：不公开。
  await sql`UPDATE article_workflow_readiness SET policy_version=4, body_quality_status='defect', ready=false WHERE article_id=${id}`;
  assert.equal((await cond())[0].ready, false, "policy4 + defect 不应公开");

  // 还原成 ok 状态，避免污染后续用例。
  await sql`UPDATE article_workflow_readiness SET body_quality_status='ok', ready=true WHERE article_id=${id}`;
});
