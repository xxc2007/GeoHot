import {CNY_FX} from "@aihot/contracts/cny";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officialCosts,peakFactor,type PricingBucket} from '../packages/backend/src/admin/official-pricing.ts';
import type { PricingVersionRow } from '../packages/backend/src/admin/pricing-map.ts';
const bucket=(over:Partial<PricingBucket>={}):PricingBucket=>({service:'workbuddy',model:'hy3',day:'2026-10-23',hour:9,calls:1,pricedCalls:1,pricedIn:1e6,pricedOut:1e6,cachedTokens:250000,unknownCacheIn:0,cacheUnknownCalls:0,...over});
test('official estimate uses cache tokens, prices unknown cache at the cached rate (single value) and excludes missing token calls',()=>{
  const r=officialCosts([bucket(),bucket({unknownCacheIn:1e6,cachedTokens:0,cacheUnknownCalls:1}),bucket({calls:2,pricedCalls:0,pricedIn:0,pricedOut:0,cachedTokens:0})]);
  assert.equal(r.pricedCalls,2);assert.equal(r.calls,4);assert.equal(r.missingUsage,2);assert.equal(r.cacheUnknownCalls,1);
  // unknownCacheIn 按缓存命中价（hy3 cached=.25）单口径：不再撑出 min/max 上下界区间。
  assert.deepEqual(r.totals[0]!.list,{low:9.0625,high:9.0625});
});
test('Agnes international and domestic standard prices stay separate without promotional discounts',()=>{
  const r=officialCosts([bucket({service:'llm',model:'agnes-3.0-flash',cachedTokens:0}),bucket({service:'agnes-cn',model:'agnes-3.0-flash',cachedTokens:0}),bucket({service:'dots',model:'dots3-note-prev',cachedTokens:0})]);
  assert.equal(r.totals.length,1);assert.equal(r.totals[0]!.currency,'CNY');
  assert.ok(Math.abs(r.totals[0]!.list.high-(1.35+.62*CNY_FX.usdToCny))<1e-9);
  assert.ok(r.models.every(m=>m.currency==='CNY'));
  assert.ok(r.totals.every(t=>t.current.high===t.list.high));
  assert.ok(r.models.every(m=>m.current?.high===m.list?.high));
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

test('historical buckets price by the version effective at call time, not the latest version', () => {
  const versions = new Map<string, PricingVersionRow[]>([['svc::hist-model', [
    { rateId: 'svc::hist-model', service: 'svc', model: 'hist-model', currency: 'USD', input: 0.1, cached: 0.01, output: 0.5, billingKind: 'equivalent-public-api', effectiveAt: '2026-11-01T00:00:00+08:00', fetchedAt: null },
    { rateId: 'svc::hist-model', service: 'svc', model: 'hist-model', currency: 'USD', input: 0.4, cached: 0.02, output: 2.0, billingKind: 'equivalent-public-api', effectiveAt: '2026-11-10T00:00:00+08:00', fetchedAt: null },
  ]]]);
  const old = officialCosts([bucket({ service: 'svc', model: 'hist-model', day: '2026-11-05', hour: 12, pricedIn: 1_000_000, pricedOut: 1_000_000, cachedTokens: 0, unknownCacheIn: 0 })], true, CNY_FX, versions);
  // 旧版本：0.1 输入 + 0.5 输出 = 0.6 USD / 1M；若误用最新版本应是 2.4。
  assert.ok(Math.abs(old.models[0]!.list!.low - 0.6 * CNY_FX.usdToCny) < 1e-9);
});

test('subscription / null-rate versions produce no estimate and are counted as unmapped', () => {
  const versions = new Map<string, PricingVersionRow[]>([['svc::sub-model', [
    { rateId: 'svc::sub-model', service: 'svc', model: 'sub-model', currency: null, input: null, cached: null, output: null, billingKind: 'subscription', effectiveAt: '2026-11-01T00:00:00+08:00', fetchedAt: null },
  ]]]);
  const r = officialCosts([bucket({ service: 'svc', model: 'sub-model' })], true, CNY_FX, versions);
  assert.equal(r.unmappedCalls, 1);
  assert.equal(r.pricedCalls, 0);
  assert.equal(r.models[0]!.list, null);
});
