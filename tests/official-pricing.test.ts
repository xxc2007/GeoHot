import {CNY_FX} from "@aihot/contracts/cny";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officialCosts,peakFactor,type PricingBucket} from '../packages/backend/src/admin/official-pricing.ts';
const bucket=(over:Partial<PricingBucket>={}):PricingBucket=>({service:'workbuddy',model:'hy3',day:'2026-10-23',hour:9,calls:1,pricingCalls:1,pricedIn:1e6,pricedOut:1e6,cachedTokens:250000,unknownCacheIn:0,cacheUnknownCalls:0,...over});
test('official estimate uses cache tokens, reports unknown cache bounds and excludes missing token calls',()=>{
  const r=officialCosts([bucket(),bucket({unknownCacheIn:1e6,cachedTokens:0,cacheUnknownCalls:1}),bucket({calls:2,pricingCalls:0,pricedIn:0,pricedOut:0,cachedTokens:0})]);
  assert.equal(r.pricedCalls,2);assert.equal(r.calls,4);assert.equal(r.missingUsage,2);assert.equal(r.cacheUnknownCalls,1);
  assert.deepEqual(r.totals[0]!.list,{low:9.0625,high:9.8125});
});
test('Agnes international and domestic prices stay separate; promotional zero is not list zero',()=>{
  const r=officialCosts([bucket({service:'llm',model:'agnes-3.0-flash',cachedTokens:0}),bucket({service:'agnes-cn',model:'agnes-3.0-flash',cachedTokens:0}),bucket({service:'dots',model:'dots3-note-prev',cachedTokens:0})]);
  assert.equal(r.totals.length,1);assert.equal(r.totals[0]!.currency,'CNY');
  assert.ok(Math.abs(r.totals[0]!.list.high-(1.35+.62*CNY_FX.usdToCny))<1e-9);
  assert.ok(r.models.every(m=>m.currency==='CNY'));
  assert.ok(r.totals.every(t=>t.current.high===0));
});
test('DeepSeek applies peak boundaries, weekends and verified Chinese holidays',()=>{
  for(const h of [9,11,14,17])assert.deepEqual(peakFactor('2026-10-23',h),{low:2,high:2});
  for(const h of [8,12,13,18])assert.deepEqual(peakFactor('2026-10-23',h),{low:1,high:1});
  assert.deepEqual(peakFactor('2026-10-24',9),{low:1,high:1});
  assert.deepEqual(peakFactor('2026-10-01',9),{low:1,high:1});
  assert.deepEqual(peakFactor('2027-10-01',9),{low:1,high:2});
  assert.equal(officialCosts([bucket({model:'deepseek-v4.1-flash',cachedTokens:0})]).totals[0]!.list.high,1.5*CNY_FX.usdToCny);
});
test('unknown gateway aliases and incomplete cache backfill never produce a guessed fee',()=>{
  const unknown=officialCosts([bucket({model:'qoder-cn/dfmodel'})]);assert.equal(unknown.unmappedCalls,1);assert.equal(unknown.pricedCalls,0);assert.equal(unknown.models[0]!.list,null);assert.deepEqual(unknown.totals,[]);
  const pending=officialCosts([bucket()],false);assert.equal(pending.state,'backfill');assert.equal(pending.models[0]!.list,null);assert.deepEqual(pending.totals,[]);
});
