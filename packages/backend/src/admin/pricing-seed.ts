/**
 * 价卡 seed：把仓库内版本化的 A/B/C 研究映射（database/seeds/pricing/*.json，47 条）幂等落库。
 * - 由 scripts/migrate.ts 在迁移后调用，clean clone 跑 `db:migrate` 即有数据，无需手工导入。
 * - fetched_at/last_success_at 用研究抓取时点（JSON fetched_at），不把部署时刻伪造成重新核价。
 * - 费率 NULL 保持 NULL，不按 0；actual 成本只来自回执，本表不写 actual。
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO_ROOT} from '../config.ts';
import type {Db} from '../db.ts';
import {parseSeedDoc, type PricingRateRecord} from './pricing-map.ts';

const SEED_FILES = ['map-A.json', 'map-B.json', 'map-C.json'];

export async function loadSeedRecords(): Promise<PricingRateRecord[]> {
  const dir = path.join(REPO_ROOT, 'database', 'seeds', 'pricing');
  const records: PricingRateRecord[] = [];
  for (const file of SEED_FILES) {
    const doc = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    records.push(...parseSeedDoc(doc));
  }
  return records;
}

/** 幂等 upsert；价格/档位相对上一行变化时写一条历史版本。返回写入条数。 */
export async function upsertPricingSeed(db: Db, records: PricingRateRecord[]): Promise<number> {
  for (const r of records) {
    const existing = await db<{input_price: number | null; output_price: number | null; cached_price: number | null}[]>`
      SELECT input_price, cached_price, output_price FROM pricing_rates WHERE id=${r.id}`;
    const changed = !existing.length ||
      existing[0]!.input_price !== r.input || existing[0]!.cached_price !== r.cached ||
      existing[0]!.output_price !== r.output;
    await db`INSERT INTO pricing_rates
      (id,service,model,name,currency,tiers,input_price,cached_price,output_price,billing_kind,
       source_urls,source_url,effective_at,fetched_at,last_attempt_at,last_success_at,last_error,stale,note)
      VALUES (${r.id},${r.service},${r.model},${r.name},${r.currency},${JSON.stringify(r.tiers)},
        ${r.input},${r.cached},${r.output},${r.billingKind},${JSON.stringify(r.sourceUrls)},
        ${r.sourceUrls[0] ?? null},${r.effectiveAt},${r.fetchedAt},${r.fetchedAt},${r.fetchedAt},null,${r.stale},${r.note})
      ON CONFLICT (id) DO UPDATE SET
        service=EXCLUDED.service,model=EXCLUDED.model,name=EXCLUDED.name,currency=EXCLUDED.currency,
        tiers=EXCLUDED.tiers,input_price=EXCLUDED.input_price,cached_price=EXCLUDED.cached_price,
        output_price=EXCLUDED.output_price,billing_kind=EXCLUDED.billing_kind,
        source_urls=EXCLUDED.source_urls,source_url=EXCLUDED.source_url,
        effective_at=COALESCE(EXCLUDED.effective_at, pricing_rates.effective_at),
        fetched_at=EXCLUDED.fetched_at,last_attempt_at=EXCLUDED.fetched_at,
        last_success_at=EXCLUDED.fetched_at,last_error=null,stale=EXCLUDED.stale,note=EXCLUDED.note,updated_at=now()`;
    if (changed) {
      await db`INSERT INTO pricing_rate_versions
        (rate_id,service,model,currency,tiers,input_price,cached_price,output_price,billing_kind,effective_at,fetched_at,note)
        VALUES (${r.id},${r.service},${r.model},${r.currency},${JSON.stringify(r.tiers)},${r.input},${r.cached},
          ${r.output},${r.billingKind},COALESCE(${r.effectiveAt},now()),${r.fetchedAt},${r.note})`;
    }
  }
  return records.length;
}

/** migrate 后调用：加载仓库 seed 并落库。 */
export async function seedPricingRates(db: Db): Promise<number> {
  const records = await loadSeedRecords();
  return upsertPricingSeed(db, records);
}
