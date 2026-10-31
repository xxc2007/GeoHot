// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
import type { CategoryKey } from '@aihot/contracts/taxonomy';
import { sql } from '../db.ts';
import { itemHasPage } from './rules.ts';
import { workflowReadyCondition } from './readiness.ts';
import { CJK_COPY_PATTERN } from '@aihot/contracts/copy';

export async function loadItemShare(id: string, now = new Date()) {
  const [row] = await sql<{
    id: string; title: string; summary: string | null; category: CategoryKey | null; selected: boolean;
    score: number | null; timeline_at: Date; source_name: string; source_mode: string; visibility: string;
    visible_after: Date | null; workflow_ready: boolean; source_fulltext: boolean; has_copy: boolean;
  }[]>`SELECT p.article_id AS id, p.title, p.summary, p.category, p.selected, p.score, p.timeline_at,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility, p.visible_after,
      ${workflowReadyCondition()} AS workflow_ready, s.site_fulltext AS source_fulltext,
      (p.title ~ ${CJK_COPY_PATTERN} AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_copy
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id = ${id} AND p.visibility = 'public' AND s.participation_mode = 'editorial'
      AND (NOT p.selected OR p.visible_after <= ${now})`;
  // The same rule as the page, widened one notch with it: a card for an item no reader can open yet
  // (withdrawn, hot_signal, or a release still behind the gate) is a preview of hidden content, and
  // crawlers pick the image up. A restricted page (summary-licence, workflow pending) has a card — the
  // daily already quotes its title and summary, and the card shows exactly those, nothing more. A row
  // with nothing to show (unsummarised, no Chinese copy) has neither page nor card.
  if (!row || !itemHasPage({ visibility: row.visibility, sourceMode: row.source_mode, selected: row.selected, visibleAfter: row.visible_after }, now)) return null;
  // The same grades the detail page answers with: a summary-licence row with copy keeps its card —
  // exactly the citation facts the daily printed; a full-licence row still being verified, or a row
  // with nothing to show, has neither page nor card.
  if (!row.source_fulltext && !row.workflow_ready && !row.has_copy) return null;
  if (row.source_fulltext && !row.workflow_ready) return null;
  return { id: row.id, title: row.title, summary: row.summary, category: row.category, selected: row.selected,
    score: row.score === null ? null : Math.round(Number(row.score)), timelineAt: row.timeline_at.toISOString(),
    source: { name: row.source_name } };
}
