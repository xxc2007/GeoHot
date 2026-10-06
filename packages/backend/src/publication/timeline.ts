// Home timeline: selected items folded into reading groups (reference SELECTED_READING):
// one card per story, per fact outside a story, or per standalone article. A card sits at its latest
// development's first appearance, so a new development brings it back up while a representative swap
// never moves it; the representative is the first-party pick of the story's initiating fact.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, chineseCopyCondition, releasedCondition, selectedCondition, tagCondition, toFeedItemSummary, topicCondition,
  type ItemRow,
} from "./items.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  topicTags?: string[] | null;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)} ${topicCondition(q.topicTags)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag, p: q.topic ?? null });
}

/** Representative preference: first-party, full text, higher score, earliest. */
type RepresentativeRow = Pick<ItemRow, "first_party" | "body_mode" | "score" | "timeline_at">;
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  return [...rows].sort((a, b) => {
    if (a.first_party !== b.first_party) return a.first_party ? -1 : 1;
    if (a.body_mode !== b.body_mode) return a.body_mode === "full" ? -1 : 1;
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sa !== sb) return sb - sa;
    return a.timeline_at.getTime() - b.timeline_at.getTime();
  })[0]!;
}

/**
 * Public pool reports linked to the facts of the given stories and standalone facts, under the same
 * filters (non-selected included): the sets "另有 N 家信源报道" expands and the group counts come from.
 * The Chinese-copy gate belongs here too, and it is the *same* one `loadGroupReports` applies
 * (`groups.ts:43`) — otherwise the card promises a number the panel it opens cannot deliver: an
 * English-only member counts here but is refused there, so 「另有 3 家」 expands to two.
 */
async function groupPool(q: TimelineQuery, now: Date, storyIds: number[], factIds: number[]) {
  if (!storyIds.length && !factIds.length) return [];
  return sql<{ story_id: number | null; fact_id: number; article_id: string; source_id: string; at: Date }[]>`
    SELECT DISTINCT f.story_id, f.id AS fact_id, p.article_id, p.source_id, p.timeline_at AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE (f.story_id IN ${sql(storyIds.length ? storyIds : [0])} OR f.id IN ${sql(factIds.length ? factIds : [0])})
      AND p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)} AND ${chineseCopyCondition()} ${filterSql(q)}`;
}

/**
 * The selected set grouped into cards (fact or standalone item) with their anchor times, newest
 * first. Every timeline page, day count and "new items" probe reads this list; it is kept for five
 * seconds per filter scope, and for no longer than the earliest release still waiting in that scope.
 *
 * The anchors and that deadline come from one read on purpose. Read separately, the deadline could be
 * measured after the anchors and be earlier than the snapshot it described: a reader landing at that
 * moment was told 「下一条 X 分发布」 while the five-second set still left X out.
 */
interface GroupedSnapshot {
  readAt: number;
  /** When this snapshot stops being true: the 5 s window or the next release, whichever is sooner. */
  until: number;
  refreshAt: string | null;
  rows: Array<{ gk: string; anchor: number }>;
}
const groupedCache = new Map<string, GroupedSnapshot>();
const groupedPending = new Map<string, Promise<GroupedSnapshot>>();
async function groupedSnapshot(q: TimelineQuery, now: Date): Promise<GroupedSnapshot> {
  const key = binding(q);
  const held = q.now ? undefined : groupedCache.get(key);
  if (held && Date.now() < held.until) return held;
  const pending = q.now ? undefined : groupedPending.get(key);
  if (pending) return pending;
  const load = queryGroupedAnchors(q, now);
  if (q.now) return load;
  groupedPending.set(key, load);
  try {
    const snap = await load;
    if (groupedCache.size >= 50) groupedCache.delete(groupedCache.keys().next().value!);
    groupedCache.set(key, snap);
    return snap;
  } finally { groupedPending.delete(key); }
}

async function queryGroupedAnchors(q: TimelineQuery, now: Date): Promise<GroupedSnapshot> {
  const rows = await sql<{ gk: string | null; anchor_at: Date | null; pending_at: Date | null }[]>`
    WITH base AS (
      SELECT p.sort_at, coalesce('s' || p.story_id::text, 'f' || p.fact_id::text, 'a' || p.article_id) AS gk
      FROM publications p
      WHERE ${selectedCondition(now)} ${filterSql(q)}
    ),
    waiting AS (
      SELECT min(p.visible_after) AS t FROM publications p
      WHERE p.visibility = 'public' AND p.selected AND p.visible_after > ${now} AND ${chineseCopyCondition()} ${filterSql(q)}
    )
    SELECT g.gk, g.anchor_at, waiting.t AS pending_at
    FROM waiting LEFT JOIN (SELECT gk, max(sort_at) AS anchor_at FROM base GROUP BY gk) g ON true
    ORDER BY g.anchor_at DESC NULLS LAST, g.gk COLLATE "C" DESC`;
  const readAt = Date.now();
  const waiting = rows[0]?.pending_at ?? null;
  return {
    readAt,
    refreshAt: waiting ? waiting.toISOString() : null,
    // A release a millisecond away must not turn every page view into a fresh grouped read; one second is
    // far below the reader-visible difference and keeps the probe honest about the next one.
    until: waiting ? Math.max(readAt + 1000, Math.min(readAt + 5000, waiting.getTime())) : readAt + 5000,
    rows: rows.filter((r) => r.gk !== null && r.anchor_at !== null).map((r) => ({ gk: r.gk!, anchor: r.anchor_at!.getTime() })),
  };
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot" | "hotAsOf" | "generatedAt">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl1", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // The reading set and its expiry are one snapshot, read alongside this page.
  const snapshot = await groupedSnapshot(q, now);
  const start = after ? snapshot.rows.findIndex((g) => g.anchor < after.a || (g.anchor === after.a && g.gk < after.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : snapshot.rows.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const storyIds = page.filter((g) => g.gk.startsWith("s")).map((g) => Number(g.gk.slice(1)));
  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id" | "sort_at"> & { story_id: number | null; fact_id: number };
  const [members, pool] = await Promise.all([
    storyIds.length || factIds.length
      ? sql<Member[]>`
        SELECT p.story_id, p.fact_id, p.article_id AS id, p.first_party, p.body_mode, p.score, p.timeline_at, p.sort_at FROM publications p
        WHERE (p.story_id IN ${sql(storyIds.length ? storyIds : [0])} OR (p.story_id IS NULL AND p.fact_id IN ${sql(factIds.length ? factIds : [0])}))
          AND ${selectedCondition(now)} ${filterSql(q)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, storyIds, factIds),
  ]);
  const groupFactIds = [...new Set([...members.map((m) => m.fact_id), ...pool.map((r) => r.fact_id)])];
  const factInfo = new Map(
    groupFactIds.length ? (await sql<{ id: number; public_id: string; title: string }[]>`SELECT id, public_id, title FROM facts WHERE id IN ${sql(groupFactIds)}`).map((f) => [f.id, f]) : [],
  );
  const firstSeen = (list: Member[]) => Math.min(...list.map((r) => (r.sort_at ?? r.timeline_at).getTime()));

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const id = Number(g.gk.slice(1));
    const isStory = g.gk.startsWith("s");
    const byFact = new Map<number, Member[]>();
    for (const m of members) {
      if (isStory ? m.story_id !== id : m.story_id !== null || m.fact_id !== id) continue;
      byFact.set(m.fact_id, [...(byFact.get(m.fact_id) ?? []), m]);
    }
    if (byFact.size === 0) continue;
    const reports = pool.filter((r) => (isStory ? r.story_id === id : r.fact_id === id));
    // The group stands for its initiating fact, the one first reported; that fact's first-party pick
    // represents it, or, when it has no selected report, the pick of the earliest fact that has one.
    const firstReport = new Map<number, number>();
    for (const r of reports) firstReport.set(r.fact_id, Math.min(firstReport.get(r.fact_id) ?? Infinity, r.at.getTime()));
    const mainFact = [...firstReport.entries()].sort((x, y) => x[1] - y[1] || x[0] - y[0])[0]?.[0] ?? [...byFact.keys()][0]!;
    const repRows = byFact.get(mainFact) ?? [...byFact.values()].sort((x, y) => firstSeen(x) - firstSeen(y))[0]!;
    const rep = pickRepresentative(repRows);
    const mainReports = reports.filter((r) => r.fact_id === mainFact);
    const [newestFact, newestRows] = [...byFact.entries()].sort((x, y) => firstSeen(y[1]) - firstSeen(x[1]) || y[0] - x[0])[0]!;
    const newest = newestFact !== mainFact ? factInfo.get(newestFact) : undefined;
    const group: GroupInfo = {
      factId: factInfo.get(mainFact)?.public_id ?? String(mainFact),
      story: null,
      additionalSourceCount: Math.max(0, new Set(mainReports.map((r) => r.source_id)).size - 1),
      // Reports of the facts that have a selected report (the developments), counted once each.
      reportCount: new Set(reports.filter((r) => byFact.has(r.fact_id)).map((r) => r.article_id)).size,
      developmentCount: byFact.size,
      latestDevelopment: newest ? { factId: newest.public_id, title: newest.title, at: new Date(firstSeen(newestRows)).toISOString() } : null,
    };
    const showGroup = group.reportCount > 1 || group.developmentCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    if (group) group.story = row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null;
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts: Record<string, number> = {};
  if (days.size) {
    for (const g of snapshot.rows) {
      const day = beijingDate(g.anchor);
      if (days.has(day)) dayCounts[day] = (dayCounts[day] ?? 0) + 1;
    }
  }

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl1", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return { filters: { channel: q.channel, category: q.category, tag: q.tag, topic: q.topic ?? null }, cards, nextCursor, refreshAt: snapshot.refreshAt, dayCounts };
}
