// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
import type { CategoryKey } from '@aihot/contracts/taxonomy';
import { sql } from '../db.ts';
import { itemHasPage } from './rules.ts';

export async function loadItemShare(id: string, now = new Date()) {
  const [row] = await sql<{
    id: string; title: string; summary: string | null; category: CategoryKey | null; selected: boolean;
    score: number | null; timeline_at: Date; source_name: string; source_mode: string; visibility: string;
    visible_after: Date | null;
  }[]>`SELECT p.article_id AS id, p.title, p.summary, p.category, p.selected, p.score, p.timeline_at,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility, p.visible_after
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${id}`;
  // The same rule as the page: a card for an item no reader can open yet (withdrawn, hot_signal, or a
  // release still behind the gate) is a preview of hidden content, and crawlers pick the image up.
  if (!row || !itemHasPage({ visibility: row.visibility, sourceMode: row.source_mode, selected: row.selected, visibleAfter: row.visible_after }, now)) return null;
  return { id: row.id, title: row.title, summary: row.summary, category: row.category, selected: row.selected,
    score: row.score === null ? null : Math.round(Number(row.score)), timelineAt: row.timeline_at.toISOString(),
    source: { name: row.source_name } };
}
