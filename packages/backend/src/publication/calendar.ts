// 日期入口的数据层：某一个月里，哪几天有本站可列的内容、哪几天真的出过日报。
//
// 为什么要有这一份：`/all` 的翻页上限是 50 页 × 40 = 2,000 条（`POOL_MAX_PAGES`），而站上「可列出的条目」
// 已经远不止一个月的量（2026-10-11 实测 7,867 条，其中 2026-10 一个月就占 6,356 条）——一路往下翻只能翻到
// 十月初，一月到九月的 1,426 条虽然搜索与条目 URL 都到得了，却没有一个"从日期进去"的入口。日历把"选一天"
// 变成入口之后，一天最多几百条，永远在那 2,000 条的上限之内。
//
// 只回**有东西的日子**（稀疏结果），空格由前端补；月份边界一律按北京的日历日算，
// 与读者在卡片上看到的日期同一口径（`timeline_at` 是"读者看到它的那一刻"归的时间）。
import { addDays, beijingMidnight, isDay, isMonth } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { listedCondition } from "./items.ts";

export { isDay, isMonth };

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
  /** 那一天本站可列出的条目数（与 `/all` 同一套成员条件）。 */
  items: number;
  /** 那一天出的日报期号；没出报就没有。 */
  issue: number | null;
}

/**
 * 某月里有内容的日子。`issue` 取 `reports.daily` 的 `issue_no`——空刊不占号（第四十四轮的规则），
 * 所以"有点但没有期号"就是那一天有内容却没出成报，日历要能把它和"有报"分开画。
 */
export async function monthMarks(month: string, now: Date = new Date()): Promise<DayMark[]> {
  const { first, last } = monthSpan(month);
  const from = beijingMidnight(first);
  const to = beijingMidnight(addDays(last, 1));
  const rows = await sql<{ date: string; items: number; issue_no: number | null }[]>`
    WITH days AS (
      SELECT to_char(p.timeline_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date, count(*)::int AS items
        FROM publications p
       WHERE ${listedCondition(now)} AND p.eligible AND p.timeline_at >= ${from} AND p.timeline_at < ${to}
       GROUP BY 1),
    issues AS (
      SELECT key AS date, issue_no FROM reports WHERE kind = 'daily' AND key >= ${first} AND key <= ${last})
    SELECT coalesce(d.date, i.date) AS date, coalesce(d.items, 0) AS items, i.issue_no
      FROM days d FULL JOIN issues i ON i.date = d.date
     ORDER BY 1`;
  return rows.map((r) => ({ date: r.date, items: Number(r.items), issue: r.issue_no === null ? null : Number(r.issue_no) }));
}
