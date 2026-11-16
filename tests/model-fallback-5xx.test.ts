// 2026-11-16: 端到端证明 429 同次切健康成员、5xx unknown 不重放。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { MODELS, chatJson } from "@aihot/backend/providers/llm";
import { sickServices, invalidateModelCache } from "@aihot/backend/editorial/models";
import { modelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

after(closeDb);

test("429 on pool member A immediately falls back to healthy B in the same call", async () => {
  const id = tag();
  const service = `fb-${id}`;
  const bad = `fb-bad-${id}`;
  const good = `fb-good-${id}`;
  let badHits = 0;
  const server = http.createServer(async (req, res) => {
    let wire = ""; for await (const part of req) wire += part;
    const model = JSON.parse(wire).model as string;
    if (model === "bad") {
      badHits += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "insufficient_quota" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"t":["ok-from-good"]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const old = { base: process.env.FB_BASE, key: process.env.FB_KEY, pool: process.env.TRANSLATE_MODEL };
  Object.assign(process.env, { FB_BASE: `http://127.0.0.1:${port}/v1`, FB_KEY: "test-key", TRANSLATE_MODEL: `${bad},${good}` });
  for (const [k, mdl] of [[bad, "bad"], [good, "good"]] as const) {
    MODELS[k] = { key: k, model: mdl, service, baseUrlEnv: "FB_BASE", apiKeyEnv: "FB_KEY", jsonMode: true };
  }
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,1000,10000)`;
  try {
    invalidateModelCache();
    await sickServices();
    const options = {
      purpose: "translate_body", subject: `fb-${id}#0`, promptVersion: "t",
      system: "Translate", user: "source", maxTokens: 100, timeoutMs: 2000,
      schema: z.object({ t: z.array(z.string()) }),
    };
    // chatJson 不应抛错：它在同一次调用内切到 good
    const result = await chatJson({ ...options, model: bad });
    assert.deepEqual(result.data.t, ["ok-from-good"]);
    assert.equal(result.model, good);
    // bad 的 attempt 必须是 unbilled（才会触发同次切流）
    const rows = await sql<{ model: string; status: string; billing_status: string }[]>`
      SELECT model, status, billing_status FROM receipt_attempts WHERE service=${service} ORDER BY id`;
    const badRow = rows.find((r) => r.model === "bad");
    assert.ok(badRow, "bad member should have an attempt");
    assert.equal(badRow!.status, "failed");
    assert.equal(badRow!.billing_status, "unbilled", "429 must be unbilled to trigger same-call fallback");
    assert.equal(badHits, 1, "bad should be hit exactly once");
  } finally {
    await sql`DELETE FROM receipts WHERE service=${service}`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
    delete MODELS[bad]; delete MODELS[good];
    for (const [k, v] of Object.entries({ FB_BASE: old.base, FB_KEY: old.key, TRANSLATE_MODEL: old.pool })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    modelCooldown.accept(service, "bad", modelCooldown.begin());
    invalidateModelCache();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("500 on pool member A does NOT fall back in the same call (billing unknown, not replayed)", async () => {
  const id = tag();
  const service = `5xx-${id}`;
  const bad = `5xx-bad-${id}`;
  const good = `5xx-good-${id}`;
  let badHits = 0;
  const server = http.createServer(async (req, res) => {
    let wire = ""; for await (const part of req) wire += part;
    const model = JSON.parse(wire).model as string;
    if (model === "bad") {
      badHits += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal server error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"t":["ok"]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const old = { base: process.env.FB5_BASE, key: process.env.FB5_KEY, pool: process.env.TRANSLATE_MODEL };
  Object.assign(process.env, { FB5_BASE: `http://127.0.0.1:${port}/v1`, FB5_KEY: "test-key", TRANSLATE_MODEL: `${bad},${good}` });
  for (const [k, mdl] of [[bad, "bad"], [good, "good"]] as const) {
    MODELS[k] = { key: k, model: mdl, service, baseUrlEnv: "FB5_BASE", apiKeyEnv: "FB5_KEY", jsonMode: true };
  }
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,1000,10000)`;
  try {
    invalidateModelCache();
    await sickServices();
    const options = {
      purpose: "translate_body", subject: `5xx-${id}#0`, promptVersion: "t",
      system: "Translate", user: "source", maxTokens: 100, timeoutMs: 2000,
      schema: z.object({ t: z.array(z.string()) }),
    };
    // 500 必须抛 ProviderRejectedError，不能静默切到 good
    await assert.rejects(chatJson({ ...options, model: bad }), /HTTP 500/);
    const rows = await sql<{ model: string; status: string; billing_status: string }[]>`
      SELECT model, status, billing_status FROM receipt_attempts WHERE service=${service} ORDER BY id`;
    const badRow = rows.find((r) => r.model === "bad");
    assert.ok(badRow);
    assert.equal(badRow!.status, "failed");
    assert.equal(badRow!.billing_status, "unknown", "generic 5xx must stay unknown, not unbilled");
    assert.equal(badHits, 1, "bad should be hit exactly once, not retried within the same call");
    // good 不应被调用（没有同次切流）
    assert.equal(rows.find((r) => r.model === "good"), undefined, "good must not be called when 5xx is unknown");
  } finally {
    await sql`DELETE FROM receipts WHERE service=${service}`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
    delete MODELS[bad]; delete MODELS[good];
    for (const [k, v] of Object.entries({ FB5_BASE: old.base, FB5_KEY: old.key, TRANSLATE_MODEL: old.pool })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    modelCooldown.accept(service, "bad", modelCooldown.begin());
    invalidateModelCache();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
