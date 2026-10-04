// A source may declare which section its items belong to (sources.default_category). Measured 2026-10-03:
// every one of the 100 freshest publicly listed items carried category = null, because the structure step
// answers nothing for a source the editorial pack has no judgement about — so they belonged to no section
// at all and the daily paper filed them all under its last section. The rule this file pins down: the
// declared section is a LAST RESORT. A model answer or a human override always wins, an unknown key is
// ignored (a stale row after a vocabulary change must not write a category no page knows), and a source
// that declares nothing behaves exactly as before.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const DECLARED = `${T}-declared`;
const PLAIN = `${T}-plain`;

const articles: string[] = [];

/** One published article from `source`, with the structure step's answer as given (null = no judgement). */
async function publish(sourceId: string, category: string | null, suffix: string) {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${suffix}`, title: `材料 ${T} ${suffix}`,
    bodyText: "测试正文。", bodyStatus: "ok", via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${`标称 ${T} 的标题`}, ${`${T} 的提要。`}, 60, false, ${sql.json({ fact: null })})`;
  await publishArticle(articleId);
  articles.push(articleId);
  const [row] = await sql<{ category: string | null }[]>`SELECT category FROM publications WHERE article_id = ${articleId}`;
  return row?.category ?? null;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at, default_category) VALUES
            (${DECLARED}, ${`默认分类源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', 'geopolitics'),
            (${PLAIN}, ${`无默认源 ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01', NULL)`;
});

after(async () => {
  await sql`DELETE FROM editorial_overrides WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${articles})`;
  await sql`DELETE FROM articles WHERE id = ANY(${articles})`;
  await sql`DELETE FROM sources WHERE id IN (${DECLARED}, ${PLAIN})`;
  await stopBoss();
  await closeDb();
});

test("no judgement from the structure step: the declared section is used", async () => {
  assert.equal(await publish(DECLARED, null, "a"), "geopolitics");
});

test("a model answer wins over the declared section", async () => {
  assert.equal(await publish(DECLARED, "physical", "b"), "physical", "声明的分类只是兜底，不能覆盖判断");
});

test("a human override wins over both", async () => {
  const id = randomUUID();
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, body_status, processing_state)
            VALUES (${id}, ${DECLARED}, ${`${T}-c`}, ${`https://example.com/${T}-c`}, ${`材料 ${T} c`}, now(), now(), 1, 'ok', 'analyzed')`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${id}, 1, 'rule', 'pass', NULL, ${`标称 ${T} 的标题`}, ${`${T} 的提要。`}, 60, false, ${sql.json({ fact: null })})`;
  await sql`INSERT INTO editorial_overrides (article_id, fields, visibility) VALUES (${id}, ${sql.json({ category: "geotech" })}, 'public')`;
  articles.push(id);
  await publishArticle(id);
  const [row] = await sql<{ category: string | null }[]>`SELECT category FROM publications WHERE article_id = ${id}`;
  assert.equal(row?.category, "geotech", "人工判断优先于来源声明");
});

test("a source that declares nothing is unchanged", async () => {
  assert.equal(await publish(PLAIN, null, "d"), null);
});

test("an unknown key is ignored instead of written", async () => {
  await sql`UPDATE sources SET default_category = 'no-such-key' WHERE id = ${DECLARED}`;
  try {
    assert.equal(await publish(DECLARED, null, "e"), null, "词表里没有的 key 不能进 publications");
  } finally {
    await sql`UPDATE sources SET default_category = 'geopolitics' WHERE id = ${DECLARED}`;
  }
});
