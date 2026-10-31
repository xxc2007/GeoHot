// 条目页的两级分级，一个谓词一个写法（detail.ts 的 pageGate + 行内 workflow_ready / 许可事实）：
//  · 全文许可且工作流已核验 → 完整阅读页（readingMode "full"）；
//  · 来源仅准摘要 → 受限页（"summary-licence"）：标题、AI 导读、来源、原文入口，无正文、无导出；
//  · 许可允许全文但工作流未核验 → 仍 404 留后台（政策原文：提取未确认的材料只留在后台）；
//  · withdrawn / 非 editorial / 发布门内 / 管理员 summary-only / 标签空稿 / 未生成摘要 → 404，与从前一致。
// 这就是期刊引用的落点：日报印出的标题与摘要已在读者面前，点击落 404 是当期缺陷——落受限页
// 不是新增暴露（标题与摘要就是引用本身），而全文未核验的完整正文仍然一个字不出站。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { loadItemShare } from "@aihot/backend/publication/og";

const T = tag();
const SOURCE = `test-page-grades-${T}`;
const BODY = `完整的中文测试正文 BODY-${T} `.repeat(40);
let n = 0;

async function sourceWithFulltext(siteFulltext: boolean) {
  const id = `${SOURCE}-${siteFulltext ? "full" : "summary"}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${id}, ${`分级测试源 ${id}`}, 'rss', 'T1', 'editorial', ${siteFulltext}, '2100-01-01')`;
  return id;
}

/** A selected, released item with a Chinese title and summary; the body is servable Chinese full text. */
async function item(sourceId: string): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${n}`, title: `Test ${n}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${`分级中文标题-${n}-${T}`}, ${`分级中文摘要-${n}-${T}`}, 85, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

let fullSource = "", summarySource = "";

before(async () => {
  fullSource = await sourceWithFulltext(true);
  summarySource = await sourceWithFulltext(false);
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ANY(${[fullSource, summarySource]})`;
  await sql`DELETE FROM sources WHERE id = ANY(${[fullSource, summarySource]})`;
  await stopBoss();
  await closeDb();
});

test("全文许可 + 工作流就绪 = 完整页；仅摘要许可 = 受限页，同版式、无正文、无导出", async () => {
  const full = await item(fullSource);
  const restricted = await item(summarySource);

  const fullDetail = await loadItemDetail(full);
  assert.equal(fullDetail.kind, "found");
  if (fullDetail.kind === "found") {
    assert.equal(fullDetail.detail.readingMode, "full", "就绪行照旧给完整页");
    assert.ok(fullDetail.detail.body?.zh?.includes(`BODY-${T}`), "完整页带正文");
    assert.equal((await exportMarkdown(full))?.body.includes(`BODY-${T}`), true, "完整页可导出");
  }

  const preview = await loadItemDetail(restricted);
  assert.equal(preview.kind, "found", "仅摘要许可不再 404：期刊引用必须落在页面上");
  if (preview.kind === "found") {
    assert.equal(preview.detail.readingMode, "summary-licence");
    assert.equal(preview.detail.body, null, "受限页一个字的正文都不给");
    assert.ok(preview.detail.title.includes(`分级中文标题`), "标题就是期刊引用过的那一个");
    assert.ok(preview.detail.summary?.includes(`分级中文摘要`), "摘要也是");
    assert.equal(preview.detail.indexable, false, "受限页 noindex");
    assert.equal(await exportMarkdown(restricted), null, "受限页无导出");
  }
  assert.equal((await itemAvailability([restricted]))[restricted], "summary-only", "收藏页按仅摘要提示");
  assert.ok((await loadItemShare(restricted))?.title, "分享卡与页面同门禁");
});

test("许可允许全文但工作流未核验：仍 404 留后台；仅摘要许可的受限页与核验状态无关", async () => {
  const id = await item(fullSource);
  // 摘掉工作流就绪事实：全文许可的行按政策继续留在后台。
  await sql`UPDATE article_workflow_readiness SET ready = false WHERE article_id = ${id}`;
  assert.equal((await loadItemDetail(id)).kind, "not_found", "全文许可未核验的行留在后台（提取未确认的材料只留在后台）");
  assert.equal(await exportMarkdown(id), null);
  assert.equal((await itemAvailability([id]))[id], "unavailable");
  // 恢复就绪事实，同一行回到完整页。
  await sql`UPDATE article_workflow_readiness SET ready = true WHERE article_id = ${id}`;
  const restored = await loadItemDetail(id);
  if (restored.kind === "found") assert.equal(restored.detail.readingMode, "full", "核验完成后自动回完整页");
});

test("发布门内、withdrawn、非 editorial、管理员 summary-only：仍然 404——泄漏门禁一寸不让", async () => {
  const gated = await item(fullSource);
  await sql`UPDATE publications SET visible_after = now() + interval '1 hour' WHERE article_id = ${gated}`;
  assert.equal((await loadItemDetail(gated)).kind, "not_found", "发布门内的条目依旧整条 404");

  const withdrawn = await item(fullSource);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;
  assert.equal((await loadItemDetail(withdrawn)).kind, "not_found");

  const isolated = await item(fullSource);
  await sql`UPDATE sources SET participation_mode = 'isolated' WHERE id = ${fullSource}`;
  assert.equal((await loadItemDetail(isolated)).kind, "not_found");
  await sql`UPDATE sources SET participation_mode = 'editorial' WHERE id = ${fullSource}`;

  const pulled = await item(fullSource);
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${pulled}`;
  assert.equal((await loadItemDetail(pulled)).kind, "not_found", "管理员的人工下架仍是整条 404，不受限页分级影响");
});

test("标签空稿（title_zh: 残片）：404 不变——残片不是标题，页面不得呈现它", async () => {
  const damaged = await item(summarySource);
  await sql`UPDATE publications SET title = 'title_zh:', summary = 'summary_zh:' WHERE article_id = ${damaged}`;
  assert.equal((await loadItemDetail(damaged)).kind, "not_found");
});
