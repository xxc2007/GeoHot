import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { parsePublishedAt } from "@aihot/backend/sources/dates";
import http from "node:http";

const url=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Reserve tests require a local disposable database');
const name=`geohot_reserves_${process.pid}_test`;
const adminUrl=new URL(url);adminUrl.pathname='/postgres';
const admin=postgres(adminUrl.toString(),{max:1});
await admin.unsafe(`CREATE DATABASE "${name}"`);
url.pathname=`/${name}`;process.env.DATABASE_URL=url.toString();
execFileSync(process.execPath,['scripts/migrate.ts'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
const {sql,closeDb}=await import('@aihot/backend/db');
const {swapReserve,maintainReserves}=await import('@aihot/backend/sources/reserves');
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,enabled,health,fail_count,last_ok_at,last_fetch_at,last_error)
    VALUES('failed','Failed','rss',true,'failing',6,now()-interval '3 days',now(),'HTTP 404'),
    ('healthy','Healthy','rss',true,'ok',0,now(),now(),NULL),
    ('reserve','Reserve','rss',false,'paused',0,NULL,NULL,NULL),
    ('reserve2','Reserve2','rss',false,'paused',0,NULL,NULL,NULL)`;
  await sql`INSERT INTO source_reserves(source_id,validated_at,validation) VALUES('reserve',now(),'{}'),('reserve2',now(),'{}')`;
  await sql`UPDATE source_registry_policy SET target_enabled=2,target_total=4,automatic_failover=true WHERE singleton`;
});
after(async()=>{await closeDb();await admin.unsafe(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();});

test('atomic failover preserves exact active count and consumes each reserve once',async()=>{
  const results=await Promise.all([swapReserve('failed','reserve',{items:3}),swapReserve('failed','reserve2',{items:3})]);
  assert.equal(results.filter(Boolean).length,1);
  const [p]=await sql`SELECT enabled_count,(SELECT count(*)::int FROM sources WHERE enabled) AS actual FROM source_registry_policy`;
  assert.equal(p!.actual,2);assert.equal(p!.enabled_count,2);
  const [old]=await sql`SELECT eligible FROM source_reserves WHERE source_id='failed'`;
  assert.equal(old!.eligible,false);
  assert.equal((await sql`SELECT * FROM audit_log WHERE action='source.auto-replace'`).length,1);
});
test('quota failures and recent successes cannot consume a reserve',async()=>{
  await sql`UPDATE sources SET health='failing',fail_count=9,last_ok_at=now()-interval '2 days',last_error='HTTP 429 quota' WHERE id='healthy'`;
  assert.equal(await swapReserve('healthy','reserve2',{}),false);
  await sql`UPDATE sources SET last_error='HTTP 404',last_ok_at=now() WHERE id='healthy'`;
  assert.equal(await swapReserve('healthy','reserve2',{}),false);
});
test('full registry blocks an extra source; retired IDs cannot be silently reseeded',async()=>{
  await assert.rejects(()=>sql`INSERT INTO sources(id,name,kind,enabled) VALUES('extra','extra','rss',false)`,/capacity exhausted/);
  await sql`INSERT INTO source_retirements(source_id,source_snapshot,reason) VALUES('retired','{}','invalid')`;
  await assert.rejects(()=>sql`INSERT INTO sources(id,name,kind,enabled) VALUES('retired','retired','rss',false)`,/explicitly reviewed/);
});
test('disabled automation performs no probes or swaps',async()=>{
  await sql`UPDATE source_registry_policy SET automatic_failover=false WHERE singleton`;
  assert.deepEqual(await maintainReserves(),{checked:0,replaced:0,state:'disabled'});
});
test('Crossref date parts preserve publication dates and reject invalid calendars',()=>{
  assert.equal(parsePublishedAt([2026,10,25],{unit:'date_parts'})?.toISOString(),'2026-10-25T00:00:00.000Z');
  assert.equal(parsePublishedAt([2026,2,30],{unit:'date_parts'}),null);
  assert.equal(parsePublishedAt([2026,0,1],{unit:'date_parts'}),null);
  assert.equal(parsePublishedAt([2026],{unit:'date_parts'})?.toISOString(),'2026-01-01T00:00:00.000Z');
});
test('metadata collector chooses online publication date and skips future-only entries',async()=>{
  const {config}=await import('@aihot/backend/config');
  const {fetchJsonList}=await import('@aihot/backend/sources/json-list');
  const was=config.allowPrivateNetworkFetch;config.allowPrivateNetworkFetch=true;
  const today=new Date();const current=[today.getUTCFullYear(),today.getUTCMonth()+1,today.getUTCDate()];
  const future=[today.getUTCFullYear()+1,1,1];
  let requestUrl='';
  const server=http.createServer((req,res)=>{requestUrl=req.url??'';res.setHeader('content-type','application/json');res.end(JSON.stringify({message:{items:[
    {title:['Already online'],DOI:'10.1234/online',published:{'date-parts':[future]},'published-online':{'date-parts':[current]}},
    {title:['Future only'],DOI:'10.1234/future',published:{'date-parts':[future]}}
  ]}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    const rows=await fetchJsonList({config:{url:`http://127.0.0.1:${port}/?until={today}`,itemsPath:'message.items',titlePaths:['title.0'],urlTemplate:'https://doi.org/{raw:DOI}',publishedAtPath:'published.date-parts.0',publishedAtUnit:'date_parts'}} as never);
    assert.equal(rows.length,1);assert.equal(rows[0]!.title,'Already online');assert.equal(rows[0]!.publishedAt?.toISOString().slice(0,10),today.toISOString().slice(0,10));
    assert.equal(requestUrl,`/?until=${today.toISOString().slice(0,10)}`);
  }finally{config.allowPrivateNetworkFetch=was;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
