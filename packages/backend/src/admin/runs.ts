// Runs view: task timeline, queue backlog, source lag, error classes, process
// heartbeats, and the receipts whose outcome needs an operator. The deliveries table is history
// only since the notify chain teardown — the admin content page still shows past rows read-only.
import { sql } from "../db.ts";
import { InvalidInput } from "./invalid.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { failureGroupSql, queueProcessing, requeueFailed } from "../jobs/content.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { snapshotReader, snapshotStore } from "./statistic-snapshot.ts";
import { modelStatisticRead } from "./model-statistics-read.ts";

const STALE_HEARTBEAT_MS = 3 * 60_000;

/** Small live status, bounded independently of the cached historical aggregate. */
export async function readLiveRunsState() {
  return modelStatisticRead(async db => {
    const processes = await db<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`;
    const queues = await db<{name:string; queued:number; active:number; at:Date|null}[]>`SELECT name, queued_count AS queued, active_count AS active, monitor_on AS at FROM pgboss.queue WHERE queued_count > 0 OR active_count > 0 ORDER BY name`;
    return { processes, queues };
  }, 1000).catch(() => null);
}

const runsSnapshot = snapshotReader(async () => {
  try { return [await runsOverview()]; }
  catch (error) {
    console.warn(JSON.stringify({ level: "warn", msg: "admin runs snapshot refresh failed", code: String((error as { code?: string })?.code ?? "unknown") }));
    throw error;
  }
}, snapshotStore<Awaited<ReturnType<typeof runsOverview>>>("runs-overview-v1"));

/** Operational scans never sit on the HTTP critical path or repeat for every browser poll. */
export async function readRunsOverview() {
  const snapshot = await runsSnapshot.get();
  const overview = snapshot.rows[0];
  if (!overview) return { unavailable: true as const };
  // Fresh, tiny heartbeat reads must not wait for the expensive multi-table statistics snapshot.
  const fresh = await readLiveRunsState();
  const live = fresh?.processes;
  const now = Date.now();
  const processes = live ? live.map(h => ({ role: h.key.slice("heartbeat.".length), ...h.value, at: h.updated_at,
    alive: now - h.updated_at.getTime() < STALE_HEARTBEAT_MS })) : overview.processes.map(p => ({...p, alive: now - new Date(p.at).getTime() < STALE_HEARTBEAT_MS}));
  // pg-boss maintains this tiny queue metadata table itself. Reading it avoids scanning the job
  // archive just to show whether the live queue is moving; its monitor timestamp remains explicit.
  const queueSnapshot = fresh?.queues;
  return { ...overview, processes, processesCheckedAt: live ? new Date(now).toISOString() : null,
    queueSnapshot: queueSnapshot?.length && queueSnapshot.every(q => q.at) ? queueSnapshot : null,
    stale: snapshot.status.state !== "ready" };
}

/**
 * `job_runs.status` records whether the *run* finished, not whether every period it was supposed to lay out
 * came out. `catchUpReports` returns `{generated, failed}` — an hour in which all nine periods failed to
 * compose is still a completed run, so it lands green and the detail sits in `detail->failed` where the
 * operator's eye never goes. Pull it into the same column the status badge is read from.
 */
const failuresSql = sql`CASE WHEN jsonb_typeof(detail->'failed') = 'array'
        THEN (SELECT left(string_agg(e #>> '{}', '；'), 300) FROM jsonb_array_elements(detail->'failed') e) END`;

export async function runsOverview() {
  return sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '4000ms'`;
    await tx`SET LOCAL lock_timeout = '250ms'`;
    await tx`SET LOCAL max_parallel_workers_per_gather = 0`;
    const [heartbeats, latest, timeline, queues, failedJobs, lagging, receipts, receiptIssues, errors, ingest, leaderboard, unknownTotals] = await Promise.all([
      tx<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`,
      tx`
        WITH latest AS (
          SELECT recent.job, recent.started_at, recent.finished_at, recent.status,
                 left(recent.error, 400) AS error, ${failuresSql} AS failures
          FROM (SELECT DISTINCT job FROM job_runs) names
          CROSS JOIN LATERAL (
            SELECT job, started_at, finished_at, status, error, detail
            FROM job_runs WHERE job = names.job ORDER BY started_at DESC LIMIT 1
          ) recent
        ), counts AS (
          SELECT job, count(*) FILTER (WHERE status = 'failed')::int AS failed_24h, count(*)::int AS runs_24h
          FROM job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job
        )
        SELECT latest.*, coalesce(counts.failed_24h, 0) AS failed_24h, coalesce(counts.runs_24h, 0) AS runs_24h
        FROM latest LEFT JOIN counts USING (job) ORDER BY job`,
      tx`SELECT id, job, started_at, finished_at, status, left(error, 300) AS error, ${failuresSql} AS failures FROM job_runs ORDER BY started_at DESC LIMIT 80`,
      tx<{ name: string; state: string; n: number; oldest: Date }[]>`
        SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job
        WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
      tx`
      WITH totals AS MATERIALIZED (
        SELECT name, count(*)::int AS failed, max(completed_on) AS last
        FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours' GROUP BY name
      )
      SELECT totals.*, left(recent.output::text,300) AS last_output FROM totals
      LEFT JOIN LATERAL (
        SELECT output FROM pgboss.job j WHERE j.name = totals.name
          AND j.state = 'failed' AND j.completed_on = totals.last LIMIT 1
      ) recent ON true ORDER BY failed DESC`,
      tx`
        SELECT id, name, kind, health, fail_count, last_ok_at, last_fetch_at, next_fetch_at, interval_minutes, left(last_error, 200) AS last_error
        FROM sources
        WHERE enabled AND kind NOT IN ('mp_account', 'external')
          AND (health = 'failing' OR next_fetch_at < now() - interval '30 minutes' OR last_ok_at < now() - make_interval(mins => greatest(interval_minutes * 6, 360)))
        ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 60`,
      tx<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM receipts WHERE created_at > now() - interval '7 days' GROUP BY 1`,
      tx`
        SELECT id, service, model, purpose, subject, status, attempts, left(error, 240) AS error, created_at, updated_at FROM receipts
        WHERE id IN (
          (SELECT id FROM receipts WHERE status = 'unknown' ORDER BY updated_at DESC LIMIT 40)
          UNION ALL
          (SELECT id FROM receipts WHERE status = 'failed' AND updated_at > now() - interval '3 days' ORDER BY updated_at DESC LIMIT 40)
          UNION ALL
          (SELECT id FROM receipts WHERE status = 'pending' AND updated_at < now() - interval '15 minutes' ORDER BY updated_at DESC LIMIT 40)
        )
        ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
      tx`
        SELECT ${failureGroupSql} AS error, count(*)::int AS n, max(discovered_at) AS last,
               (array_agg(id ORDER BY discovered_at DESC))[1] AS example
        FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      tx`SELECT client, kind, status, left(error, 200) AS error, summary, created_at FROM ingest_events ORDER BY created_at DESC LIMIT 20`,
      tx<{ value: { at: string; sources: Record<string, { ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } }[]>`
        SELECT value FROM settings WHERE key = 'leaderboard.fetch'`,
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE status = 'unknown'`,
    ]);
    // Articles waiting to retry after a passing provider problem (they are not failed).
    const [retrying] = await tx<{ n: number; next: Date | null }[]>`
      SELECT count(*)::int AS n, min(processing_retry_at) AS next FROM articles WHERE processing_state = 'new' AND processing_attempts > 0`;
    const now = Date.now();
    return {
      checkedAt: new Date(now).toISOString(),
      stale: false,
      processes: heartbeats.map((h) => ({
        role: h.key.slice("heartbeat.".length),
        ...h.value,
        at: h.updated_at,
        alive: now - h.updated_at.getTime() < STALE_HEARTBEAT_MS,
      })),
      jobs: latest,
      timeline,
      queues,
      failedJobs,
      lagging,
      receipts: { counts: Object.fromEntries(receipts.map((r) => [r.status, r.n])), issues: receiptIssues, unknownTotal: unknownTotals[0]?.n ?? 0 },
      errors,
      retrying: { count: retrying?.n ?? 0, next: retrying?.next ?? null },
      ingest,
      leaderboard: leaderboard[0]
        ? { at: leaderboard[0].value.at, sources: Object.entries(leaderboard[0].value.sources).map(([key, v]) => ({ key, ...v })).sort((a, b) => Number(a.ok) - Number(b.ok) || a.key.localeCompare(b.key)) }
        : null,
    };
  });
}

/**
 * A receipt whose outcome is unknown is not re-sent by the request that lost it. Releasing it marks it
 * failed, so the next attempt calls again; an article that stopped on it goes straight back to
 * processing (one action, not two). Only an unknown receipt is released, once.
 */
async function release(id: number, error: string, actor: string, note: string, billed: boolean | null) {
  const billingStatus = billed === null ? "unknown" : billed ? "billed" : "unbilled";
  const before = await sql.begin(async (tx) => {
    const [row] = await tx<{ subject: string | null; purpose: string; attempts: number }[]>`
      UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now()
      WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose, attempts`;
    if (!row) return null;
    // A later release must not refund an earlier automatically released attempt. Legacy migration 0022
    // wrote attempt 1 for receipts whose original attempt counter was zero.
    const [attempt] = await tx<{ id: number; billing_status: string }[]>`
      UPDATE receipt_attempts SET status = 'failed',
        billing_status = CASE WHEN ${billed}::boolean IS NULL AND billing_status IN ('billed', 'unbilled')
                         THEN billing_status ELSE ${billingStatus} END, error = ${error}
      WHERE receipt_id = ${id} AND attempt = ${Math.max(row.attempts, 1)} AND status = 'unknown' RETURNING id, billing_status`;
    if (!attempt) throw new Conflict("当前未知尝试缺失，无法核对费用；回执未放行");
    // Grouping has no @revision subject and does not fail the article's processing state.
    // Recover only this released request, atomically with its ledger change. Force bypasses an
    // old automatic membership; groupArticle still checks manual decisions before any reset.
    const groupArticle = row.purpose === "group_review"
      ? /^article:([^:@#]+):fact:\d+$/.exec(row.subject ?? "")?.[1]
      : row.purpose === "group_article" || row.purpose === "group_signal"
        ? /^article:([^:@#]+)$/.exec(row.subject ?? "")?.[1] : undefined;
    const groupRequeued = groupArticle ? !!(await enqueue(QUEUES.group,
      { articleId: groupArticle, force: true, ...(row.purpose === "group_signal" ? { signalOnly: true } : {}) },
      { singletonKey: groupArticle }, tx)) : false;
    return { ...row, attemptId: attempt.id, billingStatus: attempt.billing_status, groupRequeued };
  });
  if (!before) return null;
  // 认 subject 的形状，不认 purpose：走文章处理链的调用 subject 都是 `article:<id>@…`，
  // 而这里原先判的是 `purpose === "analyze_article"`——真实 purpose 是 prefilter/score/understand/
  // summarize/structure 那五个，这个字符串从来没出现过（git log -S 只有上游基线那一笔），
  // 于是 `jobs/content.ts` 注释里承诺的「ops 释放一次就把条目排回去」从未发生：
  // 一次 240 秒超时就把一条条目永久留在 'failed'。
  const extraction = before.purpose === "body_fallback" || before.purpose === "x_article";
  const article = extraction ? /^article:([^@#]+)$/.exec(before.subject ?? "")?.[1]
    : /^article:([^@]+)@/.exec(before.subject ?? "")?.[1];
  let requeued = before.groupRequeued;
  if (article) {
    const [a] = await sql`UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL, updated_at = now()
                          WHERE id = ${article} AND processing_state = 'failed' RETURNING id`;
    if (a) requeued = !!(await queueProcessing(article, { step: extraction ? "extract" : "analyze" }));
  }
  await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" },
    { status: "failed", billed, billingStatus: before.billingStatus, attemptId: before.attemptId, requeued });
  return { id, status: "failed", subject: before.subject, purpose: before.purpose, requeued };
}

/** Admin, after checking the provider's console: records whether it was billed and releases it. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (!input.note?.trim()) throw new InvalidInput("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核对：${input.billed ? "供应商已计费但结果未取回" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

const AUTO_RELEASE_AFTER_MS = 30 * 60_000;
const AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

/**
 * Every 10 minutes (ops.recover): unknown receipts older than half an hour are released
 * without checking the provider's bill. A lost answer costs at most one repeat: a request released this
 * way once and unknown again stays for the admin (the daily ops digest lists it).
 */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  const rows = await sql<{ id: number }[]>`
    SELECT r.id FROM receipts r
    WHERE r.status = 'unknown' AND r.updated_at < ${new Date(now - AUTO_RELEASE_AFTER_MS)}
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.error LIKE ${AUTO_RELEASE_NOTE + "%"})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  let errors = 0;
  for (const r of rows) {
    let done: { requeued: boolean } | null = null;
    try {
      done = await release(r.id, AUTO_RELEASE_NOTE, "ops.recover", "结果未知，自动放行一次", null);
    } catch {
      // One receipt whose attempt ledger no longer matches (legacy 0022 shapes did produce those) throws
      // out of release() — a poison row must not stop the rest of this batch, nor the recoveries queued
      // behind it in ops.recover. It stays visible in the runs overview receiptIssues for the admin.
      errors += 1;
      continue;
    }
    if (done) released += 1;
    if (done?.requeued) requeued += 1;
  }
  return { released, requeued, errors };
}

/** Failed articles (one failure group, or all of the last 30 days) back into processing. */
export async function requeueFailedArticles(input: { group: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new InvalidInput("reason is required");
  const result = await requeueFailed(input.group);
  await audit(actor, "processing.requeue", input.group ? `failure:${input.group.slice(0, 80)}` : "failure:all", input.reason, null, result);
  return result;
}
