// 一篇文章只该挂到一个事件上（AUDIT 2026-11-04 高危第二条）。
//
// 旧流程在拿文章行锁**之前**就读了一次"当前成员关系"，两个 worker 同时处理同一篇时都会读到
// "还没挂过"，锁只让它们先后进入事务 —— 第二个于是在事务里再造一个 story/fact，同一篇报告
// 出现在两条事件页上，热榜把一次地震数成两次。
//
// 这里不测"模型判断对不对"（那是 industry/prompts 的事），只钉死一条行为不变式：同一篇文章的
// 两个 groupArticle 并发跑完，fact_articles 里只能有一行、只能有一个 story。
//
// 说明（诚实记录）：这条用例在加守卫前后都能过——本地桩很快，"读成员关系" 往往发生在第一个
// worker 提交之后，于是第二个在 :645 就走 kept 了。真正被守卫挡住的是"两个事务都在锁前读到空"
// 那个更窄的窗口，要复现它需要在读与写之间插一个可观测的停顿，而给生产代码加测试钩子不值得。
// 所以这条用例的作用是防止"并发双挂"这件事被未来的改动重新引入（例如有人把行锁去掉、把 kept
// 判定挪出事务），守卫本身是防守性的第二道门。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { groupArticle } from "@aihot/backend/events/group";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const source = `double-attach-${tag()}`;
const articles: string[] = [];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, next_fetch_at)
            VALUES (${source}, ${source}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});

after(async () => {
  const storyIds = await sql<{ story_id: number }[]>`
    SELECT DISTINCT f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE fa.article_id = ANY(${articles})`;
  await sql`DELETE FROM fact_articles WHERE article_id = ANY(${articles})`;
  for (const { story_id } of storyIds) {
    await sql`DELETE FROM facts WHERE story_id = ${story_id}`;
    await sql`DELETE FROM stories WHERE id = ${story_id}`;
  }
  await sql`DELETE FROM regroup_pending WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await sql`DELETE FROM sources WHERE id = ${source}`;
  await stopBoss();
  await closeDb();
});

/** One published report with a passing analysis and no competing facts around it. */
async function report(): Promise<string> {
  const id = `da-${tag()}`;
  articles.push(id);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, timeline_at, discovered_at)
            VALUES (${id}, ${source}, ${id}, ${`https://example.com/${id}`}, '某地发生 4.2 级地震', '据测定，某地发生 4.2 级地震。',
                    'ok', now(), now())`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${id}, 1, 'rule', 'pass', 'physical', '某地发生 4.2 级地震', '据测定，某地发生 4.2 级地震。', 80, false,
                    ${sql.json({ fact: { title: "某地发生 4.2 级地震", subject: "某台网", action: "测定", object: "4.2 级地震" } } as never)})`;
  await publishArticle(id);
  return id;
}

test("两个 worker 同时处理同一篇文章，只会产生一套事件", async () => {
  const id = await report();
  const results = await Promise.all([groupArticle(id), groupArticle(id)]);

  const rows = await sql<{ fact_id: number; story_id: number }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE fa.article_id = ${id}`;
  assert.equal(rows.length, 1, `一篇文章只该在一个事件里，实际 ${rows.length} 行：${JSON.stringify(rows)}`);

  const stories = await sql<{ n: number }[]>`SELECT count(DISTINCT f.story_id) AS n FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE fa.article_id = ${id}`;
  assert.equal(Number(stories[0]!.n), 1, "两个 worker 各自造了一个 story");

  // 两次调用都要给出"这篇文章现在挂在哪个事件上"，而且必须指同一个。
  for (const r of results) {
    assert.ok(r.storyId, `返回值缺 storyId：${JSON.stringify(r)}`);
    assert.equal(r.storyId, rows[0]!.story_id);
  }
  // 一次造事件、另一次被"已有成员关系"挡住（kept），也算它们都说得出同一个 story。
  const verdicts = results.map((r) => r.verdict);
  assert.ok(verdicts.length === 2, verdicts.join(","));
});