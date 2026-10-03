import type { FeedItemSummary } from "@aihot/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { ITEM_COLUMNS, ITEM_FROM, chineseCopyCondition, selectedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";

export interface TopicRow {
  slug: string;
  name: string;
  grp: "company" | "field" | "genre";
  entity_id: string | null;
  tags: string[];
  definition: string;
  related: string[];
  position: number;
}

type TopicCount = { slug: string; total: number; recent: number; pages: number; indexable: boolean; latest: Date | null };
const topicsCache = cached(
  () => sql<TopicRow[]>`SELECT slug, name, grp, entity_id, tags, definition, related, position FROM topics ORDER BY position`,
  { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
);

/** How far back a topic's "recent" figure looks, and the floor on how long a count stays held. */
const RECENT_WINDOW_MS = 30 * 86400_000;
const COUNTS_FRESH_MS = 60_000;
const COUNTS_MIN_HOLD_MS = 5_000;

/**
 * Topic counts, held per process and read alongside the release gate. They may lag by about a minute,
 * like the public directory cache, but never past the next release still waiting behind the gate: a topic
 * page that advertised 「N 条」 including content no reader can open yet is a count of the wrong set.
 * The held value also records the instant it was read, so a caller with a fixed clock (a test, a replay)
 * can ask for the counts and the items at that same instant instead of two different ones.
 */
interface CountsSnapshot { readAt: number; until: number; counts: TopicCount[] }
let countsSnapshot: CountsSnapshot | null = null;
let countsPending: Promise<CountsSnapshot> | null = null;

function clearTopicCounts() {
  countsSnapshot = null;
  countsPending = null;
}

async function loadCounts(now: Date): Promise<CountsSnapshot> {
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  const [rows, [gate]] = await Promise.all([
    queryTopicCounts(now, windowStart),
    sql<{ t: Date | null }[]>`
      SELECT min(p.visible_after) AS t FROM publications p
      WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now} AND ${chineseCopyCondition()}`,
  ]);
  const readAt = Date.now();
  const releasing = gate?.t ? gate.t.getTime() : Infinity;
  return { readAt, until: Math.max(readAt + COUNTS_MIN_HOLD_MS, Math.min(readAt + COUNTS_FRESH_MS, releasing)), counts: rows };
}

async function countsHeld(now: Date | undefined): Promise<CountsSnapshot> {
  // An explicit clock bypasses the held copy: the caller wants these numbers at the same instant as its items.
  if (now) return loadCounts(now);
  if (countsSnapshot && Date.now() < countsSnapshot.until) return countsSnapshot;
  if (countsPending) return countsPending;
  const load = loadCounts(new Date());
  countsPending = load;
  try {
    const snap = await load;
    countsSnapshot = snap;
    return snap;
  } finally { countsPending = null; }
}

/**
 * The topics (stable slugs, names, definitions, related topics) come from the industry pack
 * (industry/topics.json); every environment seeds them from there. Re-runnable.
 */
export async function seedTopics(): Promise<number> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    topics: Array<{ slug: string; name: string; group: string; entityId?: string | null; tags: string[]; definition: string; related?: string[] }>;
  };
  let position = 0;
  for (const t of data.topics) {
    await sql`
      INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position)
      VALUES (${t.slug}, ${t.name}, ${t.group}, ${t.entityId ?? null}, ${t.tags}, ${t.definition}, ${t.related ?? []}, ${position++})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, grp = EXCLUDED.grp, entity_id = EXCLUDED.entity_id,
        tags = EXCLUDED.tags, definition = EXCLUDED.definition, related = EXCLUDED.related, position = EXCLUDED.position`;
  }
  topicsCache.clear();
  clearTopicCounts();
  return data.topics.length;
}

export function listTopics(): Promise<TopicRow[]> {
  return topicsCache.get();
}

export async function loadTopic(slug: string): Promise<TopicRow | null> {
  return (await listTopics()).find((t) => t.slug === slug) ?? null;
}

/**
 * Tags that put an article in a topic. A company topic takes only articles actually about the company
 * (its entity subject tag), never mere mentions; field and genre topics match their tags.
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`] : t.tags;
}

export async function loadTopicTags(slug: string): Promise<string[] | null> {
  const t = await loadTopic(slug);
  return t ? topicMatchTags(t) : null;
}

export const TOPIC_PAGE_SIZE = 20;

/**
 * Topic pages exist for every topic; only topics with enough content are listed and indexed.
 * `now` is the instant to count at: pass it when the counts must match items read at the same instant.
 */
export async function topicPageCounts(now?: Date): Promise<TopicCount[]> {
  return (await countsHeld(now)).counts;
}

/**
 * One pass over the selected set, counted inside PostgreSQL: a topic answers to the keys of
 * `topicMatchTags` (its entity subject tag for a company, its own tags otherwise), so the tags are unnested
 * and matched here rather than shipped to Node as one array per item and looped over topic by topic —
 * quadratic once the selected set grows, and every 60 s. The read uses `selectedCondition`, so the counts
 * cover exactly the items a topic page can list: released, public, and with Chinese copy.
 */
async function queryTopicCounts(now: Date, windowStart: Date): Promise<TopicCount[]> {
  const rows = await sql<{ slug: string; total: number; recent: number; latest: Date | null }[]>`
    WITH listed AS (
      SELECT p.article_id, p.timeline_at, u.tag
      FROM publications p, unnest(p.tags) AS u(tag)
      WHERE ${selectedCondition(now)}
    ),
    keys AS (
      SELECT DISTINCT t.slug, CASE WHEN t.entity_id IS NOT NULL THEN 'entity:' || t.entity_id ELSE u.key END AS key
      FROM topics t LEFT JOIN LATERAL unnest(t.tags) AS u(key) ON true
    ),
    counted AS (
      SELECT k.slug,
        count(DISTINCT l.article_id) AS total,
        count(DISTINCT l.article_id) FILTER (WHERE l.timeline_at > ${windowStart}) AS recent,
        max(l.timeline_at) AS latest
      FROM keys k JOIN listed l ON l.tag = k.key
      GROUP BY k.slug
    )
    SELECT t.slug, coalesce(c.total, 0)::int AS total, coalesce(c.recent, 0)::int AS recent, c.latest
    FROM topics t LEFT JOIN counted c ON c.slug = t.slug
    ORDER BY t.position`;
  return rows.map((r) => ({
    slug: r.slug, total: r.total, recent: r.recent, latest: r.latest,
    pages: Math.max(1, Math.ceil(r.total / TOPIC_PAGE_SIZE)),
    indexable: r.total >= 50 || (r.total >= 20 && r.recent > 0),
  }));
}

export interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function listTopicSummaries(now?: Date): Promise<TopicSummary[]> {
  const topics = await listTopics();
  const counts = new Map((await topicPageCounts(now)).map((c) => [c.slug, c]));
  return topics.map((t) => {
    const c = counts.get(t.slug);
    return { slug: t.slug, name: t.name, group: t.grp, definition: t.definition, total: c?.total ?? 0, recent: c?.recent ?? 0, indexable: c?.indexable ?? false, latestAt: c?.latest?.toISOString() ?? null };
  });
}

export interface TopicPage {
  topic: TopicSummary & { related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
}

/**
 * One topic page. `now` is optional: with a fixed clock the counts and this page's items are read at that
 * same instant (a test, a replay); without one the counts come from the held copy, which never outlives the
 * next release.
 */
export async function loadTopicPage(slug: string, page: number, now?: Date): Promise<TopicPage | null> {
  const at = now ?? new Date();
  const row = await loadTopic(slug);
  if (!row || page < 1) return null;
  const topics = await listTopicSummaries(now);
  const topic = topics.find((t) => t.slug === slug);
  if (!topic) return null;
  const pageCount = Math.max(1, Math.ceil(topic.total / TOPIC_PAGE_SIZE));
  if (page < 1 || page > pageCount) return null;
  // Page ids from the selected set first, then the joins for those rows only.
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE ${selectedCondition(at)} AND p.tags && ${topicMatchTags(row)}::text[]
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const related = row.related.map((r) => topics.find((t) => t.slug === r)).filter((t): t is TopicSummary => !!t).map((t) => ({ slug: t.slug, name: t.name }));
  return { topic: { ...topic, related }, items: rows.map(toFeedItemSummary), page, pageCount };
}
