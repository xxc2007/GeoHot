import {READER_POLICY_VERSION} from "@aihot/backend/publication/readiness";
import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {sql,closeDb} from '@aihot/backend/db';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
import {loadItemDetail,exportMarkdown} from '@aihot/backend/publication/detail';
import {itemAvailability} from '@aihot/backend/publication/availability';
import {v1Items} from '@aihot/backend/publication/v1';
import {itemFeed} from '@aihot/backend/publication/feeds';
import {prepareArticleMedia} from '@aihot/backend/media/prepare';
import {recoverBodyIntegrity} from '@aihot/backend/operations/recover-body-integrity';
import {stopBoss} from '@aihot/backend/jobs/queue';
import {pendingTranslationRanks} from '@aihot/backend/editorial/translation-selector';
import {recoverWorkflowReadiness} from '@aihot/backend/operations/recover-workflow-readiness';
const source='reader-complete-'+tag();let n=0;
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at) VALUES(${source},'完整工作流测试','rss','T1','editorial',true,'2100-01-01')`;});
after(async()=>{await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${source})`;await sql`DELETE FROM articles WHERE source_id=${source}`;await sql`DELETE FROM sources WHERE id=${source}`;await stopBoss();await closeDb();});
async function article(language='zh',html:string|null=null) {
 const {articleId:id}=await upsertMaterial({sourceId:source,url:`https://example.com/${source}/${++n}`,title:'原始报道',bodyText:language==='zh'?'这是完整中文正文，包含最后一段结尾。':'A complete original article with its final paragraph.',bodyHtml:html,language,bodyStatus:'ok',via:'fetch'});
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','完整中文标题','完整的中文摘要。',80,false)`;
 await publishArticle(id);return id;
}
async function hidden(id:string) {
 // 「藏」的两级：详情读得返回 not_found，或返回正文为空的受限页——两条路里完整正文都不出站、
 // 不进列表、不进导出。摘要许可/summary-only 行取受限页那条（页面不冒充全文），其余走 404；
 // 收藏可用性同步两级：404 级回答 unavailable，受限页级回答 summary-only（同一句提示）。
 const detail=await loadItemDetail(id);
 const noBody=detail.kind==='not_found'||(detail.kind==='found'&&detail.detail.readingMode!=='full'&&detail.detail.body===null);
 assert.ok(noBody,'要么 404，要么无正文的受限页；完整正文一个字不出站');
 assert.equal(await exportMarkdown(id),null);
 const avail=(await itemAvailability([id]))[id];
 assert.ok(avail==='unavailable'||(avail==='summary-only'&&detail.kind==='found'),`收藏可用性两级一致（${avail}）`);
 assert.ok(!(await itemFeed('all',null)).includes(id));
 const items=await v1Items({mode:'all',window:'7d',by:'timeline',category:null,q:null,limit:100,cursor:null});
 assert.ok(!items.items.some(x=>x.id===id));
}
test('old readiness cannot bypass the versioned gate; republishing restores a complete article',async()=>{
 const id=await article();assert.equal((await loadItemDetail(id)).kind,'found');
 await sql`UPDATE article_workflow_readiness SET policy_version=1,ready=true WHERE article_id=${id}`;
 await hidden(id);await publishArticle(id);assert.equal((await loadItemDetail(id)).kind,'found');
});
test('summary-only and revoked full-text permission stay bodyless even with stored ready=true',async()=>{
 const id=await article();await sql`UPDATE publications SET visibility='summary-only' WHERE article_id=${id}`;
 await publishArticle(id); // ordinary source publication returns public, so test explicit override separately
 await sql`UPDATE publications SET body_mode='summary' WHERE article_id=${id}`;
 await sql`INSERT INTO article_workflow_readiness(article_id,revision,analysis_id,ready,policy_version)
 SELECT article_id,revision,analysis_id,true,${READER_POLICY_VERSION} FROM publications WHERE article_id=${id} ON CONFLICT(article_id) DO UPDATE SET ready=true,policy_version=${READER_POLICY_VERSION}`;
 await hidden(id);
 // 手写 ready=true 也造不出正文页：同一行最多落到受限页（标题/摘要/原文入口），完整正文仍被门禁拦住。
 const summaryOnly=await loadItemDetail(id);
 assert.ok(summaryOnly.kind==='not_found'||(summaryOnly.kind==='found'&&summaryOnly.detail.readingMode!=='full'&&summaryOnly.detail.body===null),'手写 ready 不绕过正文门禁');
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
 const key=`workflow_readiness_v${READER_POLICY_VERSION}_selected_cursor`;const [saved]=await sql`SELECT value FROM settings WHERE key=${key}`;
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
  assert.equal(rows.find(x=>x.article_id===ids[0])?.policy_version,READER_POLICY_VERSION);
  assert.equal(rows.find(x=>x.article_id===ids[2])?.policy_version,READER_POLICY_VERSION);
  assert.equal(rows.find(x=>x.article_id===ids[1])?.policy_version,1);
 }finally{
  release();await holding;await sql`DELETE FROM settings WHERE key=${key}`;
  if(saved)await sql`INSERT INTO settings(key,value) VALUES(${key},${sql.json(saved.value as never)})`;
 }
});

test('publisher body defects invalidate public release and return through the ordinary extraction queue',async()=>{
 const id=await article();
 await sql`UPDATE articles SET url=${'https://doi.org/10.5194/nhess-26-fixture'}, body_html='<p>Ata, M. Y.: Reference, https://doi.org/1 https://doi.org/2 https://doi.org/3</p>', body_text='Ata, M. Y.: Reference, https://doi.org/1 https://doi.org/2 https://doi.org/3' WHERE id=${id}`;
 assert.equal((await sql`SELECT 1 FROM article_workflow_readiness WHERE article_id=${id}`).length,0);
 await publishArticle(id);await hidden(id);
 const [fact]=await sql`SELECT quality_error FROM article_workflow_readiness WHERE article_id=${id}`;assert.equal(fact.quality_error,'source:references-only');
 const result=await recoverBodyIntegrity();assert.ok(result.queued>=1);
 const [job]=await sql`SELECT data FROM pgboss.job WHERE name='content.extract-body' AND data->>'articleId'=${id} AND state='created'`;assert.equal(job.data.articleId,id);
 const [body]=await sql`SELECT body_status FROM articles WHERE id=${id}`;assert.equal(body.body_status,'pending');await hidden(id);
});

test('periodical citations have a bounded independent readiness recovery lane',async()=>{
 const id=await article();await sql`UPDATE article_workflow_readiness SET policy_version=1 WHERE article_id=${id}`;
 const key='2200-01',cursor='workflow_readiness_v'+READER_POLICY_VERSION+'_reports_cursor';
 await sql`DELETE FROM settings WHERE key=${cursor}`;
 await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('monthly',${key},'2200-01-01','2200-02-01',${sql.json({themes:[{storyRefs:[{itemId:id}]}]})},now())`;
 try{const result=await recoverWorkflowReadiness({reportsOnly:true,limit:1,budgetMs:1000});assert.equal(result.checked,1);assert.equal((await loadItemDetail(id)).kind,'found');}
 finally{await sql`DELETE FROM reports WHERE kind='monthly' AND key=${key}`;await sql`DELETE FROM settings WHERE key=${cursor}`;}
});
