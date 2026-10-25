import assert from 'node:assert/strict';
import { test } from 'node:test';
const build=await import(new URL('../build/server/index.js',import.meta.url).href);
const route=Object.values(build.routes).find((r:any)=>r.id==='routes/all') as any;
test('a failing item read is observed immediately while the optional calendar is still pending',async()=>{
 const original=globalThis.fetch;let release!:()=>void;let calendarStarted=false;
 const hold=new Promise<void>(resolve=>{release=resolve});let unhandled:unknown[]=[];
 const listener=(e:unknown)=>unhandled.push(e);process.on('unhandledRejection',listener);
 globalThis.fetch=(async(input)=>{const url=String(input);if(url.includes('/calendar')){calendarStarted=true;await hold;return Response.json({month:'2026-10',days:[]});}return Response.json({code:'temporarily_unavailable'},{status:503});}) as typeof fetch;
 try{const result=route.module.loader({request:new Request('https://example.test/all'),params:{},context:{}});const observed=result.catch((e:unknown)=>e);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calendarStarted,true);assert.deepEqual(unhandled,[]);release();const error=await observed;assert.equal(error.status,302);}finally{release();globalThis.fetch=original;process.off('unhandledRejection',listener);}
});
