import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managedFixture, command, key, git } from '../fixtures/structural/managed-fixture.mjs';
import { managedTaskSource, managedWorkProjection } from '../../.passeur-core/src/core/managed-coordination.js';
const stranger={owner_id:'c'.repeat(64),client_id:randomUUID()};

test('actual runtime enrolls its controlled implementation worktree using task facts rather than the parent source view',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();
  const reply=await f.enroll(task), work=await f.get('work',task.id,f.ordinary);
  assert.equal(reply.receipt.item_id,task.id);assert.equal(work.input_oid,f.base);assert.equal(work.intent,task.admission.request.objective);
  assert.equal(work.managed.task_id,task.id);assert.equal(work.managed.control_generation,1);assert.deepEqual(work.readers,[]);
  assert.deepEqual(work.areas,[{kind:'subtree',path:'source.ts'}]);assert.equal(work.managed.areas_source,'allowed_paths');
  assert.notEqual(work.workspace_id,f.root);assert.equal(f.counts.profile,0);assert.equal((await f.disk()).schema_version,3);
  await assert.rejects(f.get('work',task.id,stranger),{code:'COORDINATION_NOT_FOUND'});
  assert.equal((await git(task.path,['rev-parse','HEAD'])).trim(),task.head);
});
test('SHA-256 tasks retain their exact input and result format without truncation',async t=>{
  const f=await managedFixture(t,{format:'sha256'});await f.initialize();const task=await f.addTask();await f.enroll(task);
  const w=await f.get('work',task.id,f.ordinary);assert.equal(w.object_format,'sha256');assert.equal(w.input_oid.length,64);
  const item=await f.select(task,await f.claimCase());assert.equal(item.inputs[0].commit_oid,task.head);
});
test('operator metadata authority alone does not authorize enrollment of another parent task',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();const before=await f.disk();
  assert.ok(f.operator);assert.notEqual(f.operator.owner_id,f.states.get(task.id).owner_id);
  await assert.rejects(f.enroll(task,f.operator),{code:'TASK_CONTROL_CONFLICT'});
  assert.deepEqual(await f.disk(),before);
});
test('queued/creating, review, retired, and inconsistent source records refuse enrollment without migration',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();const resource=f.claims.get(task.id), admission=f.admissions.get(task.id);
  const cases=[
    [()=>{resource.state='creating';},'COORDINATION_TASK_WORKSPACE_NOT_READY'],
    [()=>{resource.state='retired';},'COORDINATION_TASK_RESOURCE_UNAVAILABLE'],
    [()=>{resource.state='pending';resource.base_commit='a'.repeat(40);},'COORDINATION_TASK_RESOURCE_CONFLICT'],
    [()=>{resource.base_commit=f.base;admission.request.mode='review';},'COORDINATION_TASK_MODE_UNSUPPORTED'],
  ];
  for(const [change,code] of cases){change();await assert.rejects(f.enroll(task),{code});assert.equal((await f.disk()).schema_version,1);}
});
test('a detached task workspace is rejected even when its former branch still names the same commit',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await git(task.path,['checkout','--detach',task.head]);
  await assert.rejects(f.enroll(task),{code:'COORDINATION_TASK_BRANCH_CHANGED'});assert.equal((await f.disk()).revision,0);
});
test('runtime stores an explicit UTF-8 objective prefix and never copies unrelated task context or infers scope',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask({objective:'a'.repeat(4095)+'😀 tail'});
  delete task.admission.request.allowed_paths;task.admission.request.context='private context must not enter coordination';
  await f.enroll(task);const work=await f.get('work',task.id,f.ordinary);
  assert.equal(work.intent,'a'.repeat(4095));assert.equal(work.managed.intent_truncated,true);
  assert.deepEqual(work.areas,[]);assert.equal(work.managed.areas_source,'not_declared');
  assert.ok(!JSON.stringify(await f.disk()).includes('private context'));
});
test('literal projection refuses replacement characters introduced by invalid UTF-8 input and preserves written scope',()=>{
  const source={task_id:key(),root:'/unused',branch_ref:'refs/heads/task',input_oid:'1'.repeat(40),objective:'literal',allowed_paths:['src/','src/','test']};
  const projected=managedWorkProjection(source,1);assert.deepEqual(projected.areas,[{kind:'subtree',path:'src'},{kind:'subtree',path:'test'}]);
  assert.throws(()=>managedWorkProjection({...source,objective:'bad\ud800'},1),{code:'COORDINATION_TASK_TEXT_INVALID'});
});
test('enrollment serializes task adoption and retirement without blocking unrelated metadata controls',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();const entered=f.gate(),release=f.gate();let once=true;
  f.setBeforeResource(async id=>{if(id===task.id&&once){once=false;entered.release();await release.promise;}});
  const enrolling=f.enroll(task);
  try{
    await entered.promise;
    await assert.rejects(f.runtime.attachTask({task_id:task.id},stranger,key()),{code:'COORDINATION_TASK_BUSY'});
    const [retire]=await f.runtime.finalize([f.archive(task)]);assert.equal(retire.error.code,'COORDINATION_TASK_BUSY');
    const info=await f.call({schema_version:1,kind:'identity'},f.ordinary);assert.equal(info.parent_id,f.ordinary.owner_id);
  }finally{release.release();}
  await enrolling;assert.equal(f.states.get(task.id).owner_id,f.ordinary.owner_id);
});
test('subsequent task adoption does not silently move coordination ownership or rewrite enrollment attribution',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();const op=key();await f.enroll(task,f.ordinary,op);
  await f.runtime.attachTask({task_id:task.id},stranger,key());assert.equal(f.states.get(task.id).owner_id,stranger.owner_id);
  const w=await f.get('work',task.id,f.ordinary);assert.equal(w.owner,f.ordinary.owner_id);assert.equal(w.managed.control_generation,1);
  await assert.rejects(f.enroll(task,stranger),{code:'COORDINATION_TASK_REGISTERED'});
  const replay=await f.enroll(task,f.ordinary,op);assert.equal(replay.receipt.item_id,task.id);
});
test('lost observer receipt does not abandon an admitted enrollment and retry does not repeat task work',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();const entered=f.gate(),release=f.gate();let once=true;
  f.setBeforeResource(async id=>{if(id===task.id&&once){once=false;entered.release();await release.promise;}});
  const op=key(),abort=new AbortController();const waiting=f.call(f.enrollRequest(task.id,op),f.ordinary,f.root,abort.signal);
  await entered.promise;abort.abort(new Error('observer left'));await assert.rejects(waiting,/observer left/);release.release();
  // Shutdown joins the runtime-owned enrollment rather than cancelling it.
  await f.runtime.shutdown();const state=await f.disk();assert.equal(state.works[0].id,task.id);assert.equal(state.receipts.length,1);
  assert.equal(f.counts.profile,0);assert.equal((await git(task.path,['rev-parse','HEAD'])).trim(),task.head);
});
test('an active reconciliation selection prevents real worktree/ref retirement until it is released',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);let item=await f.select(task,await f.claimCase());
  const operation=f.archive(task),[refused]=await f.runtime.finalize([operation]);assert.equal(refused.error.code,'COORDINATION_RESULT_SELECTED');
  assert.equal(f.writes.length,0);await access(task.path);assert.equal((await git(f.root,['rev-parse',task.branch])).trim(),task.head);
  await f.call(f.caseRequest('release_case',item),f.ordinary);
  const [done]=await f.runtime.finalize([operation]);assert.equal(done.receipt?.state,'done',JSON.stringify(done));assert.equal(done.receipt.resource.state,'retired');
  await assert.rejects(access(task.path),{code:'ENOENT'});assert.equal((await git(f.root,['rev-parse',`refs/passeur/archive/${task.id}`])).trim(),task.head);
  assert.equal((await git(f.root,['for-each-ref','--format=%(refname)',task.branch])).trim(),'');
  const [again]=await f.runtime.finalize([operation]);assert.equal(again.receipt.state,'done');
});
test('retained disposition stays available while a case selects the task and does not delete resources',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);await f.select(task,await f.claimCase());
  const [result]=await f.runtime.finalize([{...f.archive(task),disposition:'retained',owner:'fixture parent',reason:'case selected',next_action:'release case later'}]);
  assert.equal(result.receipt?.resource.state,'retained',JSON.stringify(result));await access(task.path);
});
test('closed work still protects active selections and unrelated cases reveal no private details',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);const item=await f.select(task,await f.claimCase());
  await f.call(command({kind:'close_work',operation_key:key(),work_id:task.id,expected_revision:1}),f.ordinary);
  const [reply]=await f.runtime.finalize([f.archive(task)]);assert.equal(reply.error.code,'COORDINATION_RESULT_SELECTED');assert.ok(!reply.error.message.includes(item.id));await access(task.path);
});
test('selection after retired resource state or a runtime restart cannot use the retained metadata as live Git authority',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);let item=await f.claimCase();
  f.claims.get(task.id).state='cleanup_pending';
  await assert.rejects(f.select(task,item),{code:'COORDINATION_TASK_RESOURCE_UNAVAILABLE'});
  await f.runtime.shutdown(); // Reopen via the original fixture runtime owner using the same task maps.
  await f.restart();
  await assert.rejects(f.select(task,item),{code:'COORDINATION_TASK_RESOURCE_UNAVAILABLE'});
});
test('while actual disposition is suspended, selection refuses, but explicit closure and unrelated task controls remain usable',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);const item=await f.claimCase();
  const entered=f.gate(),release=f.gate();let once=true;
  f.setBeforeOperationWrite(async(id,record)=>{if(id===task.id&&record.state==='intent'&&once){once=false;entered.release();await release.promise;}});
  const pending=f.runtime.finalize([f.archive(task)]);
  try{
    await entered.promise;
    await assert.rejects(f.select(task,item),{code:'COORDINATION_RETIREMENT_ACTIVE'});
    await f.call(command({kind:'close_work',operation_key:key(),work_id:task.id,expected_revision:1}),f.ordinary);
  }finally{release.release();}
  const [done]=await pending;assert.equal(done.receipt?.state,'done',JSON.stringify(done));
});
test('ordinary retirement still works without enabling coordination and does not create a control record',async t=>{
  const f=await managedFixture(t);const task=await f.addTask();
  const [done]=await f.runtime.finalize([f.archive(task)]);assert.equal(done.receipt?.state,'done',JSON.stringify(done));
  await assert.rejects(access(join(f.binding.storeRoot,'coordination')),{code:'ENOENT'});
});
test('corrupt initialized metadata refuses retirement instead of treating selected-result authority as absent',async t=>{
  const f=await managedFixture(t);await f.initialize();const task=await f.addTask();await f.enroll(task);
  await writeFile(join(f.binding.storeRoot,'coordination','control.json'),'not json');
  const [refused]=await f.runtime.finalize([f.archive(task)]);assert.ok(refused.error);assert.equal(f.writes.length,0);await access(task.path);
});
