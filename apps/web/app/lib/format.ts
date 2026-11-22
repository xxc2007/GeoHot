import { beijingDate, beijingTime, beijingWeekday } from "@aihot/contracts/time";
import type { Locale } from "./i18n";

export { beijingDate, beijingTime, beijingWeekday };

/** 英文页的月份与星期写法：日期函数的英文分支共用（与 story.ts、daily-archive.ts 字典同一批词）。 */
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_EN_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * 星期名随语言走：全称（「星期六」/「Saturday」）与短写（「周六」/「Sat」）。中文全称直接来自
 * contracts/time 的 beijingWeekday，词表只有一份；英文按 ISO 日期的 UTC 星期取词——入参本来就是
 * 北京日历日，两种算法同值。
 */
export function weekdayName(iso: string, locale: Locale = "zh"): string {
  if (locale === "en") return WEEKDAY_EN[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;
  return beijingWeekday(iso);
}

export function weekdayShort(iso: string, locale: Locale = "zh"): string {
  if (locale === "en") return WEEKDAY_EN_SHORT[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;
  return beijingWeekday(iso).replace("星期", "周");
}

/**
 * Which Beijing day an api answer was read on. The「今天」headers and the day counts come from the same answer,
 * so the page asks that instant instead of the browser's clock: a document rendered at 23:59:59.9 and hydrated a
 * tick later would otherwise split into two different "today"s.
 */
export const todayOf = (generatedAt: string) => beijingDate(Date.parse(generatedAt));

/** "9月1日"（中文）/ "Sep 1"（英文，Beijing）。带 `today`（YYYY-MM-DD）时跨年的日子补上年份。 */
export function monthDay(iso: string, today?: string, locale: Locale = "zh"): string {
  const date = beijingDate(iso);
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const base = locale === "en" ? `${MONTH_EN[m - 1]} ${d}` : `${m}月${d}日`;
  return today && date.slice(0, 4) !== today.slice(0, 4)
    ? (locale === "en" ? `${base}, ${date.slice(0, 4)}` : `${date.slice(0, 4)}年${base}`)
    : base;
}

export function dayLabel(date: string, today: string, locale: Locale = "zh"): string {
  const base = monthDay(date, undefined, locale);
  if (date === today) return locale === "en" ? `Today · ${base}` : `今天 · ${base}`;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 1) return locale === "en" ? `Yesterday · ${base}` : `昨天 · ${base}`;
  if (date.slice(0, 4) !== today.slice(0, 4)) return monthDay(date, today, locale);
  return base;
}

export function relativeTime(iso: string, locale: Locale = "zh", now = Date.now()): string {
  const t = Date.parse(iso);
  // Floor, never round: 59 seconds is "刚刚" and 59 minutes 50 seconds is "59 分钟前". A rounded unit
  // announces a minute (or a day) that has not passed yet.
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return locale === "en" ? "just now" : "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return locale === "en" ? `${m}m ago` : `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return locale === "en" ? `${h}h ago` : `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return locale === "en" ? `${d}d ago` : `${d} 天前`;
  // Past a month the count stops carrying information. Name the day in the same form the rest of the
  // line uses — an ISO `2026-09-01` in the middle of a sentence reads as a bug.
  return monthDay(iso, beijingDate(now), locale);
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51"（中文）/ "Sep 24 10:51"（英文，Beijing），for lists that span days. */
export function monthDayTime(iso: string, locale: Locale = "zh"): string {
  return `${monthDay(iso, undefined, locale)} ${beijingTime(iso)}`;
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
