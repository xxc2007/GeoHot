// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued, so the
// safety net only picks up articles nothing is working on and sends those still waiting for a body to
// extraction first. A provider outage makes an article wait and retry with backoff; only a permanent
// refusal or exhausted retries end in "failed", which the admin re-queues in bulk.
import type { PgBoss } from "pg-boss";
import { isCollectEnabled, positiveInt } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { publishArticle } from "../publication/publish.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { ensureQueue, enqueue, QUEUES, shutdownSignal } from "./queue.ts";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** A queued article whose job left no trace for this long is queued again. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
  /** Pulled from the scholarly record on purpose (`backfill_reason = 'archive'`); it does not go stale. */
  archive: boolean;
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * when there is only a title or a feed summary (the analysis judges the whole article), or when an
 * X post links an X Article (fetched before judging; for a discussion post only while it is news, as
 * history adds no heat).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<{ body_status: string; participation_mode: string; kind: string; config: Record<string, unknown>; url: string; bare: boolean; backfill: boolean; backfill_reason: string | null; published_at: Date | null; discovered_at: Date }[]>`
    SELECT a.body_status, s.participation_mode, s.kind, s.config, a.url, (coalesce(a.body_text, '') = '' AND a.x_post IS NULL) AS bare,
           a.backfill, a.backfill_reason, a.published_at, a.discovered_at
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  const needsXArticle = row.kind === "x_search" && (!signal || (row.participation_mode === "hot_signal" && !historical));
  // 抽取正文的消费者（`registerExtractionJobs`）是跟着采集阀门一起开关的——那一步同样要出网。
  // 于是阀门关着时把作业排进那个队列，排进去的就是一个永远没人领的作业：本机实测 54 个 job 停在
  // `state='created'`、83 篇 `body_status='pending'` 一直不动，而 5 分钟一次的安全网每轮都重排它。
  // 现在按"用手上已有的摘要判"走 —— 与抽取最终失败时本来就走的那一支同一个口径，读者侧最多少一条
  // 内容，不会多出一条错的。
  const extractable = pending && (needsPage || needsXArticle) && isCollectEnabled();
  return { step: extractable ? "extract" : "analyze", signal, historical, archive: row.backfill_reason === "archive" };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 *
 * History is not one band. A paper pulled from the scholarly record does not go stale — a March article
 * judged in October is still a March article, and it is the material the back-dated papers are made of.
 * A news item found more than 48 h late is the opposite: it decays every day it waits, and it rarely earns
 * a place. Measured on production 2026-10-10: of judged `stale-on-discovery` items 0.8% were selected,
 * against 1.9% of ordinary ones. So archive work is served between live work and late news — the ordering
 * that costs the reader least: today's paper still goes first, and 09:00 news still goes before the record.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2, archive: -1 } as const;

/** Which band of history this article belongs to: the record (no decay) or late news (decaying). */
const historyPriority = (r: { archive: boolean }) => (r.archive ? PRIORITY.archive : PRIORITY.history);

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(articleId: string, opts: { step?: Step; attemptTag?: string; db?: Db } = {}): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  const step = opts.step ?? r.step;
  await db`UPDATE articles SET processing_queued_at = now() WHERE id = ${articleId}`;
  if (step === "extract") return enqueue(QUEUES.extractBody, { articleId }, { singletonKey: articleId, priority: r.historical ? historyPriority(r) : PRIORITY.live }, opts.db);
  if (r.signal && !opts.attemptTag) {
    return enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: r.historical ? historyPriority(r) : PRIORITY.liveSignal }, opts.db);
  }
  const tagged = !!opts.attemptTag;
  return enqueue(QUEUES.analyze, tagged ? { articleId, attemptTag: opts.attemptTag } : { articleId },
    { singletonKey: tagged ? `manual:analyze:${articleId}:${opts.attemptTag}` : articleId, priority: r.historical ? historyPriority(r) : PRIORITY.live }, opts.db);
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

/** attemptTag makes an explicit re-evaluation a new (paid) request; the same tag reuses its receipt. */
export async function processArticle(articleId: string, opts: { attemptTag?: string } = {}): Promise<{ state: string }> {
  const [found] = await sql<{ participation_mode: string; processing_state: string; revision: number; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    SELECT s.participation_mode, a.processing_state, a.revision, a.backfill, a.published_at, a.discovered_at FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!found) return { state: "missing" };
  const row = { ...found, historical: isHistorical(found) };
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  try {
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag });
    if (!result) return { state: "missing" };
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    await publishArticle(articleId);
    // History is archived but founds no event (isHistorical).
    if (result.output.relevance === "pass" && !row.historical) await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority: PRIORITY.live });
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop; ops.recover releases it once and requeues the article.
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`} WHERE id = ${articleId}`;
      return { state: "unknown-receipt" };
    }
    throw error;
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
async function afterFailure(articleId: string, error: unknown): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (error instanceof ReceiptBusyError || error instanceof BudgetExceededError) {
    // Not the article's fault: the same request is in flight, or the budget window is full.
    const seconds = error instanceof BudgetExceededError ? error.retryAfterSeconds : 60;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "waiting", retryAt };
  }
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId}`;
  const attempts = (a?.processing_attempts ?? 0) + 1;
  const refused = error instanceof ProviderRejectedError && !error.retryable;
  const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "failed" };
  }
  const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
  await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
  return { state: "retrying", retryAt };
}

/** Read once at startup: `ANALYZE_CONCURRENCY=two` used to reach pg-boss as `localConcurrency: NaN`. */
const ANALYZE_CONCURRENCY = positiveInt(process.env.ANALYZE_CONCURRENCY, "ANALYZE_CONCURRENCY", 6);

export async function registerContentJobs(boss: PgBoss, concurrency = ANALYZE_CONCURRENCY) {
  await ensureQueue(QUEUES.analyze);
  await boss.work<{ articleId: string; attemptTag?: string }>(QUEUES.analyze, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId, attemptTag } = job.data;
    try {
      const result = await processArticle(articleId, { attemptTag });
      if (result.state !== "unknown-receipt") {
        await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
      }
      return result;
    } catch (error) {
      return afterFailure(articleId, error);
    }
  });
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.extractBody);
  await boss.work<{ articleId: string }>(QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId } = job.data;
    try {
      const state = await extractArticleBody(articleId);
      await queueProcessing(articleId, { step: "analyze" });
      return { state };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} RETURNING processing_attempts`;
      if ((a?.processing_attempts ?? MAX_EXTRACT_FAILURES) < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL WHERE id = ${articleId} AND body_status = 'pending'`;
      await queueProcessing(articleId, { step: "analyze" });
      return { state: "unconfirmed" };
    }
  });
}

/**
 * Safety net: articles waiting for processing that no queue holds (crash between write and enqueue,
 * a lost job, a retry that came due). Articles already queued or running are left alone.
 *
 * Oldest first, and that order is the whole point: this net takes at most 500 rows a run, so ordering by
 * `discovered_at DESC` (as it did until 2026-10-05) re-queued the newest 500 every five minutes and left
 * everything older waiting forever — with `processing_state` still 'new', no `processing_error`, and
 * therefore invisible on the admin page that lists exactly those stuck rows. One crash during a bulk
 * import is enough to exceed 500.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number; published: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at ASC LIMIT 500`;
  for (const r of rows) await queueProcessing(r.id);
  // 另一半：分析已经落库、发布投影却没跑成（崩溃正好落在 `analyze.ts` 提交与 `publishArticle` 之间）。
  // 这一半不排队、不花钱——投影是确定性计算，直接补一次；漏掉它，条目就永久停在"分析过了但站上找不到"。
  const unprojected = await sql<{ id: string }[]>`
    SELECT a.id FROM articles a
    WHERE a.processing_state = 'analyzed' AND a.updated_at < now() - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id)
    ORDER BY a.discovered_at ASC LIMIT 500`;
  for (const r of unprojected) await publishArticle(r.id);
  return { enqueued: rows.length, published: unprojected.length };
}

/**
 * How the runs page groups failures: the message with ids and numbers masked. Written as SQL text because
 * it is a fixed expression, not a parameterised one — it used to take the column as an argument and build
 * itself with `sql.unsafe`, which is a loaded gun handed to every caller (`admin/runs.ts:47` and
 * `requeueFailed` below both used the default, and the next caller passing a `req.query` would be a
 * straight injection). There is nothing left to hand it.
 */
export const failureGroupSql = sql`regexp_replace(left(coalesce(processing_error, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`;

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the safety net picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}
