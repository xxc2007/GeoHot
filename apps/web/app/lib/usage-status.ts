// Pure, testable helpers for the admin Usage page state machine.
// The page must never fake "real-time" numbers: a cached/old snapshot is labelled stale,
// and a day the snapshot did not cover is explicitly NOT shown as zero.
import { beijingToday } from "@aihot/contracts/usage-date";

export type UsageBackendState = "ready" | "stale" | "unavailable" | "error";
export type UsageViewState = "ready-data" | "ready-empty" | "stale" | "generating" | "error";

/** Instant (ms) for Beijing civil-day 00:00 of `day` (YYYY-MM-DD). */
export function beijingDayStart(day: string): number {
  // `day` is already a Beijing calendar date; interpret it as +08:00 midnight.
  return Date.parse(`${day}T00:00:00+08:00`);
}

/** True when `asOf` (ISO instant) is at or after Beijing midnight of `day`. */
export function asOfCoversDay(asOf: string | null, day: string): boolean {
  if (!asOf) return false;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return t >= beijingDayStart(day);
}

/**
 * Does the viewed range include "today" in Beijing? When it does, an old snapshot that
 * predates today's midnight cannot claim "today = 0".
 */
export function rangeIncludesToday(range: string, selectedDate: string | null, today: string): boolean {
  if (selectedDate) return selectedDate === today;
  return range === "today" || range === "7" || range === "30" || range === "90" || range === "all";
}

export interface UsageViewInput {
  /** State returned by the loader: backend snapshot state, or `error` when the request failed. */
  statusState: UsageBackendState;
  /** ISO instant the rows were actually computed at. */
  asOf: string | null;
  /** total.calls for the viewed scope, or 0 when no rows. */
  totalCalls: number;
  range: string;
  selectedDate: string | null;
  /** Beijing today (YYYY-MM-DD). */
  today: string;
  /** True when we have an older successful snapshot for the SAME scope to fall back to. */
  hasFallback: boolean;
  /** Human readable load error when statusState === "error". */
  loadError: string | null;
}

export interface UsageView {
  state: UsageViewState;
  /** When true, the numbers on screen are stale and must be labelled as such. */
  stale: boolean;
  /** Notice text to show (already in user language); empty string means no notice. */
  notice: string;
  /** True when the numbers must NOT be presented as authoritative (e.g. today not covered). */
  numbersUnverified: boolean;
}

export function classifyUsageView(i: UsageViewInput): UsageView {
  // Hard failure with nothing to show: real error + retry, no spinner, no fake zeros.
  if (i.statusState === "error" && !i.hasFallback) {
    return { state: "error", stale: false, numbersUnverified: true, notice: i.loadError ?? "用量数据暂时加载失败。" };
  }
  // Backend has no snapshot at all yet (first-run aggregation still running). Not an error:
  // show the real backend message and retry, never an indefinite spinner and never zeros.
  if (i.statusState === "unavailable" && !i.hasFallback) {
    return {
      state: "generating",
      stale: false,
      numbersUnverified: true,
      notice: "后台正在聚合用量统计（首次加载需要读取历史请求）。完成后会自动更新；尚未取得数据，不代表用量为零。",
    };
  }

  // We have rows to render (current successful load, or a same-scope fallback).
  const viewingTodayRange = rangeIncludesToday(i.range, i.selectedDate, i.today);
  const coversToday = viewingTodayRange && asOfCoversDay(i.asOf, i.today);
  // Backend says the snapshot is stale, or the load failed but we kept last good.
  const backendStale = i.statusState === "stale" || i.statusState === "error" || i.statusState === "unavailable";
  // Even when backend says "ready", a snapshot taken before today's Beijing midnight cannot
  // authoritatively answer "today" — treat it as stale for today's range.
  const todayNotCovered = viewingTodayRange && !coversToday;

  const empty = i.totalCalls === 0;
  let notice = "";
  if (backendStale) notice = "保留上次成功统计；正在后台重试更新，数字可能不是最新。";
  if (todayNotCovered) {
    const asOfDay = i.asOf ? new Date(i.asOf).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) : "—";
    notice = `${notice ? notice + " " : ""}统计更新于 ${asOfDay}（北京时间），尚未覆盖今日 ${i.today}；下方数字是上次快照，不代表今日为 0。`;
  }

  const stale = backendStale || todayNotCovered;
  if (!stale && empty) {
    return { state: "ready-empty", stale: false, numbersUnverified: false, notice: "" };
  }
  return { state: stale ? "stale" : "ready-data", stale, numbersUnverified: stale, notice };
}

/** Beijing today, injectable for tests. */
export function todayBeijing(now = new Date()): string {
  return beijingToday(now);
}
