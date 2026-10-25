// Operator-only, evidence-bound registry replacement. Default dry-run; never removes articles.
import { readFileSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";
import { lockRegistry } from "@aihot/backend/sources/registry";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { audit } from "@aihot/backend/admin/auth";

const apply=process.argv.includes('--apply');
const file=process.argv.find(x=>x.startsWith('--manifest='))?.slice(11);
if(!file || !process.env.DATABASE_URL) throw Error('Explicit DATABASE_URL and --manifest=... required');
const manifest=JSON.parse(readFileSync(file,'utf8'));
const reserves=manifest.sources as Array<Record<string,any>>;
if(reserves.length!==334 || new Set(reserves.map(s=>s.id)).size!==334) throw Error('Exactly 334 unique verified reserves required');
for(const s of reserves){
  assertSupportedConfig(s.kind,s.config);
  if(!s.validation?.checkedAt || Date.parse(s.validation.checkedAt)<Date.now()-7*86400_000 || !s.validation.ok) throw Error(`Fresh verification required: ${s.id}`);
  if(!['rss','json_list'].includes(s.kind)) throw Error('Only public RSS/JSON reserves');
}
try {
const result=await sql.begin(async tx=>{
  await lockRegistry(tx);
  await tx`SET LOCAL lock_timeout='3s'`;
  await tx`SET LOCAL statement_timeout='15s'`;
  const [before]=await tx`SELECT count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled FROM sources`;
  if(before!.enabled!==666)throw Error('Active count changed; expected 666');
  const overlap=await tx`SELECT id FROM sources WHERE enabled AND id=ANY(${reserves.map(s=>s.id)}::text[])`;
  if(overlap.length)throw Error('Reserve manifest overlaps active pool');
  if(!apply)return {mode:'dry-run',before,reserves:334,poolAfter:1000};
  await tx`UPDATE source_registry_policy SET target_enabled=666,target_total=NULL,automatic_failover=false,policy_version=policy_version+1,updated_by='operator:reserve-pool',reason='666 active + 334 verified reserves; requested by owner' WHERE singleton`;
  const retired=await tx`SELECT * FROM sources WHERE NOT enabled AND NOT(id=ANY(${reserves.map(s=>s.id)}::text[])) FOR UPDATE`;
  for(const old of retired){
    await tx`INSERT INTO source_retirements(source_id,source_snapshot,reason) VALUES(${old.id},${tx.json(old)},'Unusable or superseded endpoint removed from live registry; preserve historical attribution') ON CONFLICT(source_id) DO NOTHING`;
    // Historical articles/publications stay intact. Empty never-used rows may be safely removed below.
  }
  await tx`DELETE FROM source_reserves`;
  for(const s of reserves){
    await tx`INSERT INTO sources(id,name,kind,config,tier,participation_mode,interval_minutes,first_party,tags,enabled,health,default_category,site_fulltext,syndicate_fulltext)
      VALUES(${s.id},${s.name},${s.kind},${tx.json(s.config)},${s.tier??'T1_5'},'editorial',${s.interval_minutes??720},${s.first_party??false},${s.tags??[]},false,'paused',${s.default_category??null},false,false)
      ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,name=EXCLUDED.name,health='paused',fail_count=0,last_error=NULL,updated_at=now()`;
    await tx`INSERT INTO source_reserves(source_id,validated_at,validation,priority,next_check_at)
      VALUES(${s.id},${s.validation.checkedAt},${tx.json(s.validation)},${s.priority??50},now()+interval '1 minute'*${reserves.indexOf(s)*2})`;
  }
  // Delete only rows with no references in *any* FK table. Archive stores the exact source snapshot.
  const refs=await tx`SELECT c.conrelid::regclass::text AS table_name,a.attname AS column_name FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE c.contype='f' AND c.confrelid='sources'::regclass`;
  let deleted=0;
  const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
  for(const old of retired){
    let referenced=false;
    for(const ref of refs){const table=String(ref.table_name).split('.').map(quote).join('.');const rows=await tx.unsafe(`SELECT 1 FROM ${table} WHERE ${quote(ref.column_name)}=$1 LIMIT 1`,[old.id]);if(rows.length){referenced=true;break;}}
    if(!referenced){await tx`DELETE FROM sources WHERE id=${old.id} AND NOT enabled`;deleted++;}
  }
  const [after]=await tx`SELECT count(*) FILTER(WHERE enabled)::int AS enabled,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id))::int AS pool FROM sources s`;
  if(after!.enabled!==666||after!.pool!==1000)throw Error('Final registry counts differ from 666/1000');
  await tx`UPDATE source_registry_policy SET target_total=1000,automatic_failover=true WHERE singleton`;
  await audit('operator:reserve-pool','source.pool-provision',null,'Owner requested 1000 total,666 active and automatic verified reserve failover',before,{...after,retired:retired.length,deleted,reserves:334},undefined,tx);
  return {mode:'applied',before,after,retired:retired.length,deleted,reserves:334};
});console.log(JSON.stringify(result));
}finally{await closeDb();}
