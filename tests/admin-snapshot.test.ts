import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotReader} from '../packages/backend/src/admin/statistic-snapshot.ts';
import {CNY_FX,toCny,cnyInteger} from '@aihot/contracts/cny';
test('CNY conversion retains precision until display and never disguises a small positive fee as free',()=>{
  assert.equal(toCny(1,'USD'),CNY_FX.usdToCny);assert.equal(toCny(1,'CNY'),1);assert.equal(toCny(1,'EUR'),null);
  assert.equal(cnyInteger(.49),'＜1');assert.equal(cnyInteger(0),'0');assert.equal(cnyInteger(1.5),'2');
  assert.equal(cnyInteger(toCny(.1+.1,'USD')),'1');
});
test('snapshot cold reads never wait for the aggregate; one scan serves concurrent refreshes',async()=>{
  let release!:(v:number[])=>void,calls=0;const r=snapshotReader(()=>{calls++;return new Promise<number[]>(resolve=>release=resolve);});
  const cold=await r.get();assert.equal(cold.status.state,'unavailable');assert.deepEqual(cold.rows,[]);
  await r.get();assert.equal(calls,1);release([42]);await r.refresh();
  assert.equal((await r.get()).status.state,'ready');assert.deepEqual((await r.get()).rows,[42]);
});
test('slow or failing refresh preserves the last success and its timestamp, with a retry cooldown',async()=>{
  let time=1_000_000,calls=0,fail=false;const r=snapshotReader(async()=>{calls++;if(fail)throw new Error('SQL timeout');return [7];},undefined,()=>time);
  await r.get();await r.refresh();const good=await r.get();time+=31_000;fail=true;
  const stale=await r.get();assert.equal(stale.status.state,'stale');assert.equal(stale.status.asOf,good.status.asOf);assert.deepEqual(stale.rows,[7]);
  await r.refresh();await r.get();assert.equal(calls,2);assert.deepEqual((await r.get()).rows,[7]);
});
test('persisted success survives a process restart and stale data remains explicitly stale',async()=>{
  const saved={at:1000,rows:[8]};const r=snapshotReader(async()=>[9],{load:async()=>saved,save:async()=>{}},()=>2000);
  assert.deepEqual((await r.get()).rows,[8]);assert.equal((await r.get()).status.state,'ready');
  const old=snapshotReader(async()=>{throw new Error('down');},{load:async()=>saved,save:async()=>{}},()=>50000);
  const result=await old.get();assert.equal(result.status.state,'stale');assert.equal(result.status.asOf,new Date(1000).toISOString());await old.refresh();
});
test('different filters share the heavy-query gate instead of queuing competing scans',async()=>{
  let release!:(v:number[])=>void,calls=0;const a=snapshotReader(()=>new Promise<number[]>(resolve=>release=resolve));
  const b=snapshotReader(async()=>{calls++;return [2];});await a.get();assert.equal((await b.get()).status.state,'unavailable');assert.equal(calls,0);
  release([1]);await a.refresh();await b.get();await b.refresh();assert.equal(calls,1);
});
