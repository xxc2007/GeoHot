import {tag,purgeTagged} from './setup.ts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial,type MaterialInput} from '@aihot/backend/content/materials';
import {normalizeDoi} from '@aihot/backend/content/material-identity';
import {identityKeyForUrl} from '@aihot/backend/lib/url';
import {ingestItems} from '@aihot/backend/ingest/items';
import {spawnSync} from 'node:child_process';
const T=tag(),live=`alias-live-${T}`,archive=`alias-archive-${T}`,ingest=`alias-ingest-${T}`;
before(async()=>{for(const id of [live,archive,ingest])await sql`INSERT INTO sources(id,name,kind) VALUES(${id},${id},'external')`;});
after(async()=>{await sql`DELETE FROM receipts WHERE logical_key=${`alias-receipt-${T}`}`;await purgeTagged(live,archive,ingest);await closeDb();});
for(const order of ['live-first','archive-first','concurrent'])test(`three entrances converge ${order}`,async()=>{
 const url=`https://example.org/${T}/${order}`,doi=`10.1234/${T}-${order}`;
 const a={sourceId:live,url,title:'Original',bodyText:'Original full text',via:'fetch' as const};
 const b={sourceId:archive,url,title:'Archive rendering',bodyText:'Archive abstract',identityKey:`doi:${doi}`,via:'import' as const};
 const c={sourceId:ingest,url,title:'External rendering',raw:{original:true},via:'ingest' as const};
 const inputs:MaterialInput[]=order==='archive-first'?[b,a,c]:[a,b,c];
 const results=order==='concurrent'?await Promise.all(inputs.map(m=>upsertMaterial(m))):[];
 if(order!=='concurrent')for(const m of inputs)results.push(await upsertMaterial(m));
 assert.equal(new Set(results.map(r=>r.articleId)).size,1);
 assert.equal(results.filter(r=>r.created).length,1);
 assert.equal((await sql`SELECT count(*)::int AS n FROM article_discoveries WHERE article_id=${results[0]!.articleId}`)[0]!.n,3);
 assert.equal((await sql`SELECT count(*)::int AS n FROM material_observations WHERE article_id=${results[0]!.articleId}`)[0]!.n,3);
 await upsertMaterial(inputs[0]!);
 assert.equal((await sql`SELECT count(*)::int AS n FROM material_observations WHERE article_id=${results[0]!.articleId}`)[0]!.n,3);
 const [stored]=await sql`SELECT body_text FROM articles WHERE id=${results[0]!.articleId}`;
 assert.equal(stored!.body_text,inputs[0]!.bodyText);
});
test('DOI normalization preserves suffix punctuation, rejects invalid escaping and references',()=>{
 assert.equal(normalizeDoi(' DOI:10.1234/ABC.(1) '),'10.1234/abc.(1)');
 assert.equal(normalizeDoi('https://doi.org/10.1234%2FABC'),'10.1234/abc');
 assert.equal(normalizeDoi('https://other.example/10.1234/abc'),null);
 assert.equal(normalizeDoi('10.1234/%GG'),null);
 assert.equal(normalizeDoi('References:10.1234/abc'),null);
});
test('structured DOI bridges distinct URLs; unbridged URL, reference DOI and fragment sections remain distinct',async()=>{
 const doi=`10.1234/${T}-bridge`;
 const a=await upsertMaterial({sourceId:archive,url:`https://publisher.example/${T}`,doi,title:'Paper',via:'import'});
 const b=await upsertMaterial({sourceId:live,url:`https://doi.org/${doi.toUpperCase()}`,title:'Same paper',via:'fetch'});
 assert.equal(a.articleId,b.articleId);
 const c=await upsertMaterial({sourceId:live,url:`https://other.example/${T}`,title:'Commentary',bodyText:`References ${doi}`,via:'fetch'});
 assert.notEqual(c.articleId,a.articleId);
 const fragment=async(n:number)=>upsertMaterial({sourceId:live,url:`https://release.example/${T}#${n}`,identityKey:`url:https://release.example/${T}#${n}`,doi,title:'Section',via:'fetch'});
 assert.notEqual((await fragment(1)).articleId,(await fragment(2)).articleId);
 assert.equal((await sql`SELECT count(*)::int AS n FROM article_identity_aliases WHERE alias_key=${`url:https://release.example/${T}`}`)[0]!.n,0);
});
test('legacy DOI-only row reuses existing ID and body with exact URL reverse arrival',async()=>{
 const url=`https://legacy.example/${T}`,id=`legacy${T}`;
 await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,discovered_at,timeline_at) VALUES(${id},${archive},${`doi:10.1234/${T}-legacy`},${url},'Legacy','Original','ok',now(),now())`;
 const r=await upsertMaterial({sourceId:live,url,title:'RSS',bodyText:'Different rendering',via:'fetch'});
 assert.equal(r.articleId,id);assert.equal(r.created,false);
 assert.equal((await sql`SELECT body_text FROM articles WHERE id=${id}`)[0]!.body_text,'Original');
});
test('existing legacy twin IDs are quarantined without alias theft or canonical writes; HTTP preserves evidence',async()=>{
 const url=`https://conflict.example/${T}`,doi=`10.1234/${T}-conflict`,ids=[`twinA${T}`,`twinB${T}`];
 for(const [n,id]of ids.entries())await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${id},${live},${n?`doi:${doi}`:identityKeyForUrl(url)},${url},'Preserved',now(),now())`;
 const before=await sql`SELECT id,revision,title,updated_at FROM articles WHERE id=ANY(${ids}) ORDER BY id`;
 const [receipt]=await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,cost,attempts) VALUES(${`alias-receipt-${T}`},'local-fixture','test',${ids[0]!},'completed',1.25,1) RETURNING id`;
 await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,billing_status,cost) VALUES(${receipt!.id},1,'local-fixture','received','billed',1.25)`;
 const paidBefore=await sql`SELECT row_to_json(r) AS receipt,(SELECT jsonb_agg(a ORDER BY a.id) FROM receipt_attempts a WHERE a.receipt_id=r.id) AS attempts FROM receipts r WHERE id=${receipt!.id}`;
 const r=await upsertMaterial({sourceId:archive,url,doi,title:'Do not merge',raw:{original:'retain'},via:'import'});
 assert.equal(r.quarantined,true);assert.equal(r.created,false);assert.equal(r.revised,false);
 assert.deepEqual(await sql`SELECT id,revision,title,updated_at FROM articles WHERE id=ANY(${ids}) ORDER BY id`,before);
 assert.equal((await sql`SELECT count(*)::int AS n FROM article_identity_aliases WHERE article_id=ANY(${ids})`)[0]!.n,0);
 const response=await ingestItems({sourceId:ingest,items:[{url,title:'Conflict HTTP'}]});
 assert.equal(response.quarantined,1);assert.equal(response.created,0);
 assert.equal((await sql`SELECT count(*)::int AS n FROM material_observations WHERE conflict_id IS NOT NULL AND source_id=${ingest}`)[0]!.n,1);
 assert.deepEqual(await sql`SELECT row_to_json(r) AS receipt,(SELECT jsonb_agg(a ORDER BY a.id) FROM receipt_attempts a WHERE a.receipt_id=r.id) AS attempts FROM receipts r WHERE id=${receipt!.id}`,paidBefore);
});
test('contradictory document DOI is isolated rather than attached to an existing DOI',async()=>{
 const url=`https://contradict.example/${T}`;
 const a=await upsertMaterial({sourceId:live,url,doi:`10.1234/${T}-original`,title:'Original paper',via:'fetch'});
 const b=await upsertMaterial({sourceId:archive,url,doi:`10.1234/${T}-correction`,title:'Correction',via:'import'});
 assert.equal(b.quarantined,true);
 assert.equal((await sql`SELECT count(*)::int AS n FROM article_identity_aliases WHERE article_id=${a.articleId} AND alias_key=${`doi:10.1234/${T}-correction`}`)[0]!.n,0);
});
test('transaction abort leaves no canonical row, aliases or observation',async()=>{
 const url=`https://rollback.example/${T}`;
 await assert.rejects(sql.begin(async tx=>{await upsertMaterial({sourceId:live,url,title:'Rollback',via:'fetch'},tx);throw new Error('rollback fixture');}));
 assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE url=${url}`)[0]!.n,0);
 assert.equal((await sql`SELECT count(*)::int AS n FROM article_identity_aliases WHERE alias_key=${identityKeyForUrl(url)}`)[0]!.n,0);
});
test('source lock precedes aliases so HTTP source ownership cannot deadlock a same-source collector',async()=>{
 let other:ReturnType<typeof upsertMaterial>|undefined;
 const url=`https://source-lock.example/${T}`;
 await sql.begin(async tx=>{
  await tx`SELECT id FROM sources WHERE id=${live} FOR UPDATE`;
  other=upsertMaterial({sourceId:live,url,title:'Same source',via:'fetch'});
  const deadline=Date.now()+5000;
  while(true){
   const [r]=await tx`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE%') AS waiting`;
   if(r!.waiting)break;if(Date.now()>deadline)throw new Error('Source wait not observed');await new Promise(r=>setTimeout(r,10));
  }
  await upsertMaterial({sourceId:live,url,title:'Same source',via:'fetch'},tx);
 });
 assert.equal((await other!).created,false);
});
test('bounded legacy seed is replayable and bridges a preexisting tracking URL without canonical writes',async()=>{
 const id=`zz${T}a`,url=`https://seed.example/${T}?utm_source=a`;
 await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${id},${archive},${`doi:10.1234/${T}-seed`},${url},'Seed preserved',now(),now())`;
 const before=await sql`SELECT id,identity_key,revision,updated_at FROM articles WHERE id=${id}`;
 for(let n=0;n<2;n++) {
  const run=spawnSync(process.execPath,['scripts/seed-material-aliases.ts',`--after=zz${T}`,'--limit=1','--apply','--database-url-env=DATABASE_URL'],{encoding:'utf8',env:process.env,timeout:15000});
  assert.equal(run.status,0,run.stdout+run.stderr);const report=JSON.parse(run.stdout.trim());assert.equal(report.registered,1);assert.equal(report.nextAfter,id);
 }
 assert.deepEqual(await sql`SELECT id,identity_key,revision,updated_at FROM articles WHERE id=${id}`,before);
 assert.equal((await sql`SELECT count(*)::int AS n FROM material_observations WHERE article_id=${id}`)[0]!.n,1);
 assert.equal((await upsertMaterial({sourceId:live,url:`https://seed.example/${T}`,title:'Incoming',via:'fetch'})).articleId,id);
});
test('same-source archive synopsis records its full observation without replacing owned full text or buying another revision',async()=>{
 const url=`https://synopsis.example/${T}`;
 const a=await upsertMaterial({sourceId:live,url,title:'Owned original',bodyText:'Complete original body',via:'fetch'});
 const before=await sql`SELECT revision,title,body_text,content_hash,updated_at FROM articles WHERE id=${a.articleId}`;
 const b=await upsertMaterial({sourceId:live,url,doi:`10.1234/${T}-synopsis`,title:'Archive alternate title',bodyText:'Archive abstract',via:'import',observationOnlyExisting:true});
 assert.equal(b.articleId,a.articleId);assert.equal(b.revised,false);
 assert.deepEqual(await sql`SELECT revision,title,body_text,content_hash,updated_at FROM articles WHERE id=${a.articleId}`,before);
 const [obs]=await sql`SELECT payload FROM material_observations WHERE article_id=${a.articleId} AND via='import'`;
 assert.equal(obs!.payload.bodyText,'Archive abstract');
});
