import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './decision.mjs';
const base = { inspectionOk:true, listenerPresent:true, samePathProcess:true, exeExists:true, taskState:'Ready', ownerLock:false, lastTaskResult:0, now:100, lastState:{state:'stopped',finalReason:'deadline',lockRetained:false,at:90,deadline:80} };
test('only normal deadline or proven never-run permits recovery', () => {
  assert.equal(decide(base).startTask,true);
  assert.equal(decide({...base,lastState:null,lastStateAbsent:true,lastTaskResult:267011}).startTask,true);
  assert.equal(decide({...base,lastState:null,lastStateAbsent:true}).startTask,false);
});
test('stops, running task, locks and inspection failures prevent task launch', () => {
  for (const patch of [{disabled:true},{operatorStop:true},{inspectionOk:false},{ownerLock:true},{taskState:'Running'},{taskState:'Disabled'}]) assert.equal(decide({...base,...patch}).startTask,false);
});
test('terminal and ambiguous exits never restart', () => {
  for (const reason of ['authentication','host_key','forward_bind','unclassified_exit','operator_stop','spawn_error','completed']) assert.equal(decide({...base,lastState:{...base.lastState,finalReason:reason}}).startTask,false);
  assert.equal(decide({...base,lastState:{...base.lastState,lockRetained:true}}).startTask,false);
  assert.equal(decide({...base,lastState:{...base.lastState,at:70}}).startTask,false);
  assert.equal(decide({...base,lastTaskResult:1}).startTask,false);
});
test('one attempt per deadline; fresh deadline permits next recovery', () => {
  const token=decide(base).token;
  assert.equal(decide({...base,consumedToken:token}).startTask,false);
  assert.equal(decide({...base,consumedToken:token,lastState:{...base.lastState,at:95,deadline:94}}).startTask,true);
});
test('gateway launch requires absence of process, listener and global stop', () => {
  const missing={...base,listenerPresent:false,samePathProcess:false};
  assert.equal(decide(missing).startGateway,true);
  assert.equal(decide(missing).startTask,false);
  for (const patch of [{samePathProcess:true},{exeExists:false},{disabled:true},{operatorStop:true},{inspectionOk:false}]) assert.equal(decide({...missing,...patch}).startGateway,false);
});
