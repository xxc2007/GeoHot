#!/usr/bin/env tsx
/**
 * 把仓库内版本化 seed（database/seeds/pricing/map-{A,B,C}.json，47 条）upsert 到 pricing_rates。
 * 用法（部署/迁移后跑一次，或作为刷新入口）：
 *   tsx tooling/import-pricing-map.ts                # 读仓库 seed
 *   tsx tooling/import-pricing-map.ts <extra.json>  # 追加外部研究 JSON（刷新用，不是唯一数据来源）
 *
 * 红线：actual 成本只来自回执；本表 public-api 价一律 equivalent-public-api；rates null 存 NULL，不按 0。
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sql} from '../packages/backend/src/db.ts';
import {parseSeedDoc, type PricingRateRecord} from '../packages/backend/src/admin/pricing-map.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(here, '..', 'database', 'seeds', 'pricing');

async function loadDocs(): Promise<PricingRateRecord[]> {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['map-A.json', 'map-B.json', 'map-C.json'].map((f) => path.join(SEED_DIR, f));
  const rows: PricingRateRecord[] = [];
  for (const f of files) {
    const doc = JSON.parse(await readFile(f, 'utf8'));
    rows.push(...parseSeedDoc(doc));
  }
  return rows;
}

async function upsert(r: PricingRateRecord) {
  const existing = await sql<{input_price: number|null; output_price: number|null; effective_at: Date|null}[]>`
    SELECT input_price, output_price, effective_at FROM pricing_rates WHERE id=${r.id}`;
  const changed = !existing.length ||
    existing[0]!.input_price !== r.input || existing[0]!.output_price !== r.output;
  await sql`INSERT INTO pricing_rates
    (id,service,model,name,currency,tiers,input_price,cached_price,output_price,billing_kind,
     source_urls,source_url,effective_at,fetched_at,last_attempt_at,last_success_at,last_error,stale,note)
    VALUES (${r.id},${r.service},${r.model},${r.name},${r.currency},${JSON.stringify(r.tiers)},
      ${r.input},${r.cached},${r.output},${r.billingKind},${JSON.stringify(r.sourceUrls)},
      ${r.sourceUrls[0] ?? null},${r.effectiveAt},${r.fetchedAt},now(),now(),null,false,${r.note})
    ON CONFLICT (id) DO UPDATE SET
      service=EXCLUDED.service,model=EXCLUDED.model,name=EXCLUDED.name,currency=EXCLUDED.currency,
      tiers=EXCLUDED.tiers,input_price=EXCLUDED.input_price,cached_price=EXCLUDED.cached_price,
      output_price=EXCLUDED.output_price,billing_kind=EXCLUDED.billing_kind,
      source_urls=EXCLUDED.source_urls,source_url=EXCLUDED.source_url,
      effective_at=COALESCE(EXCLUDED.effective_at, pricing_rates.effective_at),
      fetched_at=EXCLUDED.fetched_at,last_attempt_at=now(),last_success_at=now(),last_error=null,
      stale=EXCLUDED.stale,note=EXCLUDED.note,updated_at=now()`;
  if (changed) {
    await sql`INSERT INTO pricing_rate_versions
      (rate_id,service,model,currency,tiers,input_price,cached_price,output_price,billing_kind,effective_at,fetched_at,note)
      VALUES (${r.id},${r.service},${r.model},${r.currency},${JSON.stringify(r.tiers)},${r.input},${r.cached},
        ${r.output},${r.billingKind},COALESCE(${r.effectiveAt},now()),${r.fetchedAt},${r.note})`;
  }
}

const rows = await loadDocs();
const byKind = new Map<string, number>();
for (const r of rows) { await upsert(r); byKind.set(r.billingKind, (byKind.get(r.billingKind) ?? 0) + 1); }
console.log(JSON.stringify({upserted: rows.length, byKind: Object.fromEntries(byKind)}));
process.exit(0);
