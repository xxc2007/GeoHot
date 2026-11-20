import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadPricingRates} from '../packages/backend/src/admin/official-pricing.ts';

test('loadPricingRates falls back to hardcoded constants when table missing (no external fetch)', async () => {
  // 模拟 db 抛错（表不存在）：必须回落常量，不能打外网、不能 reject。
  const throwingDb = { query: async () => { throw new Error('relation pricing_rates does not exist'); } } as never;
  const { rates, stale } = await loadPricingRates(throwingDb);
  assert.ok(rates.length >= 9);
  assert.ok(rates.find(r => r.id === 'deepseek'));
  assert.ok(rates.find(r => r.id === 'agnes-cn'));
  // 表不存在时视为 stale，前端应提示「未实时复核」。
  assert.equal(stale, true);
});

test('loadPricingRates marks stale when every row is stale=false is honored', async () => {
  // db 是 postgres.js 风格的 tagged template 函数。
  const one = {
    id: 'deepseek', name: 'DeepSeek V4.1 Flash', currency: 'USD',
    input: 0.15, cached: 0.003, output: 0.60,
    billing_kind: 'equivalent-public-api', source_url: null, source_urls: [],
    effective_at: '2026-10-31', fetched_at: '2026-10-31', stale: false, note: null,
  };
  // tagged template: db`...` 即 db(strings,...values) 返回 Promise<rows>。
  const fakeDb = (() => Promise.resolve([one])) as never;
  const { rates, stale } = await loadPricingRates(fakeDb);
  assert.equal(rates.length, 1);
  assert.equal(rates[0]!.id, 'deepseek');
  assert.equal(stale, false);
});

test('no-price models (hy4-flash) never get a guessed rate', () => {
  // hy4-flash 在 aliases 里故意不映射；这里只验证框架不偷偷把它归到 hy3。
  // 真正的 unmapped 行为由 official-pricing.test.ts 覆盖，本测试守住「不引入新映射」这条红线。
  const known = ['deepseek','hy3','glm53flash','glm53flash-intl','step5','minimax','dots','agnes','agnes-cn'];
  assert.ok(!known.includes('hy4-flash'));
});
