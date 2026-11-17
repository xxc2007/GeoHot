#!/usr/bin/env tsx
/**
 * 把官方定价研究 JSON（pricing-map-A.json 等）upsert 到 pricing_rates 表。
 * 只读 JSON + 写 DB，不打外网。B/C 组 JSON 到了直接跑 `tsx tooling/import-pricing-map.ts <file>`。
 * 不编造价格：no-public-price 条目不写费率，只留 billing_kind='no-price' 标记。
 */
import {readFile} from 'node:fs/promises';
import {sql} from '../packages/backend/src/db.ts';

interface Entry {
  service: string; upstream_model: string;
  official_provider: string | null; official_model_id: string | null;
  billing_kind: 'public-api' | 'no-public-price' | 'subscription' | 'free';
  currency: 'CNY' | 'USD' | null;
  rates: Record<string, { input: number | null; cached_input: number | null; output: number | null; reasoning: number | null }>;
  effective_at: string | null; fetched_at: string; stale: boolean;
  source_urls: string[]; notes: string;
}

async function main(path: string) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const entries = raw.entries as Entry[];
  let inserted = 0, noPrice = 0, skipped = 0;
  for (const e of entries) {
    const id = `${e.service}::${e.upstream_model}`;
    if (e.billing_kind === 'no-public-price' || !e.currency) {
      // 无公开价：upsert 一行标记，费率留 0/NULL 由前端识别。
      await sql`INSERT INTO pricing_rates (id,name,currency,input_price,cached_price,output_price,billing_kind,source_url,effective_at,fetched_at,stale,note)
        VALUES (${id},${e.upstream_model},'CNY',0,0,0,'no-price',null,now(),${e.fetched_at},true,${e.notes})
        ON CONFLICT (id) DO UPDATE SET billing_kind='no-price',fetched_at=${e.fetched_at},note=${e.notes}`;
      noPrice++; continue;
    }
    // 取 list 档作为基准（峰谷/promo 由 peakFactor 应用，不存多档）。
    const tier = e.rates.list ?? Object.values(e.rates)[0];
    if (!tier || tier.input == null || tier.output == null) { skipped++; continue; }
    await sql`INSERT INTO pricing_rates (id,name,currency,input_price,cached_price,output_price,billing_kind,source_url,effective_at,fetched_at,stale,note)
      VALUES (${id},${e.official_model_id ?? e.upstream_model},${e.currency},${tier.input},${tier.cached_input ?? 0},${tier.output},'actual',${e.source_urls[0] ?? null},${e.effective_at ?? null},${e.fetched_at},${e.stale},${e.notes})
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,input_price=EXCLUDED.input_price,cached_price=EXCLUDED.cached_price,output_price=EXCLUDED.output_price,billing_kind=EXCLUDED.billing_kind,source_url=EXCLUDED.source_url,effective_at=EXCLUDED.effective_at,fetched_at=EXCLUDED.fetched_at,stale=EXCLUDED.stale,note=EXCLUDED.note,updated_at=now()`;
    inserted++;
  }
  console.log(JSON.stringify({inserted, noPrice, skipped, total: entries.length}));
  process.exit(0);
}
main(process.argv[2]!).catch(e => { console.error(e); process.exit(1); });
