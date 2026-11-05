import "./setup.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "../packages/backend/src/db.ts";
import { listTopicSummaries } from "../packages/backend/src/publication/topics.ts";
import { proposeTopics, rotateTopics } from "../packages/backend/src/publication/topic-rotate.ts";

const stamp = `rot-${process.pid}`;
const SOURCE = `${stamp}-src`;

after(async () => {
  // 共享测试库：夹具必须自己收干净，否则主题列表与总数类断言会被这些行影响。
  await sql`DELETE FROM publication_topics WHERE article_id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM publications WHERE article_id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM articles WHERE id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM topic_proposals WHERE tag LIKE ${stamp + "%"}`;
  await sql`DELETE FROM topics WHERE slug LIKE ${stamp + "%"}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
});

async function seedTopic(slug: string, tag: string, position: number) {
  await sql`INSERT INTO topics (slug, name, grp, tags, definition, related, position)
    VALUES (${slug}, ${slug}, 'field', ARRAY[${tag}]::text[], 'fixture', ARRAY[]::text[], ${position})
    ON CONFLICT (slug) DO UPDATE SET tags = excluded.tags, dormant_at = NULL`;
}

async function seedArticle(articleId: string, tag: string, at: Date) {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'rotation fixture', 'rss', '2100-01-01') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, body_text, body_status)
    VALUES (${articleId}, ${SOURCE}, ${articleId}, ${`https://example.org/${articleId}`}, ${`fixture ${articleId}`}, 'zh', ${at}, ${at}, 'body', 'ok')
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO publications (article_id, source_id, channel, title, url, discovered_at, timeline_at, sort_at, selected, visibility, body_mode, tags)
    VALUES (${articleId}, ${SOURCE}, 'news', ${`fixture ${articleId}`}, ${`https://example.org/${articleId}`}, ${at}, ${at}, ${at}, true, 'public', 'full', ARRAY[${tag}]::text[])
    ON CONFLICT (article_id) DO UPDATE SET tags = excluded.tags, timeline_at = excluded.timeline_at`;
}

test("轮换把近 30 天零新条目的主题归档，有新条目时再放回在岗", async () => {
  const quiet = `${stamp}-quiet`;
  const busy = `${stamp}-busy`;
  const now = new Date();
  const recent = new Date(now.getTime() - 3600_000);
  const old = new Date(now.getTime() - 90 * 86400_000);

  await seedTopic(quiet, quiet, 900);
  await seedTopic(busy, busy, 901);
  await seedArticle(`${quiet}-old`, quiet, old);
  await seedArticle(`${busy}-new`, busy, recent);

  const first = await rotateTopics(now);
  assert.ok(first.archived.includes(quiet), "零新条目的主题该归档");
  assert.ok(!first.archived.includes(busy), "有今天条目的主题不该归档");
  const afterFirst = await sql<{ dormant_at: Date | null }[]>`SELECT dormant_at FROM topics WHERE slug = ${quiet}`;
  assert.ok(afterFirst[0]?.dormant_at, "归档时间要落库");

  const listed = await listTopicSummaries(now);
  assert.equal(listed.some((t) => t.slug === quiet), false, "归档主题不该出现在主题列表");
  assert.equal(listed.some((t) => t.slug === busy), true, "在岗主题仍在列表里");

  for (const n of [1, 2]) await seedArticle(`${quiet}-back-${n}`, quiet, new Date(now.getTime() - n * 60_000));
  const twoOnly = await rotateTopics(now);
  assert.ok(!twoOnly.revived.includes(quiet), "只有两条还不到复活的门槛");

  await seedArticle(`${quiet}-back-3`, quiet, new Date(now.getTime() - 180_000));
  const revived = await rotateTopics(now);
  assert.ok(revived.revived.includes(quiet), "三条就复活");
  const afterRevive = await sql<{ dormant_at: Date | null }[]>`SELECT dormant_at FROM topics WHERE slug = ${quiet}`;
  assert.equal(afterRevive[0]?.dormant_at, null);
});

test("候选主题只收有量、且没有主题认领的标签", async () => {
  const hot = `${stamp}-hot`;
  const claimedTag = `${stamp}-claimed`;
  const now = new Date();
  await seedTopic(`${stamp}-claims`, claimedTag, 902);
  for (let n = 0; n < 9; n++) {
    const at = new Date(now.getTime() - (n + 1) * 3600_000);
    await seedArticle(`${hot}-${n}`, hot, at);
    await seedArticle(`${claimedTag}-${n}`, claimedTag, at);
  }
  const proposals = await proposeTopics(now);
  assert.ok(proposals.some((p) => p.tag === hot), "高频且无人认领的标签要进候选");
  assert.equal(proposals.some((p) => p.tag === claimedTag), false, "已有主题认领的标签不该进候选");
  const rows = await sql`SELECT tag, articles FROM topic_proposals WHERE tag = ${hot}`;
  assert.equal(rows.length, 1);
});