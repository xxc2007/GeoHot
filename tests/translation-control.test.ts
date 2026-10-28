// Production's cooperative per-invocation stop must survive the historical fair scheduler merge.
import { gate, purgeTagged, stub, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translateArticle, translatePending, translateQuotes } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), SOURCE = `test-translation-control-${T}`;
const quoteIds: string[] = [];
let asked = gate<void>(), release = gate<void>(), holding = false, malformed = false, echo = false;
let calls = 0;
const provider = await stub(async (_hit, req) => {
  const segments = JSON.parse(JSON.parse(req.body).messages[1].content).segments as string[];
  calls++;
  if (holding) { asked.open();await release.promise; }
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t: malformed && segments.length > 1 ? [] : segments.map(s => echo ? s : `中文译文${"完整中文词语".repeat(Math.max(1, Math.ceil(s.length * .3)))}。`) }) } }] };
});
process.env.TRANSLATE_MODEL = "deepseek-flash";
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
process.env.GEOHOT_TRANSLATE_CONCURRENCY = "3";

async function material(marker: string, short: boolean, quoted = false) {
  const blocks = ["First", "Second"].map(word => `${word} ${marker} ${T} ${"foreign words ".repeat(short ? 2 : 140)}`);
  const tweetId = `8${Date.now()}${Math.floor(Math.random() * 1000)}`;
  if (quoted) quoteIds.push(tweetId);
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${marker}`, title: `${marker} ${T}`, language: "en", bodyText: blocks.join("\n"), bodyHtml: blocks.map(p => `<p>${p}</p>`).join(""), bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(),
    ...(quoted ? { xPost: { tweetId, authorName: "Fixture", handle: "fixture", text: "Parent text", quoted: { text: `Quoted foreign statement ${marker} ${T}.`, url: `https://x.com/source/status/${tweetId}`, authorName: "Source", handle: "source" } } } : {}),
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','geotech',${`控制${T}${marker}`},'摘要','理由',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return { articleId, tweetId };
}
async function reset() {
  await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;
  if (quoteIds.length) await sql`DELETE FROM quote_translations WHERE tweet_id = ANY(${quoteIds}::text[])`;
  calls = 0;holding = false;malformed = false;echo = false;asked = gate<void>();release = gate<void>();
}
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES(${SOURCE},'Translation invocation control','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => {
  release.open();
  if (quoteIds.length) await sql`DELETE FROM quote_translations WHERE tweet_id = ANY(${quoteIds}::text[])`;
  await purgeTagged(T);await provider.close();await stopBoss();await closeDb();
});

test("an already stopped invocation starts no paid body or quote and consumes no attempt", async () => {
  await reset();
  const { articleId } = await material("already-stopped", false);
  const controller = new AbortController();controller.abort();
  assert.deepEqual(await translatePending({ signal: controller.signal }), { done: [], quotes: 0 });
  await assert.rejects(translateArticle(articleId, { deadlineAt: Date.now() - 1 }), /invocation stopped/);
  assert.equal(calls, 0);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length, 0);
});

for (const mode of ["signal", "deadline", "cap"]) for (const misaligned of [false, true]) {
  test(`${mode} stops the next ${misaligned ? 'half-batch' : 'batch'} but persists/reuses the sent answer`, async () => {
    await reset();
    const { articleId } = await material(`${mode}-${misaligned}`, misaligned);
    holding = true;malformed = misaligned;
    const controller = new AbortController(), realNow = Date.now;
    const running = translatePending({ limit: 1, signal: controller.signal,
      ...(mode === "deadline" ? { deadlineAt: realNow() + 60_000 } : {}),
      ...(mode === "cap" ? { budgetMs: 90 * 60_000, deadlineAt: realNow() + 90 * 60_000 } : {}),
    });
    try {
      await within(Promise.race([asked.promise, running.then(() => assert.fail("no sent request"))]), 20_000, "first paid fragment");
      if (mode === "signal") controller.abort();
      if (mode === "deadline") Date.now = () => realNow() + 61_000;
      if (mode === "cap") Date.now = () => realNow() + 50 * 60_000 + 1;
      holding = false;release.open();
      assert.deepEqual(await running, { done: [], quotes: 0 });
    } finally { Date.now = realNow;holding = false;release.open(); }
    assert.equal(calls, 1, "no later fragment / half buys a second request");
    const receipts = await sql`SELECT status,response FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.status, "received");
    assert.ok(receipts[0]!.response);
    assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${articleId}`).length, 0);
    const resumed = await translatePending({ limit: 1 });
    assert.equal(resumed.done[0]!.status, "translated", "fresh invocation in same process is not globally aborted");
    assert.equal(calls, misaligned ? 3 : 2, "original received response is reused");
  });
}

test("a quote sent before invocation abort still stores its answer and stops before the next quote", async () => {
  await reset();
  const first = await material("quote-first", true, true);
  await material("quote-second", true, true);
  const controller = new AbortController();holding = true;
  const running = translateQuotes({ signal: controller.signal, limit: 30 });
  try {
    await within(Promise.race([asked.promise, running.then(() => assert.fail("no quote request"))]), 20_000, "sent quoted text");
    controller.abort();holding = false;release.open();
    await assert.rejects(running, /invocation stopped/);
  } finally { holding = false;release.open(); }
  assert.equal(calls, 1);
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${first.tweetId}`).length, 1);
  const [receipt] = await sql`SELECT status FROM receipts WHERE subject=${`quote:${first.tweetId}`}`;
  assert.equal(receipt!.status, "received");
  assert.equal(await translateQuotes({ maxModelCalls: 1 }), 1, "next invocation reuses stored quote and advances");
  assert.equal(calls, 2);
});

test("invocation abort also stops the missing-block retry, retaining the original paid receipt", async () => {
  await reset();
  const { articleId } = await material("missing-retry", true);
  const controller = new AbortController();holding = true;echo = true;
  const running = translatePending({ limit: 1, signal: controller.signal });
  try {
    await within(asked.promise, 20_000, "sent original batch");
    controller.abort();holding = false;release.open();
    assert.deepEqual(await running, { done: [], quotes: 0 });
  } finally { holding = false;release.open(); }
  assert.equal(calls, 1);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length, 0);
  echo = false;
  const resumed = await translatePending({ limit: 1 });
  assert.equal(resumed.done[0]!.status, "translated");
  assert.equal(calls, 2, "first response replays, only missing retry is purchased");
});

test("the ordinary article-start budget does not become a batch cancellation deadline", async () => {
  await reset();
  await material("soft-budget", false);
  holding = true;
  const realNow = Date.now;
  const running = translatePending({ limit: 1, budgetMs: 5000 });
  try {
    await within(asked.promise, 20_000, "sent first long-body batch");
    Date.now = () => realNow() + 10_000;
    holding = false;release.open();
    const result = await running;
    assert.equal(result.done[0]!.status, "translated");
    assert.equal(calls, 2, "same article may finish its second batch beyond start budget");
  } finally { Date.now = realNow;holding = false;release.open(); }
});
