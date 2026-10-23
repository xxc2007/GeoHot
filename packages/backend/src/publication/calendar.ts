import { withPublicRead } from "./read-budget.ts";
// 日期入口的数据层：某一个月里，哪几天有本站可列的内容、哪几天真的出过日报。
//
// 为什么要有这一份：`/all` 的翻页上限是 50 页 × 40 = 2,000 条（`POOL_MAX_PAGES`），而站上「可列出的条目」
// 已经远不止一个月的量（2026-10-11 实测 7,867 条，其中 2026-10 一个月就占 6,356 条）——一路往下翻只能翻到
// 十月初，一月到九月的 1,426 条虽然搜索与条目 URL 都到得了，却没有一个"从日期进去"的入口。日历把"选一天"
// 变成入口之后，一天最多几百条，永远在那 2,000 条的上限之内。
//
// 只回**有东西的日子**（稀疏结果），空格由前端补；月份边界一律按北京的日历日算，
// 与读者在卡片上看到的日期同一口径（`timeline_at` 是"读者看到它的那一刻"归的时间）。
//
// `filters` 不是可省的装饰：卡片挂在 `/all` 的筛选结果上面，数日子若不套同一套筛选，
// 就会出现"卡片说那天 4 条、点进去按分类一筛是空的"（2026-10-11 上线当天线上实测
// `/all?category=histgeo&date=2026-01-15` 正是如此）。条目数跟着筛选走；期号不跟——
// 日报是整份报纸，不按分类拆。
import { addDays, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { categoryCondition, channelCondition, listedCondition, tagCondition, topicCondition } from "./items.ts";
import type { PoolQuery } from "./pool.ts";

/** 与 `/api/site/pool` 同一组可作用在条目上的筛选；不给就等于不筛。 */
export type DayMarkFilters = Partial<Pick<PoolQuery, "channel" | "category" | "tag" | "topicTags">>;

/** 一个月的第一天与最后一天（含），按北京日历。 */
export function monthSpan(month: string): { first: string; last: string } {
  const [year, number] = month.split("-").map(Number);
  // `Date.UTC(y, m, 0)` 是"第 m 月的第 0 天"= 上一月的最后一天，而 m 在这里已经是 1 基的当月，
  // 所以它给出的正是这个月的天数。闰年由 Date 自己算，不手写二月 28/29 的判断。
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(days).padStart(2, "0")}` };
}

export interface DayMark {
  date: string;
  /**
   * 那一天在当前筛选下可列出的条目数（与 `/all` 同一套成员条件与同一套筛选）。
   * 不含来源没给发布时间的行：`DayList` 把它们单独放进「无发布日期」，算进某一天就会多出一个点。
   */
  items: number;
  /** 那一天出的日报期号；没出报就没有。 */
  issue: number | null;
}

/**
 * 某月里有内容的日子。`issue` 取 `reports.daily` 的 `issue_no`，并且**只认拿到号的期次**：
 * 空刊不占号（第四十四轮的规则），而归档/翻页/RSS/v1/MCP 五个出口都不列空刊——
 * 卡片若把空刊画成"第 N 期"，就是给同一个事实第二个答案。
 * 所以"有点但没有期号"= 那天有内容却没出成报，日历要能把这两种分开画。
 */
const pendingMonths = new Map<string, Promise<DayMark[]>>();
export async function monthMarks(
  month: string, filters: DayMarkFilters = {}, now?: Date,
): Promise<DayMark[]> {
  const key = JSON.stringify([month, filters.channel ?? null, filters.category ?? null, filters.tag ?? null, [...(filters.topicTags ?? [])].sort(), now?.toISOString() ?? null]);
  const pending = pendingMonths.get(key);
  if (pending) return pending;
  const load = queryMonthMarks(month, filters, now);
  pendingMonths.set(key, load);
  try { return await load; } finally { pendingMonths.delete(key); }
}

async function queryMonthMarks(
  month: string,
  filters: DayMarkFilters = {},
  now: Date = new Date(),
): Promise<DayMark[]> {
  const { first, last } = monthSpan(month);
  const from = beijingMidnight(first);
  const to = beijingMidnight(addDays(last, 1));
  const scoped = sql`${channelCondition(filters.channel)} ${categoryCondition(filters.category)} ${tagCondition(filters.tag)} ${topicCondition(filters.topicTags)}`;
  const rows = await withPublicRead(async (db) => db<{ date: string; items: number; issue_no: number | null }[]>`
    WITH days AS (
      SELECT to_char(p.timeline_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date, count(*)::int AS items
        FROM publications p
       WHERE ${listedCondition(now)} AND p.eligible AND p.published_at IS NOT NULL ${scoped}
         AND p.timeline_at >= ${from} AND p.timeline_at < ${to}
       GROUP BY 1),
    issues AS (
      SELECT key AS date, issue_no FROM reports
       WHERE kind = 'daily' AND issue_no IS NOT NULL AND key >= ${first} AND key <= ${last})
    SELECT coalesce(d.date, i.date) AS date, coalesce(d.items, 0) AS items, i.issue_no
      FROM days d FULL JOIN issues i ON i.date = d.date
     ORDER BY 1`);
  return rows.map((r) => ({ date: r.date, items: Number(r.items), issue: r.issue_no === null ? null : Number(r.issue_no) }));
}
