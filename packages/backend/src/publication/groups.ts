// Reading-group expansions: the reports behind "另有 N 家信源报道" and the developments behind
// "展开 N 条进展". Members must pass the same visibility, pool eligibility and parent-page filters.
import type { CategoryKey, ChannelKey } from "@aihot/contracts/taxonomy";
import { UUID_PATTERN } from "@aihot/contracts/taxonomy";
import type { DevelopmentsResponse, GroupReportsResponse, SiteLang } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { shortHash } from "../lib/ids.ts";
import { proxiedImage } from "../media/imgproxy.ts";
import { ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, listedCondition, selectedCondition, tagCondition, toItemSummary, topicCondition, type ItemRow } from "./items.ts";
import { FACT_MEMBER_ROLES } from "./rules.ts";
import { pickRepresentative } from "./timeline.ts";
import { textLocaleOf } from "./english-policy.ts";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { sourceNameFor } from "./source-name.ts";

export interface GroupReportsQuery {
  factPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topicTags: string[] | null;
  cursor: string | null;
  take: number;
  revision: string | null;
  lang?: SiteLang;
}

export type GroupReportsResult =
  | { kind: "ok"; body: GroupReportsResponse }
  | { kind: "not_found" }
  | { kind: "changed" };

/** A page offset a client may hand back: a whole count of rows, never NaN, a fraction or a negative. */
const isOffset = (o: unknown): o is number => Number.isInteger(o) && (o as number) >= 0;

export async function loadGroupReports(q: GroupReportsQuery, now = new Date()): Promise<GroupReportsResult> {
  const lang: SiteLang = q.lang === "en" ? "en" : "zh";
  const [fact] = await sql<{ id: number }[]>`SELECT id FROM facts WHERE public_id = ${q.factPublicId}`;
  if (!fact) return { kind: "not_found" };
  const filters = sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)} ${topicCondition(q.topicTags)}`;
  const members = await sql<{
    id: string; title: string; title_en: string | null; original_title: string | null; summary: string | null; summary_en: string | null; timeline_at: Date; url: string; selected: boolean;
    source_id: string; source_name: string; source_name_en: string | null; source_kind: string; first_party: boolean; icon_url: string | null;
  }[]>`
    SELECT p.article_id AS id, p.title, p.title_en, p.original_title, p.summary, p.summary_en, p.timeline_at, p.url, p.selected,
           s.id AS source_id, s.name AS source_name, s.name_en AS source_name_en, s.kind AS source_kind, p.first_party, s.icon_url
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id IN (SELECT article_id FROM fact_articles WHERE fact_id = ${fact.id} AND role = ANY(${FACT_MEMBER_ROLES}))
      AND p.eligible AND ${listedCondition(now, lang)} ${filters}
    ORDER BY p.timeline_at DESC, p.article_id ASC`;
  if (members.length === 0) return { kind: "not_found" };
  const visibleMembers = lang === "en"
    ? members.filter((m) => m.title_en?.trim() || (m.original_title && !hasChineseCopy(m.original_title)))
    : members;
  if (visibleMembers.length === 0) return { kind: "not_found" };

  // The revision covers the actual member set; a cursor from another revision means "reload".
  const revision = shortHash(visibleMembers.map((m) => m.id).join(","), 10);
  const binding = queryBinding({ f: q.factPublicId, c: q.channel, k: q.category, t: q.tag, p: q.topicTags, ...(lang === "en" ? { l: "en" } : {}) });
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor<{ o: number; r: string; b: string }>("gr1", q.cursor);
    if (c.b !== binding) throw new InvalidCursorError("cursor does not match this group query");
    // `c.o` is whatever the client sent: an unusable offset must be a 400, not `slice(NaN, NaN)`, which
    // would answer an empty page with `nextCursor: null` — "there is nothing more" for a cursor lie.
    if (!isOffset(c.o)) throw new InvalidCursorError("cursor offset is not a page offset");
    if (c.r !== revision) return { kind: "changed" };
    offset = c.o;
  } else if (q.revision && q.revision !== revision) {
    return { kind: "changed" };
  }
  const page = visibleMembers.slice(offset, offset + q.take);
  const next = offset + q.take < visibleMembers.length ? encodeCursor("gr1", { o: offset + q.take, r: revision, b: binding }) : null;
  return {
    kind: "ok",
    body: {
      factId: q.factPublicId,
      revision,
      reports: page.map((m) => {
        const title = lang === "en"
          ? (m.title_en?.trim() || (m.original_title && !hasChineseCopy(m.original_title) ? m.original_title : ""))
          : m.title;
        const summary = lang === "en" ? (m.summary_en?.trim() ? m.summary_en : null) : m.summary;
        const sourceName = sourceNameFor(lang, m.source_name, m.source_name_en, m.url);
        return {
          id: m.id,
          title,
          summary,
          source: { id: m.source_id, name: sourceName, kind: m.source_kind as never, firstParty: m.first_party, iconUrl: proxiedImage(m.icon_url, "avatar"), nameLocale: lang === "en" ? "en" : "zh" },
          timelineAt: m.timeline_at.toISOString(),
          originalUrl: m.url,
          selected: m.selected,
          textLocale: textLocaleOf(title, summary),
        };
      }),
      nextCursor: next,
      lang,
    },
  };
}

export interface DevelopmentsQuery {
  storyPublicId: string;
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topicTags: string[] | null;
  cursor: string | null;
  take: number;
  revision: string | null;
  lang?: SiteLang;
}

export type DevelopmentsResult = { kind: "ok"; body: DevelopmentsResponse } | { kind: "not_found" } | { kind: "changed" };

/**
 * The developments of a story's reading group: its facts with a selected report under the parent
 * page's filters, latest first, each with its first-party pick and its public report count.
 */
export async function loadDevelopments(q: DevelopmentsQuery, now = new Date()): Promise<DevelopmentsResult> {
  const lang: SiteLang = q.lang === "en" ? "en" : "zh";
  if (!UUID_PATTERN.test(q.storyPublicId)) return { kind: "not_found" };
  const [story] = await sql<{ id: number; public_id: string; title: string; title_en: string | null }[]>`
    SELECT id, public_id::text, title, title_en FROM stories WHERE public_id = ${q.storyPublicId} AND merged_into IS NULL`;
  if (!story) return { kind: "not_found" };
  const filters = sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)} ${topicCondition(q.topicTags)}`;
  type Member = Pick<ItemRow, "id" | "fact_id" | "first_party" | "body_mode" | "score" | "timeline_at" | "sort_at">;
  const selected = await sql<Member[]>`
    SELECT p.article_id AS id, p.fact_id, p.first_party, p.body_mode, p.score, p.timeline_at, p.sort_at
    FROM publications p WHERE p.story_id = ${story.id} AND ${selectedCondition(now, lang)} ${filters}`;
  if (selected.length === 0) return { kind: "not_found" };
  const counts = new Map(
    (await sql<{ fact_id: number; n: number }[]>`
      SELECT fa.fact_id, count(DISTINCT p.article_id)::int AS n
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = ${story.id} AND p.eligible AND ${listedCondition(now, lang)} ${filters}
      GROUP BY fa.fact_id`).map((c) => [c.fact_id, c.n]),
  );
  const byFact = new Map<number, Member[]>();
  for (const r of selected) if (r.fact_id !== null) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r]);
  if (byFact.size === 0) return { kind: "not_found" };
  const facts = (await sql<{ id: number; public_id: string; title: string; title_en: string | null; occurred_at: Date | null }[]>`
    SELECT id, public_id, title, title_en, occurred_at FROM facts WHERE id IN ${sql([...byFact.keys()])}`)
    // /en 的「事件进展」只列有英文标题的 fact；没有英文的 fact 不在英文页用中文标题顶上。
    .filter((f) => lang !== "en" || !!f.title_en?.trim());
  const list = facts
    .map((f) => {
      const rows = byFact.get(f.id)!;
      const rep = pickRepresentative(rows);
      const title = lang === "en" ? f.title_en!.trim() : f.title;
      return {
        first: Math.min(...rows.map((r) => (r.sort_at ?? r.timeline_at).getTime())),
        development: { factId: f.public_id, title, occurredAt: f.occurred_at?.toISOString() ?? null, representativeId: rep.id, reportCount: counts.get(f.id) ?? rows.length, textLocale: textLocaleOf(title, null) },
      };
    })
    .sort((a, b) => b.first - a.first || a.development.factId.localeCompare(b.development.factId))
    .map((d) => d.development);

  const revision = shortHash(list.map((d) => `${d.factId}:${d.representativeId}:${d.reportCount}`).join(","), 10);
  const binding = queryBinding({ s: q.storyPublicId, c: q.channel, k: q.category, t: q.tag, p: q.topicTags, ...(lang === "en" ? { l: "en" } : {}) });
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor<{ o: number; r: string; b: string }>("dv1", q.cursor);
    if (c.b !== binding) throw new InvalidCursorError("cursor does not match this group query");
    if (!isOffset(c.o)) throw new InvalidCursorError("cursor offset is not a page offset");
    if (c.r !== revision) return { kind: "changed" };
    offset = c.o;
  } else if (q.revision && q.revision !== revision) {
    return { kind: "changed" };
  }
  const next = offset + q.take < list.length ? encodeCursor("dv1", { o: offset + q.take, r: revision, b: binding }) : null;
  const page = list.slice(offset, offset + q.take);
  const rows = new Map(page.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(page.map((d) => d.representativeId))}
      AND p.story_id = ${story.id} AND ${selectedCondition(now, lang)} ${filters}`).map((row) => [row.id, row]) : []);
  if (rows.size !== page.length) return { kind: "changed" };
  const developments = page.flatMap(({ representativeId, ...development }) => {
    const row = rows.get(representativeId);
    return row ? [{ ...development, representative: toItemSummary(row, lang) }] : [];
  });
  return {
    kind: "ok",
    body: {
      story: {
        publicId: story.public_id,
        title: (lang === "en" ? story.title_en ?? story.title : story.title) ?? "",
      },
      revision,
      developments,
      nextCursor: next,
      lang,
    },
  };
}
