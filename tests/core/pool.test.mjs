// Real-store scheduler cases. Timeout/disconnect cancellation assertions were replaced by the
// durable-lifecycle suite's explicit task-control claims; this file never reinstates task deadlines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, done, context, hold, until, wrapCoordinator } from './helpers.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
const free=()=>new AbortController().signal;
test('two unrelated tasks overlap and share the configured global capacity',async t=>{
 const f=await fixture(t),gate=hold();let starts=0;const c=f.coordinator({run:async()=>{starts++;await gate.promise;return done();}},{max_workers:2,max_queued_tasks:0});
 const a=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('a')},f.owner,free()),b=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('b')},f.owner,free());
 try{await until(()=>starts===2);await assert.rejects(c.submit({schema_version:1,source_view:f.root,assignment:f.request('full')},f.owner,free()),{code:'CAPACITY_EXCEEDED'});assert.equal(c.activeCount,2);}
 finally{gate.release();await c.shutdown();}assert.equal((await f.store.readResult(a.task_id)).execution_status,'completed');assert.notEqual(a.task_id,b.task_id);
});
test('the same active key attaches and conflicting material content is rejected',async t=>{
 const f=await fixture(t),gate=hold();let starts=0;const c=f.coordinator({run:async()=>{starts++;await gate.promise;return done();}}),a=c.execute(f.request('same'),context());
 try{await until(()=>starts===1);const b=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('same')},f.owner,free());await assert.rejects(c.submit({schema_version:1,source_view:f.root,assignment:f.request('same',{objective:'different'})},f.owner,free()),{code:'REQUEST_KEY_CONFLICT'});gate.release();assert.equal((await a).task_id,b.task_id);assert.equal(starts,1);}finally{gate.release();await c.shutdown();}
});
test('an ordinary failed task does not cancel a healthy sibling',async t=>{
 const f=await fixture(t),gate=hold();let working=false;const c=f.coordinator({run:async i=>{if(i.request.request_key==='fail')return done({status:'failed'});working=true;await gate.promise;return done();}});
 const outcomes=c.executeBatch([f.request('fail'),f.request('healthy')],context());try{await until(()=>working);gate.release();const rows=await outcomes;assert.equal(rows[0].result.execution_status,'failed');assert.equal(rows[1].result.execution_status,'completed');}finally{gate.release();await c.shutdown();}
});
test('explicit cancellation of queued work retains its never-started result',async t=>{
 const f=await fixture(t),gate=hold();let starts=0;const c=f.coordinator({run:async()=>{starts++;await gate.promise;return done();}},{max_workers:1});
 const first=c.execute(f.request('first'),context());await until(()=>starts===1);const queued=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('queued')},f.owner,free());
 try{await c.cancel(queued.task_id,f.owner,queued.control_generation,'cancel-queued','Explicit fixture stop');await until(()=>c.queuedCount===0);gate.release();await first;await c.shutdown();const result=await f.store.readResult(queued.task_id);assert.equal(result.execution_status,'cancelled');assert.equal(result.worker_stop,'not_started');assert.equal(starts,1);}finally{gate.release();await c.shutdown();}
});
test('missing terminal publication freezes future starts rather than replaying work',async t=>{
 const f=await fixture(t);let starts=0;class FailingStore extends TaskStore{async writeResult(){throw Error('disk full');}}
 const store=new FailingStore(f.state),c=new Coordinator(f.root,'project',f.policy,store,f.registry({run:async()=>{starts++;return done();}}));
 const receipt=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('failed-publication')},f.owner,free());await c.waitForIdle();
 assert.match(c.frozenReason,/disk full/);assert.equal(await store.readResult(receipt.task_id),undefined);await assert.rejects(c.submit({schema_version:1,source_view:f.root,assignment:f.request('next')},f.owner,free()),{code:'PROJECT_NEEDS_RECONCILIATION'});assert.equal(starts,1);await c.shutdown();
});
test('already-cancelled submission publishes no assignment',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort(Error('before admission'));let starts=0;const c=f.coordinator({run:async()=>{starts++;return done();}});
 await assert.rejects(c.submit({schema_version:1,source_view:f.root,assignment:f.request('none')},f.owner,controller.signal));assert.equal(starts,0);assert.deepEqual(await f.store.list(),[]);
});
test('result publication survives a following control-state write failure without silent replay',async t=>{
 const f=await fixture(t),original=f.store.writeControl.bind(f.store);let fail=true,starts=0;
 f.store.writeControl=async(id,state)=>{if(state.phase==='terminal'&&fail){fail=false;throw Error('state-save fault');}return original(id,state)};
 const c=f.coordinator({run:async()=>{starts++;return done();}});const receipt=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('saved')},f.owner,free());await c.waitForIdle();
 const retried=await c.submit({schema_version:1,source_view:f.root,assignment:f.request('saved')},f.owner,free());assert.equal(retried.task_id,receipt.task_id);assert.equal((await f.store.readResult(receipt.task_id)).execution_status,'completed');assert.equal(starts,1);await c.shutdown();
});
