import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, done, context, hold, until } from './helpers.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';

test('two unrelated workers overlap before either completes', {timeout: 5000}, async t => {
  const f = await fixture(t), gate = hold(); let starts = 0;
  const c = f.coordinator({ run: async () => { starts++; await gate.promise; return done(); } });
  const a = c.delegate(f.request('docs'), context()), b = c.delegate(f.request('parser'), context());
  await until(() => starts === 2); assert.equal(c.activeCount, 2); gate.release();
  const results = await Promise.all([a, b]); assert.notEqual(results[0].task_id, results[1].task_id);
});
test('capacity covers individual and batch calls without starting rejected work', async t => {
  const f = await fixture(t), gate = hold(); let starts = 0;
  const c = f.coordinator({ run: async () => { starts++; await gate.promise; return done(); } }, {max_workers: 1, max_queued_tasks: 1});
  const first = c.delegate(f.request('a'), context()); await until(() => starts === 1);
  const second = c.delegate(f.request('b'), context()); await until(() => c.queuedCount === 1);
  await assert.rejects(c.delegate(f.request('c'), context()), {code:'CAPACITY_EXCEEDED'});
  assert.equal((await f.store.list()).length, 2); gate.release(); await Promise.all([first, second]);
});
test('same active key attaches while changed content conflicts', async t => {
  const f = await fixture(t), gate = hold(); let starts = 0;
  const c = f.coordinator({run:async () => {starts++; await gate.promise; return done();}});
  const a = c.delegate(f.request('same'), context()), b = c.delegate(f.request('same'), context());
  await until(() => starts === 1);
  await assert.rejects(c.delegate(f.request('same',{objective:'different'}), context()),{code:'REQUEST_KEY_CONFLICT'});
  gate.release(); const [one,two] = await Promise.all([a,b]); assert.equal(one.task_id,two.task_id); assert.equal(starts,1);
});
test('duplicate subscriber cancellation does not cancel the owning worker', async t => {
  const f=await fixture(t), gate=hold(); let started=false, aborted=false;
  const c=f.coordinator({run:async input=>{started=true;input.signal.addEventListener('abort',()=>aborted=true);await gate.promise;return done();}});
  const owner=c.delegate(f.request('same'),context()); await until(()=>started);
  const sub=new AbortController(); const attached=c.delegate(f.request('same'),context(sub)); attached.catch(()=>{});
  sub.abort(Error('detach')); await assert.rejects(attached,/detach/); assert.equal(aborted,false);
  gate.release(); assert.equal((await owner).execution_status,'completed');
});
test('failure does not cancel or block a healthy sibling', async t => {
  const f=await fixture(t), gate=hold(); let sibling=false;
  const c=f.coordinator({run:async input=>{if(input.request.request_key==='fail')return done({status:'failed'});sibling=true;await gate.promise;return done();}});
  const batch=c.delegateBatch([f.request('fail'),f.request('good')],context());await until(()=>sibling);gate.release();
  const results=await batch;assert.equal(results[0].result.execution_status,'failed');assert.equal(results[1].result.execution_status,'completed');
});
test('queued owner cancellation finishes without launching a worker', async t => {
  const f=await fixture(t), gate=hold();let starts=0;
  const c=f.coordinator({run:async()=>{starts++;await gate.promise;return done();}},{max_workers:1});
  const a=c.delegate(f.request('a'),context());await until(()=>starts===1);
  const ctrl=new AbortController(), b=c.delegate(f.request('b'),context(ctrl));b.catch(()=>{});await until(()=>c.queuedCount===1);
  ctrl.abort(Error('cancel queued'));await assert.rejects(b,/cancel queued/);await until(()=>c.queuedCount===0);
  gate.release();await a;await c.waitForIdle();assert.equal(starts,1);
  const record=await f.store.find({request_key:'b'});assert.equal((await f.store.readResult(record.task_id)).worker_stop,'not_started');
});
test('queue time consumes the original deadline', async t => {
  const f=await fixture(t), gate=hold();let starts=0;
  const c=f.coordinator({run:async()=>{starts++;await gate.promise;return done();}},{max_workers:1,task_timeout_ms:80});
  const a=c.delegate(f.request('a'),context());await until(()=>starts===1);
  const b=c.delegate(f.request('b'),context());const result=await b;assert.equal(result.execution_status,'timed_out');assert.equal(starts,1);
  gate.release();await a;
});
test('missing terminal persistence freezes replacement starts', async t => {
  const f=await fixture(t);let starts=0;
  class FailingStore extends TaskStore { async writeResult(id,result){ if(result.request_key==='bad')throw Error('disk full');return super.writeResult(id,result);} }
  const store=new FailingStore(f.state), c=new Coordinator(f.root,'project',f.profile,store,{run:async()=>{starts++;return done({worker_stop:'unconfirmed'});}});
  await assert.rejects(c.delegate(f.request('bad'),context()),/disk full/);
  await assert.rejects(c.delegate(f.request('next'),context()),{code:'PROJECT_NEEDS_RECONCILIATION'});assert.equal(starts,1);
});
test('unknown stop blocks queued replacement but lets a known sibling finish', async t=>{
  const f=await fixture(t), gate=hold();let starts=0;
  const c=f.coordinator({run:async input=>{starts++;if(input.request.request_key==='unknown')return done({worker_stop:'unconfirmed'});await gate.promise;return done();}});
  const results=c.delegateBatch([f.request('unknown'),f.request('healthy'),f.request('queued')],context());
  await until(()=>Boolean(c.frozenReason));gate.release();const out=await results;assert.ok(starts<=2);
  assert.equal(out[2].result?.execution_status ?? out[2].error?.code, 'blocked');
});
test('shutdown includes admission currently publishing a task', async t=>{
  const f=await fixture(t), publish=hold();let entered=false,starts=0;
  class SlowStore extends TaskStore {async create(...args){entered=true;await publish.promise;return super.create(...args);}}
  const store=new SlowStore(f.state),c=new Coordinator(f.root,'project',f.profile,store,{run:async()=>{starts++;return done();}});
  const request=c.delegate(f.request('admission'),context());await until(()=>entered);
  let closed=false;const close=c.shutdown().then(()=>closed=true);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false);
  publish.release();await close;await request;assert.equal(starts,0);assert.equal(c.activeCount,0);
});
test('fresh and cached result sizes remain bounded',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done({summary:'x'.repeat(100000)})});
  const a=await c.delegate(f.request('large'),context()),b=await c.delegate(f.request('large'),context());
  assert.ok(Buffer.byteLength(JSON.stringify(a))<=24576);assert.ok(Buffer.byteLength(JSON.stringify(b))<=24576);assert.equal(a.task_id,b.task_id);
});
test('already cancelled request publishes no task',async t=>{
  const f=await fixture(t),ctrl=new AbortController();ctrl.abort(Error('cancelled'));let starts=0;
  const c=f.coordinator({run:async()=>{starts++;return done();}});
  await assert.rejects(c.delegate(f.request('cancelled'),context(ctrl)));assert.equal(starts,0);assert.deepEqual(await f.store.list(),[]);
});

test('batch cancellation cancels newly owned tasks but only detaches duplicates',async t=>{
  const f=await fixture(t),gate=hold();let ownerStarted=false,newStarted=false,ownerAborted=false;
  const c=f.coordinator({run:async input=>{
    if(input.request.request_key==='owner'){ownerStarted=true;input.signal.addEventListener('abort',()=>ownerAborted=true);await gate.promise;return done();}
    newStarted=true;await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));return done({status:'cancelled'});
  }});
  const owner=c.delegate(f.request('owner'),context());await until(()=>ownerStarted);
  const ctrl=new AbortController(),batch=c.delegateBatch([f.request('owner'),f.request('new')],context(ctrl));await until(()=>newStarted);
  ctrl.abort(Error('cancel batch'));await batch;assert.equal(ownerAborted,false);gate.release();await owner;await c.waitForIdle();
  const record=await f.store.find({request_key:'new'});assert.equal((await f.store.readResult(record.task_id)).execution_status,'cancelled');
});
test('result-save/state-save failure prevents silent rerun under the same key',async t=>{
  const f=await fixture(t),original=f.store.writeState.bind(f.store);let fail=true;
  f.store.writeState=async (id,state)=>{if(state.phase==='terminal'&&fail){fail=false;throw Error('state-save fault');}return original(id,state);};let starts=0;
  const c=f.coordinator({run:async()=>{starts++;return done();}});await assert.rejects(c.delegate(f.request('stored'),context()),/state-save fault/);
  const retained=await c.delegate(f.request('stored'),context());assert.equal(retained.execution_status,'completed');assert.equal(starts,1);
});
