import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, A, B, C, key, register, claim, caseOp, post, repo } from '../fixtures/structural/coordination-fixture.mjs';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { decodeControl, decodeRepositoryCommand, assertControlTransition } from '../../.passeur-core/src/contracts/coordination-control.js';
import { decodeCoordinationRequest, decodeCoordinationReply } from '../../.passeur-core/src/contracts/coordination-service.js';
import { decodeCoordinationToolArguments } from '../../.passeur-core/src/mcp/coordination-operations.js';
const run = promisify(execFile);
const task = () => ({ kind: 'register_task_work', operation_key: key(), workspace_id: 'workspace:'+key(), input_oid: '1'.repeat(40), object_format: 'sha1', intent: 'Existing task objective', areas: [{ kind:'subtree', path:'src' }], managed: { task_id:key(), control_generation:1, intent_truncated:false, areas_source:'allowed_paths' } });
async function selected(t) {
  const f = await fixture(t), cmd = task(), receipt = await f.control.execute(A, cmd);
  const caseId = (await f.control.execute(A, claim())).item_id;
  const item = await f.control.reconciliation(A, caseId);
  const selection = caseOp('select_inputs', item, { target_oid:'2'.repeat(40), inputs:[{work_id: receipt.item_id,commit_oid:'3'.repeat(40)}] });
  return {...f, cmd, receipt, caseId, selection};
}

test('managed registration alone migrates v1 atomically and retains exact attribution with private default sharing', async t => {
  const f=await fixture(t), before=await f.disk(), cmd=task();
  const receipt=await f.control.execute(A,cmd), state=await f.disk(), work=await f.control.work(A,receipt.item_id);
  assert.equal(before.schema_version,1); assert.equal(state.schema_version,3); assert.deepEqual(state.recoveries,[]);
  assert.equal(work.id,cmd.managed.task_id); assert.equal(receipt.action,'register_task_work');
  assert.deepEqual(work.managed,cmd.managed); assert.deepEqual(work.readers,[]); assert.equal(work.input_oid,cmd.input_oid);
  await assert.rejects(f.control.work(B,work.id),{code:'COORDINATION_NOT_FOUND'});
  assert.deepEqual(await f.control.execute(A,cmd),receipt); assert.equal((await f.disk()).revision,1);
});
test('a rejected managed registration neither migrates nor changes accepted metadata', async t => {
  const f=await fixture(t), occupied=register(); await f.control.execute(A,occupied);
  const before=await readFile(f.file), cmd={...task(),workspace_id:occupied.workspace_id};
  await assert.rejects(f.control.execute(A,cmd),{code:'COORDINATION_WORKSPACE_HELD'});
  assert.deepEqual(await readFile(f.file),before); assert.equal((await f.disk()).schema_version,1);
});
test('managed task identity cannot be reenrolled with a new key, including after closure', async t => {
  const f=await fixture(t), cmd=task(), first=await f.control.execute(A,cmd);
  await f.control.execute(A,{kind:'close_work',operation_key:key(),work_id:first.item_id,expected_revision:1});
  await assert.rejects(f.control.execute(A,{...cmd,operation_key:key()}),{code:'COORDINATION_TASK_REGISTERED'});
  assert.deepEqual(await f.control.execute(A,cmd),first);
});
test('v2 migration retains old recovery receipts and future recoveries preserve v3 and original enrollment facts', async t => {
  const f=await fixture(t), e=await f.control.execute(A,register());
  let state=await f.disk();
  const recovery={kind:'adopt_work',operation_key:key(),epoch:state.epoch,expected_owner:A.owner_id,expected_revision:1,statement:'Fixture operator authorizes transfer',work_id:e.item_id,new_owner:B.owner_id};
  await f.control.recoverAuthorized(C,recovery); state=await f.disk(); assert.equal(state.schema_version,2);
  const previous=state.recoveries, cmd=task(), receipt=await f.control.execute(A,cmd);
  state=await f.disk(); assert.equal(state.schema_version,3); assert.deepEqual(state.recoveries,previous);
  await f.control.recoverAuthorized(C,{...recovery,operation_key:key(),work_id:receipt.item_id,expected_revision:1});
  const work=await f.control.work(B,receipt.item_id);
  assert.equal((await f.disk()).schema_version,3); assert.deepEqual(work.managed,cmd.managed);
  assert.equal(work.owner,B.owner_id); assert.equal((await f.disk()).receipts.find(r=>r.item_id===work.id).owner,A.owner_id);
});
test('decoders reject source or actor supplied to managed enrollment, and all tools except work reject it', () => {
  const cmd={kind:'register_managed_work',operation_key:key(),task_id:key()}, request={schema_version:1,kind:'command',command:cmd};
  assert.deepEqual(decodeCoordinationToolArguments('passeur_work',{request}),request);
  for(const tool of ['passeur_coordination','passeur_notes','passeur_reconciliation']) assert.throws(()=>decodeCoordinationToolArguments(tool,{request}),{code:'COORDINATION_TOOL_OPERATION_UNSUPPORTED'});
  for(const extra of [{actor:A.owner_id},{input_oid:'1'.repeat(40)},{workspace_id:key()},{approved:true},{intent:'fabricated'}]) assert.throws(()=>decodeRepositoryCommand({...cmd,...extra}),{code:'COORDINATION_INVALID'});
  assert.throws(()=>decodeRepositoryCommand(task()),{code:'COORDINATION_OPERATION_UNSUPPORTED'});
});
test('destination checks bind the managed enrollment receipt to the exact task, parent, and operation', async t => {
  const f=await fixture(t), cmd=task(), receipt=await f.control.execute(A,cmd), repository='a'.repeat(24);
  const request=decodeCoordinationRequest({schema_version:1,kind:'command',command:{kind:'register_managed_work',operation_key:cmd.operation_key,task_id:cmd.managed.task_id}});
  const reply={schema_version:1,kind:'receipt',repository_id:repository,receipt};
  assert.deepEqual(decodeCoordinationReply(request,A.owner_id,repository,reply),reply);
  for(const patch of [{owner:B.owner_id},{key:key()},{action:'register_work'},{item_id:key()},{entity:{kind:'work',id:key()}}]) assert.throws(()=>decodeCoordinationReply(request,A.owner_id,repository,{...reply,receipt:{...receipt,...patch}}),{code:'COORDINATION_SERVICE_INVALID'});
});
test('source metadata cannot be rewritten during sharing, recovery or an unrelated transition', async t => {
  const f=await fixture(t), cmd=task(), result=await f.control.execute(A,cmd), before=await f.disk();
  await f.control.execute(A,{kind:'share_work',operation_key:key(),work_id:result.item_id,expected_revision:1,readers:[B.owner_id]});
  const after=await f.disk(); assert.deepEqual(after.works[0].managed,before.works[0].managed);
  for(const edit of [x=>x.works[0].managed.control_generation++, x=>x.works[0].input_oid='a'.repeat(40), x=>x.works[0].intent='reworded']) {
    const bad=structuredClone(after); edit(bad); assert.throws(()=>decodeControl(bad,repo),{code:'COORDINATION_INVALID'});
  }
  const bad=structuredClone(after); bad.schema_version=2; assert.throws(()=>decodeControl(bad,repo),{code:'COORDINATION_INVALID'});
  const next=structuredClone(after); next.works[0].readers.push(C.owner_id); assert.throws(()=>assertControlTransition(after,next),{code:'COORDINATION_INVALID'});
});
test('active selection blocks retirement even after work closure and without disclosing the case', async t => {
  const f=await selected(t); await f.control.execute(A,f.selection);
  await f.control.execute(A,{kind:'close_work',operation_key:key(),work_id:f.receipt.item_id,expected_revision:1});
  await assert.rejects(f.control.reserveRetirement(f.cmd.managed.task_id),error=>{
    assert.equal(error.code,'COORDINATION_RESULT_SELECTED'); assert.ok(!error.message.includes(f.caseId)); return true;
  });
  const item=await f.control.reconciliation(A,f.caseId);
  await f.control.execute(A,caseOp('release_case',item));
  const reservation=await f.control.reserveRetirement(f.cmd.managed.task_id); await reservation.release(); await reservation.release();
});
test('a retirement reservation prevents new selection without holding the metadata mutex', async t => {
  const f=await selected(t), reservation=await f.control.reserveRetirement(f.cmd.managed.task_id);
  try {
    await assert.rejects(f.control.prepareSourceCommand(A,f.selection),{code:'COORDINATION_RETIREMENT_ACTIVE'});
    await assert.rejects(f.control.execute(A,f.selection),{code:'COORDINATION_RETIREMENT_ACTIVE'});
    const unrelated=await f.control.execute(B,register()); assert.equal(unrelated.outcome,'recorded');
    await f.control.execute(A,{kind:'close_work',operation_key:key(),work_id:f.receipt.item_id,expected_revision:1});
  } finally { await reservation.release(); }
});
test('preflight prepared before a complete retirement attempt cannot publish afterward with stale facts', async t => {
  const f=await selected(t), prepared=await f.control.prepareSourceCommand(A,f.selection);
  assert.equal(prepared.kind,'inspect');
  const reservation=await f.control.reserveRetirement(f.cmd.managed.task_id); await reservation.release();
  await assert.rejects(f.control.execute(A,f.selection,prepared.resource_versions),{code:'COORDINATION_RESOURCE_CHANGED'});
  assert.deepEqual((await f.control.reconciliation(A,f.caseId)).inputs,[]);
  const fresh=await f.control.prepareSourceCommand(A,f.selection); await f.control.execute(A,f.selection,fresh.resource_versions);
});
test('simultaneous selection and retirement produce one winner, never both authorities', async t => {
  const f=await selected(t), prepared=await f.control.prepareSourceCommand(A,f.selection);
  const values=await Promise.allSettled([f.control.execute(A,f.selection,prepared.resource_versions),f.control.reserveRetirement(f.cmd.managed.task_id)]);
  try { assert.equal(values.filter(x=>x.status==='fulfilled').length,1); }
  finally { if(values[1].status==='fulfilled') await values[1].value.release(); }
});
test('shutdown waits for the resource reservation, rejects new work, and permits its explicit release', async t => {
  const f=await fixture(t), cmd=task(); await f.control.execute(A,cmd);
  const reservation=await f.control.reserveRetirement(cmd.managed.task_id); let closed=false;
  const stopping=f.control.close().then(()=>{closed=true;});
  await assert.rejects(f.control.execute(A,register()),{code:'COORDINATION_CLOSED'}); assert.equal(closed,false);
  await reservation.release(); await stopping; assert.equal(closed,true);
});
test('cold reopen retains v3 enrollment after a lost response without adding a second receipt', async t => {
  const f=await fixture(t), cmd=task(), requestFile=join(f.root,'managed-request.json');
  await writeFile(requestFile,JSON.stringify({repository:repo,actor:A,command:cmd}));
  const child=fileURLToPath(new URL('../fixtures/structural/managed-reopen.mjs',import.meta.url));
  await assert.rejects(run(process.execPath,[child,f.root,requestFile,'lose-receipt']),error=>error.code===74);
  const output=await run(process.execPath,[child,f.root,requestFile,'receipt']);
  const receipt=JSON.parse(output.stdout); assert.equal(receipt.item_id,cmd.managed.task_id); assert.equal(receipt.revision,1);
  const opened=new CoordinationControl(await CoordinationStore.open(f.root,repo,()=>{}));
  try { assert.deepEqual(await opened.execute(A,cmd),receipt); assert.equal((await opened.work(A,receipt.item_id)).input_oid,cmd.input_oid); }
  finally { await opened.close(); }
  assert.equal((await f.disk()).revision,1);
});
test('close racing a suspended retirement admission never grants a reservation after the owner is closed', async t => {
  const f=await fixture(t);let entered, resume;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{resume=resolve;});
  const read=f.store.snapshot.bind(f.store);let first=true;
  f.store.snapshot=async()=>{const value=await read();if(first){first=false;entered();await gate;}return value;};
  const pending=f.control.reserveRetirement(key());await enteredPromise;
  const closing=f.control.close();resume();
  let granted;
  try {
    const outcome=await pending.then(value=>{granted=value;return 'granted';},error=>error.code);
    assert.equal(outcome,'COORDINATION_CLOSED');
  } finally {await granted?.release();await closing;}
});
