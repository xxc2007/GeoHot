#!/usr/bin/env tsx
/**
 * 合并导入三组官方定价研究 JSON（A/B/C）到 pricing_rates。
 * 用法：tsx tooling/import-pricing-map.ts <A.json> <B.json> <C.json>
 * 规则：
 *  - billing_kind 原样入库：public-api / subscription / free / no-public-price / unverified。
 *  - A 组 workbuddy/loomy 等订阅/内部路由上的 public-api 价，重标为 equivalent-public-api（等值估算，非 actual 账单）。
 *  - rates 为 null 的条目：input/cached/output 存 NULL，绝不按 0 计价。
 *  - C/B 组 notes 里的「参考价」不写入费率，只留 note 文本。
 */
import {readFile} from 'node:fs/promises';
import {sql} from '../packages/backend/src/db.ts';

type BillingKind = 'public-api'|'subscription'|'free'|'no-public-price'|'unverified';
interface Entry {
  service: string; upstream_model: string;
  billing_kind: BillingKind;
  currency: 'CNY'|'USD'|null;
  rates: Record<string, {input:number|null;cached_input:number|null;output:number|null}|null>;
  effective_at: string|null; fetched_at: string; stale: boolean;
  source_urls: string[]; notes: string;
}

// 这些路由是订阅/内部通道，公开 API 价只是「等值参考」，不是实际账单。
const SUBSCRIPTION_ROUTES = new Set(['workbuddy','workbuddy-ai','workbuddy-cn','workbuddy-desktop','loomy','dots','auto']);

async function importOne(path: string) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const entries = raw.entries as Entry[];
  let actual = 0, equivalent = 0, noRate = 0;
  for (const e of entries) {
    const id = `${e.service}::${e.upstream_model}`;
    let kind = e.billing_kind;
    let input: number|null = null, cached: number|null = null, output: number|null = null;
    if (e.billing_kind === 'public-api' && e.currency) {
      const tier = e.rates && (e.rates.list ?? Object.values(e.rates)[0]);
      if (tier && tier.input != null && tier.output != null) {
        input = tier.input; cached = tier.cached_input ?? 0; output = tier.output;
        kind = SUBSCRIPTION_ROUTES.has(e.service) ? 'equivalent-public-api' : 'actual';
        kind === 'actual' ? actual++ : equivalent++;
      } else {
        kind = 'unverified'; noRate++;
      }
    } else {
      noRate++;
    }
    await sql`INSERT INTO pricing_rates
      (id,name,currency,input_price,cached_price,output_price,billing_kind,source_url,effective_at,fetched_at,stale,note)
      VALUES (${id},${e.upstream_model},${e.currency},${input},${cached},${output},${kind},
        ${e.source_urls[0] ?? null},${e.effective_at},${e.fetched_at},${e.stale},${e.notes})
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name,currency=EXCLUDED.currency,input_price=EXCLUDED.input_price,
        cached_price=EXCLUDED.cached_price,output_price=EXCLUDED.output_price,
        billing_kind=EXCLUDED.billing_kind,source_url=EXCLUDED.source_url,
        effective_at=COALESCE(EXCLUDED.effective_at, pricing_rates.effective_at),
        fetched_at=EXCLUDED.fetched_at,stale=EXCLUDED.stale,note=EXCLUDED.note,updated_at=now()`;
  }
  console.log(path, JSON.stringify({actual, equivalent, noRate, total: entries.length}));
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: import-pricing-map.ts <A.json> [B.json] [C.json]'); process.exit(1); }
for (const f of files) await importOne(f);
process.exit(0);
