import {sql} from '../db.ts';
import {resourceHeadroom} from './resource-budget.ts';
import {refreshWorkflowReadinessTx,READER_POLICY_VERSION} from '../publication/readiness.ts';

/** Bounded persistent recovery in the existing ops.recover tick; no provider calls or new queues. */
export async function recoverWorkflowReadiness(options: {selectedOnly?:boolean;summaryOnly?:boolean;limit?:number;budgetMs?:number}={}) {
  if(!resourceHeadroom())return {checked:0,ready:0,held:true};
  const limit=Math.max(1,Math.min(options.limit??250,250));
  const deadline=Date.now()+Math.max(100,Math.min(options.budgetMs??4000,10000));
  const key=`workflow_readiness_v${READER_POLICY_VERSION}_${options.summaryOnly?'summary':options.selectedOnly?'selected':'all'}_cursor`;
  return sql.begin(async tx=>{
    await tx`SET LOCAL statement_timeout='2s'`;
    await tx`SET LOCAL lock_timeout='250ms'`;
    await tx`SET LOCAL max_parallel_workers_per_gather=0`;
    const [lock]=await tx`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`;
    if(!lock?.acquired)return {checked:0,ready:0,held:true};
    const [saved]=await tx<{value:{at:string;id:string}}[]>`SELECT value FROM settings WHERE key=${key}`;
    const cursor=saved?.value;
    const headers=await tx<{article_id:string;timeline_at:Date}[]>`SELECT p.article_id,p.timeline_at FROM publications p
      WHERE p.visibility='public' AND p.body_mode='full'
      AND EXISTS (SELECT 1 FROM sources policy_s WHERE policy_s.id=p.source_id AND policy_s.site_fulltext) ${options.selectedOnly ? tx`AND p.selected` : tx``}
      ${options.summaryOnly ? tx`AND (p.visibility='summary-only' OR EXISTS (SELECT 1 FROM sources recovery_s WHERE recovery_s.id=p.source_id AND NOT recovery_s.site_fulltext))` : tx``}
      ${cursor ? tx`AND (p.timeline_at,p.article_id)<(${cursor.at}::timestamptz,${cursor.id})` : tx``}
      ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT ${limit}`;
    let checked=0,ready=0,scanned=0,failed=0;let last:typeof headers[number]|undefined;
    for(const row of headers){
      if(Date.now()>=deadline)break;
      const [existing]=await tx`SELECT 1 FROM article_workflow_readiness WHERE article_id=${row.article_id} AND policy_version=${READER_POLICY_VERSION}`;
      if(!existing){
        try {ready+=Number(await tx.savepoint(sp=>refreshWorkflowReadinessTx(sp,row.article_id)));checked++;}
        catch(error){if(['57014','55P03','40P01'].includes((error as {code?:string}).code??''))failed++;else throw error;}
      }
      last=row;scanned++;
    }
    if(last)await tx`INSERT INTO settings(key,value) VALUES(${key},${tx.json({at:last.timeline_at.toISOString(),id:last.article_id})})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
    else if(!headers.length)await tx`DELETE FROM settings WHERE key=${key}`;
    return {checked,ready,scanned,failed,headers:headers.length,advanced:last?.article_id??null,wrapped:!headers.length};
  });
}
