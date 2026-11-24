// Public pool (/all) with numeric pages, and search in its two orderings.
import type { PoolResponse, SiteLang, TimelineFilters } from "@aihot/contracts/site";
import { addDays, beijingDate, beijingMidnight, isDay } from "@aihot/contracts/time";
import { positiveInt } from "../config.ts";
import { one, sql, withCustomPlans, type Db } from "../db.ts";
import { withPublicRead } from "./read-budget.ts";
import {
  categoryCondition, channelCondition, ITEM_COLUMNS, ITEM_FROM, ITEM_JOINS, listedCondition, tagCondition, toFeedItemSummary, topicCondition,
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
export function directMatchCondition(terms: string[], lang: SiteLang = "zh") {
  if (terms.length === 0) return sql``;
  // 英文搜索走自己的列：`pool_search` 由 publish.ts 用中文 searchText 写入，英文走它永远匹配中文。
  if (lang === "en") return directMatchConditionEn(terms);
  return terms.reduce((acc, t) => sql`${acc} AND p.search_text LIKE ${"%" + t + "%"}`, sql``);
}

/** 英文列表搜索：每个词都出现在 `publications.search_text_en`（迁移 0129 的 trigram 索引）。 */
export function directMatchConditionEn(terms: string[]) {
  if (terms.length === 0) return sql``;
  return terms.reduce((acc, t) => sql`${acc} AND p.search_text_en LIKE ${"%" + t + "%"}`, sql``);
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

/**
 * 聚合缓存，给「只影响屏上说明文字」的查询用（页数、今日条数、更新于）。`key === null` 时不缓存
 * —— 固定时钟（测试、回放）必须每次真查，否则同一进程里两次调用会拿到同一份结果。
 *
 * 2026-11-09 生产事故后改的三处：
 *  1. 有效期 30 秒 → 10 分钟。这两句是 `count(*) FROM publications … EXISTS (readiness)`，
 *     主库磁盘打满时单次要 3–5 分钟；30 秒的缓存等于每 30 秒再点一把火，几分钟内堆到 18 条
 *     同时在跑，磁盘再也回不来（`io some avg10` 连续 40 分钟 98 以上）。
 *  2. 全局同时最多两条聚合查询（`slowQueryActive`），超出的直接走陈旧值 —— 页面宁可写五分钟前的
 *     「今日 12 条」，也不能再加一条三分钟的扫表。
 *  3. 每条聚合带 15 秒 `statement_timeout`。超时不再抛给读者，而是退回上一次的结果（最长 24 小时），
 *     读者永远看得到页面，只是数字旧。
 */
const META_TTL_MS = 10 * 60_000;
const COUNT_TTL_MS = 10 * 60_000;
const STALE_FALLBACK_MS = 24 * 3600_000;
const AGGREGATE_TIMEOUT_MS = 15_000;
const AGGREGATE_CONCURRENCY = 2;

let aggregateActive = 0;

/** 受预算约束的聚合查询：限并发 + 语句超时。`build` 拿到的是一条新连接（`sql.begin` 的 tx）。 */
async function budgetedAggregate<T>(build: (client: typeof sql) => Promise<T>): Promise<T> {
  if (aggregateActive >= AGGREGATE_CONCURRENCY) throw new Error("aggregate budget busy");
  aggregateActive += 1;
  try {
    return await sql.begin(async (tx) => {
      // `SET` 不吃绑定参数（`SET LOCAL x = $1` 直接语法错误，2026-11-09 CI 上把 `/all` 打成 503），
      // 值是我们自己的常量，用 unsafe 拼进去才是对的写法。
      await tx.unsafe(`SET LOCAL statement_timeout = ${AGGREGATE_TIMEOUT_MS}`);
      // 计数与「今日 N 条」带着中文文案 regex 的绑定参数：generic plan 同样证明不了 0132 的部分
      // 索引谓词，会退回 0113 的 bitmap 扫（2026-11-24 生产实测 1.1 s / 2.2 s）。custom plan 下
      // 谓词可证明，两条聚合改走 covering 索引（EXPLAIN ANALYZE 实测 11.4 ms / 59.1 ms）。
      await tx.unsafe(`SET LOCAL plan_cache_mode = force_custom_plan`);
      return build(tx as unknown as typeof sql);
    }) as T;
  } finally {
    aggregateActive -= 1;
  }
}

const metaCache = new Map<string, { at: number; value: unknown }>();
const metaPending = new Map<string, Promise<unknown>>();
async function cachedMeta<T>(key: string | null, build: (client: typeof sql) => Promise<T[]>): Promise<T[]> {
  if (key === null) return build(sql);
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value as T[];
  const pending = metaPending.get(key);
  if (pending) return pending as Promise<T[]>;
  const load = (async () => {
    try {
      const rows = await budgetedAggregate(build);
      if (metaCache.size >= 200) metaCache.delete(metaCache.keys().next().value!);
      metaCache.set(key, { at: Date.now(), value: rows });
      return rows;
    } catch (error) {
      // 超时、并发超预算、库暂时不可用时，把上一次的数字再交出去一次。
      if (hit && Date.now() - hit.at < STALE_FALLBACK_MS) return hit.value as T[];
      throw error;
    }
  })();
  metaPending.set(key, load);
  try { return await load; } finally { metaPending.delete(key); }
}

/** 分页总数只影响「第几页 / 共几页」；十分钟内复用，超时退回上一次的值。 */
const countCache = new Map<string, { at: number; n: number }>();
const countPending = new Map<string, Promise<number>>();
async function poolCount(
  key: string | null,
  build: (client: typeof sql) => Promise<Array<{ n: number }>>,
): Promise<number> {
  if (key === null) return Number(one(await build(sql)).n);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.n;
  const pending = countPending.get(key);
  if (pending) return pending;
  const load = (async () => {
    try {
      const n = Number(one(await budgetedAggregate(build)).n);
      if (countCache.size >= 200) countCache.delete(countCache.keys().next().value!);
      countCache.set(key, { at: Date.now(), n });
      return n;
    } catch (error) {
      if (hit && Date.now() - hit.at < STALE_FALLBACK_MS) return hit.n;
      // 连一次都没成功过：宁可把「共几条」当成 0（页面仍然画得出来），也不把 503 交给读者。
      // 下一次请求会重新尝试；成功一次之后就靠上面那条陈旧值兜底了。
      return 0;
    }
  })();
  countPending.set(key, load);
  try { return await load; } finally { countPending.delete(key); }
}

export interface PoolQuery extends TimelineFilters {
  q?: string | null;
  tab?: "time" | "relevance";
  page?: number;
  /** 只看这一天（`YYYY-MM-DD`，北京日历）。非法值按"没有这个筛选"处理，路由层负责回 404。 */
  date?: string | null;
  topicTags?: string[] | null;
  now?: Date;
}

export async function loadPool(query: PoolQuery, signal?: AbortSignal): Promise<PoolResponse> {
  const now = query.now ?? new Date();
  const lang: SiteLang = query.lang === "en" ? "en" : "zh";
  const page = Math.min(Math.max(query.page ?? 1, 1), POOL_MAX_PAGES);
  const q = query.q?.trim() || null;
  const tab = q && query.tab === "relevance" ? "relevance" : "time";
  const terms = q ? searchTerms(q) : [];
  // 日历选出来的那一天。按 `timeline_at`（读者看到它的时刻）圈整天，与 `DayList` 分日、
  // 与 `monthMarks` 数日子用的是同一个口径——三处不一致的话，日历上有个点、点进去却是空的。
  // `published_at IS NOT NULL` 与那两处对齐：DayList 把没有发布时间的行挪去「无发布日期」，
  // 日历的日子也不数它们（calendar.ts 的 days CTE 同谓词），日期页若只按 timeline 圈就会比日历多。
  const date = isDay(query.date) ? query.date : null;
  const dayCondition = date
    ? sql`AND p.published_at IS NOT NULL AND p.timeline_at >= ${beijingMidnight(date)} AND p.timeline_at < ${beijingMidnight(addDays(date, 1))}`
    : sql``;
  // `scoped` 是"这一屏的其它筛选"，`filters` 再加上选中的那一天。两者必须分开：
  // 「今日 N 条」问的是今天，把某一天的窗口 AND 进去会让两个窗口互斥、任何历史日期页都印出「今日 0 条」
  // （2026-10-11 上线当天 390 截图实测：看 10 月 2 日那页，页头写着今日 0 条）。
  const scoped = sql`${channelCondition(query.channel)} ${categoryCondition(query.category)} ${tagCondition(query.tag)} ${topicCondition(query.topicTags)}`;
  const filters = sql`${scoped} ${dayCondition}`;
  const offset = (page - 1) * POOL_PAGE_SIZE;
  const cap = POOL_MAX_PAGES * POOL_PAGE_SIZE;
  // Totals are bucketed per minute instead of keyed on the exact clock: server-rendered pages always
  // pass a `now`, so keying on it verbatim meant every reader recomputed the same count (measured
  // 1.7-2.6 s per /api/site/pool call on 2026-11-07). Tests and replays that pin a clock still never
  // share a bucket with production traffic, and a one-minute stale total is a number no reader can see.
  // 2026-11-07 二次实测：冷的一次要 7.05 s，第二次 2.73 s，一分钟桶让缓存每分钟失效一次——
  // 读者量不大时，等于每分钟第一个访客仍要吃整笔成本。改成五分钟桶，代价只是「今日总数最久
  // 迟到五分钟」，换掉每分钟一次的整表计数。
  const clockBucket = query.now ? Math.floor(query.now.getTime() / 300_000) : "live";
  const filterKey = JSON.stringify([query.channel, query.category, query.tag, query.topicTags ?? null, date, clockBucket, lang]);

  // Searches go through pool_search (eligible items only): trigram indexes for longer terms, a small
  // table to scan for one- and two-character ones.
  const like = (col: ReturnType<typeof sql>, t: string) => sql`${col} LIKE ${"%" + t + "%"}`;
  const run = async (db: Db) => {
    if (!q) {
      // Page ids from the timeline index first, then the joins for those rows only.
      // 2026-11-24：外层原来是 `WHERE p.article_id IN (SELECT article_id FROM page)`。半连接不能
      // 交换内外侧，规划器把 133k 行的 publications（再连 articles/translations/stories）放在外侧做
      // 哈希半连接，最后只取 40 个 id —— 生产 EXPLAIN 实测这一半 8.6–11 秒、24 MB 临时文件，
      // 而页面本身（page CTE）只要 2.4 秒。改成 `FROM page pg JOIN publications p` 让 40 行先当
      // 外侧，外侧只剩 40 次主键连接；分页结果与排序键都不变（与 topics.ts 的 loadTopicPage 同形）。
      const rows = await db<ItemRow[]>`
        WITH page AS (
          SELECT p.article_id FROM publications p WHERE ${listedCondition(now, lang, true)} AND p.eligible ${filters}
          ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
        SELECT ${ITEM_COLUMNS} FROM page pg JOIN publications p ON p.article_id = pg.article_id ${ITEM_JOINS}
        ORDER BY p.timeline_at DESC, p.article_id DESC`;
      return { rows, total: await poolCount(filterKey, (client) => client<{ n: number }[]>`
        SELECT count(*) AS n FROM (SELECT 1 FROM publications p WHERE ${listedCondition(now, lang)} AND p.eligible ${filters} LIMIT ${cap}) t`) };
    }
    if (tab === "relevance") {
      // Rank narrow rows first: no article bodies or translations enter the sort/count. The public
      // total stops at 2,000, even though ranking must consider every matching item.
      // For an unfiltered trigram search, match each indexed field separately. OR across fields
      // can make PostgreSQL scan every toasted body instead. Keep other searches inline so short
      // terms, additional terms and selective publication filters retain their existing plans.
      if (lang === "en") {
        // 英文相关度：只读 `search_text_en` 与 `title_en`，不碰 `pool_search`（那里只有中文）。
        const partScoreEn = terms.reduce(
          (acc, t) => sql`${acc} + (CASE WHEN ${like(sql`p.search_text_en`, t)} THEN 3 ELSE 0 END)`,
          sql`0`,
        );
        const titleScoreEn = terms.reduce((acc, t) => sql`${acc} + (CASE WHEN ${like(sql`lower(p.title_en)`, t)} THEN 6 ELSE 0 END)`, sql`0`);
        const anyMatchEn = terms.reduce((acc, t) => sql`${acc} AND ${like(sql`p.search_text_en`, t)}`, sql`TRUE`);
        type RankedRow = Omit<ItemRow, "id"> & { id: string | null; rel: number; total: number };
        const result = await db<RankedRow[]>`
          WITH scored AS MATERIALIZED (
            SELECT p.article_id, p.timeline_at, (${partScoreEn}) + (${titleScoreEn}) AS rel
            FROM publications p JOIN sources s ON s.id = p.source_id
            WHERE ${listedCondition(now, "en")} AND p.eligible ${filters} AND ${anyMatchEn}
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
          WHERE ${listedCondition(now, lang)} AND p.eligible ${filters}
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
        SELECT p.article_id FROM publications p WHERE ${listedCondition(now, lang)} AND p.eligible ${filters} ${directMatchCondition(terms, lang)}
        ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${POOL_PAGE_SIZE} OFFSET ${offset})
      SELECT ${ITEM_COLUMNS} FROM page pg JOIN publications p ON p.article_id = pg.article_id ${ITEM_JOINS}
      ORDER BY p.timeline_at DESC, p.article_id DESC`;
    if (lang === "en") {
      // 英文默认搜索的「找到 N 条」直接数英文列，不再 join `pool_search`。
      const { n } = one(await db<{ n: number }[]>`
        SELECT count(*) AS n FROM (SELECT 1 FROM publications p
          WHERE ${listedCondition(now, "en")} AND p.eligible ${filters} ${directMatchConditionEn(terms)} LIMIT ${cap}) t`);
      return { rows, total: Number(n) };
    }
    const direct = terms.reduce((acc, t) => sql`${acc} AND ${like(sql`ps.direct`, t)}`, sql``);
    const { n } = one(await db<{ n: number }[]>`
      SELECT count(*) AS n FROM (SELECT 1 FROM pool_search ps JOIN publications p ON p.article_id = ps.article_id
        WHERE ${listedCondition(now)} AND p.eligible ${filters} ${direct} LIMIT ${cap}) t`);
    return { rows, total: Number(n) };
  };

  // 2026-11-16：非搜索的首屏取数原来直接跑在裸连接上（无事务、无 statement_timeout、无并发闸）。
  // 路由层的 20 秒 Promise.race 只是不再 await，底层查询仍在 PG 后端上跑到结束，连接不归还——
  // 主库一慢，10 个连接全被这种"已放弃"的查询占住，/api/health 与其它读全部排队等死（现场
  // load 32+、io.full 95%）。现在把它收进 withPublicRead：服务端 12 秒 statement_timeout 到点
  // 主动取消并回滚事务，连接必归还；4 槽 + 8 队列给并发一个有界上限，超出的走 PublicReadBusyError
  // 由路由交回底稿/陈旧值。搜索路径本来就有 withSearchCapacity，保持不变。
  //
  // 2026-11-24：最后一个参数 false → true（custom plan）。列表页的成员门里带着中文文案正则
  // （`chineseCopyCondition`），它们在 SQL 里是绑定参数；预编译的 generic plan 无法证明
  // `title ~ $n` 蕴含部分索引谓词里的 `title ~ '[一-鿿]'`，于是规划器看不见 0132 的
  // `publications_listed_page_idx`，退回 0113 的 bitmap + 1.2 万页堆读（生产实测 2.4 秒）。
  // 改用实际值生成的 custom plan（与时间线的 groupedSnapshot 同一做法），谓词可证明后
  // 走 covering 索引的 index-only scan（实测 38 ms；page CTE 再带上 `listedCondition(…, true)`
  // 的逐行探针后 1.85 ms）。
  const { rows, total } = q
    ? await withSearchCapacity(run)
    : await withPublicRead((db) => run(db), 12_000, true, signal);
  const today = beijingDate(now);
  // 表头上那句「今日 N 条」必须与它下面真的分组同一套成员条件（`DayList.tsx` 按 `timelineAt` 分日、
  // 把没有发布时间的行挪去「无发布日期」那一组）：
  //  - 原来筛的是 `NOT p.backfill`，而按发现时间补录的条目确实会出现在「今天」这一组里 —— 数字比看到的小；
  //  - 原来用 `timeline_at >= midnight` 但没有排除 `published_at IS NULL`，而那些行根本不在日组里 —— 数字比看到的大。
  // 两个方向各差一点，所以本机今天看不出来（96 条 listed backfill 没有一条落在今天）。
  // 「更新于」与「今日 N 条」「找到 N 条」是同一屏上的三句话，问的必须是同一批条目：以前它是全池的
  // `max(updated_at)`，于是任何一条 eligible 更新都会打掉所有筛选页与搜索页的 ETag，而页面上的日期
  // 说的是这一筛选之外发生的事。
  // 这两句是全站最贵的查询：`listedCondition` 里带 `EXISTS (article_workflow_readiness)`，没有索引能替它裁剪，
  // 于是每次取样都要把 `publications` 里 6.5 万条 eligible 行逐条去 readiness 里探一次（2026-11-06 生产实测
  // 单次 4.8–52 秒，`pg_stat_activity` 里常年挂着两三条）。首屏每渲染一次就跑一遍是不可接受的，而它们只是
  // 屏上的两句说明文字（「今日 N 条」「更新于」），30 秒的陈旧完全看不出来 —— 与下面的 `poolCount` 同一把尺子。
  const loadMeta = (client: typeof sql) => client<{ today_count: number; updated_at: Date | null }[]>`
    SELECT (SELECT count(*) FROM publications p
      WHERE ${listedCondition(now, lang)} AND p.eligible AND p.published_at IS NOT NULL AND p.timeline_at >= ${beijingMidnight(today)} ${scoped}) AS today_count,
      (SELECT max(p.updated_at) FROM publications p
        WHERE ${listedCondition(now, lang)} AND p.eligible ${filters}) AS updated_at`;
  // 「今日 N 条」「更新于」两句话失败不该让整页 503：拿不到就写 0 条与当前时刻。
  const meta = await cachedMeta(filterKey === null ? null : `${filterKey}|${today}`, loadMeta)
    .then((rows) => one(rows))
    .catch(() => ({ today_count: 0, updated_at: null as Date | null }));

  return {
    filters: { channel: query.channel, category: query.category, tag: query.tag, topic: query.topic ?? null, q, tab },
    items: rows.map((row) => toFeedItemSummary(row, lang)),
    page,
    pageCount: Math.min(POOL_MAX_PAGES, Math.max(1, Math.ceil(total / POOL_PAGE_SIZE))),
    total,
    todayCount: Number(meta.today_count),
    freshness: (meta.updated_at ?? now).toISOString(),
    generatedAt: now.toISOString(),
    lang,
  };
}
