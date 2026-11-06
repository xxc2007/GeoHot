import { adminReadOrBusy } from "./admin-read.ts";

/** 主题轮换看板：哪些主题最近有货、哪些被归档、候选里还排着谁。
 *
 * 2026-11-06：轮换与候选 triage 早就在跑（`topics.rotate` / `topics.proposals`），但结果只在日志里，
 * 站长看不到「上周谁被休眠、这周谁被提上来」。这里把两件事摊在一张表上：近 N 天的可读条目数、
 * 最后一条的时间、休眠标记与说明，以及候选表（多少条、第一次/最后一次出现）。
 */
export interface RotationTopic {
  slug: string;
  name: string;
  group: string;
  items30: number;
  lastItemAt: string | null;
  dormantAt: string | null;
  note: string | null;
}

export interface RotationProposal {
  tag: string;
  articles: number;
  firstSeen: string | null;
  lastSeen: string | null;
  seenAt: string;
}

export interface TopicRotationBoard {
  generatedAt: string;
  windowDays: number;
  dormant: number;
  topics: RotationTopic[];
  proposals: RotationProposal[];
}

export async function topicRotationBoard(days = 30, now = new Date()): Promise<TopicRotationBoard> {
  const windowDays = Math.min(365, Math.max(1, Math.trunc(days)));
  return adminReadOrBusy(async (db) => {
    const topics = await db<RotationTopic[]>`
      WITH recent AS (
        SELECT pt.slug, count(*)::int AS items, max(p.discovered_at) AS last_at
          FROM publication_topics pt
          JOIN publications p ON p.article_id = pt.article_id
         WHERE p.visibility = 'public'
           AND p.discovered_at > ${now}::timestamptz - make_interval(days => ${windowDays})
         GROUP BY pt.slug
      )
      SELECT t.slug, t.name, t.grp AS "group",
             coalesce(r.items, 0)::int AS items30,
             r.last_at AS "lastItemAt",
             t.dormant_at AS "dormantAt",
             t.rotation_note AS note
        FROM topics t
        LEFT JOIN recent r ON r.slug = t.slug
       ORDER BY coalesce(r.items, 0) DESC, t.position, t.slug`;
    const proposals = await db<RotationProposal[]>`
      SELECT tag, articles::int AS articles,
             first_seen AS "firstSeen", last_seen AS "lastSeen", seen_at AS "seenAt"
        FROM topic_proposals
       ORDER BY articles DESC, tag
       LIMIT 50`;
    return {
      generatedAt: now.toISOString(),
      windowDays,
      dormant: topics.filter((t) => t.dormantAt !== null).length,
      topics,
      proposals,
    };
  });
}

/** 运维提示：零条目但还没归档（说明还没到换班点或配额没跑），以及归档了却突然回货的。 */
export function rotationHints(board: TopicRotationBoard): string[] {
  const hints: string[] = [];
  const empty = board.topics.filter((t) => t.items30 === 0 && t.dormantAt === null);
  if (empty.length) hints.push(`${empty.length} 个主题近 ${board.windowDays} 天零条目，下次换班会归档：${empty.map((t) => t.slug).join("、")}`);
  const revived = board.topics.filter((t) => t.items30 >= 3 && t.dormantAt !== null);
  if (revived.length) hints.push(`${revived.length} 个已归档主题又有新货，换班时会复活：${revived.map((t) => t.slug).join("、")}`);
  if (board.proposals.length) hints.push(`候选里还有 ${board.proposals.length} 个热词待拍板（第一行：${board.proposals[0]!.tag} ${board.proposals[0]!.articles} 条）`);
  return hints;
}
