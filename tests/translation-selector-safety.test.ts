import { tag, stub, purgeTagged } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { translateQuotes } from "@aihot/backend/editorial/translate";
const T=tag(), SOURCE=`test-selector-${T}`;
const quoteIds:string[]=[];
const provider=await stub((_hit,req)=>{
  const text=JSON.parse(JSON.parse(req.body).messages[1].content).segments[0] as string;
  return {choices:[{message:{content:JSON.stringify({t:[text.includes('UNUSABLE')?'An English echo without a translation.':'引用的中文译文，保留原文事实。']})}}]};
});
process.env.TRANSLATE_MODEL='default';
process.env.LLM_BASE_URL=`${provider.url}/v1`;process.env.LLM_API_KEY='test-key';
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES(${SOURCE},'selector fixture','rss','T1','editorial',true)`;});
after(async()=>{
  if(quoteIds.length)await sql`DELETE FROM quote_translations WHERE tweet_id=ANY(${quoteIds}::text[])`;
  if(quoteIds.length)await sql`DELETE FROM quote_translation_attempts WHERE tweet_id=ANY(${quoteIds}::text[])`;
  await purgeTagged(T);await provider.close();await stopBoss();await closeDb();
});
async function parent(label:string,age:number) {
  const id=`8${Date.now()}${Math.floor(Math.random()*100000)}`;quoteIds.push(id);
  const text=`${label} A foreign quoted source bulletin with enough letters. ${T}`;
  const {articleId}=await upsertMaterial({sourceId:SOURCE,url:`https://example.org/${T}/${label}`,title:'Fixture',language:'en',bodyText:'Parent source text',bodyStatus:'ok',via:'import',discoveredAt:new Date(Date.now()-age),xPost:{tweetId:`${id}0`,text:'A parent source',authorName:'Fixture',handle:'fixture',quoted:{text,url:`https://x.com/source/status/${id}`,authorName:'Source',handle:'source'}}});
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected) VALUES(${articleId},1,'rule','pass','geotech','中文标题','中文摘要','理由',90,true)`;
  await publishArticle(articleId,{releasedAt:new Date(Date.now()-60000)});
  return id;
}
test('schema-valid bad cached quote yields next cycle and persisted failures survive a fresh process',async()=>{
  const bad=await parent('UNUSABLE',2000);const good=await parent('GOOD',1000);
  const hits=provider.hits();
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),0);
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1,'unseen tail must overtake checked unusable cache');
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${good}`).length,1);
  await translateQuotes({limit:1,maxModelCalls:1});await translateQuotes({limit:1,maxModelCalls:1});
  const [attempt]=await sql`SELECT attempts,outcome FROM quote_translation_attempts WHERE tweet_id=${bad}`;
  assert.equal(attempt!.attempts,3);assert.equal(attempt!.outcome,'failed');
  assert.equal(provider.hits()-hits,2,'received English response is reused, not repurchased');
  const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',"const{translateQuotes}=await import('@aihot/backend/editorial/translate');const{sql,closeDb}=await import('@aihot/backend/db');const{stopBoss}=await import('@aihot/backend/jobs/queue');try{console.log(JSON.stringify({stored:await translateQuotes({limit:1,maxModelCalls:1})}));}finally{await stopBoss();await closeDb();}"],{cwd:process.cwd(),env:process.env,timeout:20000});
  assert.match(child.stdout,/"stored":0/);assert.equal(provider.hits()-hits,2);
  await sql`UPDATE articles SET x_post=jsonb_set(x_post,'{quoted,text}',to_jsonb('A new independently changed source quote text.'::text)) WHERE source_id=${SOURCE} AND x_post->'quoted'->>'url'=${`https://x.com/source/status/${bad}`}`;
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1,'new text hash gets its own opportunity');
  const attempts=await sql`SELECT attempts,outcome FROM quote_translation_attempts WHERE tweet_id=${bad} ORDER BY attempts DESC`;
  assert.deepEqual(attempts.map(a=>[a.attempts,a.outcome]),[[3,'failed'],[0,'translated']]);
});
test('SQL page bounds private hydration, terminal nonword head yields to later material',async()=>{
  const head:string[]=[];
  for(let i=0;i<31;i++)head.push(await parent(`中文引用${i}`,100000-i*1000));
  const tail=await parent('PAGE_TAIL',1000),hits=provider.hits();
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM quote_translation_attempts WHERE tweet_id=ANY(${head}::text[]) AND outcome='skipped'`)[0]!.n,30,'only fixed30 candidate rows processed this invocation');
  assert.equal(provider.hits(),hits);
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1);
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${tail}`).length,1);
  assert.equal(provider.hits()-hits,1);
});
for(const status of ['unknown','pending']) test(`${status} quote rotates durably without charging attempts or changing billing evidence`,async()=>{
  const id=await parent(`RECEIPT_${status}`,1000);
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1);
  await sql`DELETE FROM quote_translations WHERE tweet_id=${id}`;
  await sql`UPDATE receipts SET status=${status},updated_at=now() WHERE subject=${`quote:${id}`}`;
  await sql`UPDATE receipt_attempts SET status=${status},billing_status='unknown' WHERE receipt_id IN (SELECT id FROM receipts WHERE subject=${`quote:${id}`})`;
  const hits=provider.hits();
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),0);
  const [attempt]=await sql`SELECT attempts,outcome FROM quote_translation_attempts WHERE tweet_id=${id}`;
  assert.equal(attempt!.attempts,0);assert.equal(attempt!.outcome,'deferred');
  assert.deepEqual((await sql`SELECT a.status,a.billing_status FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${`quote:${id}`}`).map(r=>[r.status,r.billing_status]),[[status,'unknown']]);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`quote:${id}`}`)[0]!.status,status);
  assert.equal(provider.hits(),hits);
  const tail=await parent(`TAIL_${status}`,0);
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1);
  assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${tail}`).length,1);
});
test('selector timeout is local and read-only; rollback releases the connection',async()=>{
  const {translationSelectorRead}=await import('@aihot/backend/editorial/translation-selector');
  await assert.rejects(translationSelectorRead(tx=>tx`SELECT pg_sleep(0.1)`,5),(e:unknown)=>(e as {code:string}).code==='57014');
  await assert.rejects(translationSelectorRead(tx=>tx`UPDATE sources SET name='forbidden' WHERE id=${SOURCE}`),(e:unknown)=>(e as {code:string}).code==='25006');
  assert.equal((await sql`SELECT name FROM sources WHERE id=${SOURCE}`)[0]!.name,'selector fixture');
  assert.equal((await translationSelectorRead(tx=>tx`SELECT 1 AS n`))[0]!.n,1);
  assert.equal((await sql`SHOW statement_timeout`)[0]!.statement_timeout,'0');
});

test('quote store and durable outcome roll back together while paid receipt remains reusable',async()=>{
  const id=await parent('ATOMIC_STORE',0),hits=provider.hits();
  await sql.unsafe("CREATE FUNCTION test_quote_store_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.reason='stored' THEN RAISE EXCEPTION 'fixture quote store rollback'; END IF; RETURN NEW; END$$");
  await sql.unsafe('CREATE TRIGGER test_quote_store_fail BEFORE INSERT ON quote_translation_attempts FOR EACH ROW EXECUTE FUNCTION test_quote_store_fail()');
  try {
    await assert.rejects(translateQuotes({limit:1,maxModelCalls:1}),/fixture quote store rollback/);
    assert.equal((await sql`SELECT 1 FROM quote_translations WHERE tweet_id=${id}`).length,0);
    assert.equal((await sql`SELECT 1 FROM quote_translation_attempts WHERE tweet_id=${id}`).length,0);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`quote:${id}`}`)[0]!.status,'received');
  } finally {
    await sql.unsafe('DROP TRIGGER test_quote_store_fail ON quote_translation_attempts');
    await sql.unsafe('DROP FUNCTION test_quote_store_fail()');
  }
  assert.equal(await translateQuotes({limit:1,maxModelCalls:1}),1);
  assert.equal(provider.hits()-hits,1,'store retry reuses paid response');
});
