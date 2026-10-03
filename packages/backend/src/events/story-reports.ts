// The reports of a story, exactly as a reader can open them: public, eligible, and past any embargo.
// The hot list's 报道数 and the story digest's inputs both read this one query, so an event page cannot
// show "4 篇报道" beside a 综述 written from five (the digest prompt allows only facts the reader on that
// page can reach: industry/prompts/story-digest.md, 出处边界).
import { sql } from "../db.ts";

export interface StoryReport {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  sourceName: string;
  firstParty: boolean;
  selected: boolean;
  score: number | null;
  at: Date;
}

/** This story's reader-visible reports, oldest first (the order a digest and a timeline are written in). */
export async function storyReports(storyId: number, at = new Date()): Promise<StoryReport[]> {
  const rows = await sql<{ id: string; url: string; title: string; summary: string | null; source_name: string; first_party: boolean; selected: boolean; score: number | null; at: Date }[]>`
    SELECT DISTINCT ON (p.article_id) p.article_id AS id, p.url, p.title, p.summary, s.name AS source_name, p.first_party, p.selected, p.score,
           coalesce(p.published_at, p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ${storyId} AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${at})
    ORDER BY p.article_id`;
  return rows
    .map((r) => ({ id: r.id, url: r.url, title: r.title, summary: r.summary, sourceName: r.source_name, firstParty: r.first_party, selected: r.selected, score: r.score, at: r.at }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}
