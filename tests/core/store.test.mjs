import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, context, done } from './helpers.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { reconcileStoredTasks } from '../../.passeur-core/src/core/recovery.js';

test('listing is read-only; quarantine happens explicitly and blocks unsafe starts',async t=>{
  const f=await fixture(t),id=crypto.randomUUID();await mkdir(f.store.taskDir(id));
  await assert.rejects(f.store.list());assert.ok((await readdir(join(f.state,'tasks'))).includes(id));
  const moved=await f.store.quarantineIncomplete();assert.equal(moved.length,1);assert.deepEqual(await f.store.list(),[]);assert.ok(await f.store.frozenReason());
});
test('unpublished creation directories cannot be mistaken for active tasks',async t=>{
  const f=await fixture(t);await mkdir(join(f.state,'tasks','.creating-example'));assert.deepEqual(await f.store.list(),[]);
});
test('saved result repairs a nonterminal state without another worker',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done()}),result=await c.execute(f.request('recover'),context());
  const saved=await f.store.readControl(result.task_id);saved.phase='finalizing';delete saved.outcome;await f.store.writeControl(result.task_id,saved);await reconcileStoredTasks(f.store);
  assert.equal((await f.store.readState(result.task_id)).phase,'terminal');assert.deepEqual(await f.store.readResult(result.task_id),result);
});
test('interrupted queued tasks are not replayed and did not start a worker',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),now=new Date().toISOString();
  await f.store.create(f.admission(f.request('queued'),id),f.initial(id));
  await reconcileStoredTasks(f.store);assert.equal(await f.store.readResult(id),undefined);const state=await f.store.readControl(id);assert.equal(state.phase,'needs_attention');assert.equal(state.native.state,'not_started');
});
test('legacy task records stay readable and resources remain unclassified',async t=>{
  const f=await fixture(t),id=crypto.randomUUID(),now=new Date().toISOString();
  await f.store.create({task_id:id,project_id:'old-project',canonical_hash:'hash',accepted_at:now,deadline_at:now,request:((({agent_id,...request})=>({...request,schema_version:1}))(f.request('legacy')))},{phase:'queued',updated_at:now});
  await reconcileStoredTasks(f.store);assert.equal((await f.store.readResult(id)).schema_version,3);assert.equal((await f.store.readResult(id)).identity.status,'unavailable');assert.equal((await f.store.readResource(id)).state,'legacy_unclassified');
  const c=f.coordinator({run:async()=>done()});await assert.rejects(c.execute(f.request('legacy'),context()),{code:'LEGACY_REQUEST_KEY'});
});
test('terminal execution result is immutable',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done()}),result=await c.execute(f.request('immutable'),context());
  await assert.rejects(f.store.writeResult(result.task_id,{...result,summary:'rewritten'}),{code:'RESULT_IMMUTABLE'});
});
test('artifact reads reject symlink escapes and arbitrary IDs',async t=>{
  const f=await fixture(t),id=crypto.randomUUID();
  const c=f.coordinator({run:async()=>done()}),sample=await c.execute(f.request('sample'),context());
  const admission=await f.store.find({task_id:sample.task_id});const state=f.initial(id);state.native={...sample.native_evidence};state.settled_outcome=sample.execution_status;state.phase='finalizing';await f.store.create({...admission,task_id:id},state);await writeFile(join(f.temp,'outside.txt'),'private');await symlink(join(f.temp,'outside.txt'),join(f.store.taskDir(id),'artifacts','escape'));
  await f.store.writeResult(id,{...sample,task_id:id,artifacts:[{id:'escape',kind:'report',path:'artifacts/escape',bytes:7}]});
  await assert.rejects(f.store.readArtifact(id,'escape',0,100),{code:'INVALID_ARTIFACT'});await assert.rejects(f.store.readArtifact(id,'arbitrary',0,100),{code:'ARTIFACT_NOT_FOUND'});
});
test('concurrent event writes preserve complete JSON lines',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done()}),result=await c.execute(f.request('events'),context());
  await Promise.all(Array.from({length:100},(_,i)=>f.store.appendEvent(result.task_id,{number:i})));
  const lines=(await f.store.readSection(result.task_id,'log',0,24576)).trim().split('\n');const numbered=lines.map(line=>JSON.parse(line).event.number).filter(n=>n!==undefined);assert.equal(numbered.length,100);assert.equal(new Set(numbered).size,100);
});
test('legacy import preserves existing records and request keys',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done()}),result=await c.execute(f.request('imported'),context());const fresh=new TaskStore(join(f.temp,'new-store'));
  await fresh.importLegacy(f.state);assert.equal((await fresh.find({request_key:'imported'})).task_id,result.task_id);assert.deepEqual(await f.store.list(),[]);
});
