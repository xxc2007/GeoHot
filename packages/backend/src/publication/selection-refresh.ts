import { sql } from "../db.ts";

/**
 * 精选标记的例行重算。
 *
 * `selected` 原本只在发布那一刻决定（`publish.ts` 写入），而发布发生在分析之前：
 *  - 发布时还是「只准摘要」的条目会被选中，但它们永远过不了读者门禁（要求 `body_mode='full'`），
 *    于是精选里占着位置却不交付；
 *  - 发布后才分析通过、真正可读的全文条目，却永远不会被重新选中 —— 读者看到「精选没有今天的消息」。
 *
 * 2026-11-07 就是这样：当天 14 条 `selected=true` 全是 summary 且未就绪，18 条 full+pass 全是 false。
 * 这段代码把「选中」从一次性动作改成例行巡检：只动「从未被人工/自动裁定过」的条目
 * （`selected_ready_at is null`），因此不会覆盖后台人工调整过的精选。
 */
export interface SelectionRefreshReport {
  promoted: number;
  demoted: number;
}

export async function refreshSelection(windowHours = 36): Promise<SelectionRefreshReport> {
  // 补选：公开 + 全文 + 就绪 + 近期，且从未被裁定过。
  const promoted = await sql<{ article_id: string }[]>`
    update publications p
       set selected = true, selected_ready_at = now(), updated_at = now()
     where p.selected = false
       and p.selected_ready_at is null
       and p.visibility = 'public'
       and p.body_mode = 'full'
       and p.timeline_at >= now() - (${windowHours} || ' hours')::interval
       and exists (
         select 1 from article_workflow_readiness r
          where r.article_id = p.article_id and r.ready = true
       )
    returning p.article_id`;

  // 撤选：被自动选中、但读者根本读不到（非全文 / 未就绪）的近期条目。
  const demoted = await sql<{ article_id: string }[]>`
    update publications p
       set selected = false, updated_at = now()
     where p.selected = true
       and p.selected_ready_at is null
       and p.visibility = 'public'
       and p.body_mode <> 'full'
       and p.timeline_at >= now() - (${windowHours} || ' hours')::interval
    returning p.article_id`;

  return { promoted: promoted.length, demoted: demoted.length };
}
