import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import './setup.ts';
import Fastify from 'fastify';
import { config } from '@aihot/backend/config';
import { closeDb } from '@aihot/backend/db';
import { embedMagpie, registerServerConsole } from '../apps/api/src/routes/server-console.ts';
after(closeDb);

test('Magpie stays behind admin authentication and CSRF; fixed server key never goes to the browser', async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'magpie-proxy-test-'));
 const original=config.devAdmin;const oldFetch=globalThis.fetch;const oldKey=process.env.MAGPIE_WEB_KEY_FILE;
 let calls=0;
 const app=Fastify();await registerServerConsole(app,async (resource,init)=>{calls++;assert.match(resource,/^\//);assert.equal(new Headers(init.headers).get('cookie'),'magpie_web_3430=private-server-test-key');return new Response('<html><head></head><body><script src="/app.js"></script></body></html>',{headers:{'content-type':'text/html','set-cookie':'should-not-reach-browser=secret'}});});
 try{
  config.devAdmin=null as never;
  assert.equal((await app.inject('/api/admin/magpie-proxy/')).statusCode,401);
  config.devAdmin={displayName:'isolated test'} as never;
  process.env.MAGPIE_WEB_KEY_FILE=path.join(dir,'key');await writeFile(process.env.MAGPIE_WEB_KEY_FILE,'private-server-test-key');
  const page=await app.inject('/api/admin/magpie-proxy/');assert.equal(page.statusCode,200);assert.match(page.body,/magpie-proxy\/app.js/);assert.doesNotMatch(page.body,/private-server-test-key/);assert.equal(page.headers['set-cookie'],undefined);assert.equal(page.headers['cache-control'],'no-store');
  assert.equal((await app.inject({method:'POST',url:'/api/admin/magpie-proxy/api/test',payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/magpie-proxy/api/test',headers:{'x-csrf-token':'dev',origin:'https://outside.invalid'},payload:{}})).statusCode,403);
  assert.equal((await app.inject('/api/admin/magpie-proxy/v1/models')).statusCode,404);
  assert.equal(calls,1);
 }finally{config.devAdmin=original;globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.MAGPIE_WEB_KEY_FILE;else process.env.MAGPIE_WEB_KEY_FILE=oldKey;await app.close();await rm(dir,{recursive:true,force:true});}
});
test('Magpie resource bootstrap leaves external resources external and includes the deployment prefix',()=>{
 const html=embedMagpie('<html><head></head><body><img src="/icon.svg"><a href="https://vendor.invalid/">vendor</a></body></html>','/geohot/api/admin/magpie-proxy','dev');
 assert.match(html,/src="\/geohot\/api\/admin\/magpie-proxy\/icon.svg"/);assert.match(html,/href="https:\/\/vendor.invalid\/"/);assert.match(html,/x-csrf-token/);
});
