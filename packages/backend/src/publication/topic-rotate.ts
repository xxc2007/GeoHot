import { sql } from "../db.ts";
import { topicMatchTags } from "./topics.ts";

/** 轮换看多长的窗口：一个月没动静就归档，回来三条以上就复活。 */
export const ROTATE_WINDOW_DAYS = 30;
export const REVIVE_FLOOR = 3;
/** 候选主题的门槛：近 30 天至少这么多条，且没有任何主题认领。 */
export const PROPOSAL_FLOOR = 8;

/**
 * 这些标签描述的是稿子的体裁或「不好归类」，不是读者的兴趣点。
 *
 * 2026-11-05 的首轮候选里它们占了四席（评论/解读 3171、非地理/通用 2164、机构/动态 1783、其他 958），
 * 升成主题等于把「杂项」挂到导航上；登记在这里让它们永远不出现在候选里。
 */
export const GENERIC_TAGS = ["评论/解读", "非地理/通用", "机构/动态", "其他", "转载", "快讯"];

export interface RotationResult {
  checked: number;
  archived: string[];
  revived: string[];
}

/**
 * 主题轮换：把「近 N 天零新条目」的主题置为归档，把回来有动静的归档主题清回在岗。
 *
 * 判据与主题页一致（分配表 ∪ 标签），所以「主题页上看着空」和「轮换认为它空」不会打架。
 * 归档只影响列表与导航，页面继续可访问——读者手里的旧链接不该因为轮换变成 404。
 */
export async function rotateTopics(now = new Date()): Promise<RotationResult> {
  const since = new Date(now.getTime() - ROTATE_WINDOW_DAYS * 86400_000);
  const rows = await sql<{ slug: string; dormant: boolean; recent: number }[]>`
    WITH listed AS (
      SELECT p.article_id, p.timeline_at, p.tags
        FROM publications p
       WHERE p.visibility = 'public' AND p.timeline_at > ${since}
    ), matched AS (
      SELECT pt.slug, l.article_id, l.timeline_at
        FROM publication_topics pt JOIN listed l ON l.article_id = pt.article_id
      UNION ALL
      SELECT t.slug, l.article_id, l.timeline_at
        FROM topics t JOIN listed l ON l.tags && t.tags
    ), counted AS (
      SELECT slug, count(DISTINCT article_id)::int AS recent FROM matched GROUP BY slug
    )
    SELECT t.slug, (t.dormant_at IS NOT NULL) AS dormant, coalesce(c.recent, 0) AS recent
      FROM topics t LEFT JOIN counted c ON c.slug = t.slug
  `;

  const archived = rows.filter((r) => !r.dormant && r.recent === 0).map((r) => r.slug);
  const revived = rows.filter((r) => r.dormant && r.recent >= REVIVE_FLOOR).map((r) => r.slug);

  if (archived.length) {
    await sql`UPDATE topics SET dormant_at = ${now}, rotation_note = ${`近 ${ROTATE_WINDOW_DAYS} 天零新条目（${now.toISOString().slice(0, 10)}）`} WHERE slug = ANY(${archived})`;
  }
  if (revived.length) {
    await sql`UPDATE topics SET dormant_at = NULL, rotation_note = ${`近 ${ROTATE_WINDOW_DAYS} 天重新有 ${REVIVE_FLOOR}+ 条，${now.toISOString().slice(0, 10)} 恢复在岗`} WHERE slug = ANY(${revived})`;
  }
  console.log(JSON.stringify({ level: "info", msg: "topic rotation", windowDays: ROTATE_WINDOW_DAYS, checked: rows.length, archived: archived.length, revived: revived.length }));
  return { checked: rows.length, archived, revived };
}

export interface ProposalRow {
  tag: string;
  articles: number;
}

/**
 * 候选主题：近 N 天里出现频率够高、但没有任何主题认领的标签。
 *
 * 只登记不动结构——升成正式主题要写名字、定义、相关主题与位置，那是人做的决定；
 * 但「哪些词正在变热」这件事可以每天算清楚，免得下次轮换还在看 2026-10 的标签表。
 */
export async function proposeTopics(now = new Date()): Promise<ProposalRow[]> {
  const since = new Date(now.getTime() - ROTATE_WINDOW_DAYS * 86400_000);
  const topics = await sql<{ tags: string[]; entity_id: string | null }[]>`SELECT tags, entity_id FROM topics`;
  // 已认领 = 标签本身 ∪ 机构键。机构主题（如 cma）用 entity:<id> 匹配，但它的 tags 里也写着「中国气象局」——
  // 只算 topicMatchTags 会让这些标签永远当「新候选」，2026-11-05 那次 14 个候选里有 3 个就是这么来的。
  const claimed = new Set<string>();
  for (const t of topics) {
    for (const tag of topicMatchTags(t)) claimed.add(tag);
    for (const tag of t.tags ?? []) claimed.add(tag);
  }
  const generic = new Set(GENERIC_TAGS);

  const rows = await sql<{ tag: string; articles: number; first_seen: Date; last_seen: Date }[]>`
    SELECT tag, count(*)::int AS articles, min(timeline_at) AS first_seen, max(timeline_at) AS last_seen
      FROM publications p, unnest(p.tags) AS tag
     WHERE p.visibility = 'public' AND p.timeline_at > ${since}
       AND tag NOT LIKE 'entity:%'
     GROUP BY tag
    HAVING count(*) >= ${PROPOSAL_FLOOR}
     ORDER BY articles DESC
     LIMIT 50
  `;
  const fresh = rows.filter((r) => !claimed.has(r.tag) && !generic.has(r.tag));
  const keep = fresh.map((r) => r.tag);
  // 曾经的热词冷下来了（或已被主题认领）就先撤掉，免得看板上一直挂着过期结论。
  await sql`DELETE FROM topic_proposals WHERE NOT (tag = ANY(${keep}))`;
  if (fresh.length) {
    await sql`
      INSERT INTO topic_proposals ${sql(fresh.map((r) => ({ tag: r.tag, articles: r.articles, first_seen: r.first_seen, last_seen: r.last_seen, seen_at: now })))}
      ON CONFLICT (tag) DO UPDATE SET articles = excluded.articles, last_seen = excluded.last_seen, seen_at = excluded.seen_at
    `;
  }
  console.log(JSON.stringify({ level: "info", msg: "topic proposals", windowDays: ROTATE_WINDOW_DAYS, floor: PROPOSAL_FLOOR, candidates: fresh.length, top: fresh.slice(0, 5) }));
  return fresh.map((r) => ({ tag: r.tag, articles: r.articles }));
}