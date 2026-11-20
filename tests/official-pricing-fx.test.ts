import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { officialCosts, resolveFx, loadPricingRates, pricingRowsToDetail } from "../packages/backend/src/admin/official-pricing.ts";
import { seedPricingRates } from "../packages/backend/src/admin/pricing-seed.ts";
import { CNY_FX } from "@aihot/contracts/cny";
after(closeDb);

// 汇率单一来源：officialCosts 折算优先用调用方传入的 fx（由 usage.ts 从 fx_rates 最新行解析），
// 无行回落 CNY_FX 兜底常量。有行/无行两路都在这里钉住。
test("resolveFx 有行时取行值，无行/坏行回落 CNY_FX 常量", () => {
  const live = resolveFx({ rate: 6.6529, as_of: "2026-10-30", source_url: "https://api.frankfurter.app/latest?from=USD&to=CNY" });
  assert.equal(live.usdToCny, 6.6529);
  assert.equal(live.date, "2026-10-30");
  assert.equal(live.source, "https://api.frankfurter.app/latest?from=USD&to=CNY");
  assert.equal(resolveFx(null), CNY_FX);
  assert.equal(resolveFx(undefined), CNY_FX);
  assert.equal(resolveFx(null).usdToCny, 6.718);
  // 坏行（0/负/NaN）不进折算，同样回落。
  assert.equal(resolveFx({ rate: 0, as_of: "2026-10-30", source_url: null }), CNY_FX);
  assert.equal(resolveFx({ rate: Number.NaN, as_of: "2026-10-30", source_url: null }), CNY_FX);
});

test("officialCosts 按传入汇率折算 USD 组（fx_rates 注入路径）", () => {
  const buckets = [{ service: "llm", model: "MiniMax-M3.1-Flash", day: "2026-10-30", hour: 3, calls: 1, pricedCalls: 1, pricedIn: 1_000_000, pricedOut: 1_000_000, cachedTokens: 0, unknownCacheIn: 0, cacheUnknownCalls: 0 }];
  const at665 = officialCosts(buckets, true, { usdToCny: 6.6529, date: "2026-10-30", source: "x" });
  // input 0.15 + output 0.60 = 0.75 USD → ×6.6529 = 4.989675
  assert.ok(Math.abs(at665.totals[0]!.list.low - 4.989675) < 1e-9);
  const atConst = officialCosts(buckets, true);
  assert.ok(Math.abs(atConst.totals[0]!.list.low - 0.75 * CNY_FX.usdToCny) < 1e-9);
  // 同一组数据，注入汇率不同则结果不同——证明 fx 参数真实参与折算。
  assert.notEqual(at665.totals[0]!.list.low, atConst.totals[0]!.list.low);
});

test("officialCosts 缓存未知单口径：上下界同值（区间消失）", () => {
  // 全部 token 都在 unknownCacheIn 里：低=高=cached 价。
  const buckets = [{ service: "llm", model: "hy3", day: "2026-10-30", hour: 3, calls: 1, pricedCalls: 1, pricedIn: 1_000_000, pricedOut: 0, cachedTokens: 0, unknownCacheIn: 1_000_000, cacheUnknownCalls: 1 }];
  const r = officialCosts(buckets, true);
  const m = r.models[0]!;
  assert.equal(m.list!.low, m.list!.high);
  assert.ok(Math.abs(m.list!.low - 0.25) < 1e-9); // hy3 cached = 0.25 CNY / 1M
});

test("fx_rates 表有行时 resolveFx 链路读最新行（数据库两路）", async () => {
  const day = "2026-06-01";
  await sql`DELETE FROM fx_rates WHERE as_of = ${day}`;
  await sql`INSERT INTO fx_rates (as_of, pair, rate, source_name, source_url) VALUES (${day}, 'USD/CNY', 7.1234, '欧洲央行', 'https://api.frankfurter.app/latest?from=USD&to=CNY')`;
  const [row] = await sql<{ rate: number; as_of: string; source_url: string | null }[]>`
    SELECT rate, as_of::text AS as_of, source_url FROM fx_rates WHERE pair = 'USD/CNY' ORDER BY as_of DESC LIMIT 1`;
  const fx = resolveFx(row);
  assert.equal(fx.usdToCny, 7.1234);
  await sql`DELETE FROM fx_rates WHERE as_of = ${day}`;
  // 删行后回落常量
  const [none] = await sql<{ rate: number; as_of: string; source_url: string | null }[]>`
    SELECT rate, as_of::text AS as_of, source_url FROM fx_rates WHERE pair = 'USD/CNY' ORDER BY as_of DESC LIMIT 1`;
  assert.equal(resolveFx(none ?? null), CNY_FX);
});

test("seed 重跑不覆盖异步刷新写入的 stale/last_error/last_success_at/fetched_at", async () => {
  const [before] = await sql<{ id: string; stale: boolean; last_error: string | null; ls: string | null; fa: string | null }[]>`
    SELECT id, stale, last_error, last_success_at::text AS ls, fetched_at::text AS fa
    FROM pricing_rates WHERE billing_kind='equivalent-public-api' ORDER BY id LIMIT 1`;
  const setTs = "2026-11-10T00:00:00+08:00";
  await sql`UPDATE pricing_rates SET stale=true, last_error='probe failed',
    last_success_at=${setTs}, fetched_at=${setTs}
    WHERE id=${before!.id}`;
  await seedPricingRates(sql);
  const [after] = await sql<{ stale: boolean; last_error: string | null; ls: string | null; fa: string | null }[]>`
    SELECT stale, last_error, last_success_at::text AS ls, fetched_at::text AS fa FROM pricing_rates WHERE id=${before!.id}`;
  assert.equal(after!.stale, true);
  assert.equal(after!.last_error, "probe failed");
  // 时间列按瞬间比较：PG 返回的文本格式（空格/+08）与 ISO 输入不同，不能逐字符串比。
  assert.equal(new Date(after!.ls!).getTime(), new Date(setTs).getTime());
  assert.equal(new Date(after!.fa!).getTime(), new Date(setTs).getTime());
});

test("loadPricingRates/明细只纳可计价行，订阅免费无价行不进 report.rates", async () => {
  const { rates } = await loadPricingRates(sql);
  const detail = pricingRowsToDetail(rates);
  for (const p of detail.rates) {
    assert.ok(p.input != null && p.output != null && p.currency);
  }
  assert.ok(detail.rates.length <= rates.length);
});
