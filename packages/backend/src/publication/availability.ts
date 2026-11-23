import { workflowReadyCondition } from "./readiness.ts";
// Starred items live in the browser; this tells the page which ones are still public. A starred item
// stays available as long as its page does (rules.itemHasPage), whether or not it is in the lists.
import { sql } from "../db.ts";
import { ARTICLE_ID_PATTERN } from "@aihot/contracts/taxonomy";
import type { SiteLang } from "@aihot/contracts/site";
import { itemHasPage } from "./rules.ts";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { englishCopyCondition } from "./items.ts";
import { englishReadyCondition } from "./readiness-en.ts";
import { englishPolicy, englishTextMode } from "./english-policy.ts";

/** The page asks about every star it holds, so the list is chunked rather than cut off: a reader's
 *  stars past the 500th used to be dropped from the query, and an id missing from the answer is
 *  "unknown" to the page — so a withdrawn or unpublished article kept rendering as a normal clickable
 *  entry, and the reader found out by clicking it. (A review claimed the opposite, that the leftovers
 *  were reported `unavailable`; it forgot that the old code only initialised the ids it kept.) The
 *  overall bound is a request-size guard, and like the old cut it answers "nothing", never a lie.
 *  The gate is the detail page's own two grades: a summary-licence row (or a workflow still running)
 *  opens its restricted page, so it answers `summary-only` here — the same note the page carries —
 *  instead of `unavailable`. */
const CHUNK = 500;
const MAX_IDS = 2_000;

export async function itemAvailability(ids: string[], now = new Date(), lang: SiteLang = "zh"): Promise<Record<string, "public" | "summary-only" | "unavailable">> {
  const clean = [...new Set(ids.filter((id) => ARTICLE_ID_PATTERN.test(id)))].slice(0, MAX_IDS);
  const out: Record<string, "public" | "summary-only" | "unavailable"> = {};
  const enStrict = lang === "en" && englishTextMode() === "strict";
  const needEnglishReady = enStrict && englishPolicy().membership === "english";
  for (let i = 0; i < clean.length; i += CHUNK) {
    const batch = clean.slice(i, i + CHUNK);
    for (const id of batch) out[id] = "unavailable";
    const rows = await sql<{ id: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null; workflow_ready: boolean; body_mode: string; source_fulltext: boolean; has_copy: boolean; has_any_copy: boolean; body_quality_status: string | null; english_copy_ready: boolean; english_ready: boolean }[]>`
      SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode, p.selected, p.visible_after,
        ${workflowReadyCondition()} AS workflow_ready, p.body_mode, s.site_fulltext AS source_fulltext,
        (p.title ~ ${CJK_COPY_PATTERN} AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_copy,
        (nullif(btrim(p.title), '') IS NOT NULL AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_any_copy,
        r.body_quality_status,
        (CASE WHEN ${englishCopyCondition()} THEN true ELSE false END) AS english_copy_ready,
        (CASE WHEN ${needEnglishReady ? englishReadyCondition(now) : sql`false`} THEN true ELSE false END) AS english_ready
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN article_workflow_readiness r ON r.article_id = p.article_id
      WHERE p.article_id IN ${sql(batch)}
        AND p.visibility = 'public' AND s.participation_mode = 'editorial'
        AND (NOT p.selected OR p.visible_after <= ${now})`;
    for (const r of rows) {
      if (!itemHasPage({ visibility: r.visibility, sourceMode: r.source_mode, selected: r.selected, visibleAfter: r.visible_after }, now)) continue;
      // /en strict 的详情页对缺英文的条目也给 200 回退页（标题/摘要 + 原文入口）；availability 同口径：
      // 英文本条不达标时按 summary-only 记，而不是 unavailable（机器出口与页面的同一件事）。
      if (enStrict && !(englishPolicy().membership === "english" ? r.english_ready : r.english_copy_ready)) {
        out[r.id] = r.has_any_copy ? "summary-only" : "unavailable";
        continue;
      }
      // 英文成员模式下，页面是否「完整可读」由英文门自己回答，不再借中文 workflow 判定。
      const ready = enStrict && englishPolicy().membership === "english" ? r.english_ready : r.workflow_ready;
      // Three grades:
      //  · workflow ready → public;
      //  · source lends no full text, OR the stored body failed the quality rule (pipeline settled, body
      //    dirty) → summary-only: the page opens as a safe lead, no body;
      //  · anything else (pipeline still settling on a full-text source) → unavailable (404).
      if (ready) { out[r.id] = r.body_mode === "full" && r.source_fulltext ? "public" : "summary-only"; continue; }
      const bodyDirty = r.body_quality_status === "defect";
      out[r.id] = (!r.source_fulltext || bodyDirty || enStrict) && r.has_any_copy ? "summary-only" : "unavailable";
    }
  }
  return out;
}
