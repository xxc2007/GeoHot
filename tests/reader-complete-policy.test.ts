import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
import {loadItemDetail,exportMarkdown} from '@aihot/backend/publication/detail';
import {itemAvailability} from '@aihot/backend/publication/availability';
import {loadItemShare} from '@aihot/backend/publication/og';
import {v1Items} from '@aihot/backend/publication/v1';
import {itemFeed} from '@aihot/backend/publication/feeds';
import {prepareArticleMedia} from '@aihot/backend/media/prepare';
import {stopBoss} from '@aihot/backend/jobs/queue';
import {pendingTranslationRanks} from '@aihot/backend/editorial/translation-selector';
import {recoverWorkflowReadiness} from '@aihot/backend/operations/recover-workflow-readiness';
const source='reader-complete-'+tag();let n=0;
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at) VALUES(${source},'完整工作流测试','rss','T1','editorial',true,'2100-01-01')`;});
after(async()=>{await sql`DELETE FROM articles WHERE source_id=${source}`;await sql`DELETE FROM sources WHERE id=${source}`;await stopBoss();await closeDb();});
async function article(language='zh',html:string|null=null) {
 const {articleId:id}=await upsertMaterial({sourceId:source,url:`https://example.com/${source}/${++n}`,title:'原始报道',bodyText:language==='zh'?'这是完整中文正文，包含最后一段结尾。':'A complete original article with its final paragraph.',bodyHtml:html,language,bodyStatus:'ok',via:'fetch'});
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','完整中文标题','完整的中文摘要。',80,false)`;
 await publishArticle(id);return id;
}
async function hidden(id:string) {
 assert.equal((await loadItemDetail(id)).kind,'not_found');
 assert.equal(await exportMarkdown(id),null);assert.equal(await loadItemShare(id),null);
 assert.equal((await itemAvailability([id]))[id],'unavailable');
 assert.ok(!(await itemFeed('all',null)).includes(id));
 const items=await v1Items({mode:'all',window:'7d',by:'timeline',category:null,q:null,limit:100,cursor:null});
 assert.ok(!items.items.some(x=>x.id===id));
}
test('old readiness cannot bypass the versioned gate; republishing restores a complete article',async()=>{
 const id=await article();assert.equal((await loadItemDetail(id)).kind,'found');
 await sql`UPDATE article_workflow_readiness SET policy_version=1,ready=true WHERE article_id=${id}`;
 await hidden(id);await publishArticle(id);assert.equal((await loadItemDetail(id)).kind,'found');
});
test('summary-only and revoked full-text permission stay hidden even with stored ready=true',async()=>{
 const id=await article();await sql`UPDATE publications SET visibility='summary-only' WHERE article_id=${id}`;
 await publishArticle(id); // ordinary source publication returns public, so test explicit override separately
 await sql`UPDATE publications SET body_mode='summary' WHERE article_id=${id}`;
 await sql`INSERT INTO article_workflow_readiness(article_id,revision,analysis_id,ready,policy_version)
 SELECT article_id,revision,analysis_id,true,2 FROM publications WHERE article_id=${id} ON CONFLICT(article_id) DO UPDATE SET ready=true,policy_version=2`;
 await hidden(id);
 await sql`UPDATE sources SET site_fulltext=false WHERE id=${source}`;await publishArticle(id);await hidden(id);
 await sql`UPDATE sources SET site_fulltext=true WHERE id=${source}`;
});
test('partial, stale and malformed translations never fall back to a public foreign original',async()=>{
 const id=await article('en');await hidden(id);
 for(const [revision,complete,text] of [[1,false,'部分中文'],[0,true,'旧版中文'],[1,true,'中文乱码\uFFFD'],[1,true,'中文 ⟦G1⟧']] as const){
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin) VALUES(${id},'zh',${revision},${'<p>'+text+'</p>'},${text},${complete},'model') ON CONFLICT(article_id,lang) DO UPDATE SET revision=EXCLUDED.revision,complete=EXCLUDED.complete,body_html=EXCLUDED.body_html,body_text=EXCLUDED.body_text`;
  await publishArticle(id);await hidden(id);
 }
 await sql`UPDATE translations SET revision=1,complete=true,body_html='<p>完整中文译文及最后段落。</p>',body_text='完整中文译文及最后段落。' WHERE article_id=${id}`;
 await publishArticle(id);assert.equal((await loadItemDetail(id)).kind,'found');
});
test('plain-text full bodies appear in both the reader page and Markdown export',async()=>{
 const id=await article();const detail=await loadItemDetail(id);assert.equal(detail.kind,'found');
 if(detail.kind==='found')assert.ok(detail.detail.body?.zh?.includes('最后一段结尾'));
 assert.ok((await exportMarkdown(id))?.body.includes('最后一段结尾'));
});
test('an HTML-only video poster requires successful media preparation',async()=>{
 const id=await article('zh','<p>完整的中文正文。</p><video poster="https://example.com/necessary-poster.jpg"></video>');await hidden(id);
 const failed=await prepareArticleMedia(id,{produce:async()=>{throw Error('poster offline');}});assert.ok(failed.failed>0);await hidden(id);
 const result=await prepareArticleMedia(id,{produce:async()=>({body:Buffer.from('fixture'),type:'image/webp'})});
 assert.equal(result.ready,true);assert.equal((await loadItemDetail(id)).kind,'found');
});
test('a legacy translated attempt with a quality defect becomes retryable after its cooldown',async()=>{
 const id=await article('en');
 await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin) VALUES(${id},'zh',1,'<p>损坏译文�</p>','损坏译文�',true,'model')`;
 await publishArticle(id);await hidden(id);
 await sql`UPDATE publications SET discovered_at='2200-02-01' WHERE article_id=${id}`;
 await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,updated_at) VALUES(${id},1,1,'translated',now())`;
 const ranks=()=>pendingTranslationRanks(new Date(0),100,true,()=>{});
 assert.ok(!(await ranks()).some(x=>x.article_id===id));
 await sql`UPDATE translation_attempts SET updated_at=now()-interval '7 hours' WHERE article_id=${id}`;
 assert.ok((await ranks()).some(x=>x.article_id===id));
});
test('one locked article cannot roll back or starve the rest of a recovery batch',async()=>{
 const key='workflow_readiness_selected_cursor';const [saved]=await sql`SELECT value FROM settings WHERE key=${key}`;
 await sql`DELETE FROM settings WHERE key=${key}`;
 const ids:string[]=[];
 for(let i=0;i<3;i++){
  const id=await article();ids.push(id);
  await sql`UPDATE publications SET selected=true,timeline_at=${new Date(Date.UTC(2200,0,i+1))} WHERE article_id=${id}`;
  await sql`UPDATE article_workflow_readiness SET policy_version=1 WHERE article_id=${id}`;
 }
 let acquired!:()=>void,release!:()=>void;
 const locked=new Promise<void>(resolve=>{acquired=resolve;});const unlocked=new Promise<void>(resolve=>{release=resolve;});
 const holding=sql.begin(async tx=>{await tx`SELECT id FROM articles WHERE id=${ids[1]!} FOR UPDATE`;acquired();await unlocked;});
 await locked;
 try{
  const result=await recoverWorkflowReadiness({selectedOnly:true,limit:3,budgetMs:4000});
  assert.equal('failed' in result ? result.failed:undefined,1);
  const rows=await sql`SELECT article_id,policy_version FROM article_workflow_readiness WHERE article_id=ANY(${ids})`;
  assert.equal(rows.find(x=>x.article_id===ids[0])?.policy_version,2);
  assert.equal(rows.find(x=>x.article_id===ids[2])?.policy_version,2);
  assert.equal(rows.find(x=>x.article_id===ids[1])?.policy_version,1);
 }finally{
  release();await holding;await sql`DELETE FROM settings WHERE key=${key}`;
  if(saved)await sql`INSERT INTO settings(key,value) VALUES(${key},${sql.json(saved.value as never)})`;
 }
});
