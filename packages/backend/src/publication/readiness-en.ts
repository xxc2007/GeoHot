// `/en` 的第二条成员门：不要求中文译文，只要求这条英文内容本身可读。
//
// 中文名单的口径（`items.ts` 的 chineseCopyCondition + readiness.ts 的 workflowReadyCondition）一个字都不动；
// 这里服务的是 `ENGLISH_MEMBERSHIP=english`：英文源条目可以在没有中文稿的情况下进入 /en，
// 但必须过分析、正文质量、媒体与英文文案这四关。`ENGLISH_MEMBERSHIP=parity` 仍用中文名单 +
// englishCopyCondition（英文文案只是本站的投影，不改变成员集）。
import { sql } from "../db.ts";
import { bodyMediaReadyCondition } from "./media-readiness.ts";
import { englishCopyCondition, releaseGateCondition, selectedReleaseGateCondition } from "./items.ts";

/**
 * 英文正文就绪（不含公开与放行门，供「下一批过闸时间」这类未来集合复用）：
 * 分析 pass、正文质量 ok、媒体就绪、英文标题/摘要当前，并且正文满足其一：
 *  · `body_mode='summary'`（来源只借摘要，摘要页就是完整页面）；
 *  · X 短帖（去掉链接后不足 60 字，帖子本身即正文）；
 *  · 源文声明为英文且 `body_status='ok'`；
 *  · 当前 revision 的英文译文完整且非空。
 * 刻意不要求中文译文，也不复用 `workflowReadyCondition`（那条要求中文正文/译文）。
 */
export function englishReadyBaseCondition() {
  return sql`${englishCopyCondition()} AND EXISTS (
    SELECT 1 FROM articles ready_a JOIN sources ready_s ON ready_s.id = ready_a.source_id
    JOIN analyses ready_an ON ready_an.article_id = ready_a.id
      AND ready_an.input_revision = ready_a.revision
    WHERE ready_a.id = p.article_id AND ready_an.id = p.analysis_id AND ready_an.relevance = 'pass'
      AND EXISTS (SELECT 1 FROM article_workflow_readiness ready_workflow
        WHERE ready_workflow.article_id = p.article_id AND ready_workflow.revision = p.revision
          AND ready_workflow.analysis_id = p.analysis_id AND ready_workflow.body_quality_status = 'ok')
      AND ${bodyMediaReadyCondition()}
      AND (
        p.body_mode = 'summary'
        OR (p.channel = 'x' AND length(btrim(regexp_replace(coalesce(ready_a.x_post->>'text', ready_a.body_text), 'https?://[^[:space:]]+', '', 'g'))) < 60)
        OR (ready_a.language = 'en' AND ready_a.body_status = 'ok')
        OR EXISTS (SELECT 1 FROM translations ready_tr_en
          WHERE ready_tr_en.article_id = ready_a.id AND ready_tr_en.lang = 'en'
            AND ready_tr_en.revision = ready_a.revision AND ready_tr_en.complete
            AND nullif(btrim(ready_tr_en.body_html), '') IS NOT NULL
            AND nullif(btrim(ready_tr_en.body_text), '') IS NOT NULL)
      )
  )`;
}

/** 公开 + 已放行 + 英文正文就绪：strict + english 下真正服务 /en 的成员条件。 */
export function englishReadyCondition(now: Date = new Date(), selected = false) {
  return sql`p.visibility = 'public' AND ${selected ? selectedReleaseGateCondition(now) : releaseGateCondition(now)} AND ${englishReadyBaseCondition()}`;
}