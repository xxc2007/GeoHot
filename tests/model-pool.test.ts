// Multi-model pools: a capability can name several models (`default,agnes-3.0-flash-cn`) and the work is
// spread across them. Two properties matter and neither is visible from the pool function alone — a member
// must be picked by the *work unit* (so a retry reuses that member's cached answer instead of paying a
// second model to re-judge the same words), and each member must spend its own provider's budget.
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { MODELS } from "@aihot/backend/providers/llm";
import { CAPABILITIES, poolOf, pickFromPool, modelFor, modelSources, invalidateModelCache } from "@aihot/backend/editorial/models";
import { newArticleId } from "@aihot/backend/lib/ids";

for (const name of Object.keys(process.env)) if ((/_MODEL$/.test(name) && name !== "LLM_MODEL" && name !== "EMBEDDING_MODEL") || name === "MODEL_POOL") delete process.env[name];

const T = tag();
const SOURCE = `test-model-pool-${T}`;
const POOL = "default,agnes-3.0-flash-cn";
const ANSWERED_BY: Record<string, string> = { default: "main-model", "agnes-3.0-flash-cn": "cn-model" };
const seen: Array<{ model: string; system: string }> = [];
const pacing: Array<{ service: string; perMinute: number }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const user = String(body.messages.at(-1)!.content);
  seen.push({ model: body.model, system });
  const content =
    system.includes("宽召回") ? { label: "PASS", reason: "测试" }
    : system.includes("事件注意力评分器") ? { attentionScore: 80 }
    : system.includes("内容理解编辑") ? { itemType: "technology_release", authorRole: "principal", tags: ["技术与软件"], editorialJudgment: "理由", titleZh: "池化模型的标题", summaryZh: "池化模型写的摘要。第二句。" }
    : system.includes("资料结构化助手") ? { category: "geotech", tags: ["技术与软件"], subjects: [], fact: null }
    : user.includes("title_zh") ? "title_zh: 标题\nsummary_zh: 摘要。"
    : null;
  if (content === null) throw new Error("unexpected request");
  return { id: `stub-${seen.length}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "main-model",
  AGNES_CN_BASE_URL: `${provider.url}/v1`, AGNES_CN_API_KEY: "test-key", AGNES_CN_MODEL: "cn-model",
  MODEL_CALLS_ENABLED: "true",
  PREFILTER_MODEL: POOL, SCORE_MODEL: POOL, UNDERSTAND_MODEL: POOL, STRUCTURE_MODEL: POOL, SUMMARIZE_MODEL: POOL,
});

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test model pool', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // The tests share one database, and a `models.*` row left by another file would outrank every
  // environment variable below. Take the admin switch out of the picture, then put it back the way we found it.
  await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
  // This file measures *who answers*, not how often we may ask. `agnes-cn` is capped at 9 requests a minute
  // because that is the rate the far door actually accepts (migration 0054), and four articles × five steps
  // lands twenty requests inside one minute — so the production breaker turns a routing test red for a reason
  // that has nothing to do with routing. Lift it here, restore the measured numbers in `after`.
  for (const service of ["llm", "agnes-cn"]) {
    const [row] = await sql<{ per_minute: number }[]>`SELECT per_minute FROM budgets WHERE service = ${service}`;
    pacing.push({ service, perMinute: row!.per_minute });
    await sql`UPDATE budgets SET per_minute = 500 WHERE service = ${service}`;
  }
  invalidateModelCache();
});
after(async () => {
  for (const p of pacing) await sql`UPDATE budgets SET per_minute = ${p.perMinute} WHERE service = ${p.service}`;
  await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
  await purgeTagged(T);
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function analyzeOne(): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}/${articleId0()}`, title: `A mapping platform release ${T}`,
    bodyText: `A mapping platform released a new version with open data and pricing. ${T} `.repeat(6),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  seen.length = 0;
  const result = await analyzeArticle(articleId);
  assert.ok(result?.output, `the article was not analysed (${JSON.stringify(result)?.slice(0, 200)})`);
  return articleId;
}
// The url only has to be unique within the run; the article id is what the shard key is built from.
let counter = 0;
const articleId0 = () => String(++counter);

test("a configured value is read as a pool, and unknown names are dropped", () => {
  assert.deepEqual(poolOf(POOL), ["default", "agnes-3.0-flash-cn"]);
  assert.deepEqual(poolOf(` ${POOL} `), ["default", "agnes-3.0-flash-cn"], "spaces around members are trimmed");
  assert.deepEqual(poolOf("no-such-model,default"), ["default"], "an unknown name cannot be routed to");
  assert.deepEqual(poolOf("default"), ["default"], "a single model is a pool of one");
});

test("one work unit always lands on the same member", () => {
  const key = `article:${newArticleId()}@1`;
  const first = pickFromPool(POOL, key);
  for (let i = 0; i < 50; i++) assert.equal(pickFromPool(POOL, key), first, "a retry must re-reach the model that already answered");
  assert.equal(pickFromPool("default", key), "default");
  assert.equal(pickFromPool(POOL), "default", "no shard key: the first member answers");
  assert.equal(pickFromPool("no-such-model"), "", "a pool made only of unknown names has no member");
});

test("the pool spreads real article ids instead of piling onto one member", () => {
  const ids = Array.from({ length: 400 }, () => `article:${newArticleId()}@1`);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(pickFromPool(POOL, id), (counts.get(pickFromPool(POOL, id)) ?? 0) + 1);
  assert.equal(counts.size, 2, "both members get work");
  for (const member of ["default", "agnes-3.0-flash-cn"]) {
    const share = (counts.get(member) ?? 0) / ids.length;
    assert.ok(share > 0.35 && share < 0.65, `${member} got ${(share * 100).toFixed(1)}%, expected roughly half`);
  }
});

test("every model in the registry has its own budget row", async () => {
  // Without a row the breaker is silently unlimited (receipts.ts returns early), so a new provider would
  // spend its key with no ceiling — the opposite of why the pool was added.
  const services = [...new Set(Object.values(MODELS).map((m) => m.service))].sort();
  assert.ok(services.length >= 6, `the registry lost providers (saw ${services.join(", ")})`);
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  assert.ok(rows.length > 0, "the budgets table is empty: the migration that seeds it did not run");
  const have = new Set(rows.map((r) => r.service));
  assert.deepEqual(services.filter((s) => !have.has(s)), [], `no budgets row for ${services.filter((s) => !have.has(s)).join(", ")}`);
});

test("a pooled article is judged by one member, and the receipt names that member's service", async () => {
  const articleId = await analyzeOne();
  assert.ok(seen.length >= 4, `expected the analysis to call the provider, saw ${seen.length}`);
  const models = new Set(seen.map((s) => s.model));
  assert.equal(models.size, 1, `all five stages of one article should use one member, saw ${[...models].join(", ")}`);
  const chosen = [...models][0]!;
  assert.ok(["main-model", "cn-model"].includes(chosen), `the answer came from ${chosen}, outside the pool`);

  const receipts = await sql<{ model: string; service: string }[]>`SELECT DISTINCT model, service FROM receipts WHERE subject LIKE ${`article:${articleId}@%`}`;
  assert.equal(receipts.length, 1, "one model answered this article");
  const [receipt] = receipts;
  const expectedService = chosen === "cn-model" ? "agnes-cn" : "llm";
  assert.equal(receipt!.service, expectedService, `${chosen} must spend the ${expectedService} budget, not the other one`);
  assert.equal(receipt!.model, chosen, "the receipt records the model that actually answered");
});

test("each article is answered by the member its own id selects", async () => {
  // A wiring check, not a restatement of pickFromPool: if a call site passes the wrong shard key — a subject
  // carrying a revision, or nothing at all — the model that answered will not be the one the article id picks.
  const ids = [await analyzeOne(), await analyzeOne(), await analyzeOne(), await analyzeOne(), await analyzeOne(), await analyzeOne()];
  const answered = new Set<string>();
  for (const id of ids) {
    const rows = await sql<{ model: string }[]>`SELECT DISTINCT model FROM receipts WHERE subject LIKE ${`article:${id}@%`}`;
    assert.equal(rows.length, 1, `${id} should have been judged by exactly one member`);
    const expected = ANSWERED_BY[await modelFor("prefilter", id)];
    assert.equal(rows[0]!.model, expected, `${id} was judged by ${rows[0]!.model}, not by the member its id selects (${expected})`);
    answered.add(rows[0]!.model);
  }
  for (const model of answered) assert.ok(Object.values(ANSWERED_BY).includes(model), `${model} is not in the pool`);
});

test("a pool member that cannot serve is dropped instead of chosen and failed", async () => {
  process.env.MODEL_POOL = `${POOL},space-bunny-free`;
  invalidateModelCache();
  // space-bunny-free has no OPENCODE_* here and ignores response_format besides. It must never be picked for a
  // step that parses JSON, and the admin page must not show it as capacity.
  for (let i = 0; i < 60; i++) assert.notEqual(await modelFor("digest", `article:${i}`), "space-bunny-free");
  const sources = await modelSources();
  assert.equal(sources.digest!.model, `${POOL},space-bunny-free`, "the configured string stays as configured");
  assert.equal(sources.digest!.serving, POOL, "the members that can answer are shown separately");

  // Names that are not models cannot become members — `constructor` and `__proto__` are truthy lookups on a
  // plain object, and one of them reaching chatJson means a service of undefined, i.e. no circuit breaker.
  process.env.MODEL_POOL = "default,no-such-model,constructor";
  invalidateModelCache();
  assert.equal(await modelFor("digest", "story:1"), "default", "an unknown name drops out");
  assert.deepEqual(poolOf("constructor,__proto__,toString"), [], "prototype-chain names are not models");
  delete process.env.MODEL_POOL;
  invalidateModelCache();
});

test("MODEL_POOL sets every step at once, and a step's own variable still wins", async () => {
  process.env.MODEL_POOL = POOL;
  process.env.SCORE_MODEL = "default";
  invalidateModelCache();
  assert.equal(await modelFor("score", "article:one@1"), "default", "the per-step variable outranks the site-wide pool");
  for (const key of Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>) {
    const chosen = await modelFor(key, `article:${key}@1`);
    assert.ok(!chosen.includes(","), `${key} returned the pool string instead of one of its members (${chosen})`);
    assert.ok(["default", "agnes-3.0-flash-cn"].includes(chosen), `${key} chose ${chosen}, outside the pool`);
  }
  const picked = new Set<string>();
  for (let i = 0; i < 200; i++) picked.add(await modelFor("prefilter", `article:${i}`));
  assert.equal(picked.size, 2, `MODEL_POOL through modelFor only ever chose ${[...picked].join(", ")}`);
  const sources = await modelSources();
  assert.equal(sources.score!.source, "env");
  assert.equal(sources.digest!.model, POOL, "a step with no variable of its own reports the pool as its source");
  assert.equal(sources.digest!.source, "env");
  delete process.env.MODEL_POOL;
  delete process.env.SCORE_MODEL;
  invalidateModelCache();
});

test("a capability's label and env names stay paired with the pool", () => {
  for (const [key, c] of Object.entries(CAPABILITIES)) {
    assert.match(c.env, /^[A-Z0-9_]+_MODEL$/, `${key} points at an env var that is not a *_MODEL`);
    assert.ok(poolOf(c.default).length > 0, `${key} defaults to a model that does not exist`);
  }
});
