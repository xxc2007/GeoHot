// When the identity call of a grouping job fails for good. The report is published standalone so nothing is
// held back, but the decision was never made: without a marker nothing re-opens it (pg-boss exhausts the
// queue's retries, the job goes to failed), and readers keep two event pages for one quake — counted apart in
// the heat list, because each page has its own participants. The marker is `regroup_pending`, which is also
// what stops this report being evidence for other reports until it is decided again.
import { Reply, stub, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-regroup-${T}`;
const FACT_TITLE = `测试事件${T}发生 M5.2 地震`;

let fail = true;
const provider = await stub(async (_hit, req) => {
  if (fail) return new Reply(400, { error: { message: "the judge refuses this request" } });
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const ids = [...body.messages[1]!.content.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!);
  return { id: `stub-${T}`, choices: [{ message: { content: JSON.stringify({ query: FACT_TITLE, decisions: ids.map((id) => ({ id, relation: "SAME_OCCURRENCE", confidence: 0.95, note: "" })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_MODEL = "deepseek-flash";

let storyId = 0;
let factId = 0;
const articles: string[] = [];

/** A report of the event: article, its analysis (the signed Chinese copy), its fact membership, its publication. */
async function report(suffix: string, joinFact: boolean) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/regroup-${T}-${suffix}`, title: `Bulletin ${T} ${suffix}`,
    bodyText: "A field bulletin.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${FACT_TITLE}, '一台站测定 5.2 级，震源深度 32 千米。', 80, false, ${sql.json({ fact: { title: FACT_TITLE } })})`;
  await publishArticle(articleId);
  if (joinFact) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${articleId}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${storyId}, ${articleId}, ${`source:${SOURCE}`}, ${SOURCE}, 'editorial', now())`;
  }
  articles.push(articleId);
  return articleId;
}

const waiting = async (articleId: string) =>
  (await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM regroup_pending WHERE article_id = ${articleId}`)[0]!.n;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test regroup', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${FACT_TITLE}, now(), now()) RETURNING id`;
  storyId = story!.id;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${'f' + T}, ${storyId}, ${FACT_TITLE}) RETURNING id`;
  factId = fact!.id;
  await report("seed", true);
});

after(async () => {
  await sql`DELETE FROM regroup_pending WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM grouping_decisions WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM story_signals WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM fact_articles WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await sql`DELETE FROM facts WHERE id = ${factId}`;
  await sql`DELETE FROM stories WHERE id = ${storyId}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a grouping decision that dies mid-flight leaves the report marked for a regroup", async () => {
  const articleId = await report("broken", false);
  fail = true;
  let thrown = "";
  try {
    await within(groupArticle(articleId), 30_000, "a failing grouping");
  } catch (error) {
    thrown = String(error);
  }
  assert.match(thrown, /refuses this request/, `分组调用失败要把错误抛回队列：${thrown || "没有抛出"}`);

  assert.equal(await waiting(articleId), "1", "失败的报道要留在 regroup_pending 里，否则没有任何东西会重新打开这个判断");
  const [row] = await sql<{ grouped_at: Date | null; n: string }[]>`
    SELECT a.grouped_at, (SELECT count(*)::text FROM fact_articles fa WHERE fa.article_id = a.id AND fa.role IN ('primary','report')) AS n
    FROM articles a WHERE a.id = ${articleId}`;
  assert.ok(row!.grouped_at, "报道照常发布，不被一次调用失败拖住");
  assert.equal(row!.n, "0", "但它还没有归属任何事实");
});

test("the marker is actionable: the next forced grouping decides it and clears it", async () => {
  const articleId = (await sql<{ id: string }[]>`SELECT article_id AS id FROM regroup_pending WHERE article_id = ANY(${articles}) LIMIT 1`)[0]!.id;
  fail = false;
  const result = await within(groupArticle(articleId, { force: true }), 30_000, "a regroup answer");
  assert.equal(result.verdict, "same-fact", `重新判断应并入已有事实，实际 ${result.verdict}`);
  assert.equal(await waiting(articleId), "0", "决定做过，标记就清掉");
});
