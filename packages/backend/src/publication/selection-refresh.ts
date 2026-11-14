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
  //
  // `visible_after` 必须一起写（2026-11-14 现场）：读者门禁是 `NOT p.selected OR p.visible_after <= now()`，
  // 只看 `selected` 与 `visible_after` 两个列。补选只置 `selected = true` 而 `visible_after` 仍是 NULL 时，
  // 整个条件求值为 NULL —— 条目永远不放行，而且 `selected_ready_at` 已被写死，`publish.ts` 里那段
  // 「首次满足精选条件才算释放时间」的逻辑以后再也不会补上它。生产上 248 条这样卡住（今天 39 条就绪里 27 条）。
  // 补选的都是「已经公开、已经全文、已经就绪」的条目，本来就是读者能看的，所以直接给当前时刻。
  const promoted = await sql<{ article_id: string }[]>`
    update publications p
       set selected = true, selected_ready_at = now(),
           visible_after = coalesce(p.visible_after, now()), updated_at = now()
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
