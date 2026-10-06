// Starred items live in the browser; this tells the page which ones are still public. A starred item
// stays available as long as its page does (rules.itemHasPage), whether or not it is in the lists.
import { sql } from "../db.ts";
import { ARTICLE_ID_PATTERN } from "@aihot/contracts/taxonomy";
import { itemHasPage } from "./rules.ts";

/** The page asks about every star it holds, so the list is chunked rather than cut off: a reader's
 *  stars past the 500th used to be dropped from the query, and an id missing from the answer is
 *  "unknown" to the page — so a withdrawn or unpublished article kept rendering as a normal clickable
 *  entry, and the reader found out by clicking it. (A review claimed the opposite, that the leftovers
 *  were reported `unavailable`; it forgot that the old code only initialised the ids it kept.) The
 *  overall bound is a request-size guard, and like the old cut it answers "nothing", never a lie. */
const CHUNK = 500;
const MAX_IDS = 2_000;

export async function itemAvailability(ids: string[], now = new Date()): Promise<Record<string, "public" | "summary-only" | "unavailable">> {
  const clean = [...new Set(ids.filter((id) => ARTICLE_ID_PATTERN.test(id)))].slice(0, MAX_IDS);
  const out: Record<string, "public" | "summary-only" | "unavailable"> = {};
  for (let i = 0; i < clean.length; i += CHUNK) {
    const batch = clean.slice(i, i + CHUNK);
    for (const id of batch) out[id] = "unavailable";
    const rows = await sql<{ id: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null }[]>`
      SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode, p.selected, p.visible_after
      FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id IN ${sql(batch)}`;
    for (const r of rows) {
      if (!itemHasPage({ visibility: r.visibility, sourceMode: r.source_mode, selected: r.selected, visibleAfter: r.visible_after }, now)) continue;
      out[r.id] = r.visibility === "summary-only" ? "summary-only" : "public";
    }
  }
  return out;
}
