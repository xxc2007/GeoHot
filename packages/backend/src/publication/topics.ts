import { workflowReadyCondition } from "./readiness.ts";
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
  keywords: string[];
  /** 机构名的各种写法：机构主题除了 `entity:<id>` 也认这些（0109/0110 的理由见迁移注释）。 */
  org_names: string[];
  definition: string;
  related: string[];
  position: number;
  /** 归档时间：近 30 天零新条目时置位；归档主题不进列表与导航，页面仍可访问。 */
  dormant_at: Date | null;
}

type TopicCount = { slug: string; total: number; recent: number; pages: number; indexable: boolean; latest: Date | null };
const topicsCache = cached(
  () => sql<TopicRow[]>`SELECT slug, name, grp, entity_id, tags, keywords, org_names, definition, related, position, dormant_at FROM topics ORDER BY position`,
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
      WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now} AND ${workflowReadyCondition()} AND ${chineseCopyCondition()}`,
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

/**
 * 主题页上那三组（区域与机构 / 自然与人文领域 / 内容与题材）的名字与说明。
 *
 * 它们本来**只**写在 `industry/topics.json` 里，而网页那份是手抄的三行常量——改一次词表里的组名，
 * 页面上还是旧字（这类"两处各写一份"在本仓库有过先例，见 `docs/known-issues.md` 里那些"唯一出处"）。
 * 现在由这里读出、经 `/api/site/topics` 发给网页，页面不再自带一份。
 */
export function topicGroups(): Array<{ key: string; name: string; blurb: string }> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    groups: Array<{ key: string; name: string; blurb: string }>;
  };
  return data.groups;
}

export async function loadTopic(slug: string): Promise<TopicRow | null> {
  return (await listTopics()).find((t) => t.slug === slug) ?? null;
}

/**
 * Tags that put an article in a topic.
 *
 * 机构主题：认这家机构作为来源主体的文章（`entity:<id>`），也认文章标签里写的机构名
 * （`org_names`：哥白尼 / 粮农组织 / 欧空局 …）。**不**把 `tags` 并进来 —— 0106 那次 gdacs
 * 吞掉 2,105 条灾害条目，就是机构主题的 tags 里混着体裁词。
 * 字段/体裁主题仍只认自己的 `tags`。
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags" | "org_names">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`, ...(t.org_names ?? [])] : t.tags;
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
      SELECT p.article_id, p.timeline_at, p.tags
      FROM publications p
      WHERE ${selectedCondition(now)}
    ),
    matched AS (
      SELECT pt.slug, l.article_id, l.timeline_at
        FROM publication_topics pt JOIN listed l ON l.article_id = pt.article_id
       UNION ALL
      SELECT t.slug, l.article_id, l.timeline_at
        FROM topics t JOIN listed l ON l.tags && t.tags
    ),
    counted AS (
      SELECT slug,
        count(DISTINCT article_id) AS total,
        count(DISTINCT article_id) FILTER (WHERE timeline_at > ${windowStart}) AS recent,
        max(timeline_at) AS latest
      FROM matched GROUP BY slug
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

export async function listTopicSummaries(now?: Date, includeDormant = false): Promise<TopicSummary[]> {
  const topics = await listTopics();
  const counts = new Map((await topicPageCounts(now)).map((c) => [c.slug, c]));
  // 0104 的契约：归档主题不再出现在列表与导航里，页 仍可访问。页面要拿到归档主题的
  // 计数与相关主题，列表接口则保持过滤，所以过滤交给调用方决定。
  return topics.filter((t) => includeDormant || !t.dormant_at).map((t) => {
    const c = counts.get(t.slug);
    return { slug: t.slug, name: t.name, group: t.grp, definition: t.definition, total: c?.total ?? 0, recent: c?.recent ?? 0, indexable: c?.indexable ?? false, latestAt: c?.latest?.toISOString() ?? null };
  });
}

export interface TopicPage {
  topic: TopicSummary & { related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  /** The clock this page was read at: the day headers ask the same instant which day is「今天」. */
  generatedAt: string;
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
  const topics = await listTopicSummaries(now, true);
  const topic = topics.find((t) => t.slug === slug);
  if (!topic) return null;
  const pageCount = Math.max(1, Math.ceil(topic.total / TOPIC_PAGE_SIZE));
  const related = row.related.map((r) => topics.find((t) => t.slug === r)).filter((t): t is TopicSummary => !!t).map((t) => ({ slug: t.slug, name: t.name }));
  // `page > pageCount` 不是"主题不存在"：2026-11-05 复核，越界页原先返回 null，
  // 路由把它写成 404「topic page not found」，读者看到的是"这个主题没了"。
  // 主题在、页码越界，就该给一页空列表（连同真实 pageCount），页面自己说"没有更多了"。
  if (page > pageCount) return { topic: { ...topic, related }, items: [], page, pageCount, generatedAt: at.toISOString() };
  // Page ids from the selected set first, then the joins for those rows only.
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE ${selectedCondition(at)}
        AND (EXISTS (SELECT 1 FROM publication_topics pt WHERE pt.article_id = p.article_id AND pt.slug = ${row.slug})
             OR p.tags && ${topicMatchTags(row)}::text[])
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  return { topic: { ...topic, related }, items: rows.map(toFeedItemSummary), page, pageCount, generatedAt: at.toISOString() };
}

export interface TopicFreshness {
  slug: string;
  name: string;
  /** Rows published inside the window (the same tag rule the topic page uses). */
  fresh: number;
  /** Most recent publication that belongs to the topic, or null when it never had one. */
  lastSeen: Date | null;
}

/**
 * 主题有没有跟上最近的新闻。
 *
 * 站点有 43 个主题，其中几个（地震台网、IPCC、OSM）靠的是**一两条信源**；信源被停用或开始报错之后，
 * 主题页不会变空，它只是停在上一次收录的那天——读者看到的是"这一块最近没动静"，
 * 而真相是"我们没有再去取"。`topics.audit` 每天把这组数字写进日志，让这件事有声音。
 *
 * 读法是页面用的那条判据（`topicMatchTags`），因此主题页面上能看到的最新一条，就是这里的时间。
 */
export async function topicFreshness(days = 14, now = new Date()): Promise<TopicFreshness[]> {
  const windowStart = new Date(now.getTime() - days * 86400_000);
  const rows = await sql<{ slug: string; name: string; fresh: string; last_seen: Date | null }[]>`
    WITH matched AS (
      SELECT pt.slug, p.discovered_at
        FROM publication_topics pt JOIN publications p ON p.article_id = pt.article_id
       WHERE p.discovered_at >= ${windowStart}
       UNION ALL
      SELECT t.slug, p.discovered_at
        FROM topics t JOIN publications p
          ON p.discovered_at >= ${windowStart}
         AND p.tags && (CASE WHEN t.entity_id IS NOT NULL THEN ARRAY['entity:' || t.entity_id] ELSE t.tags END)
    )
    SELECT t.slug,
           t.name,
           count(m.*)::text AS fresh,
           max(m.discovered_at) AS last_seen
      FROM topics t LEFT JOIN matched m ON m.slug = t.slug
     GROUP BY t.slug, t.name
     ORDER BY count(m.*) ASC, t.slug`;
  return rows.map((r) => ({ slug: r.slug, name: r.name, fresh: Number(r.fresh), lastSeen: r.last_seen }));
}

/** 每日一次：把"最近 N 天没有新条目的主题"写成一行日志，供运维与站长复核。 */
export async function auditTopicFreshness(days = 14, now = new Date()): Promise<{ topics: number; stale: string[] }> {
  const rows = await topicFreshness(days, now);
  const stale = rows.filter((r) => r.fresh === 0).map((r) => r.slug);
  console.log(JSON.stringify({
    level: "info",
    msg: "topic freshness audit",
    days,
    topics: rows.length,
    stale: stale.length,
    staleSlugs: stale,
    stalest: rows.slice(0, 5).map((r) => ({ slug: r.slug, lastSeen: r.lastSeen?.toISOString().slice(0, 10) ?? null })),
  }));
  return { topics: rows.length, stale };
}
