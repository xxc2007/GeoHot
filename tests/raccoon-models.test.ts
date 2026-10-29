import {stub,tag} from './setup.ts';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {MODELS,headroomFor,chatJson} from '@aihot/backend/providers/llm';
import {closeDb,sql} from '@aihot/backend/db';
import {BudgetExceededError} from '@aihot/backend/providers/receipts';
import {z} from 'zod';
import {config} from '@aihot/backend/config';
after(closeDb);
test('Raccoon exposes only selected free models with one shared account budget and explicit max reasoning',()=>{
 const rows=Object.values(MODELS).filter(m=>m.service==='raccoon');
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(m=>m.model).sort(),['raccoon/sn-deepseek-v4-1-flash-1017','raccoon/sn-sensenova-6-8-flash','raccoon/sn-sensenova-6-8-flash-lite']);
 for(const m of rows){assert.equal(m.extra?.reasoning_effort,'max');assert.equal(m.vision,true);assert.equal(m.apiKeyEnv,'RACCOON_API_KEY');assert.ok(headroomFor(m,'score')>=8000,'reasoning must leave room for a visible answer');}
 assert.equal(MODELS['codearts-deepseek-v4.1-flash']?.model,'codearts/deepseek-v4.1-flash-1017','retain the current production model when reconciling source');
});
test('different Raccoon models cannot multiply the shared account allowance',async()=>{
 const enabled=config.modelCallsEnabled;
 config.modelCallsEnabled=true;
 const prefix='raccoon-'+tag();
 const [prior]=await sql`SELECT * FROM budgets WHERE service='raccoon'`;
 const server=await stub(()=>({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
 process.env.RACCOON_BASE_URL=server.url+'/v1';process.env.RACCOON_API_KEY='test-key';
 try {
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('raccoon',1,100,100) ON CONFLICT(service) DO UPDATE SET per_minute=1,per_hour=100,per_day=100`;
  const ask=(model:string)=>chatJson({model,purpose:'invariant_test',subject:prefix+model,promptVersion:'t1',system:'',user:'input',schema:z.object({ok:z.boolean()})});
  assert.equal((await ask('raccoon-sensenova-flash-lite')).data.ok,true);
  await assert.rejects(ask('raccoon-deepseek-1017'),BudgetExceededError);
  assert.equal(server.hits(),1,'second alias must be refused before sending another request');
 } finally {
  await sql`DELETE FROM receipts WHERE subject LIKE ${prefix+'%'}`;
  if(prior) await sql`UPDATE budgets SET per_minute=${prior.per_minute},per_hour=${prior.per_hour},per_day=${prior.per_day} WHERE service='raccoon'`;
  else await sql`DELETE FROM budgets WHERE service='raccoon'`;
  await server.close();
  config.modelCallsEnabled=enabled;
 }
});
