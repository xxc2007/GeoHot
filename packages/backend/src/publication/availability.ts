import { workflowReadyCondition } from "./readiness.ts";
// Starred items live in the browser; this tells the page which ones are still public. A starred item
// stays available as long as its page does (rules.itemHasPage), whether or not it is in the lists.
import { sql } from "../db.ts";
import { ARTICLE_ID_PATTERN } from "@aihot/contracts/taxonomy";
import { itemHasPage } from "./rules.ts";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";

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

export async function itemAvailability(ids: string[], now = new Date()): Promise<Record<string, "public" | "summary-only" | "unavailable">> {
  const clean = [...new Set(ids.filter((id) => ARTICLE_ID_PATTERN.test(id)))].slice(0, MAX_IDS);
  const out: Record<string, "public" | "summary-only" | "unavailable"> = {};
  for (let i = 0; i < clean.length; i += CHUNK) {
    const batch = clean.slice(i, i + CHUNK);
    for (const id of batch) out[id] = "unavailable";
    const rows = await sql<{ id: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null; workflow_ready: boolean; source_fulltext: boolean; has_copy: boolean }[]>`
      SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode, p.selected, p.visible_after,
        ${workflowReadyCondition()} AS workflow_ready, s.site_fulltext AS source_fulltext,
        (p.title ~ ${CJK_COPY_PATTERN} AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_copy
      FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE p.article_id IN ${sql(batch)}
        AND p.visibility = 'public' AND s.participation_mode = 'editorial'
        AND (NOT p.selected OR p.visible_after <= ${now})`;
    for (const r of rows) {
      if (!itemHasPage({ visibility: r.visibility, sourceMode: r.source_mode, selected: r.selected, visibleAfter: r.visible_after }, now)) continue;
      // The detail page's own grades (detail.ts): a summary-licence row with copy opens its restricted
      // page (summary-only here); a full-licence row whose workflow is still running, or a row with
      // nothing to show (unsummarised), stays unavailable — the page is a 404.
      out[r.id] = !r.source_fulltext && !r.workflow_ready ? (r.has_copy ? "summary-only" : "unavailable") : r.workflow_ready ? "public" : "unavailable";
    }
  }
  return out;
}
