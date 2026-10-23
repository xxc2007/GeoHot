import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translateArticle, translatePending, TRANSLATE_PROMPT_VERSION } from "@aihot/backend/editorial/translate";
import { chatJson } from "@aihot/backend/providers/llm";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText } from "@aihot/backend/editorial/prompts";
import { z } from "zod";
import * as cheerio from "cheerio";

const T = tag();
const SOURCE = `test-long-body-${T}`;
const articleIds: string[] = [];
const requests: string[][] = [];
let echoLast = false;
let misaligned = false;
let inventTailNumber = false;
let corrupt: "html" | "token" | undefined;
let afterAnswer: (() => void | Promise<void>) | undefined;
let originalBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  requests.push(segments);
  await afterAnswer?.();
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t: misaligned && segments.length > 1 ? [] : segments.map(s =>
    inventTailNumber && s.includes("ADVERSARIAL_TAIL") ? '<span>完整正文译文 https://example.org/123tonnes 和 doi:10.1234/12metres，测量值 9999。</span>' : echoLast && s.includes("LEGACY_LAST") ? s : `${corrupt === "html" ? '<script>injected()</script>' : ''}完整正文译文${s.includes("UNIQUE_TAIL") ? "最后一段已译" : ""}。${"中文内容".repeat(Math.ceil(s.length / 10))}${corrupt === "token" ? "" : (s.match(/⟦G\d+⟧/g) ?? []).join("")}。`) }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});

async function primeLegacy(id: string, index: number, parts: string[], attemptTag?: string) {
  return chatJson({ model: await modelFor("translate", id), purpose: "translate_body", subject: `article:${id}@1#${index}`,
    promptVersion: TRANSLATE_PROMPT_VERSION, system: promptText("translate-body"), user: JSON.stringify({ segments: parts }),
    schema: z.object({ t: z.array(z.string()) }), temperature: 0.2,
    maxTokens: Math.min(8000, Math.ceil(parts.join("").length * 1.2) + 400), timeoutMs: 180_000, attemptTag });
}
test("new short tail rejects changed literal URLs DOI and measured numbers", async () => {
  const prefix = [...Array.from({length:19},(_,i)=>`Scientific prefix ${T} ${i} `.padEnd(3100,"x")), `Boundary ${T} `.padEnd(1000,"x")];
  const tail = "ADVERSARIAL_TAIL See https://example.org/123tonnes and doi:10.1234/12metres, measured 12.50. Short tail scientific observation.";
  const id = await selectedBody("short-tail-corruption", [...prefix,tail].map(s=>`<p>${s}</p>`).join(""));
  inventTailNumber = true;
  try { await translateArticle(id); } finally { inventTailNumber = false; }
  const [tr] = await sql`SELECT complete,body_html FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, false, "changed scientific values must never be marked complete");
  assert.equal(cheerio.load(tr!.body_html,null,false)("p").last().text(), tail);
});
test("new short tail preserves scientific text and inline DOM after valid translation", async () => {
  const prefix = [...Array.from({length:19},(_,i)=>`Scientific prefix ${T} ${i} `.padEnd(3100,"x")), `Boundary ${T} `.padEnd(1000,"x")];
  const url="https://example.org/123tonnes", doi="doi:10.1234/12metres";
  const tail=`<p class="scientific">UNIQUE_TAIL Study <a href="${url}" title="reference">Scientific river</a> ${url} and ${doi}, measured 12.50. More scientific observation data.</p>`;
  const id=await selectedBody("short-tail-valid", prefix.map(s=>`<p>${s}</p>`).join("")+tail);
  assert.equal((await translateArticle(id)).status,"translated");
  const [tr]=await sql`SELECT complete,body_html FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete,true);
  const last=cheerio.load(tr!.body_html,null,false)("p").last();
  assert.equal(last.find("a").length,1);
  assert.equal(last.find("a").attr("href"),url);
  for(const literal of [url,doi,"12.50"]) assert.ok(last.text().includes(literal),`immutable ${literal}`);
  const hits=provider.hits();
  await translateArticle(id);
  assert.equal(provider.hits(),hits,"completed short tail must reuse settled receipts");
});
for (const retry of [false, true]) test(`legacy last batch${retry ? " and retry" : ""} is sealed before new tail work`, async () => {
  const prefix = [...Array.from({ length: 19 }, (_, i) => (`Scientific legacy ${T} ${retry} ${i}. `).padEnd(3100, "x")), `LEGACY_LAST ${T} ${retry} `.padEnd(1000, "x")];
  const tail = `UNIQUE_TAIL Scientific river data ${T.replace(/\d/g, "x")} ${retry}. `.padEnd(200, "x");
  const id = await selectedBody(`sealed-${retry}`, [...prefix, tail].map(s => `<p>${s}</p>`).join(""));
  for (let i = 0; i < prefix.length; i++) {
    echoLast = retry && i === prefix.length - 1;
    await primeLegacy(id, i, [prefix[i]!]);
  }
  echoLast = false;
  if (retry) await primeLegacy(id, 0, [prefix.at(-1)!], "retry");
  const [before] = await sql`SELECT count(*)::int AS n FROM receipts WHERE subject ~ ${`^article:${id}@1#[0-9]+$`}`;
  requests.length = 0;
  assert.equal((await translateArticle(id)).status, "translated");
  assert.equal(requests.length, 1, "all old first/retry payloads must hit their original receipts");
  assert.deepEqual(requests[0], [tail], "the tail must never join or renumber the old final batch");
  const [after_] = await sql`SELECT count(*)::int AS n FROM receipts WHERE subject ~ ${`^article:${id}@1#[0-9]+$`}`;
  assert.equal(after_!.n, before!.n, "old numeric receipt namespace is immutable");
});

test("legacy failed group and its successful halves keep their original indexes and payloads", async () => {
  const prefix = Array.from({length:18}, (_,i) => `Legacy half ${T} ${i} `.padEnd(3100,'x'));
  const left = `Legacy left ${T} `.padEnd(1650,'x'), right = `Legacy right ${T} `.padEnd(1650,'x');
  const last = `Legacy end ${T} `.padEnd(500,'x'), tail = `New tail ${T.replace(/\d/g,"x")} `.padEnd(600,'x');
  const id = await selectedBody('halves', [...prefix,left,right,last,tail].map(s=>`<p>${s}</p>`).join(''));
  for(let i=0;i<prefix.length;i++)await primeLegacy(id,i,[prefix[i]!]);
  misaligned=true;
  try { await primeLegacy(id,18,[left,right]); } finally { misaligned=false; }
  await primeLegacy(id,19,[left]);await primeLegacy(id,20,[right]);await primeLegacy(id,21,[last]);
  requests.length=0;
  assert.equal((await translateArticle(id)).status,'translated');
  assert.deepEqual(requests,[[tail]],'old failed group and halves are cached; only new work dispatches');
});

test("a stop after the old cap settles the sent tail and resumes without rebuying", async () => {
  const id = await selectedBody("tail-stop", Array.from({ length: 24 }, (_, i) => `<p>Scientific river ${T} ${i}. ${"Measured discharge data. ".repeat(130)}</p>`).join(""));
  const controller = new AbortController();
  requests.length = 0;
  let chars = 0;
  let stopped = false;
  afterAnswer = () => {
    chars += requests.at(-1)!.join("").length;
    if (chars > 60000) { stopped = true; controller.abort(); }
  };
  try {
    await assert.rejects(translateArticle(id, { signal: controller.signal }), /translation invocation stopped/);
  } finally { afterAnswer = undefined; }
  assert.ok(stopped, "the provider must really reach work after the old cap");
  const before = requests.length;
  const [attempts] = await sql`SELECT count(*)::int AS n FROM translation_attempts WHERE article_id=${id}`;
  assert.equal(attempts!.n, 0);
  assert.equal((await translateArticle(id)).status, "translated");
  assert.ok(requests.length > before, "resume advances beyond the settled tail request");
  assert.equal(new Set(requests.map(parts => JSON.stringify(parts))).size, requests.length, "no paid payload was dispatched twice");
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

before(async () => {
  [originalBudget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  // This throwaway database receives only loopback fake-provider requests.
  await sql`UPDATE budgets SET per_minute=10000,per_hour=10000,per_day=10000 WHERE service='deepseek'`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES(${SOURCE},'Long body fixture','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => {
  if (articleIds.length) await sql`DELETE FROM receipts WHERE purpose='translate_body' AND subject LIKE ANY(${articleIds.map(id => `article:${id}@%`)}::text[])`;
  await purgeTagged(T);
  if (originalBudget) await sql`UPDATE budgets SET per_minute=${originalBudget.per_minute},per_hour=${originalBudget.per_hour},per_day=${originalBudget.per_day} WHERE service='deepseek'`;
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function selectedBody(name: string, body: string) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${T}/${name}`,
    title: `Long scientific bulletin ${name} ${T}`, bodyHtml: body, bodyText: body.replace(/<[^>]*>/g, ""),
    language: "en", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  articleIds.push(articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','geotech',${`长正文回归${T}`},'正文翻译回归摘要','已选',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

test("a body beyond 60000 characters reaches its tail and reuses paid batches on rerun", async () => {
  const body = Array.from({ length: 24 }, (_, i) => `<p>${i === 23 ? "UNIQUE_TAIL " : ""}Scientific river observations ${T} ${i}. ${"Measured flood discharge. ".repeat(120)}</p>`).join("");
  assert.ok(body.length > 60000);
  const id = await selectedBody("many-blocks", body);
  requests.length = 0;
  const result = await translateArticle(id);
  assert.equal(result.status, "translated", "the artificial whole-body cap must not leave a permanent partial");
  assert.ok(requests.some(parts => parts.some(s => s.includes("UNIQUE_TAIL"))), "the final source paragraph must really reach the provider");
  const [tr] = await sql`SELECT complete,body_html FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, true);
  assert.ok(tr!.body_html.includes("最后一段已译"));
  const before = requests.length;
  assert.equal((await translateArticle(id)).status, "translated");
  assert.equal(requests.length, before, "received receipts must cover every successful batch on rerun");
});

test("a first paragraph over 60000 characters is processed instead of terminal skipped", async () => {
  const id = await selectedBody("oversized-first", `<p>${T} ${"Scientific river observations with measured flood discharge. ".repeat(1100)}</p>`);
  requests.length = 0;
  const result = await translateArticle(id);
  assert.notEqual(result.status, "skipped", "an oversized first paragraph still contains translatable text");
  assert.ok(requests.length > 0);
  assert.ok(requests.every(parts => parts.every(s => s.length <= 3500)), "the new oversized path must bound each fragment");
  const [tr] = await sql`SELECT complete FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, true);
});

test("newly reached tail blocks above the provider batch size are bounded even below 60000", async () => {
  const prefix = [...Array.from({length:19},(_,i)=>`Bounded legacy ${T} ${i} `.padEnd(3100,'x')),`Boundary ${T} `.padEnd(1000,'x')];
  const tail = `Bounded new tail ${T} ${"Scientific discharge. ".repeat(240)}`;
  assert.ok(tail.length>3500 && tail.length<60000);
  const id=await selectedBody('bounded-tail',[...prefix,tail].map(s=>`<p>${s}</p>`).join(''));
  requests.length=0;
  assert.equal((await translateArticle(id)).status,'translated');
  assert.ok(requests.every(parts=>parts.every(s=>s.length<=3500)),'old short blocks stay unchanged and all new requests are bounded');
});

test("oversized text nodes preserve one anchor, protected numeric order, media, code and Unicode boundaries", async () => {
  const url = `https://example.org/paper/${T}?doi=10.1234/test`;
  const textUrl = `https://example.org/visible/${T}?x=12.50`;
  const longText = `${T} ${"River discharge 12.50 m3/s (2026). 😀e\u0301 ".repeat(1700)} ${textUrl} doi:10.1234/preserved.abc`;
  const id = await selectedBody("structure", `<p><a href="${url}" title="original">${longText}</a><img src="https://example.org/chart.png" alt="12"/><code>const science = 42; &lt;tag&gt;</code><span>Final source citation (17).</span></p>`);
  const [source] = await sql`SELECT body_html FROM articles WHERE id=${id}`;
  requests.length = 0;
  assert.equal((await translateArticle(id)).status, "translated");
  const [tr] = await sql`SELECT complete,body_html FROM translations WHERE article_id=${id}`;
  const before = cheerio.load(source!.body_html, null, false);
  const after_ = cheerio.load(tr!.body_html, null, false);
  assert.equal(after_("a").length, 1);
  assert.equal(after_("a").attr("href"), url);
  assert.deepEqual(after_("a").attr(), before("a").attr());
  assert.equal(after_("code").html(), before("code").html());
  assert.deepEqual(after_("img").attr(), before("img").attr());
  assert.equal(after_("script").length, 0);
  assert.ok(after_("a").text().includes(textUrl));
  assert.ok(after_("a").text().includes('doi:10.1234/preserved.abc'));
  assert.deepEqual(after_("a").text().match(/12\.50|2026/g), before("a").text().match(/12\.50|2026/g));
  assert.ok(requests.every(parts => parts.every(s => s.length <= 3500 && !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(s))));
  assert.ok(!requests.flat().some(s => s.includes("const science") || s.includes(url)), "attributes and code never enter text fragments");
});

for (const kind of ["html", "token"] as const) test(`oversized ${kind} corruption cannot become complete or terminal skipped`, async () => {
  const id = await selectedBody(`bad-${kind}`, `<p>${T} ${"Scientific river discharge 12.50 (17). ".repeat(1800)}</p>`);
  corrupt = kind;
  try { await assert.rejects(translateArticle(id), /no long-body fragment translated/); }
  finally { corrupt = undefined; }
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${id} AND complete`).length, 0);
});

for (const status of ["unknown", "pending"] as const) test(`a paid long-fragment ${status} refuses all renamed or split dispatch`, async () => {
  const id = await selectedBody(`reserved-${status}`, `<p>${T} ${status} ${"Scientific observation with discharge 12.50. ".repeat(1700)}</p>`);
  const controller = new AbortController();
  afterAnswer = () => { controller.abort(); };
  try { await assert.rejects(translateArticle(id, { signal: controller.signal }), /invocation stopped/); }
  finally { afterAnswer = undefined; }
  const [paid] = await sql`SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#long-v1:%`}`;
  assert.ok(paid);
  await sql`UPDATE receipts SET status=${status},updated_at=now() WHERE id=${paid!.id}`;
  const before = provider.hits();
  await assert.rejects(translateArticle(id), e => (e as Error).name === (status === "unknown" ? "ReceiptUnknownError" : "ReceiptBusyError"));
  assert.equal(provider.hits(), before);
  assert.equal((await sql`SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#long-v1:%`}`).length, 1);
});

test("a long-fragment receipt SQL failure propagates and retains paid reservation without resend", async () => {
  const id = await selectedBody("sql-refusal", `<p>${T} infrastructure ${"Scientific river observation 12.50. ".repeat(1900)}</p>`);
  await sql.unsafe(`CREATE FUNCTION test_long_fragment_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.status='received' AND NEW.subject LIKE 'article:${id}@1#long-v1:%' THEN RAISE EXCEPTION 'fixture SQL failure' USING ERRCODE='57014'; END IF; RETURN NEW; END$$`);
  await sql.unsafe('CREATE TRIGGER test_long_fragment_fail BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION test_long_fragment_fail()');
  const hits = provider.hits();
  try { await assert.rejects(translateArticle(id), e => (e as { code?: string }).code === '57014'); }
  finally { await sql.unsafe('DROP TRIGGER test_long_fragment_fail ON receipts'); await sql.unsafe('DROP FUNCTION test_long_fragment_fail()'); }
  assert.equal(provider.hits() - hits, 1);
  const [paid] = await sql`SELECT r.status,a.billing_status FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject LIKE ${`article:${id}@1#long-v1:%`}`;
  assert.deepEqual([paid!.status,paid!.billing_status], ['pending','reserved']);
  await assert.rejects(translateArticle(id), e => (e as Error).name === 'ReceiptBusyError');
  assert.equal(provider.hits() - hits, 1);
});

for (const origin of ['source','model'] as const) test(`an in-flight long body cannot replace a newer ${origin} translation`, async () => {
  const id = await selectedBody(`revision-${origin}`, `<p>${T} ${origin} ${"Scientific river observation 12.50. ".repeat(1900)}</p>`);
  let changed = false;
  afterAnswer = async () => {
    if (changed) return;changed = true;
    await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
    await sql`INSERT INTO translations(article_id,lang,revision,title,body_html,body_text,complete,origin)
      VALUES(${id},'zh',2,'较新译文','<p>应当保留的较新正文。</p>','应当保留的较新正文。',true,${origin})`;
  };
  try { assert.equal((await translateArticle(id)).revision, 1); }
  finally { afterAnswer = undefined; }
  const [tr] = await sql`SELECT revision,origin,body_text FROM translations WHERE article_id=${id}`;
  assert.deepEqual({ ...tr }, { revision: 2, origin, body_text: '应当保留的较新正文。' });
});

test("the invocation fifty-minute cap stops oversized work without spending an attempt", async () => {
  await sql`UPDATE publications SET selected=false WHERE article_id IN(SELECT id FROM articles WHERE source_id=${SOURCE})`;
  const id = await selectedBody("fifty-minute-cap", `<p>${T} deadline ${"Scientific river observation 12.50. ".repeat(1900)}</p>`);
  const realNow = Date.now;
  const hits = provider.hits();
  afterAnswer = () => { Date.now = () => realNow() + 50 * 60000 + 1; };
  try { assert.deepEqual(await translatePending({ limit: 1, budgetMs: 90 * 60000 }), { done: [], quotes: 0 }); }
  finally { Date.now = realNow;afterAnswer = undefined; }
  assert.equal(provider.hits() - hits, 1);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${id}`).length, 0);
  assert.equal((await translatePending({ limit: 1 })).done[0]!.status, 'translated');
  const [tr] = await sql`SELECT complete FROM translations WHERE article_id=${id}`;
  assert.equal(tr!.complete, true);
});

test("three actual unusable long-body outcomes remain bounded without clearing old attempts", async () => {
  await sql`UPDATE publications SET selected=false WHERE article_id IN(SELECT id FROM articles WHERE source_id=${SOURCE})`;
  const id = await selectedBody('three-bad', `<p>${T} actual-bad ${"Scientific observation 12.50. ".repeat(2300)}</p>`);
  corrupt='html';
  try {
    for(let i=1;i<=3;i++) {
      await translatePending({limit:1});
      const [a]=await sql`SELECT attempts,outcome FROM translation_attempts WHERE article_id=${id}`;
      assert.deepEqual({...a},{attempts:i,outcome:'failed'});
    }
    const calls=provider.hits();
    assert.deepEqual(await translatePending({limit:1}),{done:[],quotes:0});
    assert.equal(provider.hits(),calls);
  } finally {corrupt=undefined;}
  const [attempt]=await sql`SELECT attempts FROM translation_attempts WHERE article_id=${id}`;
  assert.equal(attempt!.attempts,3);
});

test("new fragment polishing never rewrites protected literal DOI URL or scientific numeric text", async () => {
  const url=`https://example.org/${T}/123tonnes`,doi=`doi:10.1234/${T}/12metres`;
  const id=await selectedBody('immutable-polish',`<p>Scientific repository ${url} and ${doi} ${"River observation and discharge study. ".repeat(1900)}</p>`);
  assert.equal((await translateArticle(id)).status,'translated');
  const [tr]=await sql`SELECT body_html,complete FROM translations WHERE article_id=${id}`;
  const text=cheerio.load(tr!.body_html,null,false).root().text();
  assert.ok(text.includes(url),'URL spelling is immutable after all polishing');
  assert.ok(text.includes(doi),'DOI spelling is immutable after all polishing');
  assert.equal(tr!.complete,true);
});
