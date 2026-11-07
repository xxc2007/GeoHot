import { sql } from "../db.ts";
import { refreshWorkflowReadinessTx } from "./readiness.ts";

/**
 * 就绪行的自愈。
 *
 * 事实表 `article_workflow_readiness` 只在发布事务里写（`publish.ts` 调
 * `refreshWorkflowReadinessTx`），任何后续写操作都会把那一行删掉；如果删掉之后再没有人
 * 重新计算，这篇公开文章就会永远缺行，而读者面的门禁是 `EXISTS(...)` 真值判断 ——
 * 缺行等于永久不可见，且页面上看不出来任何异常。
 *
 * 2026-11-07 就是这样丢了 404 篇：全站一条错误日志都没有，只是「今天没更新」。
 * 那次是手工补的；这段代码把它变成例行巡检，每 10 分钟挑最新的一批（默认 40 篇）重算，
 * 重算本身幂等、只写事实表，不碰发布状态、不发模型调用。
 */
export interface ReadinessReconcileReport {
  scanned: number;
  refreshed: number;
  failed: number;
  missingAfter: number;
}

export async function reconcileReadiness(limit = 40): Promise<ReadinessReconcileReport> {
  const rows = await sql<{ article_id: string }[]>`
    select p.article_id
      from publications p
     where p.visibility = 'public'
       and not exists (
         select 1 from article_workflow_readiness r where r.article_id = p.article_id
       )
     order by p.discovered_at desc
     limit ${limit}`;

  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await sql.begin((tx) => refreshWorkflowReadinessTx(tx, row.article_id))) refreshed += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        level: "warn",
        component: "readiness",
        event: "reconcile-failed",
        articleId: row.article_id,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count
      from publications p
     where p.visibility = 'public'
       and not exists (
         select 1 from article_workflow_readiness r where r.article_id = p.article_id
       )`;

  const report = { scanned: rows.length, refreshed, failed, missingAfter: count };
  // 只在确实动了东西、或还有缺口时说话，平静的巡检不写日志。
  if (refreshed > 0 || failed > 0 || count > 0) {
    console.log(JSON.stringify({ component: "readiness", event: "reconcile", ...report }));
  }
  return report;
}
