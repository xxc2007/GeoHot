import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeSeedEntry, parseSeedDoc, selectRateAt, verifySeedPriceCombo, INTERNAL_ROUTES, type SeedEntry} from '../packages/backend/src/admin/pricing-map.ts';

function entry(over: Partial<SeedEntry>): SeedEntry {
  return {
    service: 'svc', upstream_model: 'model-x', official_provider: null, official_model_id: null,
    billing_kind: 'no-public-price', currency: null, unit: null, tiers: null,
    effective_at: null, fetched_at: '2026-11-17T09:00:00+08:00', stale: false, source_urls: [], notes: '',
    ...over,
  };
}

test('public-api quote is tagged equivalent-public-api, never actual', () => {
  const r = normalizeSeedEntry(entry({
    service: 'minimax-code-global', billing_kind: 'public-api', currency: 'USD',
    tiers: { input: 0.15, cached_input: 0.015, cached_write: null, output: 0.6, reasoning: null, request: null },
  }));
  assert.equal(r.billingKind, 'equivalent-public-api');
  assert.equal(r.input, 0.15); assert.equal(r.cached, 0.015); assert.equal(r.output, 0.6);
});

test('null rates stay NULL, never coerced to 0', () => {
  const r = normalizeSeedEntry(entry({
    service: 'auto', billing_kind: 'unverified', currency: null,
    tiers: { input: null, cached_input: null, cached_write: null, output: null, reasoning: null, request: null },
  }));
  assert.equal(r.input, null); assert.equal(r.cached, null); assert.equal(r.output, null);
  assert.equal(r.billingKind, 'unverified');
});

test('subscription / free / no-public-price keep their own kind with null prices', () => {
  const sub = normalizeSeedEntry(entry({ service: 'antigravity', billing_kind: 'subscription' }));
  const free = normalizeSeedEntry(entry({ service: 'raccoon', billing_kind: 'free' }));
  const none = normalizeSeedEntry(entry({ service: 'agnes-cn', billing_kind: 'no-public-price' }));
  assert.equal(sub.billingKind, 'subscription');
  assert.equal(free.billingKind, 'free');
  assert.equal(none.billingKind, 'no-price');
  for (const r of [sub, free, none]) { assert.equal(r.input, null); assert.equal(r.output, null); }
});

test('internal subscription routes are recognized', () => {
  for (const s of ['workbuddy', 'workbuddy-ai', 'workbuddy-cn', 'loomy', 'dots', 'auto']) assert.ok(INTERNAL_ROUTES.has(s));
});

test('parseSeedDoc skips malformed rows and normalizes the rest', () => {
  const rows = parseSeedDoc({ entries: [
    entry({ service: 'a', upstream_model: 'm1', billing_kind: 'free' }),
    { service: 1 },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'a::m1');
});

test('selectRateAt picks the version effective at the call time, latest past wins', () => {
  const versions = [
    { effective_at: '2026-11-01T00:00:00Z', v: 'old' },
    { effective_at: '2026-11-10T00:00:00Z', v: 'new' },
  ];
  assert.equal(selectRateAt(versions, '2026-11-05T12:00:00Z')!.v, 'old');
  assert.equal(selectRateAt(versions, '2026-11-12T12:00:00Z')!.v, 'new');
  assert.equal(selectRateAt(versions, '2026-10-30T12:00:00Z'), null);
});

test('repo seed A/B/C totals 47; non-estimate rows never carry a guessed price', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'database', 'seeds', 'pricing');
  const all = [];
  for (const f of ['map-A.json', 'map-B.json', 'map-C.json']) {
    all.push(...parseSeedDoc(JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
  }
  assert.equal(all.length, 47);
  for (const r of all) {
    if (r.billingKind !== 'equivalent-public-api') {
      assert.equal(r.input, null, `${r.id} must have null input`);
      assert.equal(r.output, null, `${r.id} must have null output`);
    } else {
      assert.ok(r.input != null && r.output != null, `${r.id} public-api must carry a baseline quote`);
    }
  }
  const kinds = new Set(all.map(r => r.billingKind));
  assert.ok(kinds.has('subscription') && kinds.has('free') && kinds.has('no-price') && kinds.has('unverified'));
});

test('verifySeedPriceCombo passes only when seed input/output/cached still appear on the page', () => {
  const baseline = { input: 0.15, cached: 0.015, output: 0.6 };
  assert.ok(verifySeedPriceCombo('input 0.15 cached 0.015 output 0.6 per million tokens', baseline));
  // 格式化差异（0.60 / 0.1500）仍算命中。
  assert.ok(verifySeedPriceCombo('¥0.1500 / 0.60', { input: 0.15, cached: null, output: 0.6 }));
  // 调价：output 变成 0.9 → 不通过（保留旧价、标 stale）。
  assert.equal(verifySeedPriceCombo('input 0.15 output 0.9', baseline), false);
  // 缓存价消失 → 不通过。
  assert.equal(verifySeedPriceCombo('input 0.15 output 0.6', baseline), false);
  // 空页/改版 → 不通过。
  assert.equal(verifySeedPriceCombo('', baseline), false);
  assert.equal(verifySeedPriceCombo('<html>rebranded pricing</html>', baseline), false);
  // 边界匹配：整数 1/4 不得命中 12、40 这类子串。
  assert.equal(verifySeedPriceCombo('input 12 output 40', { input: 1, cached: null, output: 4 }), false);
});
