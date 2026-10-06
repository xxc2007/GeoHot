import { beijingDate, beijingTime, beijingWeekday } from "@aihot/contracts/time";

export { beijingDate, beijingTime, beijingWeekday };

/**
 * Which Beijing day an api answer was read on. The「今天」headers and the day counts come from the same answer,
 * so the page asks that instant instead of the browser's clock: a document rendered at 23:59:59.9 and hydrated a
 * tick later would otherwise split into two different "today"s.
 */
export const todayOf = (generatedAt: string) => beijingDate(Date.parse(generatedAt));

/** "9月1日" (Beijing). With `today` (YYYY-MM-DD) it keeps the year when the day is not this year's. */
export function monthDay(iso: string, today?: string): string {
  const date = beijingDate(iso);
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const base = `${m}月${d}日`;
  return today && date.slice(0, 4) !== today.slice(0, 4) ? `${date.slice(0, 4)}年${base}` : base;
}

export function dayLabel(date: string, today: string): string {
  const base = monthDay(date);
  if (date === today) return `今天 · ${base}`;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 1) return `昨天 · ${base}`;
  if (date.slice(0, 4) !== today.slice(0, 4)) return `${date.slice(0, 4)}年${base}`;
  return base;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  // Floor, never round: 59 seconds is "刚刚" and 59 minutes 50 seconds is "59 分钟前". A rounded unit
  // announces a minute (or a day) that has not passed yet.
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  // Past a month the count stops carrying information. Name the day in the same Chinese form the rest
  // of the line uses — an ISO `2026-09-01` in the middle of a Chinese sentence reads as a bug.
  return monthDay(iso, beijingDate(now));
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days. */
export function monthDayTime(iso: string): string {
  return `${monthDay(iso)} ${beijingTime(iso)}`;
}

/** "X：Ethan Mollick (@emollick)" → "Ethan Mollick"; other sources keep their name. */
export function shortSourceName(name: string): string {
  const m = /^X[:：]\s*(.+?)\s*\(@[^)]+\)\s*$/.exec(name);
  if (m) return m[1]!.replace(/（.*?）/g, "").trim();
  return name.replace(/（RSS）|（网页）|（API）/g, "").trim();
}

export function sourceInitial(name: string): string {
  const s = shortSourceName(name).replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
