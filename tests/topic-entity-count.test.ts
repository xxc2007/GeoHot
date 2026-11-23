// 机构（company）主题的计数必须与主题页的成员判据同一套：`topicMatchTags` 认
// `entity:<id>` 和 `org_names`，**不**认主题 tags 里的体裁词。这里用一个只带 `entity:usgs`
// 标签的条目钉住它：修复前全量计数按 `topics.tags`（地震）算，页面却按 entity 键列出，
// 于是 total=0、items=1，越界页与 sitemap 都会跟着错。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage, topicPageCounts } from "@aihot/backend/publication/topics";

const SOURCE = `topic-entity-source-${tag()}`;
const TOPIC = `topic-entity-${tag()}`;
let articleId = "";

after(async () => {
  await sql`DELETE FROM editorial_overrides WHERE article_id = ${articleId}`;
  await sql`DELETE FROM publications WHERE article_id = ${articleId}`;
  await sql`DELETE FROM analyses WHERE article_id = ${articleId}`;
  await sql`DELETE FROM articles WHERE id = ${articleId}`;
  await sql`DELETE FROM topics WHERE slug = ${TOPIC}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("机构主题的计数与页面条目都认 entity 键，不把体裁标签算进来", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
            VALUES (${SOURCE}, ${`机构主题计数源 ${tag()}`}, 'rss', 'T1', 'editorial', true, true, true, '2100-01-01')`;
  await sql`INSERT INTO topics (slug, name, grp, entity_id, tags, org_names, definition, related, position)
            VALUES (${TOPIC}, ${`机构主题计数 ${TOPIC}`}, 'company', 'usgs', ${["地震"]}, ${["USGS"]}, '测试主题', '{}', 9998)`;

  const material = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.org/${TOPIC}`,
    title: "USGS 发布全球地震目录更新",
    bodyText: "USGS 发布全球地震目录更新。正文给出震级、震源深度、震中位置与观测时间，并说明数据来源与更新范围。观测团队按规范到达事发地点，使用仪器测量关键参数，并查阅官方通报与历史资料进行交叉核对；正文交代事件成因、影响范围与后续应对，数据来源可追溯，段落连贯、信息充分，足以支撑成刊选稿。",
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  articleId = material.articleId;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'physical', ${["entity:usgs"]}, 'USGS 更新全球地震目录', '目录更新包含震级与位置。', '可供核对的观测目录。', 90, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 1000) });

  const now = new Date(Date.now() + 60_000);
  const count = (await topicPageCounts(now)).find((c) => c.slug === TOPIC);
  assert.ok(count, "计数里应有这个主题");
  assert.equal(count.total, 1, "只带 entity:usgs 的条目必须计入机构主题");
  assert.equal(count.recent, 1);

  const page = await loadTopicPage(TOPIC, 1, now);
  assert.ok(page, "主题页应能打开");
  assert.equal(page.topic.total, 1, "页面上的 total 必须与条目列表同口径");
  assert.equal(page.pageCount, 1);
  assert.deepEqual(page.items.map((i) => i.id), [articleId], "主题页应列出这条 entity 归因的条目");

  // 生产路径没有固定时钟：这里单独走 `loadTopicCounts`（单主题计数），钉住它与上面全量计数同口径。
  const pageNow = await loadTopicPage(TOPIC, 1);
  assert.ok(pageNow, "无固定时钟的主题页也应能打开");
  assert.equal(pageNow.topic.total, 1, "单主题计数也要认 entity 键");
  assert.deepEqual(pageNow.items.map((i) => i.id), [articleId], "单主题计数路径列出的条目应一致");
});