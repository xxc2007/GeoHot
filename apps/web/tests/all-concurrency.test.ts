import assert from 'node:assert/strict';
import { test } from 'node:test';
const build=await import(new URL('../build/server/index.js',import.meta.url).href);
const route=Object.values(build.routes).find((r:any)=>r.id==='routes/all') as any;
test('a failing item read is observed immediately while the optional calendar is still pending',async()=>{
 // 2026-11-05：这条以前断言 `error.status === 302` —— 也就是"列表读不出来就跳去搜索忙"。
 // 那个跳转是错的（`apps/api/src/routes/site.ts` 的两个 503 出口共用同一个 code），
 // 现在只有 `search_busy` 才跳。这条用 `temporarily_unavailable` 模拟"列表本身读不出来"，
 // 它该原地报 503，而不是把读者送到一个和搜索无关的页面。要点没变：失败立刻可见、没有 unhandledRejection。
 const original=globalThis.fetch;let release!:()=>void;let calendarStarted=false;
 const hold=new Promise<void>(resolve=>{release=resolve});let unhandled:unknown[]=[];
 const listener=(e:unknown)=>unhandled.push(e);process.on('unhandledRejection',listener);
 globalThis.fetch=(async(input)=>{const url=String(input);if(url.includes('/calendar')){calendarStarted=true;await hold;return Response.json({month:'2026-10',days:[]});}return Response.json({code:'temporarily_unavailable'},{status:503});}) as typeof fetch;
 try{const result=route.module.loader({request:new Request('https://example.test/all'),params:{},context:{}});const observed=result.catch((e:unknown)=>e);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calendarStarted,true);assert.deepEqual(unhandled,[]);release();const error=await observed as any;
 // `data()` 抛出的是 `DataWithResponseInit`（{ type, data, init }），状态码在 init 里；
 // `redirect()` 抛的才是带 status 的 Response。两种取法都认，断言才落在"是 503 不是 302"上。
 const status=error?.status ?? error?.init?.status;
 assert.equal(status,503,'列表失败就该原地 503，不该跳搜索忙');}finally{release();globalThis.fetch=original;process.off('unhandledRejection',listener);}
});