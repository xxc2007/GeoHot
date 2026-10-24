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
import { CAPABILITIES, poolOf, pickFromPool, modelFor, modelSources, invalidateModelCache, sickServices, refusesThisStep, shedRefusingMembers, modelRoutingSamples } from "@aihot/backend/editorial/models";
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
  // 2026-10-21: `space-bunny-free` 已从注册表删除，这里改用 `workbuddy-cn-hy3`——它在本文件里没有
  // WORKBUDDY_CN_* 凭据，所以与当初的 space-bunny 是同一种情形：名字在配置里、但这台机器叫不动它。
  process.env.MODEL_POOL = `${POOL},workbuddy-cn-hy3`;
  invalidateModelCache();
  for (let i = 0; i < 60; i++) assert.notEqual(await modelFor("digest", `article:${i}`), "workbuddy-cn-hy3");
  const sources = await modelSources();
  assert.equal(sources.digest!.model, `${POOL},workbuddy-cn-hy3`, "the configured string stays as configured");
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

// 2026-10-10, production: with four members named, Agnes 国内版 hit its daily text quota and answered 429 to
// almost everything — 1,051 failed attempts in three hours against 112 answers from the two healthy doors.
// Because the member is a hash of the article id, that was not a slow quarter of the work but a dead one:
// those items never reached a model, and the archive band moved 9 items an hour while two doors idled.
test("池子里答不出半数的成员会被跳过，答得动一半以上的成员照用", async () => {
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, created_at, updated_at)
    VALUES (${`sick-probe-${T}`}, 'agnes-cn', 'pool_health_probe', 'failed', now(), now()) RETURNING id`;
  // attempts 条里 received 的条数由调用方给；判据是"十分钟内 ≥6 次尝试且答出的少于一半"。
  const write = async (received: number) => {
    // The tests above answered through this very door a moment ago; the health window is ten minutes wide, so
    // their successful attempts would count into this rate. Clear the window first, then write the six this
    // probe is about.
    await sql`DELETE FROM receipt_attempts WHERE service = 'agnes-cn' AND started_at > now() - interval '10 minutes'`;
    await sql`DELETE FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
    for (let i = 0; i < 6; i++) {
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, started_at)
                VALUES (${receipt!.id}, ${i + 1}, 'agnes-cn', ${i < received ? "received" : "failed"}, now())`;
    }
    invalidateModelCache();
  };

  try {
    process.env.MODEL_POOL = POOL;
    await write(0);
    await sql`UPDATE receipt_attempts SET status = 'pending' WHERE receipt_id = ${receipt!.id}`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has("agnes-cn"), "unfinished requests must not count as provider failures");
    await sql`UPDATE receipt_attempts SET status = 'failed', origin = 'imported' WHERE receipt_id = ${receipt!.id}`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has("agnes-cn"), "imported failures must not change live routing");
    await write(1); // 六次里只答出一次——正是"额度用完降到每分钟一次"的样子
    const sick = await sickServices();
    assert.ok(sick.has("agnes-cn"), "答不出半数的服务应当被判为不健康");
    const picks = new Set(await Promise.all(Array.from({ length: 40 }, () => modelFor("score", newArticleId()))));
    assert.deepEqual([...picks], ["default"], `健康成员应当独挑，实际选了 ${[...picks].join(", ")}`);

    // 答得动一半以上就照用：一道门只是忙（429 之后重试成功）不该被踢出池子。
    await write(4);
    const back = new Set(await Promise.all(Array.from({ length: 40 }, () => modelFor("score", newArticleId()))));
    assert.equal(back.size, 2, `答得动一半以上就该回到池子里，实际只有 ${[...back].join(", ")}`);
  } finally {
    delete process.env.MODEL_POOL;
    await sql`DELETE FROM receipts WHERE id = ${receipt!.id}`;
    invalidateModelCache();
  }
});

// 2026-10-11, production: OpenRouter was refused 37 times in half an hour and answered nothing, yet at
// 07:36 the verdict was `sick=[]`. The rate rule above only sees ten minutes, so a door refused in bursts is
// "forgotten" between bursts and the next article is handed to it again — while what actually stopped is a
// *daily* quota that will not reopen for hours. The durable rule reads what the door said (its six newest
// live attempts are all day-quota refusals) and stays armed until it answers once, so it cannot deadlock.
test("整天额度关闭的门在空档期不再被重新挑中，瞬时限速与本站熔断则不会", async () => {
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, created_at, updated_at)
    VALUES (${`quota-probe-${T}`}, 'agnes-cn', 'pool_health_probe', 'failed', now(), now()) RETURNING id`;
  // 六小时窗口整个归这个探针用：不清掉前面几次真调用留下的成功尝试，"最近六次"就不是判据要读的那六条。
  const clear = () => sql`DELETE FROM receipt_attempts WHERE service = 'agnes-cn' AND started_at > now() - interval '6 hours'`;
  /** 六次拒绝，全部落在十分钟速率窗口之外（四十分钟前）——只有本轮那条持久判据看得见它们。 */
  const refused = async (error: string) => {
    await clear();
    for (let i = 0; i < 6; i++) {
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, error, started_at)
                VALUES (${receipt!.id}, ${i + 1}, 'agnes-cn', 'failed', ${error}, now() - interval '40 minutes')`;
    }
    invalidateModelCache();
  };
  const picks = async () => [...new Set(await Promise.all(Array.from({ length: 40 }, () => modelFor("score", newArticleId()))))];

  try {
    process.env.MODEL_POOL = POOL;
    await refused('HTTP 429: {"error":{"message":"今日文本额度已用完，当前处于限速模式：每 1 分钟可请求 1 次"}}');
    assert.ok((await sickServices()).has("agnes-cn"), "最近六次全是日额度拒绝就该判关，与它们落在哪个窗口无关");
    assert.deepEqual(await picks(), ["default"], "判关之后这个成员不该再被挑中");

    // 它真的回来了：一次成功就是"最近六次"里的一条，门立刻重新可选。
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, started_at)
              VALUES (${receipt!.id}, 7, 'agnes-cn', 'received', now() - interval '20 minutes')`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has("agnes-cn"), "答过一次就该回到池子里，不能把人永久锁死");
    assert.equal((await picks()).length, 2, "恢复之后两个成员都可用");

    // 越线保护一：没有"当日/免费档"字样的瞬时限速不是整天关闭（且这些样本在十分钟窗口外，速率判据也看不见）。
    await refused('HTTP 429: {"error":{"message":"Rate limit exceeded: 10 requests per second"}}');
    assert.ok(!(await sickServices()).has("agnes-cn"), "六次瞬时限速不该被当成整天关闭");

    // 越线保护二：本站自己的熔断消息按分钟/小时自动重开，把它读成"供应商关着"会藏掉一道健康的门。
    await refused('Budget for agnes-cn exhausted (day)');
    assert.ok(!(await sickServices()).has("agnes-cn"), "我方预算窗口不是供应商拒绝");
  } finally {
    delete process.env.MODEL_POOL;
    await clear();
    await sql`DELETE FROM receipts WHERE id = ${receipt!.id}`;
    invalidateModelCache();
  }
});

// 2026-10-11, production: over 24 hours `opencode` answered 208 summarize requests and had 660 refused by our
// own Chinese-copy gate, while on prefilter, score and structure it was barely refused at all. Neither health
// rule can see that — the rate rule deliberately discounts answer-refused attempts, and the door does answer,
// so it is not a closed day quota — and because a member is pinned by a hash of the article id, those 660 were
// not slow items but dead ones: the same article came back to the same door, and three refusals later it lands
// in `failed` with no Chinese title or summary, which is exactly what keeps an item out of the paper.
test("答不出这一步中文的门只在这一步被跳过，它在别的步骤照用", async () => {
  const stamp = `${T}-${Date.now()}`;
  const cnModel = MODELS["agnes-3.0-flash-cn"]!.model; // 判据认的是模型名，不是服务名
  let batch = 0;
  const write = async (purpose: string, refused: number, accepted: number) => {
    const slot = batch++; // one run writes several batches inside the same millisecond
    for (let i = 0; i < refused + accepted; i++) {
      const isRefused = i < refused;
      await sql`
        INSERT INTO receipts (logical_key, service, model, purpose, status, error, created_at, updated_at)
        VALUES (${`step-refusal-${stamp}-${slot}-${i}`}, 'agnes-cn', ${cnModel}, ${purpose},
          ${isRefused ? "failed" : "completed"}, ${isRefused ? "answer refused: answer has no Chinese copy" : null}, now(), now())`;
    }
    invalidateModelCache();
  };
  /** 十分钟速率判据只看 receipt_attempts；这里给足"忙但活着"的样本，才能证明被跳过的是判关之外的另一件事。 */
  const keepDoorHealthy = async () => {
    await sql`DELETE FROM receipt_attempts WHERE service = 'agnes-cn' AND started_at > now() - interval '6 hours'`;
    const [probe] = await sql<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, status, created_at, updated_at)
      VALUES (${`step-refusal-${stamp}-healthy`}, 'agnes-cn', ${cnModel}, 'pool_health_probe', 'completed', now(), now())
      RETURNING id`;
    for (let i = 0; i < 6; i++) {
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, started_at)
                VALUES (${probe!.id}, ${i + 1}, 'agnes-cn', ${i < 4 ? "received" : "failed"}, now())`;
    }
    invalidateModelCache();
  };
  const picks = async (capability: Parameters<typeof modelFor>[0]) =>
    [...new Set(await Promise.all(Array.from({ length: 60 }, () => modelFor(capability, newArticleId()))))];

  try {
    process.env.MODEL_POOL = POOL;
    await keepDoorHealthy();
    await write("summarize_article", 20, 0);
    assert.ok(!(await sickServices()).has("agnes-cn"), "前提：这道门在两条健康判据眼里是活的");
    assert.deepEqual(await picks("summarize"), ["default"], "这一步退得比答得多，中文就该交给别的门");
    assert.equal((await picks("score")).length, 2, "同一道门在别的步骤答得动，就不该被整块踢出池子");
    const sources = await modelSources();
    assert.equal(sources.summarize!.serving, "default", "后台显示的可选成员要和真正的选择一致");
    assert.equal(sources.score!.serving.split(",").length, 2, "评分那一步照旧显示两个成员");

    await write("summarize_article", 0, 25); // 答得多过退回，这一步就还给它
    assert.equal((await picks("summarize")).length, 2, "窗口里答得多过退回，门就该回到这一步");
  } finally {
    delete process.env.MODEL_POOL;
    await sql`DELETE FROM receipts WHERE logical_key LIKE ${`step-refusal-${stamp}%`}`; // 探针行会级联掉它的 attempts
    invalidateModelCache();
  }
});

test("two explicit authentication refusals cool only that member, and a later success reopens it", async () => {
  const [r] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status)
    VALUES(${`auth-probe-${T}`},'agnes-cn','auth-test','pool_health_probe','failed') RETURNING id`;
  try {
    for(let i=1;i<=2;i++) await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,error,started_at)
      VALUES(${r!.id},${i},'agnes-cn','auth-test','failed','HTTP 401: authentication expired',now()-interval '20 minutes')`;
    invalidateModelCache();
    assert.ok((await sickServices()).has('agnes-cn|auth-test'));
    assert.ok(!(await sickServices()).has('agnes-cn|healthy-sibling'));
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,started_at)
      VALUES(${r!.id},3,'agnes-cn','auth-test','received',now()-interval '19 minutes')`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has('agnes-cn|auth-test'));
  } finally { await sql`DELETE FROM receipts WHERE id=${r!.id}`; invalidateModelCache(); }
});

test("routing telemetry never launders refused attempts into successes after a later retry succeeds", async () => {
  const [r] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,attempts)
    VALUES(${`routing-probe-${T}`},'agnes-cn','routing-probe','pool_routing_probe','completed',7) RETURNING id`;
  try {
    for(let i=1;i<=7;i++) await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,latency_ms)
      VALUES(${r!.id},${i},'agnes-cn','routing-probe','received',${i===7 ? 12000 : 1000})`;
    invalidateModelCache();
    const row=(await modelRoutingSamples()).find(s=>s.purpose==='pool_routing_probe' && s.model==='routing-probe');
    assert.ok(row); assert.equal(row.total,7); assert.equal(row.accepted,1); assert.equal(row.median_ms,12000);
  } finally { await sql`DELETE FROM receipts WHERE id=${r!.id}`; invalidateModelCache(); }
});

test("shared-endpoint cooldown requires two explicitly unbilled pre-connection failures and reopens", async () => {
  const old=process.env.QODER_CN_BASE_URL;
  process.env.QODER_CN_BASE_URL='http://127.0.0.1:39127/v1';
  const spec=MODELS['workbuddy-ai-deepseek-flash']!;
  const [r]=await sql`INSERT INTO receipts(logical_key,service,model,purpose,status)
    VALUES(${`connect-probe-${T}`},${spec.service},${spec.model},'pool_health_probe','failed') RETURNING id`;
  try {
    for(let i=1;i<=2;i++) await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,error,billing_status)
      VALUES(${r!.id},${i},${spec.service},${spec.model},'failed','connect failed: ECONNREFUSED','unknown')`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has('endpoint:http://127.0.0.1:39127'));
    await sql`UPDATE receipt_attempts SET billing_status='unbilled' WHERE receipt_id=${r!.id}`;
    invalidateModelCache();
    assert.ok((await sickServices()).has('endpoint:http://127.0.0.1:39127'));
    assert.ok(!(await sickServices()).has('endpoint:https://independent.example'));
    await sql`UPDATE receipt_attempts SET started_at=now()-interval '3 minutes' WHERE receipt_id=${r!.id}`;
    invalidateModelCache();
    assert.ok(!(await sickServices()).has('endpoint:http://127.0.0.1:39127'));
  } finally { if(old===undefined)delete process.env.QODER_CN_BASE_URL;else process.env.QODER_CN_BASE_URL=old; await sql`DELETE FROM receipts WHERE id=${r!.id}`;invalidateModelCache(); }
});

test("判关要够多样本、要真退得比答得多、按模型而不是服务判，而且永远不清空池子", () => {
  assert.equal(refusesThisStep({ refused: 660, accepted: 208 }), true, "生产那一天的实际形状");
  assert.equal(refusesThisStep({ refused: 9, accepted: 0 }), false, "样本下限挡住一次抖动");
  assert.equal(refusesThisStep({ refused: 30, accepted: 40 }), false, "答得多过退的就照用");
  const cnModel = MODELS["agnes-3.0-flash-cn"]!.model;
  const pairs = new Map([[`${cnModel}|summarize_article`, { refused: 20, accepted: 0 }]]);
  assert.deepEqual(shedRefusingMembers(["default", "agnes-3.0-flash-cn"], "summarize", pairs), ["default"]);
  assert.deepEqual(shedRefusingMembers(["default", "agnes-3.0-flash-cn"], "score", pairs), ["default", "agnes-3.0-flash-cn"]);
  assert.deepEqual(shedRefusingMembers(["agnes-3.0-flash-cn"], "summarize", pairs), ["agnes-3.0-flash-cn"], "全部被退回也不清空：停不停由重试阶梯决定");
  // 按服务判会把同一扇门上的兄弟成员一起踢掉。2026-10-21：原来拿 openrouter 的 or-lfm / or-nemotron-super
  // 举这个例子，那两条已从注册表删除；改用 workbuddy 这扇门上的两条——它们共用 `service: "workbuddy"`，
  // 正是这条判据要区分的情形。
  const hy3Model = MODELS["workbuddy-hy3"]!.model;
  const refused = new Map([[`${hy3Model}|summarize_article`, { refused: 40, accepted: 20 }]]);
  assert.deepEqual(shedRefusingMembers(["workbuddy-hy3", "workbuddy-step5-preview"], "summarize", refused), ["workbuddy-step5-preview"],
    "同一个服务的兄弟模型不该跟着被关——判据认模型名");
});
