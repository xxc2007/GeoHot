import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { MODELS, chatJson } from "@aihot/backend/providers/llm";
import { modelFor, modelSources, sickServices, invalidateModelCache } from "@aihot/backend/editorial/models";
import { modelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

test("a quota refusal after a cached healthy verdict immediately routes the next translation shard to a healthy member", async () => {
  const id = tag(), service = `cooldown-${id}`, bad = `cooldown-bad-${id}`, good = `cooldown-good-${id}`;
  const hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    let wire = ""; for await (const part of req) wire += part;
    const model = JSON.parse(wire).model as string; hits.push(model);
    res.writeHead(model === "bad" ? 429 : 200, { "content-type": "application/json" });
    res.end(model === "bad" ? '{"error":{"code":14018,"message":"额度已用尽，请购买加量包"}}'
      : JSON.stringify({ choices: [{ message: { content: '{"t":["完整译文"]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const old = { base: process.env.COOLDOWN_TEST_BASE, key: process.env.COOLDOWN_TEST_KEY, pool: process.env.TRANSLATE_MODEL };
  Object.assign(process.env, { COOLDOWN_TEST_BASE: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, COOLDOWN_TEST_KEY: "local-test-key", TRANSLATE_MODEL: `${bad},${good}` });
  for (const [key, model] of [[bad, "bad"], [good, "good"]]) MODELS[key!] = { key: key!, model: model!, service, baseUrlEnv: "COOLDOWN_TEST_BASE", apiKeyEnv: "COOLDOWN_TEST_KEY", jsonMode: true };
  const [override] = await sql`SELECT value FROM settings WHERE key='models.translate'`;
  await sql`DELETE FROM settings WHERE key='models.translate'`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,1000,10000)`;
  try {
    invalidateModelCache();
    await sickServices(); // Intentionally warm the healthy 60-second snapshot before the refusal.
    const options = { purpose: "translate_body", subject: `cooldown-${id}#0`, promptVersion: "local-test", system: "Translate", user: "source", schema: z.object({ t: z.array(z.string()) }), maxTokens: 100, timeoutMs: 1000 };
    await assert.rejects(chatJson({ ...options, model: bad }), /HTTP 429/);
    assert.equal((await modelSources()).translate!.serving, good);
    assert.equal(await modelFor("translate", `article-${id}`, "translate_body"), good);
    const answer = await chatJson({ ...options, model: good });
    assert.deepEqual(answer.data.t, ["完整译文"]);
    assert.deepEqual(hits, ["bad", "good"]);
    const rows = await sql`SELECT model,status,billing_status FROM receipt_attempts WHERE service=${service} ORDER BY id`;
    assert.equal(rows[0].status, "failed");
    assert.notEqual(rows[0].billing_status, "unbilled", "HTTP refusal must not acquire unbilled connect fallback semantics");
    assert.equal(rows[1].status, "received");
  } finally {
    await sql`DELETE FROM receipts WHERE service=${service}`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
    await sql`DELETE FROM settings WHERE key='models.translate'`;
    if (override) await sql`INSERT INTO settings(key,value) VALUES('models.translate',${sql.json(override.value)})`;
    delete MODELS[bad]; delete MODELS[good];
    for (const [key, value] of Object.entries({ COOLDOWN_TEST_BASE: old.base, COOLDOWN_TEST_KEY: old.key, TRANSLATE_MODEL: old.pool })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    modelCooldown.accept(service, "bad", modelCooldown.begin()); invalidateModelCache();
    await closeDb(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
