/**
 * 官方研究映射（database/seeds/pricing/map-{A,B,C}.json，47 条）的统一归一化。
 * 被 seed 工具、DB 加载器和单测共用；不打外网、不编造价格。
 *
 * 红线：
 *  - pricing 表只存「刊例/等值估算/订阅/免费/无价/未核实」。actual 成本只能来自回执 cost_basis='actual'，
 *    这里任何 public-api 价都标 equivalent-public-api，绝不写 actual。
 *  - rates 为 null 的条目 input/cached/output 存 NULL，不按 0。
 *  - notes 里的「参考价」不进入费率。
 */

export type SeedBillingKind = "public-api" | "subscription" | "free" | "no-public-price" | "unverified";
export type RateBillingKind = "equivalent-public-api" | "subscription" | "free" | "no-price" | "unverified";

export interface SeedTier {
  input: number | null;
  cached_input: number | null;
  cached_write: number | null;
  output: number | null;
  reasoning: number | null;
  request: number | null;
}

export interface SeedEntry {
  service: string;
  upstream_model: string;
  official_provider: string | null;
  official_model_id: string | null;
  billing_kind: SeedBillingKind;
  currency: "CNY" | "USD" | null;
  unit: string | null;
  tiers: Record<string, SeedTier> | SeedTier | null;
  rates?: Record<string, SeedTier> | SeedTier | null;
  effective_at: string | null;
  fetched_at: string;
  stale: boolean;
  source_urls: string[];
  notes: string;
}

export interface PricingRateRecord {
  id: string;
  service: string;
  model: string;
  name: string;
  currency: "CNY" | "USD" | null;
  tiers: unknown;
  input: number | null;
  cached: number | null;
  output: number | null;
  billingKind: RateBillingKind;
  sourceUrls: string[];
  effectiveAt: string | null;
  fetchedAt: string;
  stale: boolean;
  note: string;
}

/** 订阅/内部聚合路由：即使研究给了公开刊例，也只是等值参考，不是该通道的实际账单。 */
export const INTERNAL_ROUTES = new Set([
  "workbuddy", "workbuddy-ai", "workbuddy-cn", "workbuddy-desktop", "loomy", "dots", "auto",
]);

const KIND_MAP: Record<SeedBillingKind, RateBillingKind> = {
  "public-api": "equivalent-public-api",
  subscription: "subscription",
  free: "free",
  "no-public-price": "no-price",
  unverified: "unverified",
};

/** 取基准档位：A 组 tiers 是档位名数组、费率在 rates；优先费率对象，list 档优先，否则首档。 */
function baseline(entry: SeedEntry): SeedTier | null {
  const source = (Array.isArray(entry.tiers) ? entry.rates : entry.tiers ?? entry.rates) ?? null;
  if (!source) return null;
  if (Array.isArray(source) || typeof source !== "object") return null;
  const rec = source as Record<string, SeedTier>;
  if ("input" in rec || "output" in rec) return rec as unknown as SeedTier;
  return rec.list ?? Object.values(rec)[0] ?? null;
}

/** 归一化单条研究映射。费率缺失时返回 null 单价，调用方必须保持 NULL，禁止当 0。 */
export function normalizeSeedEntry(entry: SeedEntry): PricingRateRecord {
  const billingKind = KIND_MAP[entry.billing_kind] ?? "no-price";
  const tier = baseline(entry);
  const hasQuote =
    entry.billing_kind === "public-api" && entry.currency && tier &&
    tier.input != null && tier.output != null;
  const input = hasQuote ? tier!.input : null;
  const cached = hasQuote && tier!.cached_input != null ? tier!.cached_input : null;
  const output = hasQuote ? tier!.output : null;
  return {
    id: `${entry.service}::${entry.upstream_model}`,
    service: entry.service,
    model: entry.upstream_model,
    name: entry.official_model_id ?? entry.upstream_model,
    currency: entry.currency,
    tiers: tier,
    input, cached, output,
    billingKind,
    sourceUrls: Array.isArray(entry.source_urls) ? entry.source_urls : [],
    effectiveAt: entry.effective_at,
    fetchedAt: entry.fetched_at,
    stale: entry.stale,
    note: entry.notes,
  };
}

/** 解析一份研究 JSON 的 entries 数组（容错：缺字段跳过）。 */
export function parseSeedDoc(doc: unknown): PricingRateRecord[] {
  const entries = (doc as { entries?: unknown[] })?.entries ?? [];
  return entries
    .map((e) => e as SeedEntry)
    .filter((e) => e && typeof e.service === "string" && typeof e.upstream_model === "string")
    .map(normalizeSeedEntry);
}

/** 历史价卡选择：在某调用时点 startedAt，返回有效版本；无当时价则返回 null（未计价）。 */
export function selectRateAt<T extends { effective_at: string | null }>(
  versions: T[], startedAt: string
): T | null {
  const past = versions
    .filter((v) => v.effective_at && new Date(v.effective_at) <= new Date(startedAt))
    .sort((a, b) => new Date(b.effective_at!).getTime() - new Date(a.effective_at!).getTime());
  return past[0] ?? null;
}

export interface PricingVersionRow {
  rateId: string;
  service: string;
  model: string;
  currency: "USD" | "CNY" | null;
  input: number | null;
  cached: number | null;
  output: number | null;
  billingKind: RateBillingKind;
  effectiveAt: string | null;
  fetchedAt: string | null;
}

/** 按 bucket 的北京日/小时构造调用时点（bucket 只到小时，取该小时整点）。 */
export function startedInstant(day: string | null, hour: number | null): string | null {
  if (!day || hour == null) return null;
  return `${day}T${String(hour).padStart(2, "0")}:00:00+08:00`;
}

/** 按 effectiveAt 选历史版本；无当时有效版本返回 null。 */
export function selectVersionAt(rows: PricingVersionRow[], startedAt: string): PricingVersionRow | null {
  const past = rows
    .filter((v) => v.effectiveAt && new Date(v.effectiveAt) <= new Date(startedAt))
    .sort((a, b) => new Date(b.effectiveAt!).getTime() - new Date(a.effectiveAt!).getTime());
  return past[0] ?? null;
}

/**
 * 选某 service/model 在调用时点有效的价卡版本。
 * 先按 service::model 精确匹配；无当时有效版本返回 null（不计估算价，不拿最新价倒算）。
 */
export function resolveVersionAt(
  versionsByRate: Map<string, PricingVersionRow[]>, service: string | null, model: string | null, startedAt: string | null
): PricingVersionRow | null {
  if (!service || !model || !startedAt) return null;
  const rows = versionsByRate.get(`${service}::${model}`);
  if (!rows?.length) return null;
  return selectVersionAt(rows, startedAt);
}

/** 数值在页面文本里的可能写法：0.15 / 0.1500 / 0.6 / 0.60 都算命中。 */
function priceCandidates(n: number): string[] {
  const set = new Set<string>([String(n), n.toFixed(2), n.toFixed(4)]);
  return [...set].filter(Boolean);
}

/** 独立数字边界匹配：避免整数 1 命中 12、0.1 命中 0.15 这类子串误判。 */
function appearsAlone(text: string, n: number): boolean {
  return priceCandidates(n).some((c) => {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![0-9.])${escaped}(?![0-9])`).test(text);
  });
}

/**
 * 保守校验：页面必须仍包含 seed 基准的 input/output 数值组合（cached 若有也需在）。
 * 不解析新价、不发现新档位；任一基准值在页面上消失/改版/调价即判不通过，
 * 由调用方保留最后成功价并标 stale。HTTP 200 本身不构成通过。
 */
export function verifySeedPriceCombo(
  body: string, baseline: { input: number | null; cached: number | null; output: number | null }
): boolean {
  if (!body) return false;
  const text = body.replace(/\s+/g, " ");
  const has = (n: number | null) => n == null || appearsAlone(text, n);
  return has(baseline.input) && has(baseline.output) && has(baseline.cached);
}
