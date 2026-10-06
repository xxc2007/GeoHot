// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotParticipant, HotStripEntry } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";

export interface HotEntry {
  rank: number;
  storyId: number;
  storyPublicId: string;
  title: string;
  heat: number;
  /** "unknown": the earlier participants' sources were behind on collection, so there is no comparison. */
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
  /** 精选组 first by tier, then 氛围组; tier is absent on rankings from before 2026-09-29. */
  participants: Array<{ name: string; kind: "editorial" | "signal"; tier?: string }>;
}

/** Faces are the 精选组 sources, T1 before T1.5 before T2; the rest (and 氛围组) count in "+N". */
const MAX_FACES = 6;
const TIER_ORDER = ["T1", "T1_5", "T2"];
export function tierRank(tier: string | undefined): number {
  const i = TIER_ORDER.indexOf(tier ?? "");
  return i < 0 ? TIER_ORDER.length : i;
}

export interface HotRanking {
  id: number;
  computedAt: string;
  ruleVersion: string;
  entries: HotEntry[];
  coverage: Record<string, unknown> | null;
}

let rankingPending: Promise<HotRanking | null> | null = null;

/**
 * How old a board may be and still be shown as 当前热点. The job recomputes every five minutes
 * (`hot.rank` in apps/worker/src/schedules.ts), so a board older than this is not "late": 24 hours is
 * **288** of those recomputes, and every one of them found nothing — i.e. nothing in the last 48 hours
 * reached two independent participants. (This said "twenty" until 2026-10-05, which is 100 minutes: the
 * number was left behind when the window was widened, and it is the only written account an operator has
 * of how long the board has been empty.) Showing it is the honest choice while it is within a day (the
 * reader gets the last board the site can stand behind, together with its cut-off time); past a day the
 * block says it has nothing.
 */
const MAX_BOARD_AGE_HOURS = 24;

export function latestHotRanking(): Promise<HotRanking | null> {
  rankingPending ??= queryLatestHotRanking().finally(() => { rankingPending = null; });
  return rankingPending;
}

async function queryLatestHotRanking(): Promise<HotRanking | null> {
  const [row] = await sql<{ id: number; computed_at: Date; rule_version: string; entries: HotEntry[]; evidence: Record<string, unknown> | null }[]>`
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings
    WHERE published AND jsonb_array_length(entries) > 0
      AND computed_at > now() - make_interval(hours => ${MAX_BOARD_AGE_HOURS})
    ORDER BY computed_at DESC LIMIT 1`;
  if (!row) return null;
  // `hot.ts` stopped publishing empty boards, and the length check also steps around the empty ones it
  // published before that — otherwise the newest empty row would hide the last board with events in it.
  // Then drop the entries the board can no longer stand behind: an event merged into another one (the group
  // step rewrites `stories.merged_into`), one whose page is gone, and one whose heading never got Chinese.
  const live = await publishableStories(row.entries.map((e) => e.storyId));
  const entries = row.entries.filter((e) => live.has(e.storyId)).map((e, i) => (i === e.rank - 1 ? e : { ...e, rank: i + 1 }));
  if (entries.length === 0) return null;
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries, coverage: row.evidence };
}

/**
 * The ids in `storyIds` that this board may still show to a reader: the event exists, has not been merged
 * away, and its own heading carries Chinese.
 *
 * The Chinese check is the same gate every other reader-facing exit applies (`chineseCopyCondition` in
 * `publication/items.ts`, reused here through its pattern constant rather than retyped). The ranking path
 * was the one exit that never referenced it: heat is computed from `stories.title`, and 482 of the 4025
 * events on production still carry a Latin-only heading — today none of them reaches two participants, but
 * a board is exactly the surface where one would embarrass the site most, because it is the only place an
 * event title is printed at 15px on the home page.
 */
async function publishableStories(storyIds: number[]): Promise<Set<number>> {
  if (storyIds.length === 0) return new Set();
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM stories WHERE id = ANY(${storyIds}::bigint[]) AND merged_into IS NULL AND title ~ ${CJK_COPY_PATTERN}`;
  return new Set(rows.map((r) => Number(r.id)));
}

// Faces and words change only with the ranking, so they are read once per ranking.
interface Extras {
  faces: Map<string, string | null>;
  texts: Map<number, { summary: string | null; latest: string | null }>;
}
let extrasCache: { rankingId: number; extras: Extras } | null = null;
const extrasPending = new Map<number, Promise<Extras>>();

async function readExtras(ranking: HotRanking): Promise<Extras> {
  if (extrasCache?.rankingId === ranking.id) return extrasCache.extras;
  const pending = extrasPending.get(ranking.id);
  if (pending) return pending;
  const load = queryExtras(ranking);
  extrasPending.set(ranking.id, load);
  try { return await load; }
  finally { extrasPending.delete(ranking.id); }
}

async function queryExtras(ranking: HotRanking): Promise<Extras> {
  const ids = ranking.entries.map((e) => e.storyId);
  const [faces, texts] = await Promise.all([
    // A participant's face: the source's icon, else the avatar on that account's latest post in the story.
    sql<{ name: string; icon_url: string | null; avatar: string | null }[]>`
      SELECT DISTINCT ON (s.id) s.name, s.icon_url, a.x_post->>'avatarUrl' AS avatar
      FROM story_signals ss JOIN sources s ON s.id = ss.source_id
      LEFT JOIN articles a ON a.id = ss.article_id AND a.x_post ? 'avatarUrl'
      WHERE ss.story_id = ANY(${ids}::bigint[])
      ORDER BY s.id, (a.id IS NULL), a.discovered_at DESC`,
    sql<{ id: number; digest: string | null; summary: string | null; latest: string | null }[]>`
      SELECT id, digest, summary, latest FROM stories WHERE id = ANY(${ids}::bigint[])`,
  ]);
  const extras: Extras = {
    faces: new Map(faces.map((f) => [f.name, f.icon_url ?? f.avatar])),
    texts: new Map(texts.map((t) => [Number(t.id), { summary: t.digest ?? t.summary, latest: t.latest }])),
  };
  extrasCache = { rankingId: ranking.id, extras };
  return extras;
}

/**
 * What the web adds to a ranking entry: participants with proxied faces in the order Faces shows them
 * (精选组 by tier, a real face before an initial within a tier, then 氛围组), the digest and the latest turn.
 */
export async function rankingExtras(ranking: HotRanking) {
  const { faces, texts } = await readExtras(ranking);
  return {
    participants: (e: HotEntry): HotParticipant[] => {
      const people = e.participants
        .map((p, i) => ({ p, i, icon: faces.get(p.name) ?? null }))
        .sort((x, y) => Number(y.p.kind === "editorial") - Number(x.p.kind === "editorial") || tierRank(x.p.tier) - tierRank(y.p.tier) || Number(!!y.icon) - Number(!!x.icon) || x.i - y.i);
      // Every name stays for the tooltip; only visible Faces need srcSet.
      return people.map(({ p, icon }, i): HotParticipant => {
        const person: HotParticipant = { name: p.name, kind: p.kind, iconUrl: proxiedImage(icon, "avatar") };
        const srcSet = p.kind === "editorial" && i < MAX_FACES ? proxiedImageSet(icon, "avatar") : undefined;
        if (srcSet) person.iconSrcSet = srcSet;
        return person;
      });
    },
    text: (e: HotEntry) => texts.get(e.storyId) ?? { summary: null, latest: null },
  };
}

/**
 * Home "current hot" strip: up to 5 entries from the board the reader is shown, plus that board's cut-off
 * time (`asOf`) so the page can say which hour the ranking is from. An empty board is not a reason to hide
 * the block — the page then says so in one honest line and points at 全部动态 (see HotTopics). Only a
 * database with no ranking rows at all returns null, because that is a different, worse state: the block
 * must not read as "nothing is hot" when it is really "the ranking has never run here".
 */
export async function loadHotStrip(): Promise<{ entries: HotStripEntry[]; asOf: string | null } | null> {
  const ranking = await latestHotRanking();
  if (!ranking) {
    const [{ any }] = await sql<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM hot_rankings) AS any`;
    if (!any) return null;
    return { entries: [], asOf: null };
  }
  const extras = await rankingExtras(ranking);
  return {
    asOf: ranking.computedAt,
    entries: ranking.entries.slice(0, 5).map((e) => ({
      rank: e.rank,
      title: e.title,
      heat: e.heat,
      trend: e.trend,
      storyPublicId: e.storyPublicId,
      itemId: e.representativeItemId,
      participants: extras.participants(e),
      participantCount: e.participantCount,
    })),
  };
}
