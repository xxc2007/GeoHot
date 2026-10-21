import { gate, purgeTagged, stub, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translatePending, translateQuotes } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), SOURCE = `test-translation-fair-${T}`;
const quoteIds: string[] = [];
let holding = false, active = 0, peak = 0;
let release = gate<void>();
let quoteRelease = gate<void>();
let shortStarted = gate<void>();
let starts = gate<void>();
const seen: string[] = [];
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body);
  const segments = JSON.parse(body.messages[1].content).segments as string[];
  const marker = segments.join(" ").match(/MARK_[a-z]+/)?.[0] ?? "unknown";
  seen.push(marker);active++;peak = Math.max(peak, active);
  if (marker === "MARK_short") shortStarted.open();
  if (active === 3) starts.open();
  if (holding) await (marker === "MARK_quoteparallel" ? quoteRelease.promise : release.promise);
  active--;
  if (marker === "MARK_badquote") return { id: "stub", choices: [{ message: { content: "not JSON" } }] };
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t: segments.map(s => `中文译文${"词".repeat(Math.max(1, Math.ceil(s.length * .3)))}。`) }) } }] };
});
process.env.TRANSLATE_MODEL = "deepseek-flash";
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
process.env.GEOHOT_TRANSLATE_CONCURRENCY = "3";

async function article(marker: string, discovered: Date, size = 100, quote?: string) {
  const text = `MARK_${marker} ${T} ${"English words ".repeat(size)}`;
  const tweetId = `9${Date.now()}${Math.floor(Math.random() * 1000)}`;
  if (quote) quoteIds.push(tweetId);
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${marker}`, title: `Material ${T} ${marker}`, language: "en", bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: "ok", via: "import", discoveredAt: discovered, publishedAt: discovered,
    ...(quote ? { xPost: { tweetId, text, authorName: "Fixture author", handle: "fixture", quoted: { text: `MARK_${quote} Quoted foreign bulletin ${T}.`, url: `https://x.com/source/status/${tweetId}`, authorName: "Fixture source", handle: "source" } } } : {}),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','geotech',${`材料${T}${marker}`},'摘要','理由',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return { articleId, tweetId };
}
async function reset() {
  if (quoteIds.length) await sql`DELETE FROM quote_translations WHERE tweet_id = ANY(${quoteIds}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;
  seen.length = 0;active = 0;peak = 0;holding = false;release = gate<void>();quoteRelease = gate<void>();shortStarted = gate<void>();starts = gate<void>();
}
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
   VALUES(${SOURCE},'Translation fairness','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => {
  release.open();quoteRelease.open();
  if (quoteIds.length) await sql`DELETE FROM quote_translations WHERE tweet_id = ANY(${quoteIds}::text[])`;
  await purgeTagged(T);await provider.close();await stopBoss();await closeDb();
});

test("explicit historical cutoff includes old body and old quote, keeps source copy and exact boundary", async () => {
  await reset();
  const boundary = new Date("2025-12-31T16:00:00Z");
  const a = await article("boundary", boundary, 5, "quote");
  const outside = await article("outside", new Date(boundary.getTime() - 1), 5);
  const owned = await article("source", boundary, 5);
  await sql`INSERT INTO translations(article_id,lang,revision,title,body_html,body_text,complete,origin)
    VALUES(${owned.articleId},'zh',1,'源译文','<p>已有源译文</p>','已有源译文',true,'source')`;
  assert.deepEqual(await translatePending({ limit: 10 }), { done: [], quotes: 0 });
  const result = await translatePending({ limit: 10, from: "2026-01-01" });
  assert.equal(result.quotes, 1);
  assert.deepEqual(result.done.map(r => r.articleId), [a.articleId]);
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${outside.articleId}`).length, 0);
  assert.equal((await sql`SELECT origin FROM translations WHERE article_id=${owned.articleId}`)[0]!.origin, 'source');
});

test("quote begins alongside busy bodies within the same three lanes, old/short get early body turns", async () => {
  await reset();
  const now = Date.now();
  await article("old", new Date("2026-01-01T12:00:00Z"), 120);
  await article("fresh", new Date(now + 3000), 110);
  await article("short", new Date(now + 1000), 5);
  await article("parent", new Date(now + 2000), 100, "quoteparallel");
  holding = true;
  const running = translatePending({ limit: 4, from: "2026-01-01" });
  try {
    await within(Promise.race([starts.promise, running.then(() => assert.fail("ended before three held requests"))]), 20_000, "quote plus two bodies to start");
    assert.equal(peak, 3);
    assert.ok(seen.slice(0, 3).includes("MARK_quoteparallel"));
    assert.ok(seen.slice(0, 3).includes("MARK_old"));
    assert.ok(seen.slice(0, 3).includes("MARK_fresh"));
    // Release ONLY the quote. Both long bodies remain blocked; its reused lane must start short.
    quoteRelease.open();
    await within(Promise.race([shortStarted.promise, running.then(() => assert.fail("short never started"))]), 20_000, "short body in reused quote lane");
    assert.equal(active, 3, "old and fresh still held while short starts");
    assert.equal(seen[3], "MARK_short");
  } finally { holding = false;release.open();quoteRelease.open(); }
  await running;
  assert.ok(peak <= 3);
});

test("quotes have a dispatch cap distinct from stored count", async () => {
  await reset();
  await article("parentone", new Date(), 5, "quoteone");
  await article("parenttwo", new Date(), 5, "quotetwo");
  const hits = provider.hits();
  assert.equal(await translateQuotes({ limit: 30, maxModelCalls: 1 }), 1);
  assert.equal(provider.hits() - hits, 1);
});

test("failed quotes cannot spend a second dispatch just because no result was stored", async () => {
  await reset();
  await article("parentbad", new Date(Date.now() - 1000), 5, "badquote");
  await article("parentgood", new Date(), 5, "goodquote");
  const hits = provider.hits();
  assert.equal(await translateQuotes({ limit: 30, maxModelCalls: 1 }), 0);
  assert.equal(provider.hits() - hits, 1);
});

test("a soft deadline stops later work while allowing all three already sent requests to settle", async () => {
  await reset();
  await article("deadlineone", new Date(Date.now() + 3000), 5);
  await article("deadlinetwo", new Date(Date.now() + 2000), 6);
  await article("deadlinethree", new Date(Date.now() + 1000), 7, "deadlinequote");
  holding = true;
  const realNow = Date.now;
  const running = translatePending({ limit: 3, budgetMs: 5000 });
  try {
    await within(Promise.race([starts.promise, running.then(() => assert.fail("no three active requests"))]), 20_000, "three initial requests");
    Date.now = () => realNow() + 10_000;
    holding = false;release.open();
    const result = await running;
    assert.equal(seen.length, 3, "no fourth paid request after the soft deadline");
    assert.equal(result.quotes, 1);
    assert.equal(result.done.length, 2);
  } finally { Date.now = realNow;holding = false;release.open(); }
});

for (const status of ["unknown", "pending"]) test(`a ${status} quote yields its unpaid opportunity to another quote`, async () => {
  await reset();
  const first = await article(`parent${status}`, new Date(Date.now() - 1000), 5, `quote${status}`);
  await translateQuotes({ maxModelCalls: 1 });
  await sql`DELETE FROM quote_translations WHERE tweet_id=${first.tweetId}`;
  await sql`UPDATE receipts SET status=${status}, updated_at=now() WHERE subject=${`quote:${first.tweetId}`}`;
  await article(`other${status}`, new Date(), 5, `quotenext${status}`);
  const hits = provider.hits();
  assert.equal(await translateQuotes({ limit: 1, maxModelCalls: 1 }), 1);
  assert.equal(provider.hits() - hits, 1, "receipt wait itself makes zero upstream calls");
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${first.tweetId}`).length, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`quote:${first.tweetId}`}`)[0]!.status, status);
});

for (const status of ["unknown", "pending"]) test(`a ${status} body receipt defers without another call or consuming attempts`, async () => {
  await reset();
  const { articleId } = await article(`deferred${status}`, new Date(), 5);
  await translatePending({ limit: 1 });
  await sql`DELETE FROM translations WHERE article_id=${articleId}`;
  await sql`DELETE FROM translation_attempts WHERE article_id=${articleId}`;
  await sql`UPDATE receipts SET status=${status}, updated_at=now() WHERE subject LIKE ${`article:${articleId}@1#%`}`;
  const hits = provider.hits();
  assert.deepEqual(await translatePending({ limit: 1 }), { done: [], quotes: 0 });
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`)[0]!.status, status);
});

test("exhausted and terminal current revisions stay protected; old-revision attempts do not block new text", async () => {
  await reset();
  const exhausted = await article("exhausted", new Date(), 5);
  const terminal = await article("terminal", new Date(), 5);
  const revised = await article("newrevision", new Date(), 5);
  await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome)
    VALUES(${exhausted.articleId},1,3,'partial'),(${terminal.articleId},1,1,'skipped'),(${revised.articleId},0,3,'failed')`;
  const result = await translatePending({ limit: 10 });
  assert.deepEqual(result.done.map(r => r.articleId), [revised.articleId]);
  assert.equal((await sql`SELECT attempts FROM translation_attempts WHERE article_id=${exhausted.articleId}`)[0]!.attempts, 3);
  assert.equal((await sql`SELECT outcome FROM translation_attempts WHERE article_id=${terminal.articleId}`)[0]!.outcome, 'skipped');
  const [fresh] = await sql`SELECT revision,attempts,outcome FROM translation_attempts WHERE article_id=${revised.articleId}`;
  assert.deepEqual({ ...fresh }, { revision: 1, attempts: 1, outcome: 'translated' });
});
