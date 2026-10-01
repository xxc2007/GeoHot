// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, two scores
// against the tier threshold decide 精选, selected and near-selected items are written by the content
// understanding and the rest by the title/summary prompts, a structure step gives the category, subjects
// and fact. Material with only a feed summary has its page fetched first. The steps run on the models
// AIHOT assigns them (set through the environment here); every prompt in the pack renders.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, SCORE_SYSTEM, tierThreshold } from "@aihot/backend/editorial/analyze";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, parseTranslateOutput, PREFILTER_SYSTEM, UNDERSTAND_SYSTEM } from "@aihot/backend/editorial/writing";
import { promptText } from "@aihot/backend/editorial/prompts";
import { SITE } from "@aihot/industry/site";
import { SELECTION } from "@aihot/industry/selection";

const T = tag();
const SOURCE = `test-analyze-${T}`;
const X_SOURCE = `test-analyze-x-${T}`;

type Step = "prefilter" | "score" | "understand" | "summarize" | "structure";
interface Req { step: Step; marker: string; system: string; user: string; body: Record<string, any> }
const requests: Req[] = [];
const MARKERS = ["CLEAR", "RESCUE", "LOW", "OFFTOPIC", "NOISE", "BARE", "VAGUE", "THIN", "SENSITIVE", "推文"];
const scoreAnswers: Record<string, number[]> = { CLEAR: [78, 72], RESCUE: [56, 50], LOW: [45, 40], THIN: [70, 70], SENSITIVE: [80, 80], 推文: [40, 40], BARE: [30, 34], VAGUE: [60, 62] };

// The steps are told apart by the exact system prompt the code sends, never by a wording copied into this
// file: rewording a prompt then stops this stub answering (loudly) instead of silently routing everything
// to one branch. The summarize prompt is a single user message, so it is the only one without a system.
const SYSTEM_STEPS: Array<[Step, string]> = [["prefilter", PREFILTER_SYSTEM], ["score", SCORE_SYSTEM], ["understand", UNDERSTAND_SYSTEM]];
const stepOf = (system: string, user: string): Step => {
  const known = SYSTEM_STEPS.find(([, text]) => system === text);
  if (known) return known[0];
  if (user.includes("title_zh")) return "summarize";
  if (system) return "structure";
  throw new Error("unknown request");
};

// One stub stands in for DashScope (prefilter, structure), Zhipu (score, understand) and DeepSeek (summarize).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> } & Record<string, any>;
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, system, user, body });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: marker === "OFFTOPIC" || marker === "NOISE" || marker === "BARE" ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: scoreAnswers[marker]!.shift() });
  if (step === "understand") {
    if (marker === "SENSITIVE") return new Reply(400, { contentFilter: [{ level: 1, role: "user" }], error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容" } });
    return answer({ itemType: "disaster_event", authorRole: "principal", tags: ["灾害事件", "预警", "地震", "不存在的标签"], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  }
  if (step === "structure") return answer({ category: "physical", tags: ["观测/数据发布", "震情"], subjects: ["cenc", "unknown-co"], fact: { title: `事实 ${marker}`, subject: "某台网", action: "测定", object: "震级", occurredAt: null } });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";
// AIHOT's own assignment of models to steps (the open-source default is one model for all of them).
Object.assign(process.env, { PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection", UNDERSTAND_MODEL: "glm-5.3-flash", SUMMARIZE_MODEL: "deepseek-flash", STRUCTURE_MODEL: "qwen3.8-flash" });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${X_SOURCE}, 'Test X account', 'x_search', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a seismic network issued a bulletin with magnitude, depth and a shake map. ".repeat(8);
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} earthquake bulletin ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; title_zh: string; reason_zh: string | null; category: string | null; tags: string[]; subjects: string[]; receipt_ids: string[]; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;

test("every prompt in the pack renders, and the site's name replaces AIHOT's", () => {
  const dir = new URL("../industry/prompts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Every value any prompt asks for, so each renders on its own.
  const names = new Set(files.flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)].map((m) => m[1]!)));
  const values = Object.fromEntries([...names].map((n) => [n, "x"]));
  for (const file of files) {
    const text = promptText(file.slice(0, -3), values);
    assert.ok(text.length > 20 && !/\{\{/.test(text), file);
  }
  // The prefilter's own sentence belongs to the industry pack, so nothing is copied out of it here: what
  // the code must do is open by naming THIS site (never the sample site) and carry no leftover wording
  // from the sample industry. Rewording the prompt therefore cannot turn this line into a tripwire.
  assert.ok(PREFILTER_SYSTEM.startsWith(`为${SITE.name}`), "the prefilter opens by naming this site");
  assert.ok(!/AIHOT/i.test(PREFILTER_SYSTEM), "the sample site's name is gone");
});

test("a selected item: prefilter, two scores, the content understanding and the structure", async () => {
  // The ladder is the industry pack's, never a number copied in here (it was re-calibrated in wave 4).
  assert.equal(tierThreshold("T1"), SELECTION.thresholds.T1, "T1 reads the pack");
  assert.ok(tierThreshold("T1") !== null && 150 >= 2 * tierThreshold("T1")!, "the fixture's 78 + 72 clears twice T1");
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, 75], "78 + 72 = 150 >= 2 × the T1 threshold, and the card shows the floored mean");
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["理解标题 CLEAR", "理由 CLEAR", "physical", 5]);
  assert.deepEqual(r.tags, ["灾害事件", "预警/响应", "地震", "中国地震台网"], "vocabulary tags (synonyms mapped, unknown dropped) and the subject's tag");
  assert.deepEqual(r.subjects, ["cenc"]);
  assert.deepEqual([r.output.writer, r.output.itemType, r.output.prefilter.label, r.output.fact.title], ["understand", "disaster_event", "PASS", "事实 CLEAR"]);
  const score = requests.find((q) => q.marker === "CLEAR" && q.step === "score")!;
  assert.match(score.user, /【标题】\nCLEAR earthquake bulletin/, "the score reads the original title, before any writing");
  assert.deepEqual([score.body.temperature, score.body.reasoning_effort, score.body.max_tokens], [1, "high", 65536]);
  const understand = requests.find((q) => q.marker === "CLEAR" && q.step === "understand")!;
  assert.ok(understand.user.startsWith("请按系统规则理解以下单篇材料，一次返回全部六个字段。"));
  assert.ok(understand.system.includes("【摘要答案前置规则") && understand.system.includes("【标题自洽规则"));
  const prefilter = requests.find((q) => q.marker === "CLEAR" && q.step === "prefilter")!;
  assert.ok(JSON.parse(prefilter.user).includes("【材料质量】"), "the material context, sent as a JSON string");
});

test("a near-selected item is written like a selected one; below the floor it is translated", async () => {
  const near = await analyzeArticle(await article("RESCUE"));
  assert.deepEqual([near!.output!.selected, near!.output!.reasonZh], [false, "理由 RESCUE"], "56 + 50 = 106 is over 2 × the understand floor but under 2 × T1");
  const lowId = await article("LOW");
  const low = await analyzeArticle(lowId);
  assert.deepEqual([low!.output!.selected, low!.output!.titleZh, low!.output!.reasonZh], [false, "翻译标题 LOW", null]);
  assert.deepEqual(calls("LOW").sort(), ["prefilter", "score", "score", "structure", "summarize"]);
  const summarize = requests.find((q) => q.marker === "LOW" && q.step === "summarize")!;
  assert.equal(summarize.body.messages.length, 1, "the title/summary prompt is one user message");
  assert.equal(summarize.body.response_format, undefined, "answered in its own text format");
  assert.deepEqual((await row(lowId)).tags, ["观测/数据发布", "地震", "中国地震台网"], "structure tags");
});

test("the prefilter's BLOCK stops everything; UNKNOWN goes on like PASS", async () => {
  // Blocked here is this site's declared noise target — 教育与文旅营销软文（研学招生 / 旅游软文）— so the
  // fixture is the real thing the prefilter is supposed to suppress rather than a placeholder headline.
  const offId = await article("OFFTOPIC", {
    title: `OFFTOPIC 研学招生：峡谷地质三日游夏令营火热报名 ${T}`,
    bodyText: `OFFTOPIC 研学招生：峡谷地质三日游夏令营火热报名，扫码咨询课程与费用。${T}`,
  });
  const off = await analyzeArticle(offId);
  assert.deepEqual([off!.output!.relevance, off!.output!.selected], ["block", false], "a 研学招生 pitch is rejected");
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"], "blocked material is never scored, written or published");
  // A second noise target of this site: 景区宣传稿 / 教研课件推销.
  const promoId = await article("NOISE", {
    title: `NOISE 景区宣传稿：一江两岸夜色如画，配套教研课件免费领取 ${T}`,
    bodyText: `NOISE 景区宣传稿：一江两岸夜色如画，配套教研课件免费领取。${T}`,
  });
  const promo = await analyzeArticle(promoId);
  assert.deepEqual([promo!.output!.relevance, promo!.output!.selected], ["block", false], "a 景区宣传稿 is rejected too");
  assert.deepEqual(calls("NOISE"), ["prefilter"]);
  // An UNKNOWN with material is judged and written like a PASS, up to 精选 (60 + 62 clears 2 × T1).
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.selected, vague!.output!.titleZh], ["pass", true, "理解标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  // Nothing but a title and no page to fetch: the BLOCK counts as UNKNOWN and is scored, but the
  // translation writes nothing from a bare title, so it waits for material instead of being published.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.deepEqual([bare!.output!.relevance, bare!.output!.selected, bare!.output!.score], ["unknown", false, 32]);
  assert.deepEqual(calls("BARE").sort(), ["prefilter", "score", "score", "structure"]);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the safety net
  // does the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.selected], [false, true]);
});

test("a short post in Chinese is its own copy; a content-filter refusal is translated instead", async () => {
  // The tag rides as a hashtag, which the language check strips.
  const text = `推文：今天把野外踏勘的路线和剖面记录整理好了，效果不错。#t${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: X_SOURCE, url: `https://x.com/test/status/1${Date.now()}`, title: text, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "测试", handle: "test", text },
  });
  const post = await analyzeArticle(articleId);
  assert.deepEqual([post!.output!.titleZh, post!.output!.summaryZh], [text, text]);
  assert.ok(!calls("推文").includes("summarize"), "no translation call");
  const sensitive = await analyzeArticle(await article("SENSITIVE"));
  assert.deepEqual([sensitive!.output!.selected, sensitive!.output!.titleZh], [true, "翻译标题 SENSITIVE"]);
  assert.deepEqual(calls("SENSITIVE").filter((s) => s === "understand" || s === "summarize"), ["understand", "summarize"]);
});

test("guards: an agency the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某台网发布地震速报", text: "某台网发布地震速报，给出震级、震源深度与烈度图。", sourceKind: "rss" };
  const guarded = enforceIdentity(input, { titleZh: "中国地震台网发布地震速报", summaryZh: "某台网发布地震速报。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], ["某台网发布地震速报", "某台网发布地震速报。", "fallback"]);
  // The identity lexicon: a Chinese rendering of an agency the input names in English is no invention.
  const nasa = { title: "NASA releases a new ice-sheet map of Greenland", text: "NASA published the updated ice-sheet elevation map for Greenland.", sourceKind: "rss" };
  assert.equal(enforceIdentity(nasa, { titleZh: "美国宇航局发布格陵兰冰盖高程新图", summaryZh: "美国宇航局公布更新后的格陵兰冰盖高程图。" }).identityGuard.outcome, "pass");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：PixVerse (@PixVerse)").bodyZh, "我们懂你。", "a repeated prompt line is dropped");
});

test("analysing the same revision again reuses every paid answer", async () => {
  scoreAnswers.CLEAR = [80, 70];
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR earthquake bulletin again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
});
