// Space Bunny short-writing requests use existing reasoning headroom without changing other stages or
// buying a second answer when an exact legacy summary receipt already exists.
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { chatJson } from "@aihot/backend/providers/llm";
import { logicalKeyFor, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { noChineseAnswer, SCORE_SYSTEM } from "@aihot/backend/editorial/analyze";
import { parseTranslateOutput, PREFILTER_SYSTEM } from "@aihot/backend/editorial/writing";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

test("space bunny summary request normalization and exact legacy recovery", async (t) => {
  const T = tag();
  const prefix = `test-space-summary-${T}`;
  const source = `${prefix}-source`;
  const queue = `${prefix}-queue`;
  const originalQueue = QUEUES.analyze;
  const originalCallsEnabled = config.modelCallsEnabled;
  const env = {
    OPENCODE_BASE_URL: "", OPENCODE_API_KEY: "stub-only",
    LLM_MODEL: "test-llm", LLM_BASE_URL: "", LLM_API_KEY: "stub-only",
    DASHSCOPE_BASE_URL: "", DASHSCOPE_API_KEY: "stub-only",
    SUMMARIZE_MODEL: "space-bunny-free,default", PREFILTER_MODEL: "default", SCORE_MODEL: "default",
    STRUCTURE_MODEL: "qwen3.8-flash", UNDERSTAND_MODEL: "default", COLLECT_ENABLED: "false",
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const budgets = await sql`SELECT * FROM budgets WHERE service IN('opencode','llm','dashscope')`;
  const settings = await sql`SELECT * FROM settings WHERE key LIKE 'models.%'`;
  const bodies: Array<Record<string, any>> = [];
  const ids: string[] = [];
  const chinese = "title_zh: 台网发布地震观测资料\nsummary_zh: 台网发布新的地震观测资料，并说明资料覆盖的区域和时间。";
  let refuseWriting = false;
  const provider = await stub((_hit, request) => {
    const body = JSON.parse(request.body);
    bodies.push(body);
    const system = body.messages[0]?.role === "system" ? String(body.messages[0].content) : "";
    const content = system === PREFILTER_SYSTEM ? JSON.stringify({ label: "PASS", reason: "观测资料" })
      : system === SCORE_SYSTEM ? JSON.stringify({ attentionScore: 0 })
      : system === "generic" ? '{"ok":true}' : refuseWriting ? "" : chinese;
    return { choices: [{ message: { content }, finish_reason: refuseWriting && !system ? "length" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  });
  const schema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });
  const opts = (label: string) => ({ model: "space-bunny-free", purpose: "summarize_article", subject: `${prefix}-${label}`,
    promptVersion: "summary-fixture-v1", system: "", user: `${prefix}-${label}`, schema, json: false,
    maxTokens: 2048, parse: parseTranslateOutput, usable: noChineseAnswer, attemptTag: "summarize" });
  async function legacy(label: string, status: "received" | "completed" | "pending" | "unknown" | "failed") {
    const o = opts(label);
    // Frozen pre-fix parameters: the exact original 2048 identity, with no extra fields.
    const request = { service: "opencode", model: "space-bunny-free", purpose: o.purpose, subject: o.subject, attemptTag: o.attemptTag,
      identity: { model: "space-bunny-free", promptVersion: o.promptVersion, system: sha256(o.system), user: sha256(o.user),
        temperature: 0.2, maxTokens: 2048, json: false, extra: null } };
    const response = { choices: [{ message: { content: chinese }, finish_reason: "stop" }], usage: { total_tokens: 20 } };
    const [row] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts,response)
      VALUES(${logicalKeyFor(request)},'opencode','space-bunny-free',${o.purpose},${o.subject},${status},1,${sql.json(response)}) RETURNING id`;
    return row!.id as number;
  }
  try {
    Object.assign(env, { OPENCODE_BASE_URL: `${provider.url}/v1`, LLM_BASE_URL: `${provider.url}/v1`, DASHSCOPE_BASE_URL: `${provider.url}/v1` });
    Object.assign(process.env, env);
    config.modelCallsEnabled = true;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES
      ('opencode',500,5000,50000),('llm',500,5000,50000),('dashscope',0,5000,50000)
      ON CONFLICT(service) DO UPDATE SET per_minute=excluded.per_minute,per_hour=excluded.per_hour,per_day=excluded.per_day`;
    invalidateModelCache();

    await t.test("new summary sends 8048 without new parameters; score/understand and other models stay unchanged", async () => {
      await chatJson(opts("new"));
      const summary = bodies.at(-1)!;
      assert.equal(summary.max_tokens, 8048);
      assert.equal(summary.chat_template_kwargs, undefined);
      assert.equal(summary.reasoning_effort, undefined);
      for (const purpose of ["score_article", "understand_article"]) {
        await chatJson({ model: "space-bunny-free", purpose, subject: `${prefix}-${purpose}`, promptVersion: "other-fixture",
          system: "generic", user: `${prefix}-${purpose}`, maxTokens: 2048, schema: z.object({ ok: z.boolean() }) });
        const body = bodies.at(-1)!;
        assert.equal(body.max_tokens, 2048);
        assert.equal(body.chat_template_kwargs, undefined);
        assert.equal(body.reasoning_effort, undefined);
      }
    });

    await t.test("headroom respects the hard output cap and other models remain unchanged", async () => {
      await chatJson({ ...opts("cap"), maxTokens: 100_000 });
      assert.equal(bodies.at(-1)!.max_tokens, 65_536);
      await chatJson({ ...opts("other-model"), model: "default" });
      assert.equal(bodies.at(-1)!.max_tokens, 2048);
      assert.equal(bodies.at(-1)!.reasoning_effort, undefined);
    });
    await t.test("legacy received/completed summaries recover across the pool without sending", async () => {
      for (const status of ["received", "completed"] as const) {
        const id = await legacy(status, status);
        const hits = provider.hits();
        const result = await chatJson({ ...opts(status), model: "default" });
        assert.equal(result.receiptId, id);
        assert.equal(result.model, "space-bunny-free", "actual recovered model remains the legacy pool member");
        assert.equal(result.reused, true);
        assert.equal(result.data.titleZh, "台网发布地震观测资料");
        assert.equal(provider.hits(), hits);
      }
    });

    await t.test("legacy pending/unknown across the pool prevent a new dispatch", async () => {
      for (const status of ["pending", "unknown"] as const) {
        const id = await legacy(status, status);
        const hits = provider.hits();
        const error = status === "pending" ? ReceiptBusyError : ReceiptUnknownError;
        await assert.rejects(chatJson({ ...opts(status), model: "default" }), error);
        assert.equal(provider.hits(), hits);
        assert.equal((await sql`SELECT status FROM receipts WHERE id=${id}`)[0]!.status, status);
      }
    });

    await t.test("failed legacy identity is recovery-only: the next new call never dispatches old thinking parameters", async () => {
      const id = await legacy("failed", "failed");
      const hits = provider.hits();
      const result = await chatJson(opts("failed"));
      assert.equal(provider.hits(), hits + 1);
      assert.notEqual(result.receiptId, id);
      assert.equal(bodies.at(-1)!.max_tokens, 8048);
      assert.equal(bodies.at(-1)!.chat_template_kwargs, undefined);
      assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${id}`)[0]!.attempts, 1);
      await chatJson(opts("failed"));
      assert.equal(provider.hits(), hits + 1, "new usable summary remains recoverable");
    });

    await t.test("empty final content remains refused and real worker retries are bounded", async () => {
      const anonymous = { choices: [{ message: { content: "", reasoning_content: "应先核实区域和时间，再拟定中文摘要。" }, finish_reason: "length" }],
        usage: { completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2048 } } };
      assert.deepEqual(parseTranslateOutput(anonymous.choices[0]!.message.content), { titleZh: "", summaryZh: "", bodyZh: "" });
      assert.equal(noChineseAnswer(parseTranslateOutput(anonymous.choices[0]!.message.content)), "answer has no Chinese copy");
      assert.equal(noChineseAnswer(parseTranslateOutput(chinese)), null, "correct Chinese labels survive pure parsing");
      bodies.length = 0;
      refuseWriting = true;
      process.env.SUMMARIZE_MODEL = "space-bunny-free";
      invalidateModelCache();
      await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
        VALUES(${source},'Space Bunny bounded writing','rss','T1','editorial','2100-01-01')`;
      (QUEUES as { analyze: string }).analyze = queue;
      const boss = await getBoss();
      await registerContentJobs(boss, 1);
      const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${prefix}/bounded`, title: `Observation bulletin ${T}`,
        bodyText: `Observation data were released. ${T} ` + "The bulletin explains the spatial and temporal coverage. ".repeat(12),
        bodyStatus: "ok", language: "en", via: "fetch", publishedAt: new Date() });
      ids.push(articleId);
      for (let n = 1; n <= 3; n++) {
        const jobId = await boss.send(queue, { articleId });
        assert.ok(jobId);
        const deadline = Date.now() + 15_000;
        let result: string | undefined;
        while (Date.now() < deadline) {
          const [job] = await sql`SELECT state,output FROM pgboss.job WHERE id=${jobId}`;
          if (job?.state === "completed") { result = job.output?.state; break; }
          await delay(30);
        }
        assert.equal(result, n === 3 ? "failed" : "retrying");
        assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${articleId}`)[0]!.processing_attempts, n);
      }
      const [writing] = await sql`SELECT attempts,status FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='summarize_article'`;
      assert.equal(writing!.attempts, 3);
      assert.equal(writing!.status, "failed");
      assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
      assert.ok(bodies.filter((body) => !body.messages[0]?.role || body.messages[0]?.role === "user")
        .every((body) => body.max_tokens === 8048 && body.chat_template_kwargs === undefined));
    });
  } finally {
    await stopBoss();
    (QUEUES as { analyze: string }).analyze = originalQueue;
    await sql`DELETE FROM pgboss.job WHERE name=${queue}`;
    await sql`DELETE FROM pgboss.queue WHERE name=${queue}`;
    await sql`DELETE FROM receipts WHERE subject LIKE ${`${prefix}%`} OR subject=ANY(${ids.map((id) => `article:${id}@1`)}::text[])`;
    await purgeTagged(T);
    await sql`DELETE FROM budgets WHERE service IN('opencode','llm','dashscope')`;
    for (const row of budgets) await sql`INSERT INTO budgets ${sql(row)}`;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    for (const row of settings) await sql`INSERT INTO settings ${sql(row)}`;
    config.modelCallsEnabled = originalCallsEnabled;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    invalidateModelCache();
    await provider.close();
    await closeDb();
  }
});
