// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { identityKeyFor, upsertMaterial } from "../content/materials.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { fetchXSearch, planXShards, readXSearch, shardHandle, shardQuery, SHARDABLE_SQL, tweetToCandidate, type XBacklog, type XRead } from "./x.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  /** Candidates a listing offered that this round did not read (see takeListingRun). */
  dropped?: number;
  error?: string;
}

/** The newest items one round reads, and the tail it reads on from below them. */
const MAX_ITEMS_PER_RUN = 60;
const MAX_TAIL_ITEMS_PER_RUN = 60;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A noise marker as it must be matched. An ASCII marker has to stand as a word: NASA's "mars" would
 * otherwise drop a Marseille story, "galaxy" a product called GalaxyDock, gsc-europa's "NAGU" any longer
 * Latin word that happens to contain it. A plural is still the same marker ("exoplanet" keeps matching
 * "exoplanets"), and anything not a Latin letter is a word boundary, so a marker glued to Chinese
 * ("全新iPhone手机") still fires — Chinese has no spaces to break on. A marker with a non-ASCII character
 * in it keeps plain substring matching for the same reason.
 */
function markerPattern(marker: string): RegExp {
  const k = marker.trim().toLowerCase();
  const body = escapeRe(k);
  return /^[\x20-\x7e]+$/.test(k) ? new RegExp(`(^|[^a-z])${body}s?([^a-z]|$)`, "i") : new RegExp(body, "i");
}

const markers = new Map<string, RegExp>();

/** Whether one of the markers appears in this text, each compiled once per process. */
function hasMarker(text: string, words: string[] | undefined): boolean {
  return (words ?? []).some((k) => {
    let re = markers.get(k);
    if (!re) {
      re = markerPattern(k);
      markers.set(k, re);
    }
    return re.test(text);
  });
}

/**
 * How long one round may run. The queue expires a fetchSource job after 600 s and a shard after 900 s;
 * pg-boss then releases the singleton key while this handler is still writing, so the +10-minute
 * placeholder in scheduleDueSources starts a SECOND concurrent run of the same source, and the first one
 * keeps storing. A round that stops inside its own budget finalises its run and its cursor, so the
 * budget is what keeps one run per source. It is read per call so a deployment can change it without a
 * restart, and the env value is a cap: whichever comes first, budget or work, ends the round.
 */
function roundBudgetMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Past the round's wall-clock budget, or the process is shutting down: stop taking more work. */
function makeStopwatch(defaultMs: number, envName: string): { stop: () => boolean; budgetMs: number; deadlineAt: number } {
  const started = Date.now();
  const budgetMs = roundBudgetMs(envName, defaultMs);
  return { budgetMs, deadlineAt: started + budgetMs, stop: () => Date.now() - started > budgetMs || shutdownSignal.signal.aborted };
}

export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-folded word matching, see markerPattern: the lists are written as words ("agent" keeps "Agent").
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  // A whitelist for feeds whose signal is a minority of their volume (研招网的政策栏目 covers all of
  // education; only the exam-and-discipline documents belong to the 考研 board). It is a *precondition*,
  // not an exemption: a title it does not name is filtered out, and one it does name still has to survive
  // the drop lists below (an MBA ad that mentions 专业目录 is dropped — see tests/sources.test.ts).
  if (f.requireTitleMarkers?.length && !hasMarker(title, f.requireTitleMarkers)) return true;
  if (hasMarker(hay, f.keepIfMatches)) return false;
  return hasMarker(title, f.dropMarkersTitleOnly) || hasMarker(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

/** Titles of the articles already stored under these URLs. */
async function storedTitles(urls: string[]): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const rows = await sql<{ url: string; title: string }[]>`SELECT url, title FROM articles WHERE url IN ${sql(urls)}`;
  return new Map(rows.map((r) => [r.url, r.title]));
}

const DAY_MS = 86_400_000;
/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) => title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

/**
 * Stores a round's candidates in the order the listing gave them. `stop` ends the round early (its
 * budget is over, or the process is shutting down): how many were handled is what decides which read
 * position the source may remember, so an item never counts as read before it is stored.
 */
async function store(
  sourceId: string,
  candidates: Candidate[],
  backfill: string | null,
  stop?: () => boolean,
): Promise<{ created: number; revised: number; handled: number; stopped: boolean }> {
  let created = 0;
  let revised = 0;
  let handled = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    if (stop?.()) return { created, revised, handled, stopped: true };
    handled += 1;
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    // A listing that names one article twice (a featured card and its list entry, a feed repeating an
    // item) stores its first entry only; the later ones would otherwise revise it on every fetch.
    const key = identityKeyFor(material);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await upsertMaterial(material);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised) await queueProcessing(res.articleId);
  }
  return { created, revised, handled, stopped: false };
}

/** The identity a listing's read position is remembered by (the same key the material is stored under). */
const listingKey = (c: Candidate): string => c.identityKey ?? identityKeyForUrl(c.url) ?? c.url;

export interface ListingRun {
  /** What this round reads: the newest items, then the tail of an earlier round if there is one left. */
  read: Candidate[];
  /** The oldest item read below the head: where the next round goes on. Null once the listing is covered. */
  resumeAfter: string | null;
  /** Items the listing offered that this round did not read (kept for the next rounds). */
  unread: number;
}

/**
 * What one round reads of a listing, and where the next round goes on.
 *
 * An RSS feed or a JSON API gives no watermark, so cutting every round to the first 60 items in listing
 * order read the same newest 60 forever. Verified against the live USGS feed: its 4.5_week.geojson
 * answers 135 M4.5+ earthquakes whose 60th is three and a half days old, so the 75 below it — half of a
 * week of world seismicity — were unreachable for good, because the next round's first 60 are all newer.
 * The position below the head is therefore kept in the source cursor and read on from, oldestwards, the
 * way an X search keeps the stretch it did not finish, until the listing is covered.
 */
export function takeListingRun(
  candidates: Candidate[],
  resumeAfter: string | null | undefined,
  head = MAX_ITEMS_PER_RUN,
  tail = MAX_TAIL_ITEMS_PER_RUN,
): ListingRun {
  const items = candidates.slice(0, head);
  if (candidates.length <= head) return { read: items, resumeAfter: null, unread: 0 };
  const anchor = resumeAfter ? candidates.findIndex((c) => listingKey(c) === resumeAfter) : -1;
  const start = anchor >= 0 ? anchor + 1 : head;
  const rest = candidates.slice(start, start + tail);
  const read = [...items, ...rest];
  return {
    read,
    resumeAfter: rest.length ? listingKey(rest[rest.length - 1]!) : null,
    unread: Math.max(0, candidates.length - Math.max(head, start + rest.length)),
  };
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  const outOfRound = makeStopwatch(420_000, "COLLECT_ROUND_BUDGET_MS");
  let created = 0;
  let revised = 0;
  let found = 0;
  let filtered = 0;
  let dropped = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: Candidate[];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    let listing: ListingRun | null = null;
    if (source.kind === "rss") {
      const rss = await fetchRss(source, opts);
      candidates = rss.candidates;
      // The first import has a smaller backfill cap than later runs: allow the next run to read
      // the ordinary window before accepting 304s. Persist validators only after store succeeds.
      if (!firstImport) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else if (source.kind === "json_list") candidates = await fetchJsonList(source);
    else {
      const x = await fetchXSearch(source, { stop: () => outOfRound.stop() });
      candidates = x.candidates;
      if (x.lastId) nextCursor.lastTweetId = x.lastId;
      // A search longer than one run keeps its position for the next runs (shown in the admin).
      if (x.backlog.length) nextCursor.xBacklog = x.backlog;
      else delete nextCursor.xBacklog;
      detail = { pages: x.pages, truncated: x.truncated, backlog: x.backlog.length, backlogPages: x.backlogPages, dropped: x.dropped };
    }
    // `found` is what the listing offered before any rule of ours was applied; the operator reads the
    // three numbers against each other to see a fetch that returned nothing because of a filter.
    found = candidates.length;
    candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
    filtered = candidates.length;
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      const kept = candidates.filter((c) => !c.publishedAt || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
      dropped = candidates.length - kept.length;
      candidates = kept;
      delete nextCursor.listingTailAfter;
    } else if (source.kind !== "x_search") {
      // A listing longer than the round keeps its unread tail in the cursor instead of losing it.
      listing = takeListingRun(candidates, typeof source.cursor?.listingTailAfter === "string" ? source.cursor.listingTailAfter : null);
      dropped = listing.unread;
      candidates = listing.read;
    }
    // X keeps every post it read: its watermark already covers them, so a cut there would lose them.

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const known = await storedTitles(candidates.map((c) => c.url));
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    let detailMissed = 0;
    // Applied to every candidate before the paid loop: a round that stops for its budget must not leave
    // the rest of them carrying a listing date this source says is unreliable.
    if (d?.publishedAtAuthoritative === true) for (const c of candidates) c.publishedAt = null;
    for (const c of candidates) {
      const stored = known.get(c.url);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored;
        continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      // A detail page costs 20-60 s (and, for a Jina rule, a paid render). Past the round's budget the
      // listing's own values are used and the queue's own extraction step still gets the page later.
      if (outOfRound.stop()) {
        detailMissed += 1;
        continue;
      }
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && !c.excerpt,
        body: source.participation_mode === "editorial" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      detailUsed += 1;
      try {
        const got = await fetchDetail(c.url, source, need);
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch {
        // detail is best effort
      }
    }

    const storedRun = await store(sourceId, candidates, firstImport ? "first-import" : null, () => outOfRound.stop());
    ({ created, revised } = storedRun);
    if (listing) {
      // The remembered tail position moves only over items this round actually stored: a round that ran
      // out of time must read them again, not lose them.
      if (storedRun.handled >= listing.read.length) {
        if (listing.resumeAfter) nextCursor.listingTailAfter = listing.resumeAfter;
        else delete nextCursor.listingTailAfter;
      } else if (storedRun.handled > 0) nextCursor.listingTailAfter = listingKey(listing.read[storedRun.handled - 1]!);
      dropped += Math.max(0, listing.read.length - storedRun.handled);
    }
    // What the operator sees against `found`: what the filters took out, what was stored, what the round
    // could not read. Without these a listing cut at 60 items looked like a healthy fetch. Only for a round
    // that read something: a 304 is the common case, and five zeros in every such row is noise in the runs view.
    if (found > 0) detail = { ...(detail ?? {}), found, filtered, stored: created + revised, dropped, detailFetched: detailUsed, ...(detailMissed ? { detailMissed } : {}) };

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${sql.json(nextCursor as never)}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => interval_minutes)
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                detail = ${sql.json(detail as never)} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok", found, created, revised, dropped };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** X ids begin with their millisecond timestamp (since 2010-11-04): the smallest id of a post made at `ms`. */
const xIdAt = (ms: number) => (BigInt(Math.max(0, ms - 1288834974657)) << 22n);

/**
 * Where an account's posts are known to be read up to. A quiet account's newest post can be months
 * old, but its last successful check read everything up to then; bounding a shard's search by the
 * post alone would re-read months of the other accounts' posts. Ten minutes before the check allows
 * for posts that reach the search late.
 */
function coveredTo(m: SourceRow): bigint {
  const raw = String(m.cursor?.lastTweetId ?? "");
  let own: bigint;
  try {
    own = BigInt(raw);
  } catch {
    throw new FetchError(`${m.id}: cursor.lastTweetId is not a tweet id (${raw.slice(0, 40)})`);
  }
  const checked = Date.parse(String(m.cursor?.lastOkAt ?? ""));
  if (!Number.isFinite(checked)) return own;
  const byTime = xIdAt(checked - 10 * 60_000);
  return byTime > own ? byTime : own;
}

/** Minutes between reads of a shard: editorial accounts every half hour, hot-signal accounts hourly. */
const X_SHARD_MINUTES: Record<string, number> = { editorial: 30, hot_signal: 60 };
const shardMinutes = (mode: string) => X_SHARD_MINUTES[mode] ?? 60;

/**
 * One search for a shard of X accounts (planXShards). Each post goes to the source whose handle wrote
 * it, and every account keeps its own fetch run, health and cursor. The oldest watermark bounds the
 * search, so no account misses a post (the others only see posts they already have again); afterwards
 * every account is covered up to the newest post the search saw, and the stretches still unread are
 * kept in each account's cursor, so they survive a change of shards.
 */
export async function collectXShard(key: string, sourceIds: string[]): Promise<{ key: string; status: "ok" | "failed" | "skipped"; accounts: number; found: number; created: number; stopped?: number; error?: string }> {
  const members = (
    await sql<SourceRow[]>`
      SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
      FROM sources WHERE id IN ${sql(sourceIds)}`
  ).filter((m) => m.enabled && shardHandle(m));
  if (members.length === 0) return { key, status: "skipped", accounts: 0, found: 0, created: 0 };
  const minutes = shardMinutes(members[0]!.participation_mode);
  const runs = new Map<string, number>();
  for (const m of members) runs.set(m.id, (await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${m.id}) RETURNING id`)[0]!.id);

  // A round that never got an answer still has to close the rows it opened and leave every member with
  // its error, its fail_count and its health; the run row of a shard opened here is all the admin sees.
  const failRound = async (message: string, budgetExceeded: boolean) => {
    for (const m of members) {
      await sql`
        UPDATE sources SET last_fetch_at = now(),
          fail_count = CASE WHEN ${budgetExceeded} THEN fail_count ELSE fail_count + 1 END,
          last_error = ${message},
          health = CASE WHEN ${budgetExceeded} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
          next_fetch_at = now() + make_interval(mins => CASE WHEN ${budgetExceeded} THEN 15 ELSE LEAST(${minutes} * (fail_count + 2), 360) END),
          updated_at = now()
        WHERE id = ${m.id}`;
      await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message}, detail = ${sql.json({ shard: key, accounts: members.length })} WHERE id = ${runs.get(m.id)!}`;
    }
  };

  const outOfRound = makeStopwatch(600_000, "COLLECT_X_BUDGET_MS");
  let since: bigint;
  const backlog: XBacklog[] = [];
  try {
    // The members' watermarks are read here, inside the try: a malformed cursor used to throw out of this
    // function after the run rows were inserted, and with retryLimit 0 nothing requeued the job, so the
    // round vanished, no member got last_error or fail_count, and N rows stayed 'running' forever.
    since = members.map(coveredTo).reduce((a, b) => (b < a ? b : a));
    const stretches = new Set<string>();
    for (const m of members) {
      for (const b of (Array.isArray(m.cursor?.xBacklog) ? m.cursor.xBacklog : []) as XBacklog[]) {
        if (!stretches.has(`${b.query} ${b.next}`)) backlog.push(b);
        stretches.add(`${b.query} ${b.next}`);
      }
    }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    await failRound(`unreadable cursor: ${message}`, false);
    throw error;
  }
  let read: XRead;
  try {
    read = await readXSearch(shardQuery(members.map((m) => shardHandle(m)!)), {
      lastId: String(since), backlog, subject: `x-shard:${key}`,
      // Pages cost 60 s each and a shard may want twenty: stop inside the job's expiry and hand the rest
      // of the search to the next rounds, which is what the backlog is for.
      stop: () => outOfRound.stop(),
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    await failRound(message, budget);
    return { key, status: "failed", accounts: members.length, found: 0, created: 0, error: message };
  }

  const detail = { shard: key, accounts: members.length, pages: read.pages, truncated: read.truncated, backlog: read.backlog.length, backlogPages: read.backlogPages, dropped: read.dropped };
  let found = 0;
  let created = 0;
  let stopped = 0;
  for (const m of members) {
    if (outOfRound.stop()) {
      // An account whose posts were read but not stored keeps its own watermark, so the next round's
      // search starts at the oldest one of them again and nothing that was not stored counts as seen.
      stopped += 1;
      await sql`UPDATE fetch_runs SET status = 'skipped', finished_at = now(), error = ${"round stopped before this account"} WHERE id = ${runs.get(m.id)!}`;
      continue;
    }
    const handle = shardHandle(m)!.toLowerCase();
    const mine = read.tweets.filter((t) => t.user.screen_name.toLowerCase() === handle);
    const stored = await store(m.id, mine.map(tweetToCandidate).map((c) => rewriteUrl(c, m)).filter((c) => !noiseFiltered(c, m)), null);
    found += mine.length;
    created += stored.created;
    const own = String(m.cursor!.lastTweetId);
    const cursor: Record<string, unknown> = { ...m.cursor, lastTweetId: read.lastId && BigInt(read.lastId) > BigInt(own) ? read.lastId : own, lastOkAt: new Date().toISOString() };
    if (read.backlog.length) cursor.xBacklog = read.backlog;
    else delete cursor.xBacklog;
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${sql.json(cursor as never)}, interval_minutes = ${minutes}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => ${minutes})
      WHERE id = ${m.id}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${mine.length}, new_count = ${stored.created},
                detail = ${sql.json({ ...detail, stored: stored.created + stored.revised } as never)} WHERE id = ${runs.get(m.id)!}`;
  }
  return { key, status: stopped === members.length ? "skipped" : "ok", accounts: members.length - stopped, found, created, stopped };
}

/** X accounts read by shard: a plain query and a watermark (the first fetch of an account is its own). */
const sharded = () => sql`kind = 'x_search' AND config->>'query' ~* ${SHARDABLE_SQL} AND coalesce(config->>'searchType', 'Latest') = 'Latest' AND cursor->>'lastTweetId' IS NOT NULL`;

/** Every minute: a shard is read when any of its accounts is due, all of them at once. */
async function scheduleXShards(): Promise<number> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode"> & { due: boolean }>>`
    SELECT id, kind, config, cursor, participation_mode, (next_fetch_at IS NULL OR next_fetch_at <= now()) AS due
    FROM sources WHERE enabled AND ${sharded()}`;
  const due = new Set(rows.filter((r) => r.due).map((r) => r.id));
  let enqueued = 0;
  for (const shard of planXShards(rows)) {
    if (!shard.sourceIds.some((id) => due.has(id))) continue;
    await enqueue(QUEUES.fetchXShard, { key: shard.key, sourceIds: shard.sourceIds }, { singletonKey: shard.key });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id IN ${sql(shard.sourceIds)}`;
    enqueued += 1;
  }
  return enqueued;
}

/**
 * A listing a Jina render is bought for, as SQL. Only the address the collector fetches counts: a source
 * that merely names r.jina.ai in allowUrlPrefixes is not paid and must not be left out of a development
 * round (which is what `config::text LIKE '%r.jina.ai%'` did to it).
 */
const paidListingSql = (alias = "") => {
  const c = alias ? `${alias}.config` : "config";
  return sql`${c}->>'url' LIKE ${JINA_LIST_PREFIX} OR ${c}->>'feedUrl' LIKE ${JINA_LIST_PREFIX}`;
};
const JINA_LIST_PREFIX = "https://r.jina.ai/%";

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first; X accounts by shard. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number; shards: number }> {
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list,x_search").split(",");
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ${sql(kinds)} AND (next_fetch_at IS NULL OR next_fetch_at <= now()) AND NOT (${sharded()})
      ${skipJina ? sql`AND NOT (${paidListingSql()})` : sql``}
    ORDER BY next_fetch_at NULLS FIRST LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  const shards = kinds.includes("x_search") ? await scheduleXShards() : 0;
  return { enqueued: rows.length, shards };
}

/**
 * The interval the industry pack curates for a source id, from industry/sources.json — the operator's own
 * number, which no daily job may overtake. Read once per process: the file only changes with a deploy, and
 * a deployment without it (nothing to read) simply has no curated ceiling.
 */
let packIntervals: Map<string, number> | null = null;
function curatedInterval(id: string): number | null {
  packIntervals ??= readPackIntervals();
  return packIntervals.get(id) ?? null;
}

function readPackIntervals(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources?: Array<{ id?: unknown; interval_minutes?: unknown }> };
    for (const s of pack.sources ?? []) {
      if (typeof s?.id === "string" && Number.isFinite(Number(s.interval_minutes))) out.set(s.id, Number(s.interval_minutes));
    }
  } catch {
    // no pack in this deployment: adapt from what the row itself says
  }
  return out;
}

/**
 * Daily: adapt each source's interval to its recent output, between the floor (15 min for a free source,
 * 60 for one read through Jina) and the interval the operator curated for it. The curated value is the
 * ceiling, not a starting point: this job used to rewrite all 36 collectable rows from a week's volume
 * alone, so a ministry page curated at 240 minutes and a journal feed at 720 held their pace for one day
 * and were then pulled to 60 — or to 15, sixteen times the crawl delay set for the statistics bureau.
 * `_aihot.intervalMinutesLocked` takes a source out of the adaptation altogether.
 */
export async function adaptIntervals(): Promise<{ updated: number; ceilingRecorded: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor" | "interval_minutes"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, s.interval_minutes,
      coalesce(s.config->>'url', '') LIKE ${JINA_LIST_PREFIX} OR coalesce(s.config->>'feedUrl', '') LIKE ${JINA_LIST_PREFIX} AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  let updated = 0;
  let recorded = 0;
  for (const r of rows) {
    if (r.config?._aihot?.intervalMinutesLocked === true) continue;
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // editorial X and listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer. These are the defaults for a source nobody curated an interval for.
    const quiet = r.participation_mode === "hot_signal" ? 180 : r.kind === "x_search" || r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const floor = r.paid_listing ? 60 : 15;
    // The operator's number: the pack's interval for this id, or the ceiling the source itself declares,
    // and only for a source neither of them knows (an account added in the admin) the old volume default.
    const declared = Number(r.config?._aihot?.intervalMinutesMax);
    const curated = curatedInterval(r.id) ?? (Number.isFinite(declared) && declared > 0 ? declared : quiet);
    // This job never writes an interval above the ceiling, so a row that sits higher was raised by a
    // person — from the admin or the pack — and that decision becomes the ceiling from now on.
    const remembered = Number(r.cursor?.intervalCeiling);
    const ceiling = Math.max(Number.isFinite(remembered) && remembered > 0 ? remembered : 0, curated, r.interval_minutes);
    // Remembered for a source the pack does not list, so a busy one can relax back to its own pace
    // instead of being stuck at the fastest interval it ever had.
    if ((!Number.isFinite(remembered) || remembered !== ceiling) && ceiling !== r.interval_minutes) {
      await sql`UPDATE sources SET cursor = coalesce(cursor, '{}'::jsonb) || ${sql.json({ intervalCeiling: ceiling } as never)} WHERE id = ${r.id}`;
      recorded += 1;
    }
    // X accounts read by shard follow the shard's pace, whatever their own volume.
    const target = shardHandle(r)
      ? shardMinutes(r.participation_mode)
      : perDay <= 0.15
        ? ceiling
        : Math.round(Math.min(ceiling, Math.max(Math.min(floor, ceiling), (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated, ceilingRecorded: recorded };
}
