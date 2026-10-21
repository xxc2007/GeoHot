// Preserve the production Step summary cap and exact pre-cap-change receipt identities on both doors.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { sha256 } from "@aihot/backend/lib/ids";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { logicalKeyFor, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

test("both Step doors preserve production summary caps and legacy receipt protection", async (t) => {
  const prefix = `step-summary-${tag()}`;
  const bodies: Array<Record<string, unknown>> = [];
  const provider = await stub((_hit, req) => {
    bodies.push(JSON.parse(req.body));
    return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { total_tokens: 20 } };
  });
  const env = {
    WORKBUDDY_BASE_URL: `${provider.url}/v1`, WORKBUDDY_API_KEY: "local-test-only",
    WORKBUDDY_CN_BASE_URL: `${provider.url}/v1`, WORKBUDDY_CN_API_KEY: "local-test-only",
    SUMMARIZE_MODEL: "workbuddy-step5-preview,workbuddy-cn-step5-preview",
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const previousEnabled = config.modelCallsEnabled;
  const budgets = await sql`SELECT * FROM budgets WHERE service IN ('workbuddy','workbuddy-cn')`;
  const settings = await sql`SELECT * FROM settings WHERE key LIKE 'models.%'`;
  const opts = (model: string, label: string) => ({ model, purpose: "summarize_article", subject: `${prefix}-${model}-${label}`,
    promptVersion: "summary-cap-v1", system: "generic", user: `${prefix}-${model}-${label}`, schema: z.object({ ok: z.boolean() }),
    maxTokens: 2048, json: false, attemptTag: "summarize" });
  async function legacy(model: string, label: string, status: "received" | "completed" | "pending" | "unknown" | "failed") {
    const o = opts(model, label), spec = MODELS[model]!;
    // Frozen production predecessor: 2048 visible + 4000 hidden, same effort and request identity.
    const request = { service: spec.service, model: spec.model, purpose: o.purpose, subject: o.subject, attemptTag: o.attemptTag,
      identity: { model: spec.model, promptVersion: o.promptVersion, system: sha256(o.system), user: sha256(o.user),
        temperature: 0.2, maxTokens: 6048, json: false, extra: { reasoning_effort: "high" } } };
    const response = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
    const [row] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts,response)
      VALUES(${logicalKeyFor(request)},${spec.service},${spec.model},${o.purpose},${o.subject},${status},1,${sql.json(response)}) RETURNING id`;
    return row!.id as number;
  }
  try {
    Object.assign(process.env, env); config.modelCallsEnabled = true;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES ('workbuddy',500,5000,50000),('workbuddy-cn',500,5000,50000)
      ON CONFLICT(service) DO UPDATE SET per_minute=excluded.per_minute,per_hour=excluded.per_hour,per_day=excluded.per_day`;
    invalidateModelCache();
    for (const model of ["workbuddy-step5-preview", "workbuddy-cn-step5-preview"]) {
      const otherDoor = model === "workbuddy-step5-preview" ? "workbuddy-cn-step5-preview" : "workbuddy-step5-preview";
      await t.test(`${model}: new summary uses 15360 (2048 + 13312); other purposes retain 4000 headroom and the hard cap`, async () => {
        await chatJson(opts(model, "new"));
        assert.equal(bodies.at(-1)!.max_tokens, 15360);
        assert.equal(bodies.at(-1)!.reasoning_effort, "high");
        for (const purpose of ["score_article", "understand_article", "translate_body"]) {
          await chatJson({ ...opts(model, purpose), purpose });
          assert.equal(bodies.at(-1)!.max_tokens, 6048);
          assert.equal(bodies.at(-1)!.reasoning_effort, "high");
        }
        await chatJson({ ...opts(model, "cap"), maxTokens: 100_000 });
        assert.equal(bodies.at(-1)!.max_tokens, 65_536);
      });
      await t.test(`${model}: received/completed legacy answers are reused with zero requests`, async () => {
        for (const status of ["received", "completed"] as const) {
          const id = await legacy(model, status, status), hits = provider.hits();
          const result = await chatJson({ ...opts(model, status), model: otherDoor });
          assert.equal(result.receiptId, id); assert.equal(result.reused, true); assert.equal(result.model, model);
          assert.equal(result.data.ok, true); assert.equal(provider.hits(), hits);
        }
      });
      await t.test(`${model}: pending/unknown legacy outcomes cannot buy another answer`, async () => {
        for (const status of ["pending", "unknown"] as const) {
          const id = await legacy(model, status, status), hits = provider.hits();
          await assert.rejects(chatJson({ ...opts(model, status), model: otherDoor }), status === "pending" ? ReceiptBusyError : ReceiptUnknownError);
          assert.equal(provider.hits(), hits);
          assert.equal((await sql`SELECT status FROM receipts WHERE id=${id}`)[0]!.status, status);
        }
      });
      await t.test(`${model}: failed legacy identity never dispatches the old cap`, async () => {
        const id = await legacy(model, "failed", "failed"), hits = provider.hits();
        const result = await chatJson(opts(model, "failed"));
        assert.notEqual(result.receiptId, id); assert.equal(provider.hits(), hits + 1);
        assert.equal(bodies.at(-1)!.max_tokens, 15360);
        assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${id}`)[0]!.attempts, 1);
      });
    }
  } finally {
    await sql`DELETE FROM receipts WHERE subject LIKE ${`${prefix}%`}`;
    await sql`DELETE FROM budgets WHERE service IN ('workbuddy','workbuddy-cn')`;
    for (const b of budgets) await sql`INSERT INTO budgets ${sql(b)}`;
    await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
    for (const setting of settings) await sql`INSERT INTO settings ${sql(setting)}`;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    config.modelCallsEnabled = previousEnabled; invalidateModelCache();
    await provider.close(); await closeDb();
  }
});
