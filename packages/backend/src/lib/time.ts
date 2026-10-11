// 跨脚本共用的 SQL 时间片段。JS 侧的同一规则在 `reports/compose.ts` 的 `dailyWindow`，
// 这里只放"要在 Postgres 里算"的那一份。
import { sql } from "../db.ts";

/** 片段类型直接取本文件构造出来的那一个：nesting 用的就是它，不去猜 postgres 的内部类型名。 */
const COLUMN = sql`a.timeline_at`;

/**
 * 一期日报所服务的北京日期：`[D-1 08:00, D 08:00)` ⇔ 时刻折成北京时间、减 8 小时、再 +1 天。
 *
 * 参数收的是"哪一列是时刻"而不是表别名——同一段公式在 `articles a` 与 `publications p` 两边都要用。
 * 这一条在本仓库抄过两份，两份注释各自解释了一遍 -8h，而其中一份漏了它：
 * 只按 `timeline_at >= from` 截日，会把窗口头一天判成"已结算"（实测真的得到一个假的 days_settled=1）。
 */
export function editionDay(timeline: typeof COLUMN) {
  return sql`((${timeline} AT TIME ZONE 'Asia/Shanghai') - interval '8 hours')::date + 1`;
}
