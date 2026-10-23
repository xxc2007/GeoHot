import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import postgres from 'postgres';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {classifyIngestResponse} from '@aihot/contracts/ingest';
const target=new URL(process.env.DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname))throw new Error('Local mixed-ingest fixture only');
const name=`geohot_mixed_${tag()}_test`,adminUrl=new URL(target);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1});
await admin.unsafe(`CREATE DATABASE "${name}"`);target.pathname='/'+name;process.env.DATABASE_URL=target.toString();process.env.INGEST_TOKEN='mixed-ingest-local-fixture-token-123456789';
execFileSync(process.execPath,['scripts/migrate.ts'],{env:process.env,stdio:'pipe'});
const {sql,closeDb}=await import('@aihot/backend/db');const {upsertMaterial}=await import('@aihot/backend/content/materials');
const {stopBoss,ensureQueue,QUEUES}=await import('@aihot/backend/jobs/queue');const {buildApp}=await import('../apps/api/src/app.ts');
const app=await buildApp();
after(async()=>{await app.close();await stopBoss();await closeDb();await admin.unsafe(`DROP DATABASE "${name}"`);await admin.end()});
for(const queue of Object.values(QUEUES))await ensureQueue(queue);

test('response contract separates source review, mixed material quarantine, skips and acceptance',()=>{
assert.throws(()=>classifyIngestResponse({ok:true,created:0,revised:0,skipped:[],quarantined:null},200,1),/Invalid ingest response/);
assert.deepEqual(classifyIngestResponse({ok:true,created:0,revised:0,skipped:[],quarantined:2,sourceStatus:'pending_review'},202,2),{created:0,revised:0,accepted:[],quarantined:[0,1],rejected:[]});
assert.deepEqual(classifyIngestResponse({ok:true,created:1,revised:0,skipped:[{index:1,reason:'identity conflict'},{index:2,reason:'invalid'}],quarantined:1,identityConflicts:[{index:1,conflictId:'9007199254740993'}]},202,3),{created:1,revised:0,accepted:[0],quarantined:[1],rejected:[2]});
for(const value of [
{ok:true,created:1,revised:0,skipped:[],quarantined:1,identityConflicts:[{index:1,conflictId:1}]},
{ok:true,created:0,revised:0,skipped:[{index:0}],quarantined:1,identityConflicts:[{index:1,conflictId:1}]},
{ok:true,created:0,revised:0,skipped:[{index:0}],quarantined:1,identityConflicts:[{index:0,conflictId:0}]},
{ok:true,created:0,revised:0,skipped:[{index:0},{index:0}],quarantined:1,identityConflicts:[{index:0,conflictId:1}]},
])assert.throws(()=>classifyIngestResponse(value,202,2),/Invalid ingest response/);
});

test('actual mixed HTTP import realigns accepted material only and preserves quarantined legacy twins',async()=>{
const source='mixed-review-source';await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'Mixed source','external')`;
const accepted=await upsertMaterial({sourceId:source,url:'https://example.org/mixed/a',title:'Accepted original',publishedAt:new Date('2026-01-02T00:00:00Z'),discoveredAt:new Date('2026-01-02T01:00:00Z'),via:'import',backfill:'archive'});
for(const [id,key]of [['mixed-twin-a','url:https://example.org/mixed/b'],['mixed-twin-b','doi:10.1234/mixed-twin']])await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,backfill) VALUES(${id!},${source},${key!},'https://example.org/mixed/b','Preserved twin','2026-01-02','2026-01-02','2026-01-02',true)`;
const twins=await sql`SELECT id,title,published_at,discovered_at,timeline_at,backfill,revision,raw FROM articles WHERE id IN ('mixed-twin-a','mixed-twin-b') ORDER BY id`;
await app.listen({host:'127.0.0.1',port:0});const base=app.listeningOrigin;
const dir=mkdtempSync(path.join(os.tmpdir(),'geohot-mixed-ingest-')),input=path.join(dir,'items.jsonl');
try{
writeFileSync(input,[{kind:'material',sourceId:source,title:'Accepted rewrite',url:'https://example.org/mixed/a',publishedAt:'2026-01-02T00:00:00Z'},{kind:'material',sourceId:source,title:'Conflicting rewrite',url:'https://example.org/mixed/b',publishedAt:'2026-01-02T01:00:00Z'}].map(v=>JSON.stringify(v)).join('\n')+'\n');
const result=await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const child=spawn(process.execPath,['scripts/seed-curated.ts','--route','http','--input',input,'--base-url',base],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
assert.equal(result.code,0,result.err);const response=JSON.parse(result.out.split(/\r?\n/).findLast(line=>line.startsWith('{'))!);
assert.equal(response.quarantined,1);assert.deepEqual(response.httpOutcomes.map((v:{status:string})=>v.status),['quarantined','accepted']);
assert.equal((await sql`SELECT backfill FROM articles WHERE id=${accepted.articleId}`)[0]!.backfill,false);
assert.deepEqual(await sql`SELECT id,title,published_at,discovered_at,timeline_at,backfill,revision,raw FROM articles WHERE id IN ('mixed-twin-a','mixed-twin-b') ORDER BY id`,twins);
assert.equal((await sql`SELECT count(*)::int AS n FROM material_observations WHERE source_id=${source} AND conflict_id IS NOT NULL`)[0]!.n,1);
}finally{unlinkSync(input);rmdirSync(dir)}
});
