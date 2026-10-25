// Resume only derived cache measurements. Never modify or replay a paid request.
import { mkdirSync,readFileSync,writeFileSync,renameSync } from "node:fs";
import path from "node:path";
import { retryModelLabelBatch } from "../packages/backend/src/admin/model-label-backfill.ts";
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required");
const target=new URL(process.env.DATABASE_URL),databaseId=`${target.hostname}:${target.port}${target.pathname}`;
const progress=path.resolve('.data/admin-usage-cache-progress.json');let cursor=0;
try{const saved=JSON.parse(readFileSync(progress,'utf8'));if(saved.databaseId!==databaseId)throw new Error('progress database mismatch');cursor=saved.cursor;}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
if(!Number.isSafeInteger(cursor)||cursor<0)throw new Error('invalid cursor');
const {sql,closeDb}=await import('@aihot/backend/db');
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
try{let batch=500,batches=0;for(;;){
  const result=await retryModelLabelBatch(size=>sql.begin(async db=>{
    await db`SET LOCAL statement_timeout='5s'`;await db`SET LOCAL lock_timeout='250ms'`;await db`SET LOCAL jit=off`;
    const ids=await db<{id:number}[]>`SELECT id FROM admin_model_attempt_metrics WHERE id>${cursor} ORDER BY id LIMIT ${size}`;
    if(!ids.length)return null;
    await db`UPDATE admin_model_attempt_metrics m SET tokens_cached=admin_metric_cached_tokens(a.usage),cache_checked=true
      FROM receipt_attempts a WHERE m.id=ANY(${ids.map(r=>r.id)}::bigint[]) AND a.id=m.id AND NOT m.cache_checked`;
    return ids.at(-1)!.id;
  }),batch,pause,(retry,size,code)=>console.log(`cache retry=${retry} batch=${size} code=${code}`));
  batch=result.batch;if(result.result===null)break;cursor=result.result;
  mkdirSync(path.dirname(progress),{recursive:true});writeFileSync(progress+'.tmp',JSON.stringify({databaseId,cursor})+'\n');renameSync(progress+'.tmp',progress);
  if(++batches%100===0)console.log(`cache cursor=${cursor}`);await pause(75);
}
await sql.begin(async db=>{await db`SET LOCAL statement_timeout='5s'`;
  if((await db`SELECT 1 FROM admin_model_attempt_metrics WHERE NOT cache_checked LIMIT 1`).length)throw new Error('cache backfill gap remains');
  await db`UPDATE settings SET value='true',updated_at=now() WHERE key='admin.usageCacheReady'`;});
console.log(`cache complete cursor=${cursor}`);
}finally{await closeDb();}
