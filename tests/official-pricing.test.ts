import {CNY_FX} from "@aihot/contracts/cny";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {officialCosts,peakFactor,pricingRowsToDetail,type PricingBucket,type PricingRateRow} from '../packages/backend/src/admin/official-pricing.ts';
import {parseSeedDoc,type PricingVersionRow} from '../packages/backend/src/admin/pricing-map.ts';
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

test('supplied versions Map (even empty) never falls back to constant latest prices', () => {
  // hy3 在常量兜底里有价；Map 已传入即只走版本，空 Map = 无当时版本 = 未计价。
  const r = officialCosts([bucket({ model: 'hy3' })], true, CNY_FX, new Map());
  assert.equal(r.unmappedCalls, 1);
  assert.equal(r.pricedCalls, 0);
  assert.equal(r.models[0]!.list, null);
});

test('bucket earlier than the first effective version is unpriced, not back-priced by the latest rate', () => {
  const versions = new Map<string, PricingVersionRow[]>([['svc::hist-model', [
    { rateId: 'svc::hist-model', service: 'svc', model: 'hist-model', currency: 'USD', input: 0.4, cached: 0.02, output: 2.0, billingKind: 'equivalent-public-api', effectiveAt: '2026-11-10T00:00:00+08:00', fetchedAt: null },
  ]]]);
  const early = officialCosts([bucket({ service: 'svc', model: 'hist-model', day: '2026-10-01', hour: 12, pricedIn: 1_000_000, pricedOut: 1_000_000, cachedTokens: 0, unknownCacheIn: 0 })], true, CNY_FX, versions);
  assert.equal(early.pricedCalls, 0);
  assert.equal(early.unmappedCalls, 1);
  assert.equal(early.models[0]!.list, null);
});

test('mixed unpriced-then-priced buckets for one service/model do not throw and upgrade the group', () => {
  // 线上回归：同一 service/model 先命中无当时有效价卡的桶，组对象 list=null；
  // 再命中有效价卡的桶时，旧实现直接 m.list!.low += ... 抛 TypeError，用量页永久 unavailable。
  const versions = new Map<string, PricingVersionRow[]>([['svc::mixed-model', [
    { rateId: 'svc::mixed-model', service: 'svc', model: 'mixed-model', currency: 'USD', input: 0.1, cached: 0.01, output: 0.5, billingKind: 'equivalent-public-api', effectiveAt: '2026-11-10T00:00:00+08:00', fetchedAt: null },
  ]]]);
  const mixed = officialCosts([
    bucket({ service: 'svc', model: 'mixed-model', day: '2026-11-05', hour: 12, calls: 2, pricedCalls: 0, pricedIn: 0, pricedOut: 0, cachedTokens: 0, unknownCacheIn: 0 }),
    bucket({ service: 'svc', model: 'mixed-model', day: '2026-11-12', hour: 12, calls: 1, pricedCalls: 1, pricedIn: 1_000_000, pricedOut: 1_000_000, cachedTokens: 0, unknownCacheIn: 0 }),
  ], true, CNY_FX, versions);
  assert.equal(mixed.models.length, 1);
  assert.equal(mixed.unmappedCalls, 2);
  assert.equal(mixed.pricedCalls, 1);
  assert.equal(mixed.models[0]!.currency, 'CNY');
  assert.ok(mixed.models[0]!.list);
  assert.ok(Math.abs(mixed.models[0]!.list!.low - 0.6 * CNY_FX.usdToCny) < 1e-9);
  assert.equal(mixed.totals.length, 1);
  assert.ok(Math.abs(mixed.totals[0]!.list.low - 0.6 * CNY_FX.usdToCny) < 1e-9);
});

test('pricingRowsToDetail keeps only priced rows and reports the latest verification date', () => {
  const rows: PricingRateRow[] = [
    { id: 'a', service: 's', model: 'm', name: 'A', currency: 'USD', input: 0.15, cached: 0.015, output: 0.6, billing_kind: 'equivalent-public-api', source_url: 'u', source_urls: ['u'], effective_at: null, fetched_at: '2026-11-17T09:00:00+08:00', last_success_at: null, stale: false, note: 'n' },
    { id: 'b', service: 's', model: 'sub', name: 'Sub', currency: null, input: null, cached: null, output: null, billing_kind: 'subscription', source_url: null, source_urls: [], effective_at: null, fetched_at: '2026-11-17T09:30:00+08:00', last_success_at: null, stale: false, note: null },
  ];
  const d = pricingRowsToDetail(rows);
  assert.equal(d.rates.length, 1);
  assert.equal(d.rates[0]!.id, 'a');
  assert.equal(d.verifiedOn, '2026-11-17T09:00:00+08:00');
});

const deepseekVersions = () => new Map<string, PricingVersionRow[]>([[
  'workbuddy-ai::workbuddy-ai/deepseek-v4.1-flash',
  [{ rateId: 'workbuddy-ai::workbuddy-ai/deepseek-v4.1-flash', service: 'workbuddy-ai', model: 'workbuddy-ai/deepseek-v4.1-flash', currency: 'CNY', input: 1, cached: 0.02, output: 4, billingKind: 'equivalent-public-api', effectiveAt: '2026-09-10T12:00:00+08:00', fetchedAt: null }],
]]);
const dsBucket = (hour: number): PricingBucket => ({
  service: 'workbuddy-ai', model: 'workbuddy-ai/deepseek-v4.1-flash', day: '2026-11-18', hour,
  calls: 1, pricedCalls: 1, pricedIn: 1_000_000, pricedOut: 1_000_000, cachedTokens: 0, unknownCacheIn: 0, cacheUnknownCalls: 0,
});

test('DeepSeek 峰谷按 service/model 判定：峰时成本为谷时两倍（真实 service::model id）', () => {
  const versions = deepseekVersions();
  const off = officialCosts([dsBucket(3)], true, CNY_FX, versions);
  const peak = officialCosts([dsBucket(10)], true, CNY_FX, versions);
  // base = 1M*1 + 1M*4 = 5 CNY；谷时 factor 1，峰时 factor 2。
  assert.ok(Math.abs(off.models[0]!.list!.low - 5) < 1e-9);
  assert.ok(Math.abs(peak.models[0]!.list!.low - 10) < 1e-9);
  assert.ok(peak.models[0]!.list!.high > off.models[0]!.list!.high);
});

test('DB 明细无 priced 行时不把旧常量核验日期冒充新核验', () => {
  const r = officialCosts([], true, CNY_FX, new Map(), { rates: [], verifiedOn: null });
  assert.equal(r.verifiedOn, null);
  assert.equal(r.rates.length, 0);
});

test('seed 47 个 service::model 与仓库 fixture 一一相等，无多余无缺失', () => {
  const dir = path.join(process.cwd(), 'database', 'seeds', 'pricing');
  const seedIds = new Set<string>();
  for (const f of ['map-A.json', 'map-B.json', 'map-C.json']) {
    const doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    parseSeedDoc(doc).forEach((r) => seedIds.add(r.id));
  }
  const fix = JSON.parse(readFileSync(path.join(dir, 'registry-fixture.json'), 'utf8'));
  const fixIds = new Set((fix.models as { service: string; model: string }[]).map((m) => `${m.service}::${m.model}`));
  assert.equal(seedIds.size, 47);
  assert.equal(fixIds.size, 47);
  assert.deepEqual([...seedIds].sort(), [...fixIds].sort());
});
