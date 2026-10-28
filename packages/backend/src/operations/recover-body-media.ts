import { sql } from "../db.ts";
import { enqueue, ensureQueue, QUEUES } from "../jobs/queue.ts";
import { resourceHeadroom } from "./resource-budget.ts";
import { textWorkflowReadyCondition } from "../publication/readiness.ts";
import { bodyMediaReadyCondition, bodyMediaFingerprint, bodyMediaRequiredCondition } from "../publication/media-readiness.ts";

/** Five ordinary jobs per existing ops.recover tick, 250 indexed headers scanned, persistent keyset cursor. */
export async function recoverBodyMedia() {
  if (!resourceHeadroom()) return { queued: 0, held: true };
  await ensureQueue(QUEUES.prepareMedia);
  return sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout='2s'`;
    await tx`SET LOCAL lock_timeout='250ms'`;
    await tx`SET LOCAL max_parallel_workers_per_gather=0`;
    const [lock]=await tx`SELECT pg_try_advisory_xact_lock(hashtext('recover:body-media')) AS acquired`;
    if (!lock?.acquired) return { queued: 0, held: true };
    const [saved]=await tx<{ value: { at: string; id: string } | null }[]>`SELECT value FROM settings WHERE key='body_media_recovery_cursor'`;
    const cursor=saved?.value;
    const headers=await tx<{ article_id: string; timeline_at: Date }[]>`
      SELECT p.article_id,p.timeline_at FROM publications p
      WHERE p.visibility='public' AND p.eligible AND p.body_mode='full'
        ${cursor ? tx`AND (p.timeline_at,p.article_id)<(${cursor.at}::timestamptz,${cursor.id})` : tx``}
      ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT 250`;
    const candidates=headers.length ? await tx<{ article_id: string; revision: number; fingerprint: string; timeline_at: Date }[]>`
      SELECT p.article_id,ready_a.revision,${bodyMediaFingerprint()} AS fingerprint,p.timeline_at
      FROM publications p JOIN articles ready_a ON ready_a.id=p.article_id
      LEFT JOIN article_media_readiness stamp ON stamp.article_id=p.article_id
      WHERE p.article_id=ANY(${headers.map(r=>r.article_id)}::text[])
        AND p.visibility='public' AND p.eligible AND p.body_mode='full'
        AND ${textWorkflowReadyCondition()} AND ${bodyMediaRequiredCondition()} AND NOT ${bodyMediaReadyCondition()}
        AND (greatest(stamp.attempted_at,stamp.queued_at) IS NULL OR greatest(stamp.attempted_at,stamp.queued_at)<now()-interval '15 minutes')
      ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT 5` : [];
    let queued=0;
    for (const row of candidates) {
      const job=await enqueue(QUEUES.prepareMedia,{articleId:row.article_id},{singletonKey:`media:${row.article_id}`},tx);
      if(job) {
        await tx`INSERT INTO article_media_readiness(article_id,revision,fingerprint,ready,queued_at)
          VALUES(${row.article_id},${row.revision},${row.fingerprint},false,now())
          ON CONFLICT(article_id) DO UPDATE SET queued_at=EXCLUDED.queued_at`;
        queued++;
      }
    }
    const last=candidates.length===5 ? candidates.at(-1) : headers.at(-1);
    if (last) await tx`INSERT INTO settings(key,value) VALUES('body_media_recovery_cursor',${tx.json({at:last.timeline_at.toISOString(),id:last.article_id})}::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
    else await tx`DELETE FROM settings WHERE key='body_media_recovery_cursor'`;
    return {queued,scanned:headers.length};
  });
}
