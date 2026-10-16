// Full-text translations follow the text: an article corrected while the model was translating the old
// wording is translated again, and a translation of an older revision is never shown as the current one.
// Links and images inside a paragraph survive the model, and the post an X item quotes is translated.
import { gate, purgeTagged, stub, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { translateConcurrency, translatePending, translateWindowDays } from "@aihot/backend/editorial/translate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-translate-${T}`;
const URL_ = `https://example.com/translate-${T}`;

// The model: one Chinese sentence per segment. `hold` keeps an answer back while the test revises the text.
let hold: ReturnType<typeof gate<void>> | null = null;
const asked = gate();
const asks = new Map<string, number>();
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  // 一块答坏 ≠ 整篇作废：带 Poison 的那一批故意交回非 JSON，让生产代码必须在"块"这一级隔离它。
  if (segments.some((s) => s.includes("Poison"))) {
    return { id: "stub", choices: [{ message: { content: "这一次模型没有交回 JSON" } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  }
  if (hold) {
    asked.open();
    await hold.promise;
  }
  const t = segments.map((s) => {
    // A block with a link and an image: the first answer drops the link, the second keeps everything.
    if (s.includes("Sentinel-2")) {
      const n = (asks.get(s) ?? 0) + 1;
      asks.set(s, n);
      return n === 1 ? "解释 Sentinel-2 的文字 ⟦0⟧。" : '解释 <a id="L0">Sentinel-2</a> 的文字 ⟦0⟧。';
    }
    if (s.includes("never keeps")) return "丢了链接。";
    if (s.includes("Magnitude revised")) return "震级修订为 7.2 级。";
    return s.includes("twenty") ? "价格是二十美元。" : s.includes("ten") ? "价格是十美元。" : "译文";
  });
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ t }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
const app = await buildApp();

// Discovered "later" than anything else in the test database, so a one-item run takes this article. The
// tag keeps the text unique: identical input would reuse an earlier run's paid answer.
const material = (price: string) =>
  upsertMaterial({
    sourceId: SOURCE, url: URL_, title: `Price update ${T}`, language: "en", bodyText: `The price is ${price} dollars (${T}).`,
    bodyHtml: `<p>The price is ${price} dollars (${T}).</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 600_000),
  });

async function detail(id: string) {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body) as { body: { zh: string | null; original: string | null; complete: boolean } };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test translate', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
});
after(async () => {
  // Clean up: this file's materials are discovered "later" than anything else so `translatePending` picks
  // them; left behind they also outrank every later test in the home timeline's anchors (2026-10-03: a day
  // of runs left 46 future-anchored selected rows in the shared database, and publication-copy-gate's
  // front-page assertions began failing on pool composition alone).
  await purgeTagged(T);
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a text corrected while its translation was running is translated again, and the old translation is not shown", async () => {
  const { articleId: id } = await material("ten");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`价格更新-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  // The model is asked about revision 1; the source corrects the price before it answers.
  hold = gate();
  const running = translatePending({ limit: 1 });
  await within(Promise.race([asked.promise, running.then(() => assert.fail("the run ended without asking the model"))]), 30_000, "the model to be asked");
  const revised = await material("twenty");
  assert.equal(revised.revised, true);
  hold.open();
  hold = null;
  await running;

  const [attempt] = await sql<{ revision: number; outcome: string }[]>`SELECT revision, outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.deepEqual({ ...attempt }, { revision: 1, outcome: "translated" }, "the attempt is booked on the revision translated");
  const stale = await detail(id);
  assert.equal(stale.body.zh, null, "a translation of the old wording is not shown");
  assert.ok(stale.body.original?.includes("twenty"));

  await translatePending({ limit: 1 });
  const [tr] = await sql<{ revision: number }[]>`SELECT revision FROM translations WHERE article_id = ${id}`;
  assert.equal(tr?.revision, 2, "the corrected text is translated on the next run");
  const current = await detail(id);
  assert.ok(current.body.zh?.includes("二十美元") && current.body.complete, "the page shows the translation of the corrected text");
});

test("links and images inside a paragraph survive the translation, or the paragraph stays in the original", async () => {
  // The Copernicus product note lost its link to the Sentinel-2 docs; an ice-sheet post lost two charts.
  const html = `<p>Explaining <a href="https://sentinel2.docs/overview">Sentinel-2</a> in text ${T} <img src="https://example.com/chart-${T}.png" alt="ICESat-2 elevations"></p>` +
    `<p>A paragraph the model <a href="https://example.com/kept">never keeps</a> whole ${T}.</p>`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-links`, title: `Links ${T}`, language: "en", bodyText: `Explaining Sentinel-2. ${T}`, bodyHtml: html,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 1_200_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`链接-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  await translatePending({ limit: 1 });
  const [tr] = await sql<{ body_html: string; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.ok(tr!.body_html.includes('<a href="https://sentinel2.docs/overview">Sentinel-2</a>'), tr!.body_html);
  assert.ok(tr!.body_html.includes(`chart-${T}.png`), "the chart stays");
  assert.ok(tr!.body_html.includes('<a href="https://example.com/kept">never keeps</a>'), "a paragraph that loses its link stays in the original");
  assert.equal(tr!.complete, false);
});

test("the post a selected X post quotes is translated once and shown with the item", async () => {
  // A quake watcher's post quoting USGS's own revised-magnitude bulletin. The quoted text is the segment the
  // stub maps to its own sentence below, so the answer proves the *quote* was written by the model.
  const tweetId = `7${Date.now()}`;
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `https://x.com/quakewatch/status/8${Date.now()}`, title: `USGS bulletin ${T}`, language: "en", bodyText: "Worth reading.", bodyStatus: "ok",
    via: "fetch", publishedAt: new Date(), discoveredAt: new Date(Date.now() + 1_800_000),
    xPost: { tweetId: `8${Date.now()}`, authorName: "Quake Watch", handle: "quakewatch", text: "Worth reading.", quoted: { authorName: "USGS", handle: "USGS", text: `Magnitude revised to 7.2 ${T}`, url: `https://x.com/USGS/status/${tweetId}` } },
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`引用-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });
  const run = await translatePending({ limit: 1 });
  assert.ok(run.quotes >= 1);
  const [q] = await sql<{ text_zh: string; origin: string }[]>`SELECT text_zh, origin FROM quote_translations WHERE tweet_id = ${tweetId}`;
  assert.deepEqual({ ...q }, { text_zh: "震级修订为 7.2 级。", origin: "model" });
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  const item = JSON.parse(res.body) as { x: { quoted: { text: string; translation: string | null } } };
  assert.deepEqual([item.x.quoted.text, item.x.quoted.translation], [`Magnitude revised to 7.2 ${T}`, "震级修订为 7.2 级。"]);
  await translatePending({ limit: 1 });
  const receipts = await sql`SELECT 1 FROM receipts WHERE purpose = 'translate_quoted' AND subject = ${`quote:${tweetId}`}`;
  assert.equal(receipts.length, 1, "translated once");
});

// 窗口决定"英文版还能不能拿到中文版"。2026-10-16 打开 260 道全文门后实测：精选外文条目里 3–7 天档
// 1,786 条、7–30 天档 217 条**一条译文都没有**——不是翻译失败，是待翻查询按 3 天窗口挑活，而这一腿
// 单条串行 ≈36 条/时，3 天窗口永远追不上存量。默认值于是跟着重投影的口径走（30 天），并且乱填的环境
// 变量不许把这一腿整个关掉（NaN / 0 / 负数都退回默认）。
test("the translation window covers the backlog it exists to clear, and a bad env value cannot shut it off", () => {
  assert.equal(translateWindowDays(undefined), 30, "默认 30 天，与 scripts/republish-fulltext.ts 同一口径");
  assert.equal(translateWindowDays(""), 30);
  assert.equal(translateWindowDays("abc"), 30, "垃圾值不许变成 NaN 把窗口筛成空集");
  assert.equal(translateWindowDays("0"), 30, "0 天等于关掉这一腿");
  assert.equal(translateWindowDays("-5"), 30, "负数同理");
  assert.equal(translateWindowDays("7.9"), 7, "小数向下取整");
  assert.equal(translateWindowDays("7"), 7, "要省钱可以收紧");
  assert.equal(translateWindowDays("3"), 3, "旧值仍可表达");
  // 并发只解决"一轮能开几篇"，钳位是为 240 MB 的 worker 留的硬顶。
  assert.equal(translateConcurrency(undefined), 3, "默认 3 路");
  assert.equal(translateConcurrency(""), 3);
  assert.equal(translateConcurrency("abc"), 3);
  assert.equal(translateConcurrency("0"), 3, "0 会退化成不翻，按默认处理");
  assert.equal(translateConcurrency("-2"), 3);
  assert.equal(translateConcurrency("2"), 2);
  assert.equal(translateConcurrency("99"), 6, "超过 6 一律压到 6");
  // 上面那些只证明了这个函数本身；真正咬人的是"待翻查询有没有走它"。这一段读的是源码文本，理由与
  // admin-source-policy.test.ts 相同：这是不建夹具、不抢共享库里那些未来时间锚点，就能抓住"有人把
  // SQL 改回写死 3 天"的唯一一层。
  const src = readFileSync(new URL("../packages/backend/src/editorial/translate.ts", import.meta.url), "utf8");
  const pending = /FROM publications p JOIN articles a[\s\S]*?LIMIT \$\{opts\.limit/.exec(src)?.[0] ?? "";
  assert.ok(pending, "translatePending 的待翻查询还是那个形状（改了形状就同步改这条断言）");
  assert.match(pending, /now\(\) - \$\{TRANSLATE_WINDOW_DAYS\} \* interval '1 day'/, "窗口必须走那个变量");
  assert.equal(/interval '\d+ days'/.test(pending), false, "查询里不许再出现写死的天数窗口（`${窗口} * interval '1 day'` 那种写法不算）");
});

// 2026-10-16 实测 12 小时 116 次 translate_body 调用：<180 s 的 107 次全部 received，≥180 s 的 9 次全挂。
// 而折半重试当时只挂在"答复条数对不上"上——chatJson 抛出（超时、非 JSON 的答复、超过 30 分钟被自动放行
// 的 unknown）时异常直接穿出 translateAll，整篇一块都没入库，还要占掉三次尝试里的一次。长正文批次多，
// 于是被钉死的全是长正文：pinned_failed 正文 p50 20,136 字，translated 只有 3,135 字。
// 夹具刻意把三段各写满 ≈1,800 字：BATCH_CHARS 是 3,500，一段装得下、两段就超，于是三块真的是三个批次
// ——短正文会被贪心装进同一批，那种"坏一块"根本没有别的批次可救，证明不了这条腿。
test("a batch the model answers badly does not throw away the blocks already translated", async () => {
  const para = (marker: string) => `${marker} moraine survey ${T} `.repeat(110).trim();
  const html = ["Alpha", "Poison", "Gamma"].map((m) => `<p>${para(m)}</p>`).join("");
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-bad-batch`, title: `Bad batch ${T}`, language: "en",
    bodyText: `Alpha Poison Gamma ${T}`, bodyHtml: html, bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(), discoveredAt: new Date(Date.now() + 2_400_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`坏批-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  const run = await translatePending({ limit: 1 });
  assert.equal(run.done[0]?.status, "partial", "坏掉那一块不该把整篇打成 failed");
  assert.equal(run.done[0]?.segments, 2, "另外两批是翻出来了的");
  assert.equal(run.done[0]?.reason, "1 of 3 blocks kept in the original", "没翻出来几块要看得见，不然账上只剩 partial");

  const [tr] = await sql<{ body_html: string; complete: boolean }[]>`SELECT body_html, complete FROM translations WHERE article_id = ${id}`;
  assert.ok(tr, "已经付过费的答复必须入库，而不是随异常一起丢掉");
  assert.ok(!tr!.body_html.includes("Alpha moraine survey"), "第一批不再留英文");
  assert.ok(!tr!.body_html.includes("Gamma moraine survey"), "第三批不再留英文");
  assert.equal(tr!.body_html.split("译文").length - 1, 2, "两批的答复都进了正文");
  assert.ok(tr!.body_html.includes("Poison moraine survey"), "坏掉那块保留原文，不猜、不空");
  assert.equal(tr!.complete, false, "缺一块就不能说整篇翻完了");

  const [at] = await sql<{ outcome: string }[]>`SELECT outcome FROM translation_attempts WHERE article_id = ${id}`;
  assert.equal(at!.outcome, "partial", "终态是 partial 而不是 failed：下一次运行不该再从三次尝试里扣一次");
});

// 上一条把"坏一块"救回来了，这一条守它反面：整篇一块都没翻出来时不许写终态。
// `skipped` 与 `partial` 都会把条目从待翻查询里永久排除（translatePending 的 NOT EXISTS），
// 批次错误被折成 null 之后 `done === 0` 变得可达——一门被墙死的时段里，每一篇都会这样，
// 于是"这一轮什么也没翻成"会把条目永久钉成 skipped，而不是留三次机会。
test("an article whose every batch errored is not booked as terminal", async () => {
  const { articleId: id } = await upsertMaterial({
    sourceId: SOURCE, url: `${URL_}-all-bad`, title: `All bad ${T}`, language: "en",
    bodyText: `Poison only ${T}.`, bodyHtml: `<p>Poison only ${T}.</p>`, bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(), discoveredAt: new Date(Date.now() + 3_000_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${id}, 1, 'rule', 'pass', 'geotech', ${`全坏-${T}`}, '摘要', '理由', 90, true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60_000) });

  await translatePending({ limit: 1 });
  const [tr] = await sql`SELECT 1 AS one FROM translations WHERE article_id = ${id}`;
  assert.equal(tr, undefined, "没有任何答复就不该有译文行");
  const [at] = await sql<{ outcome: string; attempts: number }[]>`SELECT outcome, attempts FROM translation_attempts WHERE article_id = ${id}`;
  assert.equal(at!.outcome, "failed", "记 failed：下一次运行还能再来，最多三次（skipped 与 partial 都是终态，会把条目永久钉住）");
  assert.equal(at!.attempts, 1);
});
