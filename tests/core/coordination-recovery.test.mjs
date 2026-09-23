import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, A, B, C, register, claim, caseOp, post, key } from '../fixtures/structural/coordination-fixture.mjs';
import { decodeControl, decodeCommand, decodeRecoveryCommand, decodeRecoveryReceipt, CONTROL_RELEASE_BYTES } from '../../.passeur-core/src/contracts/coordination-control.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

async function work(f, readers = []) {
  const receipt = await f.control.execute(A, register({ readers }));
  return f.control.work(A, receipt.item_id);
}
async function recovery(f, kind, item, extra = {}) {
  return { kind, operation_key: key(), epoch: (await f.disk()).epoch,
    expected_owner: item.owner ?? item.lead, expected_revision: item.revision,
    ...('workspace_id' in item ? { work_id: item.id } : { case_id: item.id, expected_generation: item.generation }),
    statement: 'Operator selected recovery after inspecting retained metadata.', ...extra };
}

test('operator inspection leaves the exact v1 record unchanged', async t => {
  const f = await fixture(t), w = await work(f), original = await readFile(f.file);
  const view = await f.control.inspectRecoveryAuthorized(C, { kind: 'work', id: w.id });
  assert.equal(view.subject.owner, A.owner_id); assert.equal(view.epoch, (await f.disk()).epoch);
  assert.deepEqual(await readFile(f.file), original); assert.equal((await f.disk()).schema_version, 1);
});
test('adoption atomically upgrades metadata and preserves source, statements and ordinary receipts', async t => {
  const f = await fixture(t), w = await work(f, [B.owner_id]);
  const nr = await f.control.execute(A, post({kind:'work',id:w.id}, {note_kind:'agreement_proposal',parties:[A.owner_id,B.owner_id]}));
  const before = await f.disk();
  const c = await recovery(f, 'adopt_work', w, {new_owner:B.owner_id});
  const receipt = await f.control.recoverAuthorized(C,c), after = await f.disk();
  assert.equal(after.schema_version,2); assert.equal(after.recoveries.length,1); assert.deepEqual(after.receipts,before.receipts);
  assert.deepEqual(after.notes,before.notes); assert.deepEqual(after.works[0], {...w,owner:B.owner_id,readers:[],revision:2});
  assert.equal(receipt.operator,C.owner_id); assert.equal(receipt.revision,before.revision+1);
  assert.equal((await f.control.note(B,nr.item_id)).agreement,'pending');
  await assert.rejects(f.control.execute(A,{kind:'share_work',operation_key:key(),work_id:w.id,expected_revision:2,readers:[]}),{code:'COORDINATION_NOT_FOUND'});
  await f.control.execute(B,{kind:'close_work',operation_key:key(),work_id:w.id,expected_revision:2});
  assert.equal((await f.disk()).schema_version,2);
});
test('recovery retry is a historical receipt, not a second transfer after another adoption', async t => {
  const f=await fixture(t),w=await work(f),first=await recovery(f,'adopt_work',w,{new_owner:B.owner_id});
  const saved=await f.control.recoverAuthorized(C,first), b=await f.control.work(B,w.id);
  await f.control.recoverAuthorized(C,await recovery(f,'adopt_work',b,{new_owner:A.owner_id}));
  const before=await readFile(f.file); assert.deepEqual(await f.control.recoverAuthorized(C,first),saved);
  assert.equal((await f.control.work(A,w.id)).owner,A.owner_id); assert.deepEqual(await readFile(f.file),before);
  await assert.rejects(f.control.recoverAuthorized(C,{...first,new_owner:C.owner_id}),{code:'COORDINATION_KEY_CONFLICT'});
});
test('ordinary and recovery operation keys share one operator namespace', async t=>{
  const f=await fixture(t),op=key(),w=await work(f);
  await f.control.execute(C,claim({operation_key:op}));
  await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,'close_work',w,{operation_key:op})),{code:'COORDINATION_KEY_CONFLICT'});
  const c=await recovery(f,'adopt_work',w,{new_owner:B.owner_id});await f.control.recoverAuthorized(C,c);
  await assert.rejects(f.control.execute(C,claim({operation_key:c.operation_key,target:'refs/heads/another'})),{code:'COORDINATION_KEY_CONFLICT'});
  await assert.rejects(f.control.prepareSourceCommand(C,claim({operation_key:c.operation_key,target:'refs/heads/another'})),{code:'COORDINATION_KEY_CONFLICT'});
});
for (const [name,patch,code] of [
  ['epoch',{epoch:'00000000-0000-0000-0000-000000000001'},'COORDINATION_STALE_EPOCH'],
  ['owner',{expected_owner:B.owner_id},'COORDINATION_STALE_REVISION'],
  ['revision',{expected_revision:2},'COORDINATION_STALE_REVISION'],
]) test(`stale ${name} refuses recovery without migrating or editing`,async t=>{
  const f=await fixture(t),w=await work(f),before=await readFile(f.file);
  await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,'adopt_work',w,{new_owner:B.owner_id,...patch})),{code});
  assert.deepEqual(await readFile(f.file),before);
});
test('competing recovery requests serialize one accepted owner change',async t=>{
  const f=await fixture(t),w=await work(f);
  const requests=await Promise.all([recovery(f,'adopt_work',w,{new_owner:B.owner_id}),recovery(f,'adopt_work',w,{new_owner:C.owner_id})]);
  const replies=await Promise.allSettled(requests.map(c=>f.control.recoverAuthorized(C,c)));
  assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(replies.find(r=>r.status==='rejected').reason.code,'COORDINATION_STALE_REVISION');
  assert.equal((await f.disk()).recoveries.length,1);
});
test('recovery does not reopen closed work or close a case with unaccounted external effects',async t=>{
  const f=await fixture(t),w=await work(f,[B.owner_id]);
  await f.control.execute(A,{kind:'close_work',operation_key:key(),work_id:w.id,expected_revision:1});
  await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,'adopt_work',await f.control.work(A,w.id),{new_owner:B.owner_id})),{code:'COORDINATION_WORK_CLOSED'});
  const cr=await f.control.execute(A,claim({members:[B.owner_id]}));let c=await f.control.reconciliation(A,cr.item_id);
  await f.control.execute(A,caseOp('select_inputs',c,{target_oid:w.input_oid,inputs:[{work_id:w.id,commit_oid:w.input_oid}]}));
  c=await f.control.reconciliation(A,c.id);
  await f.control.execute(A,caseOp('begin_external_integration',c));c=await f.control.reconciliation(A,c.id);
  const before=await readFile(f.file);
  for(const kind of ['release_case','adopt_case']) await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,kind,c,kind==='adopt_case'?{new_owner:B.owner_id}:{})),{code:'COORDINATION_EXTERNAL_EFFECT_UNRESOLVED'});
  assert.deepEqual(await readFile(f.file),before);
});
test('operator settlement remains an attributed report and requires a fresh adoption revision',async t=>{
  const f=await fixture(t),w=await work(f,[B.owner_id]);const cr=await f.control.execute(A,claim());let c=await f.control.reconciliation(A,cr.item_id);
  await f.control.execute(A,caseOp('select_inputs',c,{target_oid:w.input_oid,inputs:[{work_id:w.id,commit_oid:w.input_oid}]}));
  c=await f.control.reconciliation(A,c.id);await f.control.execute(A,caseOp('begin_external_integration',c));c=await f.control.reconciliation(A,c.id);
  const stale=await recovery(f,'adopt_case',c,{new_owner:B.owner_id});
  const settlement=await recovery(f,'settle_case',c,{statement:'Operator evidence: inspected the external Git process and its retained output.'});
  const saved=await f.control.recoverAuthorized(C,settlement);
  assert.equal(saved.command.statement,settlement.statement);assert.equal((await f.control.reconciliation(A,c.id)).lead,A.owner_id);
  await assert.rejects(f.control.recoverAuthorized(C,stale),{code:'COORDINATION_STALE_REVISION'});
  c=await f.control.reconciliation(A,c.id);await f.control.recoverAuthorized(C,await recovery(f,'adopt_case',c,{new_owner:B.owner_id}));
  const after=await f.control.reconciliation(B,c.id);assert.equal(after.generation,c.generation+1);assert.equal(after.external_effect,'not_started');
  await assert.rejects(f.control.execute(A,caseOp('release_case',after)),{code:'COORDINATION_FORBIDDEN'});
});
test('new reconciliation lead receives no implicit selected-input sharing',async t=>{
  const f=await fixture(t),w=await work(f),cr=await f.control.execute(A,claim());let c=await f.control.reconciliation(A,cr.item_id);
  await f.control.execute(A,caseOp('select_inputs',c,{target_oid:w.input_oid,inputs:[{work_id:w.id,commit_oid:w.input_oid}]}));c=await f.control.reconciliation(A,c.id);
  await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,'adopt_case',c,{new_owner:B.owner_id})),{code:'COORDINATION_NOT_FOUND'});
  assert.equal((await f.disk()).schema_version,1);
});
test('reserved capacity permits operator closure when there is no spare adoption slot',async t=>{
  const f=await fixture(t,{receipts:2}),w=await work(f);
  await assert.rejects(f.control.recoverAuthorized(C,await recovery(f,'adopt_work',w,{new_owner:B.owner_id})),{code:'COORDINATION_CAPACITY'});
  await f.control.recoverAuthorized(C,await recovery(f,'close_work',w));
  assert.equal((await f.disk()).works[0].state,'closed');assert.equal((await f.disk()).revision,2);
});
test('maximum encoded recovery closure fits the reserved release byte allowance',async t=>{
  const f=await fixture(t),w=await work(f),before=await readFile(f.file);
  await f.control.recoverAuthorized(C,await recovery(f,'close_work',w,{operation_key:'\x01'.repeat(256),statement:'\x02'.repeat(256)}));
  const growth=(await readFile(f.file)).length-before.length;
  assert.ok(growth<=CONTROL_RELEASE_BYTES,`${growth} must fit ${CONTROL_RELEASE_BYTES}`);
});
test('store transition rejects forged unrelated mutation and audit rewriting',async t=>{
  const f=await fixture(t),w=await work(f);const c=await recovery(f,'adopt_work',w,{new_owner:B.owner_id});
  const receipt=await f.control.recoverAuthorized(C,c),before=await f.disk();
  const bad=structuredClone(before);bad.revision++;bad.works[0].intent='unrelated mutation';
  const second={...c,kind:'close_work',operation_key:key(),expected_owner:B.owner_id,expected_revision:2};delete second.new_owner;
  bad.works[0].revision++;bad.works[0].state='closed';
  bad.recoveries.push({operator:C.owner_id,command:second,revision:bad.revision,request_hash:canonicalHash({operator:C.owner_id,recovery:second})});
  await assert.rejects(f.store.publish(before,bad),{code:'COORDINATION_INVALID'});
  const corrupted=structuredClone(before);corrupted.recoveries[0].command.statement='rewritten';
  assert.throws(()=>decodeControl(corrupted,f.store.repositoryId),{code:'COORDINATION_INVALID'});
  assert.deepEqual(await f.disk(),before);assert.deepEqual(decodeRecoveryReceipt(receipt),receipt);
});
test('reopening migrated state preserves receipt identity and ordinary operations',async t=>{
  const f=await fixture(t),w=await work(f),c=await recovery(f,'adopt_work',w,{new_owner:B.owner_id});
  const receipt=await f.control.recoverAuthorized(C,c);await f.control.close();
  const store=await CoordinationStore.open(f.root,f.store.repositoryId,()=>{}), reopened=new CoordinationControl(store);
  try {assert.deepEqual(await reopened.recoverAuthorized(C,c),receipt);await reopened.execute(B,{kind:'close_work',operation_key:key(),work_id:w.id,expected_revision:2});}
  finally{await reopened.close();}
});
test('ordinary command decoder cannot invoke recovery, and recovery has closed bounded fields',()=>{
  const c={kind:'adopt_work',operation_key:key(),epoch:key(),work_id:key(),expected_owner:A.owner_id,expected_revision:1,new_owner:B.owner_id,statement:'Operator selected this parent.'};
  assert.throws(()=>decodeCommand(c),{code:'COORDINATION_OPERATION_UNSUPPORTED'});
  assert.deepEqual(decodeRecoveryCommand(c),c);
  for(const value of [{...c,approved:true},{...c,statement:' '},{...c,statement:'x'.repeat(257)},{...c,expected_revision:0}]) assert.throws(()=>decodeRecoveryCommand(value));
  let touched=false;const accessor={...c};Object.defineProperty(accessor,'statement',{enumerable:true,get(){touched=true;return 'bad';}});
  assert.throws(()=>decodeRecoveryCommand(accessor));assert.equal(touched,false);
});
test('pre-publication authority loss preserves v1 and a cold reopen can apply the original key',async t=>{
  let calls=0,cutoff=Infinity;
  const f=await fixture(t,{},()=>{if(++calls===cutoff)throw Error('authority withdrawn');}),w=await work(f);
  const c=await recovery(f,'adopt_work',w,{new_owner:B.owner_id}),before=await readFile(f.file);
  // Store.assertMutable, publish.assertMutable, atomic mkdir/write/rename all use the actual authority boundary.
  cutoff=calls+5;
  await assert.rejects(f.control.recoverAuthorized(C,c),{code:'COORDINATION_PUBLICATION_UNCERTAIN'});
  assert.deepEqual(await readFile(f.file),before);
  await assert.rejects(f.control.recoverAuthorized(C,c),{code:'COORDINATION_REOPEN_REQUIRED'});
  await f.control.close();cutoff=Infinity;
  const store=await CoordinationStore.open(f.root,f.store.repositoryId,()=>{}),owner=new CoordinationControl(store);
  try {await owner.recoverAuthorized(C,c);assert.equal((await store.snapshot()).works[0].owner,B.owner_id);}
  finally{await owner.close();}
});
test('recovery receipt cannot claim a revision preceding its subject or change a persisted audit',async t=>{
  const f=await fixture(t),w=await work(f),c=await recovery(f,'adopt_work',w,{new_owner:B.owner_id});
  const receipt=await f.control.recoverAuthorized(C,c);
  assert.throws(()=>decodeRecoveryReceipt({...receipt,revision:1}),{code:'COORDINATION_INVALID'});
  const state=await f.disk(),altered=structuredClone(state);altered.recoveries[0].command.statement='changed';
  altered.recoveries[0].request_hash=canonicalHash({operator:C.owner_id,recovery:altered.recoveries[0].command});
  // Even a self-consistent rewritten hash does not authorize replacing a prior published audit.
  altered.revision++;const close={kind:'close_work',operation_key:key(),work_id:w.id,expected_revision:2};
  altered.works[0].state='closed';altered.works[0].revision++;
  altered.receipts.push({owner:B.owner_id,key:close.operation_key,request_hash:canonicalHash({owner:B.owner_id,command:close}),revision:altered.revision,action:'close_work',entity:{kind:'work',id:w.id},item_id:w.id,outcome:'recorded'});
  await assert.rejects(f.store.publish(state,altered),{code:'COORDINATION_INVALID'});
  const downgrade=structuredClone(altered);downgrade.schema_version=1;delete downgrade.recoveries;
  await assert.rejects(f.store.publish(state,downgrade));
  assert.deepEqual(await f.disk(),state);
});


test('lost operator receipt is recovered by a new process without repeating adoption', async t => {
  const f = await fixture(t), w = await work(f);
  const recoveryRequest = await recovery(f, 'adopt_work', w, { new_owner: B.owner_id });
  const requestPath = join(f.root, 'recovery-request.json');
  await writeFile(requestPath, JSON.stringify({ repository: f.store.repositoryId, actor: C, recovery: recoveryRequest }));
  await f.control.close();
  const child = fileURLToPath(new URL('../fixtures/structural/recovery-reopen.mjs', import.meta.url));
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, [child, f.root, requestPath, 'lose-receipt']), { code: 74 });
  const original = await readFile(f.file);
  const disk = JSON.parse(original.toString('utf8'));
  assert.equal(disk.schema_version, 2);
  assert.equal(disk.works[0].owner, B.owner_id);
  assert.equal(disk.works[0].revision, 2);
  const { stdout } = await run(process.execPath, [child, f.root, requestPath, 'read-receipt']);
  assert.deepEqual(JSON.parse(stdout), disk.recoveries[0]);
  assert.deepEqual(await readFile(f.file), original);
});

test('reserved case capacity accounts for separate operator settlement and release', async t => {
  const f = await fixture(t, { receipts: 7 }), w = await work(f);
  const claimed = await f.control.execute(A, claim());
  let c = await f.control.reconciliation(A, claimed.item_id);
  await f.control.execute(A, caseOp('select_inputs', c, { target_oid: w.input_oid, inputs: [{ work_id: w.id, commit_oid: w.input_oid }] }));
  c = await f.control.reconciliation(A, c.id);
  await f.control.execute(A, caseOp('begin_external_integration', c));
  await assert.rejects(f.control.recoverAuthorized(C, await recovery(f, 'adopt_work', w, { new_owner: B.owner_id })), { code: 'COORDINATION_CAPACITY' });
  await f.control.recoverAuthorized(C, await recovery(f, 'close_work', w));
  c = await f.control.reconciliation(A, c.id);
  const before = await readFile(f.file);
  await f.control.recoverAuthorized(C, await recovery(f, 'settle_case', c, { operation_key: '\x01'.repeat(256), statement: '\x02'.repeat(256) }));
  assert.ok((await readFile(f.file)).length - before.length <= CONTROL_RELEASE_BYTES);
  c = await f.control.reconciliation(A, c.id);
  await f.control.recoverAuthorized(C, await recovery(f, 'release_case', c));
  assert.equal((await f.disk()).cases[0].state, 'closed');
  assert.equal((await f.disk()).revision, 7);
});
