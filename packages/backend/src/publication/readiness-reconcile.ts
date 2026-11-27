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
  // 2026-11-07 第二课：光补「缺行」不够。发布事务先于分析完成，那一行会写成 ready=false，
  // 之后分析通过却没人重算 —— 当天 18 篇「全文 + 相关性通过」的文章就这样卡在门禁外，
  // 读者面的「今天」与精选都看不到。所以除了缺行，也重算「未就绪且十分钟没动过」的行。
  //
  // 2026-11-28 现场：这次挑选本身能跑 157 秒（`not exists` 对 publications 全表 + 按 discovered_at 排序，
  // 盘一慢就停不下来），随后还要逐篇跑 `refreshWorkflowReadinessTx`。它每 10 分钟一次，
  // 在 2 vCPU / 250 IOPS 的读者机上就是读者的直接对手。现在两道闸：
  //   ① 挑选一条语句 3 秒预算，超时这轮跳过；
  //   ② 重算循环再给 4 秒墙钟，到点就收工，下一轮接着来（幂等）。
  let rows: { article_id: string }[];
  try {
    rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', '3s', true)`;
      return tx<{ article_id: string }[]>`
    (select p.article_id
       from publications p
      where p.visibility = 'public'
        and not exists (
          select 1 from article_workflow_readiness r where r.article_id = p.article_id
        )
      order by p.discovered_at desc
      limit ${limit})
    union
    (select r.article_id
       from article_workflow_readiness r
       join publications p on p.article_id = r.article_id
      where p.visibility = 'public'
        and r.ready = false
        and r.checked_at < now() - interval '10 minutes'
      order by r.checked_at asc
      limit ${limit})`;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "57014") {
      console.warn(JSON.stringify({ level: "warn", component: "readiness", event: "reconcile-skip", reason: "selection budget exhausted" }));
      return { scanned: 0, refreshed: 0, failed: 0, missingAfter: -1 };
    }
    throw error;
  }

  let refreshed = 0;
  let failed = 0;
  // 重算循环的墙钟预算：每篇 `refreshWorkflowReadinessTx` 都要跑一遍重 EXISTS，80 篇能跑到分钟级。
  // 到点收工，剩下的下一轮再来（幂等，漏不掉）。
  const deadline = Date.now() + 4_000;
  for (const row of rows) {
    if (Date.now() > deadline) break;
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

  // 这条计数同样是全表 `not exists`：给它 2 秒预算，超时就把 -1（未知）写进报告，别拖死这一轮。
  let missingAfter = -1;
  try {
    const [counted] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', '2s', true)`;
      return tx<{ count: number }[]>`
        select count(*)::int as count
          from publications p
         where p.visibility = 'public'
           and not exists (
             select 1 from article_workflow_readiness r where r.article_id = p.article_id
           )`;
    });
    missingAfter = counted?.count ?? -1;
  } catch (error) {
    if ((error as { code?: string }).code !== "57014") throw error;
    console.warn(JSON.stringify({ level: "warn", component: "readiness", event: "reconcile-count-skip", reason: "budget exhausted" }));
  }

  const report = { scanned: rows.length, refreshed, failed, missingAfter };
  // 只在确实动了东西、或还有缺口时说话，平静的巡检不写日志。
  if (refreshed > 0 || failed > 0 || missingAfter > 0) {
    console.log(JSON.stringify({ component: "readiness", event: "reconcile", ...report }));
  }
  return report;
}
