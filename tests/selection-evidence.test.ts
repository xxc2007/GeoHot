import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import postgres from 'postgres';
import {execFileSync} from 'node:child_process';
const target=new URL(process.env.DATABASE_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname))throw new Error('Local evidence fixture only');
const name=`geohot_evidence_${tag()}_test`,adminUrl=new URL(target);adminUrl.pathname='/postgres';
const admin=postgres(adminUrl.toString(),{max:1});await admin.unsafe(`CREATE DATABASE "${name}"`);target.pathname='/'+name;process.env.DATABASE_URL=target.toString();
execFileSync(process.execPath,['scripts/migrate.ts'],{env:process.env,stdio:'pipe'});
const {sql,closeDb}=await import('@aihot/backend/db');const {upsertMaterial}=await import('@aihot/backend/content/materials');
const {publishArticle}=await import('@aihot/backend/publication/publish');const {stopBoss,ensureQueue,QUEUES}=await import('@aihot/backend/jobs/queue');
after(async()=>{await stopBoss();await closeDb();await admin.unsafe(`DROP DATABASE "${name}"`);await admin.end()});
await ensureQueue(QUEUES.notifySelected);await ensureQueue(QUEUES.prepareMedia);
await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES('evidence-test','Official science','rss','T1','editorial',true)`;
async function article(n:number,extra:Record<string,unknown>={}){
const title='二氧化碳直接辐射强迫增强可致印度夏季降温';
const {articleId}=await upsertMaterial({sourceId:'evidence-test',url:`https://example.org/evidence/${n}`,title,via:'fetch',...extra});
await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${articleId},1,'model','pass',${title},'模型在没有正文时仍写出的流畅导读并不能作为原始证据。',99,true)`;
return articleId;
}
const releasedAt=new Date(Date.now()-60000);
const {hasSelectionEvidence}=await import('@aihot/backend/publication/selection-evidence');
test('headline fragments, repeated headlines, HTML wrappers/entities and pure numeric garbage add no source evidence',()=>{
const title='研究指出二氧化碳直接辐射强迫增强可致印度夏季降温';
for(const bodyText of [title.slice(0,20)+'…',title+title,`<p>${title}</p>`,'<a href="https://example.org/research">Read more</a>','&nbsp;'.repeat(20),'0123456789'.repeat(3)])assert.equal(hasSelectionEvidence({title,bodyStatus:'ok',bodyText,excerpt:null,xPost:null}),false,bodyText);
});
test('short independent Chinese and quantified English alerts do not need an arbitrary minimum length',()=>{
for(const bodyText of ['黄河下游解除洪水预警。','M7.1, Nepal, 10 km.'])assert.equal(hasSelectionEvidence({title:'机构快讯',bodyStatus:'ok',bodyText,excerpt:null,xPost:null}),true,bodyText);
});
test('title-only official material retains original and analysis but cannot enter automatic selection',async()=>{
const id=await article(1);const result=await publishArticle(id,{releasedAt});assert.equal(result?.selected,false);
const [row]=await sql`SELECT p.eligible,p.selected,a.title,(SELECT count(*)::int FROM analyses WHERE article_id=a.id) AS analyses FROM publications p JOIN articles a ON a.id=p.article_id WHERE a.id=${id}`;assert.equal(row!.eligible,true);assert.equal(row!.analyses,1);assert.ok(row!.title);
});
test('independent source excerpt can support selection without licensed fulltext',async()=>{
const id=await article(2,{excerpt:'研究团队使用数值模式区分二氧化碳直接辐射效应与海温反馈，发现印度夏季地表温度响应的区域差异。'});assert.equal((await publishArticle(id,{releasedAt}))?.selected,true);
});
test('a body that only repeats the headline is still title-only',async()=>{
const id=await article(3,{bodyText:'二氧化碳直接辐射强迫增强可致印度夏季降温。',bodyStatus:'ok'});assert.equal((await publishArticle(id,{releasedAt}))?.selected,false);
});
test('link-only X wrapper supplies no substantive source evidence',async()=>{
const id=await article(4,{xPost:{tweetId:'123456789',authorName:'Agency',handle:'agency',text:'https://example.org/research'}});assert.equal((await publishArticle(id,{releasedAt}))?.selected,false);
});
test('actual short X alert remains source evidence even when its own text is also the title',async()=>{
const text='地震快讯：北纬30.2度、东经102.1度发生4.5级地震，震源深度10千米。';const id=await article(5,{title:text,xPost:{tweetId:'123456790',authorName:'Agency',handle:'agency',text}});assert.equal((await publishArticle(id,{releasedAt}))?.selected,true);
});
test('explicit editor promotion keeps its required operation reason without requiring a separate recommendation',async()=>{
const id=await article(6);await sql`INSERT INTO editorial_overrides(article_id,version,fields) VALUES(${id},1,${sql.json({selected:true})})`;assert.equal((await publishArticle(id,{releasedAt}))?.selected,false);
await sql`UPDATE editorial_overrides SET reason='编辑决定保留这条简讯。' WHERE article_id=${id}`;assert.equal((await publishArticle(id,{releasedAt}))?.selected,true);
});
test('losing source evidence removes the selected ledger entry without deleting material or analysis',async()=>{
const id=await article(7,{bodyText:'研究团队使用数值模式区分二氧化碳直接辐射效应与海温反馈，发现印度夏季地表温度响应的区域差异。',bodyStatus:'ok'});
assert.equal((await publishArticle(id,{releasedAt}))?.selected,true);
await sql`UPDATE articles SET body_text=NULL,body_status='none' WHERE id=${id}`;
const result=await publishArticle(id,{releasedAt});assert.equal(result?.selected,false);assert.equal(result?.reduced,true);assert.equal(result?.ledger,'remove');
const [state]=await sql`SELECT in_set FROM selected_state WHERE article_id=${id}`;assert.equal(state!.in_set,false);
const [kept]=await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${id}`;assert.equal(kept!.n,1);
});
test('the real admin override accepts its operation reason with no optional recommendation',async()=>{
const id=await article(8);await publishArticle(id,{releasedAt});
const {overrideFields}=await import('@aihot/backend/admin/content');
await overrideFields(id,{fields:{selected:true},reason:'编辑决定保留此简讯。',version:0},'evidence-test-editor');
const [row]=await sql`SELECT p.selected,o.reason,o.fields FROM publications p JOIN editorial_overrides o ON o.article_id=p.article_id WHERE p.article_id=${id}`;
assert.equal(row!.selected,true);assert.equal(row!.reason,'编辑决定保留此简讯。');assert.equal(row!.fields.reason,undefined);
});
