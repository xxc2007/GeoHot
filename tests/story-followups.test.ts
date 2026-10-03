// 「事件后续」这条接口必须把两件事分开：事件不存在（404）与事件还没有已发布的后续（200 + 空列表）。
// 线上 2026-10-03 的 bug：条目页 /items/f0w9b40pjc3a9zwq7nh80d94q（一条未精选的预警）底下永久显示
// 「事件后续暂时无法加载，点击重试」——因为 loadDevelopments 对"没有 selected 报道"的事件也回 not_found，
// 路由把它当 404，前端把 404 当失败，重试永远打在同一个 404 上。
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadStoryFollowups } from "@aihot/backend/publication/followups";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `${T}-fu`;
const articles: string[] = [];
let storyId = 0;
let storyPublicId = "";
const factIds: number[] = [];

async function publishFact(title: string, selected: boolean, suffix: string) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${suffix}`, title, bodyText: "测试正文。", bodyStatus: "ok", via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${title}, ${`${title} 的提要`}, 80, ${selected}, ${sql.json({ fact: null })})`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${randomUUID()}, ${storyId}, ${title}) RETURNING id`;
  factIds.push(fact!.id);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'primary')`;
  // releasedAt 放在过去：精选条目要过发布闸门才算公开（publish.ts 的 visible_after）。
  await publishArticle(articleId, selected ? { releasedAt: new Date(Date.now() - 3600_000) } : {});
  articles.push(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at)
            VALUES (${SOURCE}, ${`后续测试源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const [story] = await sql<{ id: number; public_id: string }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`测试事件 ${T}`}, now(), now()) RETURNING id, public_id::text`;
  storyId = story!.id;
  storyPublicId = story!.public_id;
});

after(async () => {
  await sql`DELETE FROM fact_articles WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await sql`DELETE FROM facts WHERE story_id = ${storyId}`;
  await sql`DELETE FROM stories WHERE id = ${storyId}`;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

test("只有一个未精选报道的事件：回空列表，不是 not-found", async () => {
  await publishFact(`未精选报道 ${T}`, false, "a");
  const result = await loadStoryFollowups(storyPublicId);
  assert.ok(result, "事件存在就必须有答案——不能回 null（那是 404，会让前端永远重试）");
  assert.deepEqual(result.items, []);
  assert.equal(result.more, false);
});

test("有精选报道后，后续里能拿到另一条事实的代表条目", async () => {
  const released = await publishFact(`已精选报道 ${T}`, true, "b");
  const result = await loadStoryFollowups(storyPublicId);
  assert.ok(result);
  assert.equal(result.items.length, 1, "两条事实里只有一条满足精选门槛");
  assert.equal(result.items[0]!.representative.id, released);
  assert.equal(result.items[0]!.representative.source.name, `后续测试源 ${T}`);
});

test("不存在的事件与畸形 id 仍然是 not-found", async () => {
  assert.equal(await loadStoryFollowups(randomUUID()), null);
  assert.equal(await loadStoryFollowups("not-a-public-id"), null);
});
