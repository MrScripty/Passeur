import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, diagnosticInfo, errorInfo, filesystemFailure } from '../../.passeur-core/src/core/errors.js';
import { acquireRepositoryLease } from '../../.passeur-core/src/core/lease.js';
import { RepositoryRuntime } from '../../.passeur-core/src/core/repository-runtime.js';
const hold = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const identity = {package_version:'0.1.0',build_id:'development-unidentified',mode:'development',node_version:process.version,node_executable:process.execPath,pid:process.pid,started_at:new Date().toISOString()};
const binding = {project:'/fixture/project',repositoryId:'abc',commonDir:'/fixture/project/.git',stateRoot:'/fixture/state',storeRoot:'/fixture/state/repo',profilePath:'/fixture/config.json'};
const noop = ()=>{};
async function temporary(t) { const root=await mkdtemp(join(tmpdir(),'passeur-lease-check-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
function runtimeFixture(t, overrides={}) {
  let state='held', releases=0, acquired=0, initializes=0, recoveries=0, authority, notification;
  const lease={get state(){return state},assertOwned(){if(state!=='held')throw new BridgeError('LEASE_COMPROMISED','lost')},async release(){releases++;state='released'}};
  const store={async initialize(){authority();initializes++},async importLegacy(){authority()},async frozenReason(){return undefined},async list(){return []},async find(){return undefined},async readResource(){return undefined}};
  const runtime=new RepositoryRuntime({project:'/fixture/project'},identity,{
    resolveBinding:async()=>binding,legacyRoots:async()=>[],
    acquire:async(_path,_signal,onLost)=>{acquired++;notification=onLost;state='held';return lease},
    store:(_root,guard)=>{authority=guard;return store},recover:async()=>{authority();recoveries++},
    ...overrides,
  },{});
  t.after(()=>runtime.shutdown());
  return {runtime,lease,store,get authority(){return authority},get acquired(){return acquired},get initializes(){return initializes},get recoveries(){return recoveries},get releases(){return releases},
    compromise(){state='lost';notification(new BridgeError('LEASE_COMPROMISED','lost'))}};
}

test('diagnostics preserve native cause and do not label domain codes as native',()=>{
  const cause=Object.assign(new Error('secret=abc'),{code:'EACCES'}),e=filesystemFailure(cause,'lease.acquire','/state');
  assert.equal(e.cause,cause);assert.equal(diagnosticInfo(e).code,'PERMISSION_DENIED');assert.equal(diagnosticInfo(e).native_code,'EACCES');
  assert.equal(diagnosticInfo(new BridgeError('PROJECT_IN_USE','held')).native_code,undefined);
  assert.deepEqual(Object.keys(errorInfo(e)).sort(),['code','message']);
});
test('diagnostic projection bounds and redacts credentials',()=>{
  const r=diagnosticInfo(new Error('Bearer xyz token=abc sk-abcdefghijklmnop '+'x'.repeat(5000)));
  assert.ok(!r.message.includes('xyz'));assert.ok(!r.message.includes('token=abc'));assert.ok(!r.message.includes('sk-abc'));assert.ok(r.message.length<=2048);
});
test('lease reports actual lock contention separately from permission failure',async t=>{
  const root=await temporary(t);
  for(const [code,expected] of [['ELOCKED','PROJECT_IN_USE'],['EACCES','PERMISSION_DENIED'],['EROFS','STORAGE_READ_ONLY'],['ENOSPC','STORAGE_FULL']]){
    await assert.rejects(acquireRepositoryLease(root,{onCompromised:noop,lock:async()=>{throw Object.assign(new Error('native'),{code})}}),{code:expected});
  }
});
test('lease directory failure never masquerades as another coordinator',async t=>{
  const root=await temporary(t);await writeFile(join(root,'file'),'x');let called=false;
  await assert.rejects(acquireRepositoryLease(join(root,'file','child'),{onCompromised:noop,lock:async()=>{called=true;return async()=>{}}}),e=>e.code==='STORAGE_UNAVAILABLE'&&e.context.native_code==='ENOTDIR');
  assert.equal(called,false);
});
test('lease retains shared heartbeat policy and releases exactly once',async t=>{
  const root=await temporary(t);let settings,count=0;
  const lease=await acquireRepositoryLease(root,{onCompromised:noop,lock:async(_p,o)=>{settings=o;return async()=>{count++}}});
  assert.equal(settings.stale,30000);assert.equal(settings.update,10000);assert.equal(settings.retries,0);
  await Promise.all([lease.release(),lease.release()]);assert.equal(count,1);assert.equal(lease.state,'released');assert.throws(()=>lease.assertOwned(),{code:'LEASE_NOT_HELD'});
});
test('compromise invalidates authority before notifying and never releases a foreign lock',async t=>{
  const root=await temporary(t);let callback,releases=0,lease;
  lease=await acquireRepositoryLease(root,{onCompromised:()=>assert.throws(()=>lease.assertOwned(),{code:'LEASE_COMPROMISED'}),lock:async(_p,o)=>{callback=o.onCompromised;return async()=>{releases++}}});
  callback(new Error('changed'));assert.equal(lease.state,'lost');await lease.release();assert.equal(releases,0);
});
test('failed release invalidates local authority instead of pretending heartbeats continue',async t=>{
  const root=await temporary(t);let notifications=0;
  const lease=await acquireRepositoryLease(root,{onCompromised:()=>notifications++,lock:async()=>async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'})}});
  await assert.rejects(lease.release(),{code:'PERMISSION_DENIED'});assert.equal(lease.state,'lost');assert.equal(notifications,1);assert.throws(()=>lease.assertOwned());
});
test('late lease acquisition after cancellation is released before rejection',async t=>{
  const root=await temporary(t),entered=hold(),answer=hold(),abort=new AbortController();let releases=0;
  const p=acquireRepositoryLease(root,{signal:abort.signal,onCompromised:noop,lock:async()=>{entered.resolve();await answer.promise;return async()=>{releases++}}});
  const rejected=assert.rejects(p,{message:'cancelled'});await entered.promise;abort.abort(new Error('cancelled'));answer.resolve();await rejected;assert.equal(releases,1);
});
test('read-only status performs no preparation and reports unchecked execution',t=>{
  const f=runtimeFixture(t);assert.equal(f.runtime.status().coordination.state,'idle');assert.equal(f.runtime.status().execution.profile,'not_checked');assert.equal(f.acquired,0);
});
test('coordination preparation does not load profile or provider',async t=>{
  const f=runtimeFixture(t,{profile:async()=>{throw Error('must not load')}});
  const status=await f.runtime.prepare();assert.equal(status.coordination.state,'ready');assert.equal(status.execution.profile,'not_checked');assert.equal(f.recoveries,1);
});
test('concurrent first callers share one owned preparation',async t=>{
  const entered=hold(),release=hold();const f=runtimeFixture(t,{recover:async()=>{entered.resolve();await release.promise}});
  const a=f.runtime.prepare(),b=f.runtime.prepare();await entered.promise;assert.equal(f.acquired,1);assert.equal(f.runtime.status().coordination.state,'preparing');release.resolve();
  await Promise.all([a,b]);assert.equal(f.acquired,1);assert.equal(f.releases,0);
});
test('one cancelled waiter cannot cancel shared preparation',async t=>{
  const entered=hold(),release=hold(),abort=new AbortController();const f=runtimeFixture(t,{recover:async()=>{entered.resolve();await release.promise}});
  const a=f.runtime.prepare(abort.signal),b=f.runtime.prepare();const detached=assert.rejects(a,{message:'detached'});
  await entered.promise;abort.abort(new Error('detached'));await detached;release.resolve();await b;assert.equal(f.runtime.status().coordination.state,'ready');assert.equal(f.acquired,1);
});
test('a corrected pre-admission failure can retry in the same runtime',async t=>{
  let attempts=0;const f=runtimeFixture(t,{recover:async()=>{if(++attempts===1)throw new BridgeError('PERMISSION_DENIED','blocked')}});
  await assert.rejects(f.runtime.prepare(),{code:'PERMISSION_DENIED'});assert.equal(f.runtime.status().coordination.state,'blocked');assert.equal(f.releases,1);
  await f.runtime.prepare();assert.equal(f.runtime.status().coordination.state,'ready');assert.equal(f.acquired,2);
});
test('frozen stored execution releases provisional ownership and does not report ready',async t=>{
  const f=runtimeFixture(t);f.store.frozenReason=async()=> 'worker stop unknown';
  await assert.rejects(f.runtime.prepare(),{code:'PROJECT_NEEDS_RECONCILIATION'});assert.equal(f.releases,1);assert.equal(f.runtime.status().coordination.state,'blocked');
});
test('successful preparation retains the lease while idle and repeat preparation is no-op',async t=>{
  const f=runtimeFixture(t);await f.runtime.prepare();await f.runtime.prepare();assert.equal(f.acquired,1);assert.equal(f.releases,0);f.authority();
  await f.runtime.shutdown();assert.equal(f.releases,1);
});
test('shutdown waits for late acquisition and never publishes stale readiness',async t=>{
  const entered=hold(),release=hold();let count=0,initialized=0;
  const lease={state:'held',assertOwned(){},async release(){count++;this.state='released'}};
  const f=runtimeFixture(t,{acquire:async()=>{entered.resolve();await release.promise;return lease},store:()=>{initialized++;throw Error('must not compose')}});
  const p=f.runtime.prepare(),rejected=assert.rejects(p);await entered.promise;const closed=f.runtime.shutdown();release.resolve();await Promise.all([closed,rejected]);
  assert.equal(count,1);assert.equal(initialized,0);assert.equal(f.runtime.status().coordination.state,'closed');
});
test('shutdown observes an uncancellable recovery completion before releasing',async t=>{
  const entered=hold(),finish=hold();const f=runtimeFixture(t,{recover:async()=>{entered.resolve();await finish.promise}});
  const p=f.runtime.prepare(),rejected=assert.rejects(p);await entered.promise;const closed=f.runtime.shutdown();assert.equal(f.releases,0);finish.resolve();await Promise.all([closed,rejected]);assert.equal(f.releases,1);assert.equal(f.runtime.status().coordination.state,'closed');
});
test('compromised prepared runtime refuses future preparation and mutations without reacquisition',async t=>{
  const f=runtimeFixture(t);await f.runtime.prepare();f.compromise();assert.equal(f.runtime.status().coordination.state,'frozen');assert.throws(()=>f.authority(),{code:'LEASE_COMPROMISED'});
  await assert.rejects(f.runtime.prepare(),{code:'LEASE_COMPROMISED'});assert.equal(f.acquired,1);await f.runtime.shutdown();assert.equal(f.releases,0);
});
test('runtime shutdown is idempotent and rejects new admission',async t=>{
  const f=runtimeFixture(t);await f.runtime.prepare();const a=f.runtime.shutdown(),b=f.runtime.shutdown();assert.equal(a,b);await a;
  assert.throws(()=>f.runtime.prepare(),{code:'BRIDGE_CLOSING'});assert.equal(f.releases,1);
});
test('repository preparation retains no ambient per-client approval authority',async t=>{
  const f=runtimeFixture(t);await f.runtime.prepare();assert.equal(f.runtime.status().execution.approval,'not_checked');assert.equal(f.acquired,1);
});
test('history access has no lease or execution prerequisite and denies accidental writes',async t=>{
  const f=runtimeFixture(t,{profile:async()=>{throw Error('must not load')}});const result=await f.runtime.inspect();assert.deepEqual(result.tasks,[]);assert.equal(f.acquired,0);assert.throws(()=>f.authority(),{code:'READ_ONLY_STORE'});
});
