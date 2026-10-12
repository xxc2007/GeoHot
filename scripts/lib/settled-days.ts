// 「这一天判完了没有」——唯一的口径。
//
// 为什么单独一个文件：这条判据在仓库里原本有三份抄本（`backfill-papers.ts` 的 `unsettled()`、
// `archive-progress.ts` 的 per_day、`jobs/content.ts` 的派发条件），三份各自表述过同一个意思，
// 而"哪一天算结算完"直接决定回填什么时候开始出刊、审计什么时候可以宣布跑完。工单 #144 记着这笔债；
// 那两份现在在别人手里改，所以这里先立一份**给新调用方用的**，审计脚本是第一个消费者，
// 等两边改完再把它们的活并入这一份，而不是继续各写各的。
//
// 与 `backfill-papers.ts` 同一条定义，两笔都要算：
//  · `new`：还没走判定；
//  · `analyzed` 但没有 `publications` 行：判完了而投影没跑成——这正是 `sweepUnprocessed` 几分钟后
//    会免费补上的那一段，只数前一种会让这一天在缺一条本该入刊的故事的情况下出刊，
//    而下一轮还会说"已出刊"（那一次真的发生过）。
// `blocked` / `failed` 不挡日：`blocked` 是模型判「不相关」的终态（`editorial/analyze.ts` 的
// `relevance === "block"`），`failed` 只有人工或 30 天重排才救得回来，交给 `--refresh`。
import { sql, type Db } from "@aihot/backend/db";
import { editionDay } from "@aihot/backend/lib/time";

/** 期次日（北京时间，一天覆盖 [D-1 08:00, D 08:00)）——只在 `lib/time.ts` 写一次，这里用同一份。 */
export const dayLabel = (column: Parameters<typeof editionDay>[0]) => editionDay(column);

/** 未结算的条目数；`from` 是区间下界（含），按新闻日期算。 */
export function unsettledSql(from: string, to: string) {
  const day = dayLabel(sql`a.timeline_at`);
  return sql`
    SELECT ${day} AS day, count(*) FILTER (
      WHERE a.processing_state = 'new'
         OR (a.processing_state = 'analyzed' AND NOT EXISTS (
              SELECT 1 FROM publications p WHERE p.article_id = a.id))
    ) AS unsettled, count(*) AS rows_total
    FROM articles a
    WHERE ${day} BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1`;
}

/**
 * 区间内**已判完**的日子（`unsettled = 0`），可选地只挑其中「没有存下任何日报期次」的那些。
 * 返回按日期升序。
 */
export async function settledDays(db: Db, from: string, to: string, onlyWithoutEdition = false) {
  const perDay = unsettledSql(from, to);
  const rows = onlyWithoutEdition
    ? await db<{ day: string; unsettled: number }[]>`
        WITH per_day AS (${perDay})
        SELECT d::text AS day, 0 AS unsettled FROM (
          SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS d
        ) g
        JOIN per_day p ON p.day = g.d
        WHERE p.unsettled = 0
          AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.kind = 'daily' AND r.key = g.d::text)`
    : await db<{ day: string; unsettled: number }[]>`
        WITH per_day AS (${perDay})
        SELECT day::text AS day, unsettled FROM per_day WHERE unsettled = 0 ORDER BY 1`;
  return rows.map((r) => r.day);
}
