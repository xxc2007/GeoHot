// Own isolated DB: real666 capacity fixtures must not depend on or remove another suite's sources.
import { gate, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
const T = tag();
const url = new URL(process.env.DATABASE_URL!);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Source registry concurrency tests require localhost');
const dbName = `geohot_registry_${T}_test`;
const adminUrl = new URL(url);adminUrl.pathname='/postgres';
const admin = postgres(adminUrl.toString(),{max:1});
await admin.unsafe(`CREATE DATABASE "${dbName}"`);
url.pathname=`/${dbName}`;process.env.DATABASE_URL=url.toString();
execFileSync(process.execPath,['scripts/migrate.ts'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
const {sql,closeDb}=await import('@aihot/backend/db');
const {stopBoss,ensureQueue,QUEUES}=await import('@aihot/backend/jobs/queue');
const {setRegistryTarget,registryChange}=await import('@aihot/backend/sources/registry');
const {createSource,replaceSources,updateSource}=await import('@aihot/backend/admin/sources');
const {ingestItems}=await import('@aihot/backend/ingest/items');

async function reset() {
  await sql`UPDATE source_registry_policy SET target_enabled=NULL WHERE singleton`;
  await sql`DELETE FROM ingest_source_submissions`;
  await sql`DELETE FROM articles`;
  await sql`DELETE FROM sources`;
}
async function fixture(count:number,enabled:number) {
  await sql`INSERT INTO sources(id,name,kind,enabled,health,cursor,owner_entity_id)
    SELECT 'registry-'||n,'Fixture '||n,'external',n<=${enabled},CASE WHEN n<=${enabled} THEN 'ok' ELSE 'paused' END,
    jsonb_build_object('untouched',n),NULL FROM generate_series(1,${count}) n`;
}
async function state() {
  const [row]=await sql`SELECT target_enabled,enabled_count,policy_version,(SELECT count(*)::int FROM sources WHERE enabled) AS actual FROM source_registry_policy WHERE singleton`;
  assert.equal(row!.enabled_count,row!.actual);return row!;
}
async function version(id:string) { const [r]=await sql`SELECT updated_at FROM sources WHERE id=${id}`;return new Date(r!.updated_at).toISOString(); }
before(reset);
after(async()=>{try{await reset();}finally{await stopBoss();await closeDb();await admin.unsafe(`DROP DATABASE "${dbName}"`);await admin.end();}});

test('default policy is off and genuine671/666 activation preserves all rows/cursors',async()=>{
  await fixture(671,666);
  assert.equal((await state()).target_enabled,null);
  const before=await sql`SELECT id,enabled,cursor,updated_at FROM sources ORDER BY id`;
  await setRegistryTarget(666,666,'test','Reviewed existing capacity');
  assert.deepEqual(await sql`SELECT id,enabled,cursor,updated_at FROM sources ORDER BY id`,before);
  assert.equal((await state()).enabled_count,666);
  await assert.rejects(setRegistryTarget(665,666,'test','No automatic mass pause'));
  await assert.rejects(setRegistryTarget(666,665,'test','Wrong expected count'));
});

for (const mode of ['update/update','insert/insert','update/insert']) test(`direct concurrent ${mode} statements serialize and exactly one reaches666`,async()=>{
  await reset();await fixture(667,665);await setRegistryTarget(666,665,'test','race');
  const a=postgres(url.toString(),{max:1,connection:{application_name:'registry-race-A'}});
  const b=postgres(url.toString(),{max:1,connection:{application_name:'registry-race-B'}});
  const entered=gate<void>(),release=gate<void>();
  const first=a.begin(async tx=>{if(mode.startsWith('insert'))await tx`INSERT INTO sources(id,name,kind) VALUES('race-insert-A','A','external')`;else await tx`UPDATE sources SET enabled=true WHERE id='registry-666'`;entered.open();await release.promise;});
  await within(entered.promise,10000,'first transaction lock');
  const query=mode.endsWith('insert') ? b`INSERT INTO sources(id,name,kind) VALUES('race-insert-B','B','external')` : b`UPDATE sources SET enabled=true WHERE id='registry-667'`;
  const second=query.then(()=>({ok:true}),error=>({ok:false,error}));
  try {
    await within((async()=>{while(true){const [r]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='registry-race-B' AND wait_event_type='Lock') AS waiting`;if(r!.waiting)return;await tick();}})(),10000,'second connection visibly waiting');
  } finally {release.open();}
  await first;assert.equal((await second).ok,false);
  assert.equal((await state()).enabled_count,666);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id='registry-667'`)[0]!.enabled,false);
  await a.end();await b.end();
});

test('counter covers conflict-do-nothing, no-op updates, delete and rollback; managed truncate refused',async()=>{
  await reset();await fixture(2,2);await setRegistryTarget(2,2,'test','small cap');
  await sql`INSERT INTO sources(id,name,kind) VALUES('registry-1','repeat','external') ON CONFLICT DO NOTHING`;
  await sql`UPDATE sources SET enabled=enabled WHERE id='registry-1'`;
  assert.equal((await state()).enabled_count,2);
  await assert.rejects(sql`INSERT INTO sources(id,name,kind) VALUES('too-many','extra','external')`);
  await assert.rejects(sql.begin(async tx=>{await tx`UPDATE sources SET enabled=false WHERE id='registry-1'`;throw new Error('rollback');}));
  assert.equal((await state()).enabled_count,2);
  await assert.rejects(sql`TRUNCATE sources CASCADE`);
  await sql`DELETE FROM sources WHERE id='registry-1'`;
  assert.equal((await state()).enabled_count,1);
});

test('full registry quarantines20 unknown submissions idempotently with no source/article/job',async()=>{
  await reset();await fixture(671,666);await setRegistryTarget(666,666,'test','quarantine');
  const payload=(n:number)=>({sourceId:`unknown-${n}`,items:[{title:'Evidence',url:`https://example.com/${T}/${n}`,publishedAt:'2026-01-02'}]});
  const answers=await Promise.all(Array.from({length:20},(_,n)=>ingestItems(payload(n))));
  assert.ok(answers.every(a=>a.quarantined===1&&a.created===0));
  const repeat=await ingestItems(payload(0));assert.equal(repeat.submissionId,answers[0]!.submissionId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM ingest_source_submissions`)[0]!.n,20);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM sources`)[0]!.n,671);
  await assert.rejects(ingestItems({sourceId:'registry-671',items:[{title:'Paused',url:'https://example.com/paused'}]}),/paused/);
  const result=await ingestItems({sourceId:'registry-1',items:[{title:'Known',url:`https://example.com/${T}/known`}]});
  assert.equal(result.created,1);assert.equal((await state()).enabled_count,666);
  await assert.rejects(ingestItems({sourceId:'oversized',items:[{title:'Large',url:'https://example.com/large',raw:{data:'x'.repeat(600000)}}]}),/512 KiB/);
});

test('managed admin creates a disabled candidate; replacement state/audit/jobs rollback together',async()=>{
  await reset();await fixture(3,2);await setRegistryTarget(2,2,'test','replacement');
  const created=await createSource({id:'reviewed-new',name:'New candidate',kind:'external',config:{}},'test');
  assert.equal(created.created&&created.source!.enabled,false);
  const policy=await state();
  const request={disable:[{id:'registry-1',version:await version('registry-1')}],enable:[{id:'registry-3',version:await version('registry-3')}],expectedPolicyVersion:policy.policy_version,reason:'Independent quality review',evidence:'sha256:review-fixture'};
  // A transaction-level fixture trigger simulates failure AFTER source changes/audit but before commit.
  await sql.unsafe("CREATE FUNCTION test_registry_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='source.replace' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END$$");
  await sql.unsafe('CREATE TRIGGER test_registry_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_registry_audit_fail()');
  await assert.rejects(replaceSources(request,'test'),/fixture rollback/);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id='registry-1'`)[0]!.enabled,true);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id='registry-3'`)[0]!.enabled,false);
  assert.equal((await state()).policy_version,policy.policy_version);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='source.replace'`)[0]!.n,0);
  await sql.unsafe('DROP TRIGGER test_registry_audit_fail ON audit_log');await sql.unsafe('DROP FUNCTION test_registry_audit_fail()');
  await ensureQueue(QUEUES.republishSource);
  await sql.unsafe("CREATE FUNCTION test_registry_job_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.name='publication.republish-source' AND NEW.data->>'sourceId'='registry-3' THEN RAISE EXCEPTION 'fixture queue rollback'; END IF; RETURN NEW; END$$");
  await sql.unsafe('CREATE TRIGGER test_registry_job_fail BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION test_registry_job_fail()');
  await assert.rejects(replaceSources(request,'test'),/fixture queue rollback/);
  assert.equal((await state()).policy_version,policy.policy_version);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='source.replace'`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.republishSource}`)[0]!.n,0);
  await sql.unsafe('DROP TRIGGER test_registry_job_fail ON pgboss.job');await sql.unsafe('DROP FUNCTION test_registry_job_fail()');
  await replaceSources(request,'test');assert.equal((await state()).enabled_count,2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='source.replace'`)[0]!.n,1);
  await assert.rejects(replaceSources(request,'test'),/version changed/);
  const id='registry-2';
  await assert.rejects(updateSource(id,{patch:{enabled:false},version:await version(id)},'test'),/requires a reason/);
  await updateSource(id,{patch:{enabled:false},version:await version(id),reason:'Emergency quarantine'},'test');
  assert.equal((await state()).enabled_count,1,'safe pause is allowed to create an honest gap');
});

test('metadata updates do not wait for the registry policy lock',async()=>{
  await reset();await fixture(1,1);
  const entered=gate<void>(),release=gate<void>();
  const holder=registryChange(async()=>{entered.open();await release.promise;});
  await entered.promise;
  try {await within(sql`UPDATE sources SET cursor='{"health-only":true}'::jsonb WHERE id='registry-1'`,10000,'health write independent of capacity lock');}
  finally {release.open();await holder;}
});

test('HTTP reports202 quarantine with no public item or model queue',async()=>{
  await reset();await fixture(2,2);await setRegistryTarget(2,2,'test','HTTP managed');
  process.env.INGEST_TOKEN='registry-local-ingest-token-0123456789';
  const {buildApp}=await import('../apps/api/src/app.ts');
  const app=await buildApp();
  try {
    const res=await app.inject({method:'POST',url:'/api/ingest/items',headers:{authorization:`Bearer ${process.env.INGEST_TOKEN}`},payload:{sourceId:'http-unknown',items:[{title:'Untrusted item',url:'https://example.com/http-isolated'}]}});
    assert.equal(res.statusCode,202);assert.equal(res.json().sourceStatus,'pending_review');assert.equal(res.json().created,0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles`)[0]!.n,0);
    assert.equal((await state()).enabled_count,2);
  }finally{await app.close();}
});

test('managed curated inproc preserves unknown evidence; managed seed preserves671 originals and adds disabled drafts',async()=>{
  await reset();await fixture(671,666);await setRegistryTarget(666,666,'test','operator seed protection');
  const originals=await sql`SELECT id,enabled,cursor,updated_at FROM sources ORDER BY id`;
  const dir=mkdtempSync(path.join(tmpdir(),'geohot-registry-'));
  try{
    const input=path.join(dir,'unknown.jsonl');
    writeFileSync(input,JSON.stringify({kind:'material',sourceId:'curated-unknown',title:'Historical evidence',url:'https://example.com/curated-isolated',publishedAt:'2026-01-02T00:00:00Z',bodyText:'Private pending source evidence'})+'\n');
    const run=(allow:boolean)=>spawnSync(process.execPath,['scripts/seed-curated.ts','--input',input,...(allow?['--allow-unknown-source']:[]),'--no-queue','--archive'],{encoding:'utf8',env:process.env,timeout:30000});
    for(let i=0;i<2;i++){
      const result=run(i===1);assert.equal(result.status,0,result.stdout+result.stderr);
      const answer=JSON.parse(result.stdout.split(/\r?\n/).findLast(line=>line.startsWith('{'))!);
      assert.equal(answer.quarantined,1);assert.equal(answer.created,0);assert.equal(answer.queued,0);
    }
    assert.equal((await sql`SELECT count(*)::int AS n FROM ingest_source_submissions`)[0]!.n,1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles`)[0]!.n,0);
    const seed=spawnSync(process.execPath,['scripts/seed.ts'],{encoding:'utf8',env:process.env,timeout:60000});
    assert.equal(seed.status,0,seed.stdout+seed.stderr);
    assert.deepEqual(await sql`SELECT id,enabled,cursor,updated_at FROM sources WHERE id LIKE 'registry-%' ORDER BY id`,originals);
    assert.equal((await state()).enabled_count,666);
    const pack=JSON.parse(readFileSync('industry/sources.json','utf8')) as {sources:Array<{id:string;enabled?:boolean}>};
    const candidate=pack.sources.find(s=>s.enabled!==false)!;
    assert.equal((await sql`SELECT enabled FROM sources WHERE id=${candidate.id}`)[0]!.enabled,false);
    const setState=spawnSync(process.execPath,['scripts/set-source-state.ts',`--ids=${candidate.id}`,'--apply',`--database-url=${url}`],{encoding:'utf8',env:process.env,timeout:15000});
    assert.notEqual(setState.status,0,'managed pack alignment must not auto-enable a candidate');
    assert.match(setState.stderr,/Managed enabled changes require/);
    assert.equal((await state()).enabled_count,666);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('disjoint reviewed replacements serialize while stale overlapping requests fail',async()=>{
  await reset();await fixture(6,3);await setRegistryTarget(3,3,'test','parallel replacement');
  const policy=await state();
  const request=async(out:string,into:string)=>({disable:[{id:out,version:await version(out)}],enable:[{id:into,version:await version(into)}],expectedPolicyVersion:policy.policy_version,reason:'Independent source review',evidence:'fixture:reviewed'});
  const a=await request('registry-1','registry-4'),b=await request('registry-2','registry-5');
  const stale=await request('registry-1','registry-6');
  await Promise.all([replaceSources(a,'test'),replaceSources(b,'test')]);
  assert.equal((await state()).enabled_count,3);
  assert.equal((await state()).policy_version,policy.policy_version);
  await assert.rejects(replaceSources(stale,'test'),/state or version changed/);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id='registry-6'`)[0]!.enabled,false);
  assert.equal((await state()).actual,3);
});

test('explicit legacy delete updates managed counter and transactional audit',async()=>{
  await reset();await fixture(2,1);await setRegistryTarget(1,1,'test','delete fixture');
  const result=spawnSync(process.execPath,['scripts/delete-sources.ts','Remove fixture source','registry-1','--yes'],{encoding:'utf8',env:process.env,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal((await state()).enabled_count,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='source.delete' AND subject='source:registry-1'`)[0]!.n,1);
});
