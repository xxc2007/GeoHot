// Deterministic configuration refusals — a member switched off upstream (HTTP 404 "switched off in
// Magpie", the minimax-code-global shape) or rejected for a stable parameter reason (HTTP 400 code
// 11150 "reasoning effort value is not supported by the current model", the workbuddy-cn shape) —
// must bench the member for the explicit-refusal hour, exactly like quota/auth refusals do. Before
// that, only the 10-minute failure-ratio window covered them, and the bench expired between bursts:
// on 2026-10-30~31 the two shapes burned ~985 translate_body receipt failures in 24h against the
// same two gates.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { MODELS, chatJson } from "@aihot/backend/providers/llm";
import { modelFor, modelSources, sickServices, invalidateModelCache } from "@aihot/backend/editorial/models";
import { modelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

test("a 404 switched-off refusal and a 400 parameter rejection each bench the member for the explicit-refusal hour", async () => {
  const id = tag(), service = `config-refusal-${id}`, bad = `config-bad-${id}`, good = `config-good-${id}`;
  let badHits = 0;
  const server = http.createServer(async (req, res) => {
    let wire = ""; for await (const part of req) wire += part;
    const model = JSON.parse(wire).model as string;
    if (model !== "bad") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"t":["完整译文"]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    badHits += 1;
    // First refusal: the observed minimax-code-global shape. Second: the workbuddy-cn 11150 shape.
    const body = badHits === 1
      ? '{"error":{"code":null,"message":"MiniMax Code (Global) is switched off in Magpie, so \\"minimax-code-global/MiniMax-M3.1-Flash\\" is not served; switch it on again in Magpie\'s Providers"}}'
      : '{"error":{"message":"workbuddy rejected (HTTP 400): {\\"code\\":11150,\\"msg\\":\\"the reasoning effort value is not supported by the current model\\"}"}}';
    res.writeHead(badHits === 1 ? 404 : 400, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const old = { base: process.env.CONFIG_TEST_BASE, key: process.env.CONFIG_TEST_KEY, pool: process.env.TRANSLATE_MODEL };
  Object.assign(process.env, { CONFIG_TEST_BASE: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, CONFIG_TEST_KEY: "local-test-key", TRANSLATE_MODEL: `${bad},${good}` });
  for (const [key, model] of [[bad, "bad"], [good, "good"]]) MODELS[key!] = { key: key!, model: model!, service, baseUrlEnv: "CONFIG_TEST_BASE", apiKeyEnv: "CONFIG_TEST_KEY", jsonMode: true };
  const [override] = await sql`SELECT value FROM settings WHERE key='models.translate'`;
  await sql`DELETE FROM settings WHERE key='models.translate'`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,1000,10000)`;
  try {
    invalidateModelCache();
    await sickServices(); // Warm the healthy 60-second snapshot before the first refusal.
    const options = { purpose: "translate_body", subject: `config-${id}#0`, promptVersion: "local-test", system: "Translate", user: "source", schema: z.object({ t: z.array(z.string()) }), maxTokens: 100, timeoutMs: 1000 };
    await assert.rejects(chatJson({ ...options, model: bad }), /HTTP 404/);
    assert.equal((await modelSources()).translate!.serving, good, "the switched-off member is benched at once");
    await assert.rejects(chatJson({ ...options, model: bad }), /HTTP 400/);
    assert.equal((await modelSources()).translate!.serving, good, "the parameter rejection keeps the bench up");
    assert.equal(await modelFor("translate", `article-${id}`, "translate_body"), good);
    const answer = await chatJson({ ...options, model: good });
    assert.deepEqual(answer.data.t, ["完整译文"]);
    const rows = await sql`SELECT status, error FROM receipt_attempts WHERE service=${service} ORDER BY id`;
    assert.match(rows[0]!.error!, /switched off in Magpie/);
    assert.match(rows[1]!.error!, /not supported by the current model/);
  } finally {
    await sql`DELETE FROM receipts WHERE service=${service}`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
    await sql`DELETE FROM settings WHERE key='models.translate'`;
    if (override) await sql`INSERT INTO settings(key,value) VALUES('models.translate',${sql.json(override.value)})`;
    delete MODELS[bad]; delete MODELS[good];
    for (const [key, value] of Object.entries({ CONFIG_TEST_BASE: old.base, CONFIG_TEST_KEY: old.key, TRANSLATE_MODEL: old.pool })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    modelCooldown.accept(service, "bad", modelCooldown.begin()); invalidateModelCache();
    await closeDb(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
