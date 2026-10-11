// Drive the real pg-boss analysis callback: a rejected paid draft must not disappear behind
// a parallel structure budget wait, while a usable draft keeps the ordinary waiting semantics.
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput, runAnalysis, SCORE_SYSTEM } from "@aihot/backend/editorial/analyze";
import { PREFILTER_SYSTEM } from "@aihot/backend/editorial/writing";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

test("analysis worker counts rejected drafts despite structure budget waits", async (t) => {
  const T = tag();
  const source = `test-budget-output-${T}`;
  const queue = `test.budget-output-${T}`;
  const originalQueue = QUEUES.analyze;
  const originalCallsEnabled = config.modelCallsEnabled;
  const env = {
    MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false",
    LLM_BASE_URL: "", LLM_API_KEY: "test-key", LLM_MODEL: "test-score-model",
    DEEPSEEK_BASE_URL: "", DEEPSEEK_API_KEY: "test-key",
    DASHSCOPE_BASE_URL: "", DASHSCOPE_API_KEY: "test-key",
    PREFILTER_MODEL: "default", SCORE_MODEL: "default", SUMMARIZE_MODEL: "deepseek-flash",
    STRUCTURE_MODEL: "qwen3.8-flash", UNDERSTAND_MODEL: "default",
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const budgets = await sql`SELECT * FROM budgets WHERE service IN ('llm','deepseek','dashscope')`;
  const settings = await sql`SELECT * FROM settings WHERE key LIKE 'models.%'`;
  let validWriting = false;
  const calls: string[] = [];
  const provider = await stub((hit, request) => {
    const body = JSON.parse(request.body);
    const system = body.messages[0]?.role === "system" ? String(body.messages[0].content) : "";
    const user = String(body.messages.at(-1)?.content ?? "");
    const step = system === PREFILTER_SYSTEM ? "prefilter" : system === SCORE_SYSTEM ? "score"
      : user.includes("title_zh") ? "summarize" : "structure";
    calls.push(step);
    const content = step === "prefilter" ? { label: "PASS", reason: "地震信息" }
      : step === "score" ? { attentionScore: 0 }
      : step === "structure" ? { category: "physical", tags: [], subjects: [], fact: null }
      : validWriting ? "title_zh: 地震台网发布观测资料\nsummary_zh: 地震台网发布新的观测资料，并说明数据覆盖范围。"
      : "title_zh: Earthquake bulletin\nsummary_zh: A network released an earthquake bulletin.";
    return { id: `stub-${hit}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  });
  const articleIds: string[] = [];
  try {
    Object.assign(env, { LLM_BASE_URL: `${provider.url}/v1`, DEEPSEEK_BASE_URL: `${provider.url}/v1`, DASHSCOPE_BASE_URL: `${provider.url}/v1` });
    Object.assign(process.env, env);
    config.modelCallsEnabled = true;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day) VALUES
      ('llm',500,5000,50000),('deepseek',500,5000,50000),('dashscope',0,5000,50000)
      ON CONFLICT (service) DO UPDATE SET per_minute=excluded.per_minute,per_hour=excluded.per_hour,per_day=excluded.per_day`;
    invalidateModelCache();
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
      VALUES(${source},'Budget output regression','rss','T1','editorial','2100-01-01')`;
    (QUEUES as { analyze: string }).analyze = queue;
    const boss = await getBoss();
    await registerContentJobs(boss, 1);

    async function article(marker: string) {
      const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${T}/${marker}`,
        title: `Earthquake observation ${T} ${marker}`, bodyText: `A network released earthquake observation data. ${T} ${marker} ` + "The bulletin explains the spatial coverage of the observations. ".repeat(10),
        bodyStatus: "ok", language: "en", via: "fetch", publishedAt: new Date() });
      articleIds.push(articleId);
      return articleId;
    }
    async function run(articleId: string) {
      const id = await boss.send(queue, { articleId });
      assert.ok(id);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const [job] = await sql`SELECT state,output FROM pgboss.job WHERE id=${id}`;
        if (job?.state === "completed") return job.output as { state: string; retryAt?: string };
        assert.notEqual(job?.state, "failed", "the real callback should record the article outcome");
        await delay(30);
      }
      assert.fail("analysis job did not complete against the local stub");
    }

    await t.test("the third unusable paid draft reaches failed, rather than unlimited budget waiting", async () => {
      const id = await article("rejected");
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await run(id);
        assert.equal(result.state, attempt === 3 ? "failed" : "retrying");
        const [row] = await sql`SELECT processing_state,processing_attempts,processing_retry_at,processing_error FROM articles WHERE id=${id}`;
        assert.equal(row!.processing_attempts, attempt);
        assert.equal(row!.processing_state, attempt === 3 ? "failed" : "new");
        assert.match(row!.processing_error, /Paid writing produced no usable Chinese/);
        assert.equal(row!.processing_retry_at === null, attempt === 3);
      }
      const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE subject=${`article:${id}@1`} AND purpose='summarize_article'`;
      assert.equal(receipt!.status, "failed");
      assert.equal(receipt!.attempts, 3, "only the three bounded output attempts bought a draft");
      assert.equal(calls.filter((step) => step === "summarize").length, 3);
      assert.equal(calls.filter((step) => step === "prefilter").length, 1, "already received selection steps are reused");
      assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0);
    });

    await t.test("successful structure also counts three rejected drafts and reuses the other completed steps", async () => {
      await sql`UPDATE budgets SET per_minute=500 WHERE service='dashscope'`;
      const id = await article("rejected-structure-complete");
      const writingBefore = calls.filter((step) => step === "summarize").length;
      const structureBefore = calls.filter((step) => step === "structure").length;
      for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal((await run(id)).state, attempt === 3 ? "failed" : "retrying");
        const [row] = await sql`SELECT processing_state,processing_attempts FROM articles WHERE id=${id}`;
        assert.equal(row!.processing_attempts, attempt);
        assert.equal(row!.processing_state, attempt === 3 ? "failed" : "new");
      }
      assert.equal(calls.filter((step) => step === "summarize").length - writingBefore, 3);
      assert.equal(calls.filter((step) => step === "structure").length - structureBefore, 1);
      assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${id}`).length, 0);
      assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0);
      await sql`UPDATE budgets SET per_minute=0 WHERE service='dashscope'`;
    });

    await t.test("usable writing plus structure budget exhaustion waits without adding output failures", async () => {
      validWriting = true;
      const structureBefore = calls.filter((step) => step === "structure").length;
      const id = await article("usable");
      await sql`UPDATE articles SET processing_attempts=1 WHERE id=${id}`;
      const writingBefore = calls.filter((step) => step === "summarize").length;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(id);
        assert.equal(result.state, "waiting");
        assert.ok(result.retryAt);
        const [row] = await sql`SELECT processing_state,processing_attempts,processing_retry_at,processing_error FROM articles WHERE id=${id}`;
        assert.equal(row!.processing_state, "new");
        assert.equal(row!.processing_attempts, 1, "local budget refusal is not an output failure");
        assert.ok(row!.processing_retry_at);
        assert.match(row!.processing_error, /Budget for dashscope exhausted/);
      }
      const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE subject=${`article:${id}@1`} AND purpose='summarize_article'`;
      assert.equal(receipt!.status, "received");
      assert.equal(receipt!.attempts, 1);
      assert.equal(calls.filter((step) => step === "summarize").length - writingBefore, 1, "second budget wait reuses the usable paid draft");
      assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0, "incomplete structure is never published");
      assert.equal(calls.filter((step) => step === "structure").length, structureBefore, "the stopped local budget never sends structure to a provider");
    });

    await t.test("a structure outcome unknown keeps its recovery state despite rejected writing", async () => {
      validWriting = true;
      await sql`UPDATE budgets SET per_minute=500 WHERE service='dashscope'`;
      const id = await article("unknown");
      const input = await loadAnalyzeInput(id);
      assert.ok(input);
      // Prime exact request identities with local fixture answers, then represent a response whose
      // outcome was lost. No business judgement is committed, and no real provider is contacted.
      await runAnalysis(input);
      const [structure] = await sql`SELECT id,attempts FROM receipts WHERE subject=${`article:${id}@1`} AND purpose='structure_article'`;
      assert.ok(structure);
      await sql`UPDATE receipts SET status='unknown',error='test: outcome lost' WHERE id=${structure.id}`;
      await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${structure.id}`;
      await sql`UPDATE receipts SET status='failed',error='test: draft rejected' WHERE subject=${`article:${id}@1`} AND purpose='summarize_article'`;
      validWriting = false;
      const structureBefore = calls.filter((step) => step === "structure").length;
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await run(id)).state, "unknown-receipt");
        const [row] = await sql`SELECT processing_state,processing_attempts,processing_error FROM articles WHERE id=${id}`;
        assert.equal(row!.processing_state, "failed");
        assert.equal(row!.processing_attempts, 0, "an unknown paid outcome is not an output retry");
        assert.match(row!.processing_error, /outcome unknown/);
      }
      const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE id=${structure.id}`;
      assert.equal(receipt!.status, "unknown");
      assert.equal(receipt!.attempts, structure.attempts);
      assert.equal(calls.filter((step) => step === "structure").length, structureBefore, "unknown structure is never sent again");
      assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0);
    });
  } finally {
    // Stop the real consumer before deleting its fixtures; restore shared test state even on failure.
    await stopBoss();
    (QUEUES as { analyze: string }).analyze = originalQueue;
    await sql`DELETE FROM pgboss.job WHERE name=${queue}`;
    await sql`DELETE FROM pgboss.queue WHERE name=${queue}`;
    if (articleIds.length) await sql`DELETE FROM receipts WHERE subject=ANY(${articleIds.map((id) => `article:${id}@1`)}::text[])`;
    await purgeTagged(T);
    await sql`DELETE FROM budgets WHERE service IN ('llm','deepseek','dashscope')`;
    for (const row of budgets) await sql`INSERT INTO budgets ${sql(row)}`;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    for (const row of settings) await sql`INSERT INTO settings ${sql(row)}`;
    config.modelCallsEnabled = originalCallsEnabled;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    invalidateModelCache();
    await provider.close();
    await closeDb();
  }
});
