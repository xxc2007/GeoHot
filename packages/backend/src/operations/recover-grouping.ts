import { sql } from "../db.ts";
import { enqueue, ensureQueue, QUEUES } from "../jobs/queue.ts";
import { audit } from "../admin/auth.ts";

/** Recover only retained evidence of an unsent, locally budget-blocked grouping job. */
export async function recoverBudgetBlockedGrouping(): Promise<{ requeued: number }> {
  await ensureQueue(QUEUES.group);
  return sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout = '2000ms'`;
    await tx`SET LOCAL lock_timeout = '250ms'`;
    await tx`SET LOCAL max_parallel_workers_per_gather = 0`;
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('recover:grouping-budget')) AS acquired`;
    if (!lock?.acquired) return { requeued: 0 };
    // Include every terminal outcome before choosing the latest per article. A later success or
    // different failure must never be replaced by evidence from an earlier budget failure.
    const candidates = await tx<{ article_id: string; signal_only: boolean; failed_job_id: string }[]>`
      WITH recent AS MATERIALIZED (
        SELECT id, created_on, completed_on, state, data->>'articleId' AS article_id,
          data->'signalOnly' = 'true'::jsonb AS signal_only,
          output->>'name' AS error_name, output->'retryAfterSeconds' AS retry_after
        FROM pgboss.job
        WHERE name = ${QUEUES.group} AND state IN ('failed','completed','cancelled')
          AND completed_on > now() - interval '26 hours'
        ORDER BY completed_on DESC, created_on DESC, id DESC LIMIT 10000
      ), latest AS MATERIALIZED (
        SELECT DISTINCT ON (article_id) id, article_id, signal_only, state, completed_on, error_name,
          CASE WHEN jsonb_typeof(retry_after) = 'number' AND retry_after #>> '{}' ~ '^[0-9]{1,5}$'
               THEN (retry_after #>> '{}')::int END AS retry_seconds
        FROM recent ORDER BY article_id, completed_on DESC, created_on DESC, id DESC
      )
      SELECT rp.article_id, coalesce(j.signal_only, false) AS signal_only,j.id AS failed_job_id
      FROM latest j JOIN regroup_pending rp ON rp.article_id = j.article_id
      WHERE j.state = 'failed' AND j.error_name = 'BudgetExceededError'
        AND j.retry_seconds BETWEEN 0 AND 86400
        AND j.completed_on + j.retry_seconds * interval '1 second' <= now()
        AND NOT EXISTS (SELECT 1 FROM pgboss.job live
          WHERE live.name = ${QUEUES.group} AND live.state IN ('created','retry','active')
            AND live.data->>'articleId' = rp.article_id)
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.status IN ('pending','unknown')
          AND r.purpose IN ('group_article','group_review','group_signal')
          AND split_part(r.subject, ':', 1) = 'article' AND split_part(r.subject, ':', 2) = rp.article_id)
      ORDER BY j.completed_on, rp.article_id LIMIT 10
      FOR UPDATE OF rp SKIP LOCKED`;
    let requeued = 0;
    for (const candidate of candidates) {
      const jobId=await enqueue(QUEUES.group, { articleId: candidate.article_id, force: true,
        ...(candidate.signal_only ? { signalOnly: true } : {}) }, { singletonKey: candidate.article_id }, tx);
      if(jobId) {
        await audit("ops.recover","grouping.budget-recovery",`article:${candidate.article_id}`,
          "Restore an expired local budget deferral; receipt and billing evidence unchanged",
          {failedJobId:candidate.failed_job_id},{jobId},undefined,tx);
        requeued++;
      }
    }
    return { requeued };
  });
}
