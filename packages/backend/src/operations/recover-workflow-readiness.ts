import {sql} from '../db.ts';
import {resourceHeadroom} from './resource-budget.ts';
import {refreshWorkflowReadinessTx,READER_POLICY_VERSION} from '../publication/readiness.ts';

/** Bounded persistent recovery in the existing ops.recover tick; no provider calls or new queues. */
export async function recoverWorkflowReadiness(options: {selectedOnly?:boolean;summaryOnly?:boolean;reportsOnly?:boolean;limit?:number;budgetMs?:number}={}) {
  if(!resourceHeadroom())return {checked:0,ready:0,held:true};
  const limit=Math.max(1,Math.min(options.limit??250,250));
  const deadline=Date.now()+Math.max(100,Math.min(options.budgetMs??4000,10000));
  const key=`workflow_readiness_v${READER_POLICY_VERSION}_${options.reportsOnly?'reports':options.summaryOnly?'summary':options.selectedOnly?'selected':'all'}_cursor`;
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
      ${options.reportsOnly ? tx`AND p.article_id IN (SELECT cited->>'itemId' FROM reports r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.content->'sections',r.content->'themes','[]'::jsonb) || jsonb_build_array(jsonb_build_object('items',coalesce(r.content->'flashes','[]'::jsonb)))) grp CROSS JOIN LATERAL jsonb_array_elements(coalesce(grp->'items',grp->'storyRefs','[]'::jsonb)) cited)` : tx``}
      AND EXISTS (SELECT 1 FROM sources policy_s WHERE policy_s.id=p.source_id AND policy_s.site_fulltext) ${options.selectedOnly ? tx`AND p.selected` : tx``}
      ${options.summaryOnly ? tx`AND (p.visibility='summary-only' OR EXISTS (SELECT 1 FROM sources recovery_s WHERE recovery_s.id=p.source_id AND NOT recovery_s.site_fulltext))` : tx``}
      ${cursor ? tx`AND (p.timeline_at,p.article_id)<(${cursor.at}::timestamptz,${cursor.id})` : tx``}
      ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT ${limit}`;
    let checked=0,ready=0,scanned=0,failed=0;let last:typeof headers[number]|undefined;const errors:Array<{articleId:string;code:string;error:string}>=[];
    for(const row of headers){
      if(Date.now()>=deadline)break;
      const [existing]=await tx`SELECT 1 FROM article_workflow_readiness WHERE article_id=${row.article_id} AND policy_version=${READER_POLICY_VERSION}`;
      if(!existing){
        try {ready+=Number(await tx.savepoint(sp=>refreshWorkflowReadinessTx(sp,row.article_id)));checked++;}
        catch(error){
          // 单篇的确定性报错不能把整轮游标卡死：以前这里只有超时/锁冲突被吞，其余错误直接抛出，
          // 于是 sql.begin 回滚、游标停在原地，那篇文章后面的每一条都要陪它一起等（而且没有日志）。
          // 现在一律记一次（第一次带原文、其余只计数），游标照常前进；真连不上库会先在 headers 查询上失败。
          const code=(error as {code?:string}).code??'';
          failed++;
          if(!errors.length)errors.push({articleId:row.article_id,code,error:error instanceof Error?(error.name+': '+error.message):String(error)});
        }
      }
      last=row;scanned++;
    }
    if(last)await tx`INSERT INTO settings(key,value) VALUES(${key},${tx.json({at:last.timeline_at.toISOString(),id:last.article_id})})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
    else if(!headers.length)await tx`DELETE FROM settings WHERE key=${key}`;
    if(errors.length)console.error(JSON.stringify({level:"error",msg:"workflow readiness recompute threw; cursor still advanced",...errors[0],failed}));
    return {checked,ready,scanned,failed,headers:headers.length,advanced:last?.article_id??null,wrapped:!headers.length,errors};
  });
}
