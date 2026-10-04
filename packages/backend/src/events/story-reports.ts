// The one definition of "the reports of this story a reader can open on its event page". Three places read
// it and none of them may have its own idea of the set:
//  · `publication/stories.ts` — the event page itself (报道时间线, 来源数, 进展) and, through it, the MCP
//    event card and the /og/stories share card;
//  · `events/digest.ts` — the only evidence a 综述 may rest on, and the identity context the event title is
//    guarded against (industry/prompts/story-digest.md, 出处边界: only facts the reader on that page can reach);
//  · `events/hot.ts` — the 报道数 written into the ranking.
// Before this was one query the two halves disagreed on 273 of the 1626 stories with reports (measured on
// the development database, 2026-10-04: the page always listed one more than the digest could cite). A title
// naming a company that appears only in the page's extra report was then refused as "an institution no report
// of this story mentions", and the event kept a stale heading for good.
//
// The gate is `rules.itemHasPage` for a list: public, from a source that takes part editorially *now*, and
// past the release gate (one expression, `releasedCondition` in publication/items.ts — this file used to
// retype it by hand, which is how a fourth reading of the same rule could appear). It deliberately does not
// ask `p.eligible`: that is a snapshot of the pool rule taken when the row was published, so it also leaves
// out reports the AI pool never rated — imported hot stories carry them, and the live pages showed them.
// **It does not ask for Chinese, and that is a decision, not an omission** (2026-10-04 晚: a gate was tried
// and reverted the same evening). Measured then: 1374 public editorial reports and 474 event pages were
// English-only. The site's copy rule keeps those out of every *list* — the feeds, the hot strip, the sitemap —
// but it has never decided that their pages stop opening: `rules.itemHasPage` says a public released row has a
// page, and `tests/publication.test.ts` pins that ("a story whose only page is unsummarised still has a page").
// Gating here turned four such tests red, so the leak stays visible and is recorded in `docs/known-issues.md`
// as an owner decision (404 the page, or keep it reachable-but-unlisted) instead of a silent change. Reports that mention this event from an article
// about something else are included (an article's other events), and `hot_signal` material is heat evidence
// only — its source does not take part editorially, so it is neither listed here nor shown on the page.
import { sql } from "../db.ts";
import { releasedCondition } from "../publication/items.ts";

export interface StoryReport {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  iconUrl: string | null;
  firstParty: boolean;
  selected: boolean;
  score: number | null;
  /** The fact this report is read as evidence for; an article linked to two facts of one story counts once,
   * under its `primary` link (`DISTINCT ON` prefers that role, exactly as the page's development list does). */
  factId: number;
  factPublicId: string;
  at: Date;
}

/** The columns the query returns, before the rename below (the read layer hands rows out as SQL names them). */
interface ReportRow {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  first_party: boolean;
  selected: boolean;
  score: number | null;
  source_id: string;
  source_name: string;
  source_kind: string;
  icon_url: string | null;
  fact_id: number;
  fact_public_id: string;
  at: Date;
}

/** This story's reader-openable reports, oldest first (the order a digest and a timeline are written in). */
export async function storyReports(storyId: number, at = new Date()): Promise<StoryReport[]> {
  const rows = await sql<ReportRow[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.url, p.title, p.summary, p.first_party, p.selected, p.score,
           s.id AS source_id, s.name AS source_name, s.kind AS source_kind, s.icon_url,
           f.id AS fact_id, f.public_id AS fact_public_id,
           coalesce(p.published_at, p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND p.visibility = 'public' AND s.participation_mode = 'editorial'
      AND ${releasedCondition(at)}
    ORDER BY p.article_id, (fa.role = 'primary') DESC`;
  return rows
    .map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      summary: r.summary,
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceKind: r.source_kind,
      iconUrl: r.icon_url,
      firstParty: r.first_party,
      selected: r.selected,
      score: r.score,
      factId: Number(r.fact_id),
      factPublicId: r.fact_public_id,
      at: r.at,
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}
