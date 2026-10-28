import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import './setup.ts';
import postgres from 'postgres';
const originalUrl = process.env.DATABASE_URL!;
const adminUrl = new URL(originalUrl); adminUrl.pathname='/postgres';
const admin = postgres(adminUrl.toString(),{max:1});
const isolatedName = 'reader_gate_'+process.pid+'_'+Date.now()+'_test';
await admin.unsafe('CREATE DATABASE "'+isolatedName+'"');
const isolatedUrl = new URL(originalUrl); isolatedUrl.pathname='/'+isolatedName;
process.env.DATABASE_URL=isolatedUrl.toString();
const {sql,closeDb}=await import('../packages/backend/src/db.ts');
const {rawWorkflowReadyCondition:workflowReadyCondition}=await import('../packages/backend/src/publication/readiness.ts');
const database = new URL(process.env.DATABASE_URL ?? 'postgres://unset/unset').pathname.slice(1);
if (!/_(test|ci)$/.test(database)) throw new Error('Requires a disposable *_test or *_ci database');
after(async()=>{ await closeDb(); await admin.unsafe('DROP DATABASE "'+isolatedName+'"');await admin.end(); });
before(async () => {
 await sql.unsafe(`CREATE TABLE sources(id text PRIMARY KEY,site_fulltext boolean);
 CREATE TABLE articles(id text PRIMARY KEY,source_id text,revision int,language text,body_status text,body_text text,x_post jsonb,body_html text,media jsonb);
 CREATE TABLE article_media_readiness(article_id text PRIMARY KEY,revision int,fingerprint text,ready boolean);
 CREATE TABLE analyses(id int PRIMARY KEY,article_id text,input_revision int,relevance text);
 CREATE TABLE translations(article_id text,lang text,revision int,complete boolean,body_html text,body_text text);
 CREATE TABLE publications(article_id text PRIMARY KEY,analysis_id int,title text,summary text,visibility text,channel text,body_mode text);`);
 await sql`INSERT INTO sources VALUES ('licensed',true),('summary',false)`;
});
let seq=0;
async function fixture(opts: Record<string, any> = {}) {
 const id=`ready-${++seq}`;
 await sql`INSERT INTO articles(id,source_id,revision,language,body_status,body_text,x_post) VALUES (${id},${opts.source ?? 'licensed'},1,${opts.language ?? 'en'},${opts.bodyStatus ?? 'ok'},${opts.body ?? 'English article paragraph '.repeat(8)},${opts.x ? sql.json({text:opts.body ?? 'English post paragraph '.repeat(8)}) : null})`;
 await sql`INSERT INTO analyses VALUES (${seq},${id},${opts.analysisRevision ?? 1},'pass')`;
 await sql`INSERT INTO publications VALUES (${id},${opts.noAnalysis ? null : seq},'中文标题','中文摘要',${opts.visibility ?? 'public'},${opts.x ? 'x' : 'news'},${opts.bodyMode ?? 'full'})`;
 return id;
}
async function ready(id: string) { const [r] = await sql<{ready:boolean}[]>`SELECT ${workflowReadyCondition()} AS ready FROM publications p WHERE p.article_id=${id}`; return r!.ready; }
async function translation(id: string, complete: boolean, revision=1, body='完整中文译文') { await sql`INSERT INTO translations VALUES (${id},'zh',${revision},${complete},${`<p>${body}</p>`},${body})`; }
test('foreign full text waits for a complete nonempty current revision translation; completion automatically restores it', async()=> {
 const id=await fixture(); assert.equal(await ready(id),false);
 await translation(id,false); assert.equal(await ready(id),false);
 await sql`UPDATE translations SET complete=true WHERE article_id=${id}`; assert.equal(await ready(id),true);
 await sql`UPDATE articles SET revision=2 WHERE id=${id}`; assert.equal(await ready(id),false);
 await sql`UPDATE analyses SET input_revision=2 WHERE article_id=${id}`; assert.equal(await ready(id),false);
 await sql`UPDATE translations SET revision=2 WHERE article_id=${id}`; assert.equal(await ready(id),true);
});
test('pending or empty licensed body and stale/missing analysis never masquerade as permitted summaries',async()=> {
 for (const opts of [{bodyStatus:'pending'},{body:''},{analysisRevision:0},{noAnalysis:true}]) {
  const id=await fixture(opts); await translation(id,true); assert.equal(await ready(id),false);
 }
});
test('native Chinese bodies do not require machine translation; sample fallback matches bodyIsChinese',async()=> {
 assert.equal(await ready(await fixture({language:'zh',body:'中文原稿'})),true);
 assert.equal(await ready(await fixture({language:'fr',body:'以中文撰写的原文'})),true);
 assert.equal(await ready(await fixture({language:'en',body:'English 引述一句中文'})),false);
});
test('summary-only sources and partial reader projections are withheld under the complete-reader policy',async()=> {
 assert.equal(await ready(await fixture({source:'summary',bodyStatus:'none',body:''})),false);
 assert.equal(await ready(await fixture({visibility:'summary-only',bodyStatus:'none',body:''})),false);
 assert.equal(await ready(await fixture({source:'summary',noAnalysis:true})),false);
});
test('empty and echo translations are rejected even when complete flag is true',async()=> {
 for(const body of ['', 'Untranslated source paragraph']) { const id=await fixture(); await translation(id,true,1,body); assert.equal(await ready(id),false); }
});
test('Chinese X posts and intentional short foreign X posts retain semantics; substantive foreign posts wait',async()=> {
 assert.equal(await ready(await fixture({x:true,language:'zh',body:'中文原帖'})),true);
 assert.equal(await ready(await fixture({x:true,body:'Breaking https://example.com/test'})),true);
 const id=await fixture({x:true}); assert.equal(await ready(id),false); await translation(id,true); assert.equal(await ready(id),true);
});

test('a Chinese body cannot bypass a stale summary projection',async()=> { assert.equal(await ready(await fixture({language:'zh',body:'中文正文',bodyMode:'summary'})),false); });
