import { sql } from "../db.ts";

/** Recurring ticks contain no article IDs: each scan discovers current translation work anew.
 * Keep a pending successor and cancel at most 127 redundant, never-started empty ticks per scan.
 * Active/retry jobs and every article/receipt remain untouched. Cancellation and audit are atomic.
 */
export async function coalesceTranslationTicks(): Promise<number> {
  return sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout = '2s'`;
    await tx`SET LOCAL lock_timeout = '250ms'`;
    const changed = await tx<{id: string}[]>`
      WITH candidates AS MATERIALIZED (
        SELECT id FROM pgboss.job
        WHERE name='cron.content.translate' AND state='created'
          AND started_on IS NULL AND data='{}'::jsonb
        ORDER BY created_on, id LIMIT 128 FOR UPDATE SKIP LOCKED
      ), redundant AS (
        SELECT id FROM candidates OFFSET 1
      )
      UPDATE pgboss.job j SET state='cancelled', completed_on=pgboss.job_now(),
        output='{"reason":"coalesced recurring translation scan"}'::jsonb
      FROM redundant r WHERE j.name='cron.content.translate' AND j.id=r.id
        AND j.state='created' AND j.started_on IS NULL AND j.data='{}'::jsonb
      RETURNING j.id`;
    if (changed.length) await tx`
      INSERT INTO job_runs (job,status,finished_at,detail)
      VALUES ('ops.coalesce-translation-ticks','ok',now(),${tx.json({ cancelled: changed.length,
        ids: changed.map(r => r.id), reason: "redundant empty scan ticks; not translated articles", keptSuccessor: true })})`;
    return changed.length;
  }) as Promise<number>;
}
