import { tag, gate, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
const T=tag(),SOURCE=`test-translate-infra-${T}`,ids:string[]=[];
const url=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Local infrastructure fixtures only');
const adminUrl=new URL(url);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1});
const dbName=`geohot_translate_infra_${T}_test`;await admin.unsafe(`CREATE DATABASE "${dbName}"`);
url.pathname='/'+dbName;process.env.DATABASE_URL=url.toString();process.env.DATABASE_POOL_MAX='1';
execFileSync(process.execPath,['scripts/migrate.ts'],{env:process.env,stdio:'pipe'});
const provider=await stub(()=>({choices:[{message:{content:JSON.stringify({t:['中文译文保留了原文通报的事实内容。']})}}]}));
process.env.TRANSLATE_MODEL='deepseek-flash';process.env.DEEPSEEK_BASE_URL=`${provider.url}/v1`;process.env.DEEPSEEK_API_KEY='test-key';
const{sql,closeDb}=await import('@aihot/backend/db');const{stopBoss}=await import('@aihot/backend/jobs/queue');
const{upsertMaterial}=await import('@aihot/backend/content/materials');const{publishArticle}=await import('@aihot/backend/publication/publish');
const{translateQuotes,translatePending}=await import('@aihot/backend/editorial/translate');const{invalidateModelCache}=await import('@aihot/backend/editorial/models');
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${SOURCE},'Infrastructure fixture','rss','T1','editorial',true)`;});
beforeEach(async()=>{await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;if(ids.length){await sql`DELETE FROM quote_translations WHERE tweet_id=ANY(${ids}::text[])`;await sql`DELETE FROM quote_translation_attempts WHERE tweet_id=ANY(${ids}::text[])`;}invalidateModelCache();});
after(async()=>{await provider.close();await stopBoss();await closeDb();await admin.unsafe(`DROP DATABASE "${dbName}"`);await admin.end();});
async function material(quoted=true) {
  const tweet=`7${Date.now()}${ids.length}`;ids.push(tweet);
  const text=`A source bulletin with independently reported geography facts. ${T} ${tweet}`;
  const{articleId}=await upsertMaterial({sourceId:SOURCE,url:`https://example.org/${T}/${tweet}`,title:'Source facts',bodyText:text,bodyHtml:`<p>${text}</p>`,bodyStatus:'ok',language:'en',via:'import',...(quoted?{xPost:{tweetId:tweet+'0',text:'Parent source facts',handle:'fixture',authorName:'Fixture',quoted:{text,url:`https://x.com/source/status/${tweet}`,handle:'source',authorName:'Source'}}}:{})});
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${articleId},1,'rule','pass','中文标题','通报的中文摘要。',90,true)`;
  await publishArticle(articleId,{releasedAt:new Date(Date.now()-60000)});return{articleId,tweet};
}
const code=(expected:string)=>(error:unknown)=>(error as {code?:string}).code===expected;
for(const failure of ['57014','55P03'])for(const quoted of [true,false])test(`model routing SQL ${failure} propagates without capping an unsent ${quoted?'quote':'body'}`,async()=>{
  const{tweet,articleId}=await material(quoted),hits=provider.hits(),locker=postgres(url.toString(),{max:1}),entered=gate<void>(),release=gate<void>();
  const held=locker.begin(async tx=>{await tx`LOCK TABLE settings IN ACCESS EXCLUSIVE MODE`;entered.open();await release.promise;});await entered.promise;
  try{
    if(failure==='57014')await sql`SET statement_timeout='50ms'`;else await sql`SET lock_timeout='50ms'`;
    for(let n=0;n<3;n++)await assert.rejects(quoted?translateQuotes({limit:1,maxModelCalls:1}):translatePending({limit:1}),code(failure));
  }finally{release.open();await held;await locker.end();await sql`SET statement_timeout=0`;await sql`SET lock_timeout=0`;}
  assert.equal(provider.hits(),hits);assert.equal((await sql`SELECT 1 FROM quote_translation_attempts WHERE tweet_id=${tweet}`).length,0);
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length,0);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${`quote:${tweet}`}`).length,0);
  if(quoted)assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1);else assert.equal((await translatePending({limit:1})).done[0]!.status,'translated');
  assert.equal(provider.hits()-hits,1);
});
async function trigger(table:string,event:string,condition:string,state:string) {
  await sql.unsafe(`CREATE FUNCTION test_translation_infra_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture infrastructure refusal' USING ERRCODE='${state}'; END IF; RETURN NEW; END$$`);
  await sql.unsafe(`CREATE TRIGGER test_translation_infra_fail BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_translation_infra_fail()`);
  return async()=>{await sql.unsafe(`DROP TRIGGER test_translation_infra_fail ON ${table}`);await sql.unsafe('DROP FUNCTION test_translation_infra_fail()');};
}
test('receipt claim SQL fault propagates before dispatch without quote failure',async()=>{
  const{tweet}=await material(),hits=provider.hits();const clear=await trigger('receipts','INSERT',"NEW.purpose='translate_quoted'",'55P03');
  try{await assert.rejects(translateQuotes({limit:1,maxModelCalls:1}),code('55P03'));}finally{await clear();}
  assert.equal(provider.hits(),hits);assert.equal((await sql`SELECT 1 FROM quote_translation_attempts WHERE tweet_id=${tweet}`).length,0);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${`quote:${tweet}`}`).length,0);
});
test('receipt response persistence SQL fault leaves the sent receipt reserved and does not cap content',async()=>{
  const{tweet}=await material(),hits=provider.hits();const clear=await trigger('receipts','UPDATE',"NEW.status='received'",'57014');
  try{await assert.rejects(translateQuotes({limit:1,maxModelCalls:1}),code('57014'));}finally{await clear();}
  assert.equal(provider.hits()-hits,1);assert.equal((await sql`SELECT 1 FROM quote_translation_attempts WHERE tweet_id=${tweet}`).length,0);
  const[r]=await sql`SELECT r.status,a.billing_status FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${`quote:${tweet}`}`;
  assert.deepEqual([r!.status,r!.billing_status],['pending','reserved']);
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),0);assert.equal(provider.hits()-hits,1,'no resend of pending receipt');
});
test('body persistence SQL fault propagates without a translation attempt and reuses the paid receipt',async()=>{
  const{articleId}=await material(false),hits=provider.hits();const clear=await trigger('translations','INSERT','true','55P03');
  try{await assert.rejects(translatePending({limit:1}),code('55P03'));}finally{await clear();}
  assert.equal(provider.hits()-hits,1);assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length,0);
  const receipts=await sql`SELECT status FROM receipts WHERE subject LIKE ${`article:${articleId}@1#%`}`;assert.equal(receipts[0]!.status,'received');
  assert.equal((await translatePending({limit:1})).done[0]!.status,'translated');assert.equal(provider.hits()-hits,1,'persistence retry reuses receipt');
});
