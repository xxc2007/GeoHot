#!/usr/bin/env tsx
/**
 * 异步价卡刷新（由 timer/cron 调用，页面请求绝不打外网）。
 *
 * 契约：
 *  - 只访问 seed 条目的 source_urls（公开官方页）；不主动发现新源。
 *  - HTTP 200 本身不算成功：必须解析出正数 input/output 单价才更新 fetched_at/last_success_at、置 stale=false。
 *  - 失败/无法解析：写 last_error、置 stale=true，保留最后一次成功价卡，不清空费率。
 *  - 订阅/免费/无价/未核实条目无逐 token 公开价，不参与单价校验，保持原 stale 标记。
 *
 * 厂商页校验：verifySeedPriceCombo 只核对页面是否仍含 seed 基准数值组合；
 * 不解析新价、不发现新档位。任一基准值消失/改版/调价即判 stale，保留最后成功价。
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO_ROOT} from '../packages/backend/src/config.ts';
import {sql} from '../packages/backend/src/db.ts';
import {parseSeedDoc, verifySeedPriceCombo, type PricingRateRecord} from '../packages/backend/src/admin/pricing-map.ts';

const SEED_DIR = path.join(REPO_ROOT, 'database', 'seeds', 'pricing');
const FETCH_TIMEOUT_MS = 10_000;

async function fetchBody(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { accept: 'text/html,application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshEntry(e: PricingRateRecord): Promise<{ id: string; outcome: 'verified' | 'stale' | 'skipped'; reason?: string }> {
  if (e.billingKind !== 'equivalent-public-api') {
    // 非公开 API 通道无逐 token 公开价：保留既有标记，不参与单价校验。
    return { id: e.id, outcome: 'skipped' };
  }
  // 无基准刊例（费率 null）的条目不参与校验：保持原 stale 标记，不把 null 当 0 去比对。
  if (e.input == null || e.output == null) {
    await sql`UPDATE pricing_rates SET last_attempt_at=now(), stale=true WHERE id=${e.id}`;
    return { id: e.id, outcome: 'stale', reason: 'no baseline quote to verify' };
  }
  const url = e.sourceUrls[0];
  if (!url) {
    await sql`UPDATE pricing_rates SET last_attempt_at=now(), last_error='no source url', stale=true WHERE id=${e.id}`;
    return { id: e.id, outcome: 'stale', reason: 'no source url' };
  }
  try {
    const body = await fetchBody(url);
    // 保守校验：页面必须仍含 seed 基准的 input/output（及 cached）数值组合。
    // 校验通过只刷新核验时间戳，不改写费率；不解析、不发现新价，避免把网页报价误当新刊例。
    const ok = verifySeedPriceCombo(body, { input: e.input, cached: e.cached, output: e.output });
    if (!ok) {
      // 改版/调价/数值消失：保留最后成功价，标 stale，不清空费率。
      await sql`UPDATE pricing_rates SET last_attempt_at=now(), last_error='seed price combo changed or missing', stale=true WHERE id=${e.id}`;
      return { id: e.id, outcome: 'stale', reason: 'seed price combo changed or missing' };
    }
    await sql`UPDATE pricing_rates SET
      fetched_at=now(), last_success_at=now(), last_error=null, stale=false, updated_at=now()
      WHERE id=${e.id}`;
    return { id: e.id, outcome: 'verified' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await sql`UPDATE pricing_rates SET last_attempt_at=now(), last_error=${reason.slice(0, 500)}, stale=true WHERE id=${e.id}`;
    return { id: e.id, outcome: 'stale', reason };
  }
}

async function main() {
  const records: PricingRateRecord[] = [];
  for (const f of ['map-A.json', 'map-B.json', 'map-C.json']) {
    const doc = JSON.parse(await readFile(path.join(SEED_DIR, f), 'utf8'));
    records.push(...parseSeedDoc(doc));
  }
  const summary = { verified: 0, stale: 0, skipped: 0, failures: [] as string[] };
  for (const e of records) {
    const r = await refreshEntry(e);
    if (r.outcome === 'verified') summary.verified++;
    else if (r.outcome === 'stale') { summary.stale++; if (r.reason) summary.failures.push(`${r.id}: ${r.reason}`); }
    else summary.skipped++;
  }
  console.log(JSON.stringify(summary));
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
