// Public pool (/all) with numeric pages, and search in its two orderings.
import type { PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { positiveInt } from "../config.ts";
import { one, sql, withCustomPlans, type Db } from "../db.ts";
import {
  categoryCondition, channelCondition, ITEM_COLUMNS, ITEM_FROM, listedCondition, tagCondition, toFeedItemSummary, topicCondition,
  type ItemRow,
} from "./items.ts";

export const POOL_PAGE_SIZE = 40;
export const POOL_MAX_PAGES = 50;

export class SearchBusyError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("search capacity exhausted");
    this.retryAfter = retryAfter;
  }
}

// Search capacity guard: bounded concurrency with a short queue. Overflow answers 503 + Retry-After
// instead of letting machine traffic drag list browsing down.
// The two limits come from the environment, so they are validated rather than trusted: an unparseable
// value used to become NaN, which makes both guards false (`running >= NaN` is false), so the 503 +
// Retry-After path could never fire and machine traffic had no ceiling at all; a zero or negative one
// answered 503 for every search. `config.positiveInt` is that rule now — a bad setting falls back to the
// default with one line naming the number actually in force.
const MAX_CONCURRENT_SEARCHES = positiveInt(process.env.SEARCH_MAX_CONCURRENCY, "SEARCH_MAX_CONCURRENCY", 4);
const MAX_QUEUED_SEARCHES = positiveInt(process.env.SEARCH_MAX_QUEUE, "SEARCH_MAX_QUEUE", 8);
const QUEUE_WAIT_MS = positiveInt(process.env.SEARCH_QUEUE_WAIT_MS, "SEARCH_QUEUE_WAIT_MS", 3_000);
// Retry-After is derived from the wait window, not a number typed next to it: the hint we give a machine
// is "wait about as long as we just waited". With `SEARCH_QUEUE_WAIT_MS=3000` that is 4 seconds.
const RETRY_AFTER_SECONDS = Math.ceil(QUEUE_WAIT_MS / 1000) + 1;
let running = 0;
const waiters: Array<() => void> = [];

export async function withSearchCapacity<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  // The slot is *handed over*, not released and then reacquired. Releasing first (`running -= 1` in the
  // old finally, before the woken waiter reached its own `running += 1` one microtask later) let any
  // arrival in that window see a free slot and take it, so the ceiling was soft: `MAX + whoever slipped
  // through`. This guard exists precisely so machine traffic cannot raise the number of concurrent
  // searches above the pool under it (`db.ts` max: 10), which is why the count moves with the wake-up.
  let holdsSlot = false;
  if (running >= MAX_CONCURRENT_SEARCHES) {
    if (waiters.length >= MAX_QUEUED_SEARCHES) throw new SearchBusyError(RETRY_AFTER_SECONDS);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(go);
        if (i >= 0) waiters.splice(i, 1);
        reject(new SearchBusyError(RETRY_AFTER_SECONDS));
      }, QUEUE_WAIT_MS);
      const go = () => {
        clearTimeout(timer);
        holdsSlot = true; // the holder that woke us is still counted; it will not decrement
        resolve();
      };
      waiters.push(go);
    });
  }
  if (!holdsSlot) running += 1;
  try {
    return await withCustomPlans(fn);
  } finally {
    const next = waiters.shift();
    if (next) next();
    else running -= 1;
  }
}

/** Search terms: whitespace separated, lower-cased, LIKE metacharacters escaped. */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[\\%_]/g, (m) => `\\${m}`));
}

/** Default search: subject, title or summary match (search_text), newest first. */
export function directMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  return terms.reduce((acc, t) => sql`${acc} AND p.search_text LIKE ${"%" + t + "%"}`, sql``);
}

/**
 * The public APIs' q (v1 and MCP): every term matches the subject, title or summary, or
 * the start of a body whose full text may be shown, as the API documents it ("title / Chinese
 * title / Chinese summary / body"). Results stay in time order.
 */
export function publicMatchCondition(terms: string[]) {
  if (terms.length === 0) return sql``;
  // Keep the body lookup correlated to the time-ordered candidates. Without OFFSET 0, PostgreSQL
  // may hash every matching body in pool_search before serving even the first 40 recent items.
  return terms.reduce(
    (acc, t) => sql`${acc} AND (p.search_text LIKE ${"%" + t + "%"} OR EXISTS (
      SELECT 1 FROM pool_search ps WHERE ps.article_id = p.article_id AND ps.body LIKE ${"%" + t + "%"} OFFSET 0))`,
    sql``,
  );
}

/** Unfiltered-by-search totals only set the page count; they are reused for 30 seconds per filter. */
const countCache = new Map<string, { at: number; n: number }>();
const countPending = new Map<string, Promise<number>>();
async function poolCount(key: string | null, query: () => Promise<Array<{ n: number }>>): Promise<number> {
  if (key === null) return Number(one(await query()).n);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.n;
  const pending = countPending.get(key);
  if (pending) return pending;
  const load = (async () => {
    const n = Number(one(await query()).n);
    if (countCache.size >= 200) countCache.delete(countCache.keys().next().value!);
    countCache.set(key, { at: Date.now(), n });
    return n;
  })();
  countPending.set(key, load);
  try { return await load; } finally { countPending.delete(key); }
}

export interface PoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
  topicTags?: string[] | null;
  now?: Date;
}

export async function loadPool(query: PoolQuery): Promise<PoolResponse> {
  const now = query.now ?? new Date();
  const page = Math.min(Math.max(query.page ?? 1, 1), POOL_MAX_PAGES);
  const q = query.q?.trim() || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  const terms = q ? searchTerms(q) : [];
  const filters = sql`${channelCondition(query.channel)} ${categoryCondition(query.category)} ${tagCondition(query.tag)} ${topicCondition(query.topicTags)}`;
  const offset = (page - 1) * POOL_PAGE_SIZE;
  const cap = POOL_MAX_PAGES * POOL_PAGE_SIZE;
  // A fixed clock (tests, replays) never shares cached totals.
  const filterKey = query.now ? null : JSON.stringify([query.channel, query.category, query.tag, query.topicTags ?? null]);

  // Searches go through pool_search (eligible items only): trigram indexes for longer terms, a small
  // table to scan for one- and two-character ones.
  const like = (col: ReturnType<typeof sql>, t: string) => sql`${col} LIKE ${"%" + t + "%"}`;
  const run = async (db: Db) => {
    if (!q) {
      // Page ids from the timeline index first, then the joins for those rows only.
      const rows = await db<ItemRow[]>`
        WITH page AS (
          SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters}
          ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
        SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
        ORDER BY p.timeline_at DESC, p.article_id DESC`;
      return { rows, total: await poolCount(filterKey, () => db<{ n: number }[]>`
        SELECT count(*) AS n FROM (SELECT 1 FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters} LIMIT ${cap}) t`) };
    }
    if (tab === "relevance") {
      // Rank narrow rows first: no article bodies or translations enter the sort/count. The public
      // total stops at 2,000, even though ranking must consider every matching item.
      // For an unfiltered trigram search, match each indexed field separately. OR across fields
      // can make PostgreSQL scan every toasted body instead. Keep other searches inline so short
      // terms, additional terms and selective publication filters retain their existing plans.
      const splitFields = terms.length === 1 && /[\p{L}\p{N}]{3}/u.test(terms[0]!)
        && (!query.channel || query.channel === "all") && !query.category && !query.tag && !query.topicTags?.length;
      const partScore = terms.reduce(
        (acc, t) => sql`${acc} + (CASE WHEN ${like(sql`ps.direct`, t)} THEN 3 ELSE 0 END) + (CASE WHEN ${like(sql`ps.body`, t)} THEN 1 ELSE 0 END)`,
        sql`0`,
      );
      const titleScore = terms.reduce((acc, t) => sql`${acc} + (CASE WHEN ${like(sql`lower(p.title)`, t)} THEN 6 ELSE 0 END)`, sql`0`);
      const anyMatch = terms.reduce((acc, t) => sql`${acc} AND (${like(sql`ps.direct`, t)} OR ${like(sql`ps.body`, t)})`, sql`TRUE`);
      const matches = splitFields ? sql`
        SELECT coalesce(d.article_id, b.article_id) AS article_id,
          (CASE WHEN d.article_id IS NOT NULL THEN 3 ELSE 0 END) + (CASE WHEN b.article_id IS NOT NULL THEN 1 ELSE 0 END) AS part
        FROM (SELECT article_id FROM pool_search WHERE direct LIKE ${"%" + terms[0]! + "%"}) d
        FULL JOIN (SELECT article_id FROM pool_search WHERE body LIKE ${"%" + terms[0]! + "%"}) b ON b.article_id = d.article_id`
        : sql`SELECT ps.article_id, (${partScore}) AS part FROM pool_search ps WHERE ${anyMatch}`;
      type RankedRow = Omit<ItemRow, "id"> & { id: string | null; rel: number; total: number };
      const result = await db<RankedRow[]>`
        WITH matches AS ${splitFields ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (${matches}), scored AS MATERIALIZED (
          SELECT p.article_id, p.timeline_at, matches.part + (${titleScore}) AS rel
          FROM matches JOIN publications p ON p.article_id = matches.article_id JOIN sources s ON s.id = p.source_id
          WHERE ${listedCondition(now)} AND p.eligible ${filters}
        ), page AS MATERIALIZED (
          SELECT article_id, rel FROM scored ORDER BY rel DESC, timeline_at DESC, article_id DESC
          LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset}
        ), total AS (SELECT count(*) AS n FROM (SELECT 1 FROM scored LIMIT ${cap}) capped)
        SELECT hydrated.*, total.n AS total FROM total LEFT JOIN LATERAL (
          SELECT ${ITEM_COLUMNS}, page.rel ${ITEM_FROM} JOIN page ON page.article_id = p.article_id
        ) hydrated ON true ORDER BY hydrated.rel DESC, hydrated.timeline_at DESC, hydrated.id DESC`;
      const rows = result.filter((r): r is ItemRow & { rel: number; total: number } => r.id !== null);
      return { rows, total: Number(result[0]!.total) };
    }
    // Default search: newest first straight from the timeline index; the total from the pool's
    // search rows, where one- and two-character terms scan a small table instead of every item.
    const rows = await db<ItemRow[]>`
      WITH page AS (
        SELECT p.article_id FROM publications p WHERE ${listedCondition(now)} AND p.eligible ${filters} ${directMatchCondition(terms)}
        ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
      SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
      ORDER BY p.timeline_at DESC, p.article_id DESC`;
    const direct = terms.reduce((acc, t) => sql`${acc} AND ${like(sql`ps.direct`, t)}`, sql``);
    const { n } = one(await db<{ n: number }[]>`
      SELECT count(*) AS n FROM (SELECT 1 FROM pool_search ps JOIN publications p ON p.article_id = ps.article_id
        WHERE ${listedCondition(now)} AND p.eligible ${filters} ${direct} LIMIT ${cap}) t`);
    return { rows, total: Number(n) };
  };

  const { rows, total } = q ? await withSearchCapacity(run) : await run(sql);
  const today = beijingDate(now);
  // 表头上那句「今日 N 条」必须与它下面真的分组同一套成员条件（`DayList.tsx` 按 `timelineAt` 分日、
  // 把没有发布时间的行挪去「无发布日期」那一组）：
  //  - 原来筛的是 `NOT p.backfill`，而按发现时间补录的条目确实会出现在「今天」这一组里 —— 数字比看到的小；
  //  - 原来用 `timeline_at >= midnight` 但没有排除 `published_at IS NULL`，而那些行根本不在日组里 —— 数字比看到的大。
  // 两个方向各差一点，所以本机今天看不出来（96 条 listed backfill 没有一条落在今天）。
  // 「更新于」与「今日 N 条」「找到 N 条」是同一屏上的三句话，问的必须是同一批条目：以前它是全池的
  // `max(updated_at)`，于是任何一条 eligible 更新都会打掉所有筛选页与搜索页的 ETag，而页面上的日期
  // 说的是这一筛选之外发生的事。
  const meta = one(await sql<{ today_count: number; updated_at: Date | null }[]>`
    SELECT (SELECT count(*) FROM publications p
      WHERE ${listedCondition(now)} AND p.eligible AND p.published_at IS NOT NULL AND p.timeline_at >= ${beijingMidnight(today)} ${filters}) AS today_count,
      (SELECT max(p.updated_at) FROM publications p
        WHERE ${listedCondition(now)} AND p.eligible ${filters}) AS updated_at`);

  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, topic: query.topic ?? null, q, tab },
    items: rows.map(toFeedItemSummary),
    page,
    pageCount: Math.min(POOL_MAX_PAGES, Math.max(1, Math.ceil(total / POOL_PAGE_SIZE))),
    total,
    todayCount: Number(meta.today_count),
    freshness: (meta.updated_at ?? now).toISOString(),
    generatedAt: now.toISOString(),
  };
}
