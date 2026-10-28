import {sql} from '../db.ts';
import {isCollectEnabled} from '../config.ts';
import {resourceHeadroom} from './resource-budget.ts';
import {READER_POLICY_VERSION} from '../publication/readiness.ts';
import {queueProcessing} from '../jobs/content.ts';
import {ensureQueue,QUEUES} from '../jobs/queue.ts';

/** Re-extract positively identified incomplete bodies through the ordinary queue and safeguards. */
export async function recoverBodyIntegrity(){
 if(!isCollectEnabled()||!resourceHeadroom())return {queued:0,held:true};
 await ensureQueue(QUEUES.extractBody);
 return sql.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='2s'`;await tx`SET LOCAL lock_timeout='250ms'`;
  const [lock]=await tx`SELECT pg_try_advisory_xact_lock(hashtext('recover:body-integrity')) AS acquired`;
  if(!lock?.acquired)return {queued:0,held:true};
  const rows=await tx<{article_id:string}[]>`SELECT w.article_id FROM article_workflow_readiness w
   JOIN publications p ON p.article_id=w.article_id AND p.revision=w.revision AND p.analysis_id=w.analysis_id
   JOIN articles a ON a.id=w.article_id JOIN sources s ON s.id=a.source_id
   WHERE w.policy_version=${READER_POLICY_VERSION} AND w.quality_error LIKE 'source:%'
    AND p.visibility='public' AND s.site_fulltext AND s.participation_mode='editorial'
    AND a.body_status IN ('ok','unconfirmed') AND (a.processing_retry_at IS NULL OR a.processing_retry_at<=now())
   ORDER BY w.checked_at,w.article_id LIMIT 5 FOR UPDATE OF a SKIP LOCKED`;
  let queued=0;
  for(const row of rows){
   const job=await queueProcessing(row.article_id,{step:'extract',db:tx});
   if(job){await tx`UPDATE articles SET body_status='pending',processing_state='new',updated_at=now() WHERE id=${row.article_id}`;queued++;}
  }
  return {queued};
 });
}
