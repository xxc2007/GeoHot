import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql,closeDb } from "@aihot/backend/db";
import { readUsage,usageRange } from "../packages/backend/src/admin/usage.ts";
import { switchModel } from "../packages/backend/src/admin/models.ts";
after(closeDb);

test("usage validates ranges and retired monitor cannot be configured",async()=>{
  assert.equal(usageRange(),"all");assert.equal(usageRange("nonsense"),"all");assert.equal(usageRange("7"),"7");assert.equal(usageRange("all"),"all");
  await assert.rejects(switchModel("monitor","default","unused feature","test"),/unknown capability/);
});
test("usage counts attempts including retries, separates currencies and missing measurements, uses Shanghai days",async()=>{
  await assert.rejects(sql.begin(async db=>{
    await db`INSERT INTO settings(key,value) VALUES('admin.modelLabelsReady','true'),('admin.modelMetricsReady','true'),('admin.usageCacheReady','true') ON CONFLICT(key) DO UPDATE SET value='true'`;
    const service=`usage-fixture-${Date.now()}`;
    const [r]=await db`INSERT INTO receipts(logical_key,service,purpose,status,request) VALUES(${service},${service},'score_article','pending','{}') RETURNING id`;
    await db`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,usage,cost,currency,cost_basis,started_at)
      VALUES(${r!.id},1,${service},'hy3','received','{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}',1,'USD','actual','2026-01-01T18:30:00Z'),
      (${r!.id},2,${service},'hy3','failed',NULL,NULL,NULL,NULL,'2026-01-01T18:31:00Z'),
      (${r!.id},3,${service},'hy3','unknown','{"prompt_tokens":5,"completion_tokens":2,"cached_tokens":8}',2,'CNY','estimated','2026-01-01T18:32:00Z')`;
    await db`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,origin,usage) VALUES(${r!.id},4,${service},'hy3','received','replay','{"prompt_tokens":999}')`;
    const rows=await readUsage(db,"all",service,"");const total=rows.find(r=>r.kind==='total')!;
    assert.equal(total.calls,3);assert.equal(total.ok,1);assert.equal(total.failed,1);assert.equal(total.unknown,1);
    assert.equal(total.tokensIn,105);assert.equal(total.tokensOut,22);assert.equal(total.missingUsage,1);assert.equal(total.unpriced,1);
    assert.equal(total.pricing!.pricedCalls,2);assert.equal(total.pricing!.cacheUnknownCalls,1);
    assert.ok(Math.abs(total.pricing!.totals[0]!.list.low-.00015925)<1e-10);
    assert.ok(Math.abs(total.pricing!.totals[0]!.list.high-.000163)<1e-10);
    const cache=await db`SELECT tokens_cached,cache_checked FROM admin_model_attempt_metrics WHERE receipt_id=${r!.id} AND origin='live' ORDER BY id`;
    assert.equal(cache[0]!.tokens_cached,40);assert.equal(cache[2]!.tokens_cached,null);assert.ok(cache.every(r=>r.cache_checked));
    assert.equal(total.actualCost,null);assert.equal(total.estimatedCost,null);
    assert.equal(rows.find(r=>r.kind==='currency'&&r.currency==='USD')!.actualCost,1);
    assert.equal(rows.find(r=>r.kind==='currency'&&r.currency==='CNY')!.estimatedCost,2);
    assert.equal(rows.find(r=>r.kind==='day')!.day,'2026-01-02');
    assert.equal(rows.find(r=>r.kind==='hour')!.hour,2);
    assert.equal((await readUsage(db,'all',service,'different-model')).find(r=>r.kind==='total')!.calls,0);
    assert.equal((await readUsage(db,'date',service,'','2026-01-02')).find(r=>r.kind==='total')!.calls,3);
    assert.equal((await readUsage(db,'date',service,'','2026-01-03')).find(r=>r.kind==='total')!.calls,0);
    await assert.rejects(readUsage(db,'date',service,'','invalid'),/Invalid usage date/);
    const shared = await readUsage(db,'*',service,'');
    assert.equal(shared.find(r=>r.kind==='total'&&r.rangeKey==='all')!.calls,3);
    assert.equal((await db`SELECT status FROM receipts WHERE id=${r!.id}`)[0]!.status,'pending','read does not mutate ledger');
    await db`DELETE FROM receipt_model_labels WHERE receipt_id=${r!.id}`;
    await assert.rejects(readUsage(db,'all','', 'hy3'),/label gap/);
    throw new Error('rollback usage fixture');
  }),/rollback usage fixture/);
});
