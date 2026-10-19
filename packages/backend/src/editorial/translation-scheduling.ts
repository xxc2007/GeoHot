import { beijingMidnight, isDay } from "@aihot/contracts/time";

export function translateWindowDays(raw: string | undefined, dflt = 30): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

/** Explicit history scope overrides rolling windows for both legs; dates mean Beijing midnight. */
export function translationScope(opts: { now?: Date; from?: string; bodyDays?: string; quoteDays?: string } = {}) {
  const now = opts.now ?? new Date();
  const from = opts.from ?? process.env.GEOHOT_TRANSLATE_FROM;
  if (from !== undefined && from !== "") {
    if (!isDay(from)) throw new Error("GEOHOT_TRANSLATE_FROM must be a valid YYYY-MM-DD date");
    const cutoff = beijingMidnight(from);
    return { historical: true, bodyFrom: cutoff, quoteFrom: cutoff };
  }
  return {
    historical: false,
    bodyFrom: new Date(now.getTime() - translateWindowDays(opts.bodyDays ?? process.env.GEOHOT_TRANSLATE_WINDOW_DAYS, 30) * 86400_000),
    quoteFrom: new Date(now.getTime() - translateWindowDays(opts.quoteDays ?? process.env.GEOHOT_TRANSLATE_QUOTE_WINDOW_DAYS, 3) * 86400_000),
  };
}

export interface TranslationRank { article_id: string; by_fresh: number; by_short: number; by_old: number }

/** Each stream contains its first N candidates. Skip overlap and refill to N unique work units. */
export function fairTranslationOrder(rows: TranslationRank[], total: number, historical: boolean): string[] {
  const fresh = [...rows].sort((a, b) => a.by_fresh - b.by_fresh);
  const short = [...rows].sort((a, b) => a.by_short - b.by_short);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => { if (!seen.has(id) && out.length < total) { seen.add(id); out.push(id); } };
  if (historical && rows.length) add([...rows].sort((a, b) => a.by_old - b.by_old)[0]!.article_id);
  let f = 0, s = 0;
  while (out.length < total && (f < fresh.length || s < short.length)) {
    while (f < fresh.length && seen.has(fresh[f]!.article_id)) f++;
    if (f < fresh.length) add(fresh[f++]!.article_id);
    while (s < short.length && seen.has(short[s]!.article_id)) s++;
    if (s < short.length) add(short[s++]!.article_id);
  }
  return out;
}
