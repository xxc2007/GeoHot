import "./setup.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "../packages/backend/src/db.ts";
import { rotationHints, topicRotationBoard } from "../packages/backend/src/admin/topic-rotation.ts";

/** 后台「主题轮换」看板：站长要能看到谁在岗、谁被归档、候选里还排着谁。
 * 这份夹具刻意造三种状态：近 30 天有货、零条目但还没归档、已归档却又有新货。 */
const stamp = `board-${process.pid}`;
const SOURCE = `${stamp}-src`;
const busy = `${stamp}-busy`;
const quiet = `${stamp}-quiet`;
const revived = `${stamp}-revived`;

after(async () => {
  await sql`DELETE FROM publication_topics WHERE article_id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM publications WHERE article_id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM articles WHERE id LIKE ${stamp + "%"}`;
  await sql`DELETE FROM topic_proposals WHERE tag LIKE ${stamp + "%"}`;
  await sql`DELETE FROM topics WHERE slug LIKE ${stamp + "%"}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
});

async function seedTopic(slug: string, position: number, dormantAt: Date | null = null) {
  await sql`INSERT INTO topics (slug, name, grp, tags, definition, related, position, dormant_at)
    VALUES (${slug}, ${slug}, 'field', ARRAY[]::text[], 'fixture', ARRAY[]::text[], ${position}, ${dormantAt})
    ON CONFLICT (slug) DO UPDATE SET dormant_at = excluded.dormant_at, position = excluded.position`;
}

async function seedItem(articleId: string, slug: string, at: Date) {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'board fixture', 'rss', '2100-01-01') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, body_text, body_status)
    VALUES (${articleId}, ${SOURCE}, ${articleId}, ${`https://example.org/${articleId}`}, ${`fixture ${articleId}`}, 'zh', ${at}, ${at}, 'body', 'ok')
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO publications (article_id, source_id, channel, title, url, discovered_at, timeline_at, sort_at, selected, visibility, body_mode)
    VALUES (${articleId}, ${SOURCE}, 'news', ${`fixture ${articleId}`}, ${`https://example.org/${articleId}`}, ${at}, ${at}, ${at}, true, 'public', 'full')
    ON CONFLICT (article_id) DO NOTHING`;
  await sql`INSERT INTO publication_topics (article_id, slug, source) VALUES (${articleId}, ${slug}, 'tag')
    ON CONFLICT DO NOTHING`;
}

test("看板把在岗、零条目、已归档又回货三种状态摊开，并给出运维提示", async () => {
  const now = new Date("2026-11-06T02:00:00Z");
  const recent = new Date(now.getTime() - 3600_000);
  await seedTopic(busy, 910);
  await seedTopic(quiet, 911);
  await seedTopic(revived, 912, new Date(now.getTime() - 5 * 86400_000));
  await seedItem(`${stamp}-a`, busy, recent);
  await seedItem(`${stamp}-b`, busy, recent);
  for (const n of [1, 2, 3]) await seedItem(`${stamp}-r${n}`, revived, new Date(now.getTime() - n * 3600_000));
  await sql`INSERT INTO topic_proposals (tag, articles, first_seen, last_seen) VALUES (${stamp + "-tag"}, 12, ${recent}, ${recent})
    ON CONFLICT (tag) DO UPDATE SET articles = excluded.articles`;

  const board = await topicRotationBoard(30, now);
  const row = (slug: string) => board.topics.find((t) => t.slug === slug);
  assert.equal(row(busy)?.items30, 2, "近 30 天的可读条目要数进去");
  assert.equal(row(quiet)?.items30, 0);
  assert.equal(row(quiet)?.dormantAt, null, "零条目不等于已归档");
  assert.ok(row(revived)?.dormantAt, "归档时间要原样带出来");
  // 共享测试库里还有别的归档主题，只数自己种的这几个。
  assert.equal(board.topics.filter((t) => t.slug.startsWith(stamp) && t.dormantAt).length, 1);
  assert.equal(board.windowDays, 30);

  const proposal = board.proposals.find((p) => p.tag === `${stamp}-tag`);
  assert.equal(proposal?.articles, 12);

  const hints = rotationHints(board);
  assert.ok(hints.some((h) => h.includes("下次换班会归档") && h.includes(quiet)), "零条目未归档要提示");
  assert.ok(hints.some((h) => h.includes("换班时会复活") && h.includes(revived)), "归档后回货要提示");
  assert.ok(hints.some((h) => h.includes("待拍板")), "候选要提示");
});

test("窗口天数会被收进 1–365，越界不报错", async () => {
  const narrow = await topicRotationBoard(0);
  assert.equal(narrow.windowDays, 1);
  const wide = await topicRotationBoard(10_000);
  assert.equal(wide.windowDays, 365);
});
