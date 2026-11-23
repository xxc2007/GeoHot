import type { FeedItemSummary, SiteLang } from "@aihot/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { withPublicRead } from "./read-budget.ts";
import { ITEM_COLUMNS, ITEM_JOINS, pendingReadyCondition, selectedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";

export interface TopicRow {
  slug: string;
  name: string;
  /** 英文主题名/说明（迁移 0128 的可空列）；缺失时 `/en` 回退中文。 */
  name_en?: string | null;
  definition_en?: string | null;
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
  () => sql<TopicRow[]>`SELECT slug, name, name_en, definition_en, grp, entity_id, tags, keywords, org_names, definition, related, position, dormant_at FROM topics ORDER BY position`,
  { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
);

/** How far back a topic's "recent" figure looks, and the floor on how long a count stays held. */
const RECENT_WINDOW_MS = 30 * 86400_000;
// 主题计数的那条读要扫「精选全集」再 unnest 标签。2026-11-16 现场：主库 io some avg10 99 时，
// 它在 `pg_stat_activity` 里挂了 178 秒；而它回答的只是 21 行数字。刷新频率从 1 分钟放宽到 5 分钟——
// 与边缘对 `/topics` 的 300 秒缓存同频，读者看到的数字不会更旧；`until` 里那条「下一批过闸时间」
// 仍然会让缓存提前失效，所以「有稿件刚要放出来」这种情况不会多等。
const COUNTS_FRESH_MS = 5 * 60_000;
const COUNTS_MIN_HOLD_MS = 5_000;

/**
 * Topic counts, held per process and read alongside the release gate. They may lag by about a minute,
 * like the public directory cache, but never past the next release still waiting behind the gate: a topic
 * page that advertised 「N 条」 including content no reader can open yet is a count of the wrong set.
 * The held value also records the instant it was read, so a caller with a fixed clock (a test, a replay)
 * can ask for the counts and the items at that same instant instead of two different ones.
 */
interface CountsSnapshot { readAt: number; until: number; counts: TopicCount[] }
// 计数按语言分桶：en 页的成员门与中文页不同时，数字不能共用（旧缓存只有 zh）。
const countsSnapshots = new Map<SiteLang, CountsSnapshot>();
const countsPending = new Map<SiteLang, Promise<CountsSnapshot>>();

function clearTopicCounts() {
  countsSnapshots.clear();
  countsPending.clear();
}

async function loadCounts(now: Date, lang: SiteLang): Promise<CountsSnapshot> {
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  // 计数 CTE 与「下一批过闸时间」必须在同一条 15 秒有界事务里跑：原来 gate 那条是裸 sql，
  // io.full=95% 时它会自己挂住（计数那条已被 15s 取消），Promise.all 永不 resolve，
  // countsHeld 的陈旧回退也接不上——整个主题页被一条 gate 查询拖死。
  const { rows, gate } = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = 15000`);
    const rows = await tx<{ slug: string; total: number; recent: number; latest: Date | null }[]>`
      WITH listed AS MATERIALIZED (
        SELECT p.article_id, p.timeline_at, p.tags
        FROM publications p
        WHERE ${selectedCondition(now, lang)}
      ),
      matched AS (
        SELECT pt.slug, l.article_id, l.timeline_at
          FROM publication_topics pt JOIN listed l ON l.article_id = pt.article_id
         UNION ALL
        SELECT t.slug, l.article_id, l.timeline_at
          FROM topics t JOIN listed l
            ON l.tags && (CASE WHEN t.entity_id IS NOT NULL
                 THEN ARRAY['entity:' || t.entity_id] || coalesce(t.org_names, ARRAY[]::text[])
                 ELSE t.tags END)
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
    const [gate] = await tx<{ t: Date | null }[]>`
      SELECT min(p.visible_after) AS t FROM publications p
      WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now} AND ${pendingReadyCondition(lang)}`;
    return { rows, gate };
  });
  const counts = rows.map((r) => ({
    slug: r.slug, total: r.total, recent: r.recent, latest: r.latest,
    pages: Math.max(1, Math.ceil(r.total / TOPIC_PAGE_SIZE)),
    indexable: r.total >= 50 || (r.total >= 20 && r.recent > 0),
  }));
  const readAt = Date.now();
  const releasing = gate?.t ? gate.t.getTime() : Infinity;
  return { readAt, until: Math.max(readAt + COUNTS_MIN_HOLD_MS, Math.min(readAt + COUNTS_FRESH_MS, releasing)), counts };
}

async function countsHeld(now: Date | undefined, lang: SiteLang): Promise<CountsSnapshot> {
  // An explicit clock bypasses the held copy: the caller wants these numbers at the same instant as its items.
  if (now) return loadCounts(now, lang);
  const held = countsSnapshots.get(lang);
  if (held && Date.now() < held.until) return held;
  const pending = countsPending.get(lang);
  if (pending) return pending;
  // 2026-11-16：计数 CTE 在 io.full=95% 时挂过 178 秒，原来直接把整个主题页拖成 503。
  // 读不出来就把上一份计数（哪怕已过期）再交一次：页面仍渲染，数字旧几分钟，until 已过
  // 下一个请求会自动重试；一次都没成功过才真抛。
  const load = loadCounts(new Date(), lang).catch((err: unknown) => {
    if (held) return held;
    throw err;
  });
  countsPending.set(lang, load);
  try {
    const snap = await load;
    countsSnapshots.set(lang, snap);
    return snap;
  } finally { countsPending.delete(lang); }
}

/**
 * The topics (stable slugs, names, definitions, related topics) come from the industry pack
 * (industry/topics.json); every environment seeds them from there. Re-runnable.
 */
export async function seedTopics(): Promise<number> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    topics: Array<{ slug: string; name: string; nameEn?: string; definition: string; definitionEn?: string; group: string; entityId?: string | null; tags: string[]; related?: string[] }>;
  };
  let position = 0;
  for (const t of data.topics) {
    await sql`
      INSERT INTO topics (slug, name, name_en, definition_en, grp, entity_id, tags, definition, related, position)
      VALUES (${t.slug}, ${t.name}, ${t.nameEn ?? null}, ${t.definitionEn ?? null}, ${t.group}, ${t.entityId ?? null}, ${t.tags}, ${t.definition}, ${t.related ?? []}, ${position++})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, name_en = EXCLUDED.name_en, definition_en = EXCLUDED.definition_en,
        grp = EXCLUDED.grp, entity_id = EXCLUDED.entity_id,
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
export function topicGroups(): Array<{ key: string; name: string; blurb: string; nameEn: string | null; blurbEn: string | null }> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    groups: Array<{ key: string; name: string; blurb: string; nameEn?: string; blurbEn?: string }>;
  };
  // 组名/说明的英文与主题行一样是可选列：词表还没补英文时 `/en` 回退中文，不伪造译文。
  return data.groups.map((g) => ({ key: g.key, name: g.name, blurb: g.blurb, nameEn: g.nameEn ?? null, blurbEn: g.blurbEn ?? null }));
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
export async function topicPageCounts(now?: Date, lang: SiteLang = "zh"): Promise<TopicCount[]> {
  return (await countsHeld(now, lang)).counts;
}

/**
 * One pass over the selected set, counted inside PostgreSQL: a topic answers to the keys of
 * `topicMatchTags` (its entity subject tag for a company, its own tags otherwise), so the tags are unnested
 * and matched here rather than shipped to Node as one array per item and looped over topic by topic —
 * quadratic once the selected set grows, and every 60 s. The read uses `selectedCondition`, so the counts
 * cover exactly the items a topic page can list: released, public, and with Chinese copy.
 */
export interface TopicSummary {
  slug: string;
  name: string;
  /** 英文展示名/说明；`/en` 优先，缺英文回退中文并保留这两个字段供页面判断。 */
  nameEn?: string | null;
  definitionEn?: string | null;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function listTopicSummaries(now?: Date, includeDormant = false): Promise<TopicSummary[]> {
  return listTopicSummariesFor(now, includeDormant, "zh");
}

/** 带读取语言的版本：en 的计数按 /en 名单读，中英字段都随包发。 */
export async function listTopicSummariesFor(now: Date | undefined, includeDormant: boolean, lang: SiteLang): Promise<TopicSummary[]> {
  const topics = await listTopics();
  const counts = new Map((await topicPageCounts(now, lang)).map((c) => [c.slug, c]));
  // 0104 的契约：归档主题不再出现在列表与导航里，页 仍可访问。页面要拿到归档主题的
  // 计数与相关主题，列表接口则保持过滤，所以过滤交给调用方决定。
  return topics.filter((t) => includeDormant || !t.dormant_at).map((t) => {
    const c = counts.get(t.slug);
    return {
      slug: t.slug,
      // 中文 `name/definition` 保持原义；`/en` 由调用方按 locale 选 `nameEn ?? name`。
      name: t.name,
      ...(t.name_en ? { nameEn: t.name_en } : {}),
      ...(t.definition_en ? { definitionEn: t.definition_en } : {}),
      group: t.grp, definition: t.definition, total: c?.total ?? 0, recent: c?.recent ?? 0, indexable: c?.indexable ?? false, latestAt: c?.latest?.toISOString() ?? null,
    };
  });
}

export interface TopicPage {
  topic: TopicSummary & { related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  /** The clock this page was read at: the day headers ask the same instant which day is「今天」. */
  generatedAt: string;
  lang?: SiteLang;
}

/**
 * One topic's counts, read at one instant with the same membership as {@link loadCounts}:
 * the explicit assignments of `publication_topics` plus the topic's own tags (`topics.tags`).
 * `loadCounts` answers all 43 topics at once and is held for the topic list; a detail page only
 * needs its own number, and paying for the other 42 was most of the 2026-11-23 cold read
 * (5–7 s): the all-topics assignment join probes `publication_topics` once per selected row.
 * The single-topic form uses `publication_topics_slug_idx` (slug, article_id) instead.
 */
async function loadTopicCounts(row: TopicRow, now: Date, lang: SiteLang): Promise<{ total: number; recent: number; latest: Date | null }> {
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  const [counts] = await withPublicRead<Array<{ total: number; recent: number; latest: Date | null }>>((db) => db`
    WITH listed AS MATERIALIZED (
      SELECT p.article_id, p.timeline_at, p.tags
      FROM publications p
      WHERE ${selectedCondition(now, lang)}
    ), tagged AS (
      SELECT l.article_id, l.timeline_at
      FROM listed l
      WHERE l.tags && ${topicMatchTags(row)}::text[]
    ), assigned AS (
      SELECT l.article_id, l.timeline_at
      FROM publication_topics pt JOIN listed l ON l.article_id = pt.article_id
      WHERE pt.slug = ${row.slug}
    ), matched AS (
      SELECT article_id, timeline_at FROM tagged
      UNION
      SELECT article_id, timeline_at FROM assigned
    )
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE timeline_at > ${windowStart})::int AS recent,
           max(timeline_at) AS latest
    FROM matched`);
  return counts ?? { total: 0, recent: 0, latest: null };
}

/**
 * One topic page. With a fixed clock (`now`) the counts come from the same full snapshot as
 * `topicPageCounts(now)` and the items are read at that same instant (a test, a replay); without one,
 * the page counts only its own topic at the read instant (see loadTopicCounts) and reads items at that
 * same instant. The all-topics snapshot stays with the topic list, which actually needs 43 numbers.
 */
export async function loadTopicPage(slug: string, page: number, now?: Date, lang: SiteLang = "zh"): Promise<TopicPage | null> {
  const at = now ?? new Date();
  const row = await loadTopic(slug);
  if (!row || page < 1) return null;
  // 固定时钟（测试/回放）：沿用与 `topicPageCounts(now)` 同一份全量计数，保证两边在同一瞬间、
  // 同一份名单上逐主题一致。生产路径只算本主题（见 loadTopicCounts）：一条详情页不需要为
  // 其余 42 个主题付全量计数——2026-11-23 冷缓存时那一步 5–7 秒，而页面只需要自己的
  // total/recent/latest 与 related 的名字（名字直接来自 topics 目录，不带计数）。
  const allTopics = now
    ? (lang === "en" ? await listTopicSummariesFor(now, true, lang) : await listTopicSummaries(now, true))
    : null;
  let topic: TopicSummary;
  if (allTopics) {
    const found = allTopics.find((t) => t.slug === slug);
    if (!found) return null;
    // `/en` 页面用英文字段（缺英文回退中文）；计数与分页按 lang 的名单读（见 topicPageCounts）。
    topic = lang === "en"
      ? { ...found, name: found.nameEn ?? found.name, definition: found.definitionEn ?? found.definition }
      : found;
  } else {
    const counts = await loadTopicCounts(row, at, lang);
    const built: TopicSummary = {
      slug: row.slug, name: row.name,
      ...(row.name_en ? { nameEn: row.name_en } : {}),
      ...(row.definition_en ? { definitionEn: row.definition_en } : {}),
      group: row.grp, definition: row.definition,
      total: counts.total, recent: counts.recent,
      indexable: counts.total >= 50 || (counts.total >= 20 && counts.recent > 0),
      latestAt: counts.latest?.toISOString() ?? null,
    };
    topic = lang === "en"
      ? { ...built, name: built.nameEn ?? built.name, definition: built.definitionEn ?? built.definition }
      : built;
  }
  const pageCount = Math.max(1, Math.ceil(topic.total / TOPIC_PAGE_SIZE));
  const relatedSource = allTopics
    ? allTopics.map((t) => ({ slug: t.slug, name: t.name, nameEn: t.nameEn ?? null }))
    : (await listTopics()).map((t) => ({ slug: t.slug, name: t.name, nameEn: t.name_en ?? null }));
  const related = row.related
    .map((r) => relatedSource.find((t) => t.slug === r))
    .filter((t): t is { slug: string; name: string; nameEn: string | null } => !!t)
    .map((t) => ({ slug: t.slug, name: lang === "en" ? t.nameEn ?? t.name : t.name }));
  // `page > pageCount` 不是"主题不存在"：2026-11-05 复核，越界页原先返回 null，
  // 路由把它写成 404「topic page not found」，读者看到的是"这个主题没了"。
  // 主题在、页码越界，就该给一页空列表（连同真实 pageCount），页面自己说"没有更多了"。
  if (page > pageCount) return { topic: { ...topic, related }, items: [], page, pageCount, generatedAt: at.toISOString(), lang };
  // Page ids from the selected set first, then the joins for those rows only.
  // 2026-11-16：这条原来跑在裸连接上、无 statement_timeout；主库 io.full=95% 时它在 pg_stat_activity
  // 里挂住，连接不归还，主题页跟着 503。收进 withPublicRead：服务端 12 秒取消、连接必归还，
  // 失败由路由层按 503/降级处理。
  //
  // 2026-11-23：主库上这条查询每个主题要 7–13 秒，主题详情页整站 503。原来的写法把
  // `EXISTS (publication_topics …) OR p.tags && $tags` 和整条成员门放在同一个 WHERE 里，
  // 规划器只能在「按 timeline 走索引、逐行探 EXISTS」与「位图并集后再排序」之间猜，实际每次
  // 都把门逐行算一遍。现在先把成员门物化成 `listed`（一次性算完，与主题计数那条读同形），
  // 主题归属再从这张小表上取：`publication_topics` 是显式分配表（0102），标签只是它的兜底
  // 旧路径，两条都只和 `listed` 做连接，不再在 300 MB 的 `publications` 上逐行 OR。
  //
  // 2026-11-24：第二处更贵——外层原来是 `WHERE p.article_id IN (SELECT … page)`。半连接不能交换
  // 内外侧，规划器只能把 133k 行的 `publications`（再连 articles/translations/stories）放在外侧做
  // 哈希半连接，再回头问哪 20 个 id 要 (实测 10–16 s、24 MB 临时文件)。改成 `FROM page pg JOIN
  // publications p` 让 20 行先当外侧，外侧只剩 20 次主键连接；分页结果与排序键都不变。
  const rows = await withPublicRead<ItemRow[]>((db) => db`
    WITH listed AS MATERIALIZED (
      SELECT p.article_id, p.timeline_at, p.tags
      FROM publications p
      WHERE ${selectedCondition(at, lang)}
    ), matched AS (
      SELECT pt.article_id
      FROM publication_topics pt
      WHERE pt.slug = ${row.slug}
      UNION
      SELECT l.article_id FROM listed l WHERE l.tags && ${topicMatchTags(row)}::text[]
    ), page AS (
      SELECT l.article_id, l.timeline_at
      FROM listed l JOIN matched m ON m.article_id = l.article_id
      ORDER BY l.timeline_at DESC, l.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} FROM page pg
    JOIN publications p ON p.article_id = pg.article_id
    ${ITEM_JOINS}
    ORDER BY pg.timeline_at DESC, pg.article_id DESC`);
  return { topic: { ...topic, related }, items: rows.map((r) => toFeedItemSummary(r, lang)), page, pageCount, generatedAt: at.toISOString(), lang };
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
         AND p.tags && (CASE WHEN t.entity_id IS NOT NULL
                       THEN ARRAY['entity:' || t.entity_id] || coalesce(t.org_names, ARRAY[]::text[])
                       ELSE t.tags END)
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
