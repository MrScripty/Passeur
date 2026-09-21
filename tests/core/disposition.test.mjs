import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git, done, context, hold, until, commitFile } from './helpers.mjs';
import { DispositionManager } from '../../.passeur-core/src/core/disposition.js';
import { cleanupTask } from '../../.passeur-core/src/core/cleanup.js';
import { refHead } from '../../.passeur-core/src/workspace/project.js';
import { worktreeEntries } from '../../.passeur-core/src/workspace/worktree.js';
const op=(result,extra={})=>({operation_key:'retire-'+result.task_id,task_id:result.task_id,expected_head:result.delivery.head_commit,expected_branch_ref:result.delivery.branch_ref,disposition:'archived',archive_authorized:true,cleanup_authorized:true,...extra});
async function committed(t){const f=await fixture(t),c=f.coordinator({run:input=>commitFile(input)}),result=await c.execute(f.implementation('work'),context());return {...f,c,result,manager:new DispositionManager(f.root,'project',f.store,c)};}

test('external fast-forward followed by retirement preserves commits',async t=>{
  const f=await committed(t);await git(f.root,'merge','--ff-only',f.result.delivery.head_commit);
  const receipt=await f.manager.finalize(op(f.result,{disposition:'integrated',target_ref:'refs/heads/main',accepted_commit:f.result.delivery.head_commit}));
  assert.equal(receipt.state,'done');assert.equal(receipt.resource.state,'retired');
  assert.equal(await refHead(f.root,f.result.delivery.branch_ref),undefined);assert.ok(!(await worktreeEntries(f.root)).some(w=>w.path===f.result.delivery.worktree_path));
  assert.equal((await git(f.root,'rev-parse','HEAD')).trim(),f.result.delivery.head_commit);
});
test('archive protects exact task tip before removing the active branch',async t=>{
  const f=await committed(t),receipt=await f.manager.finalize(op(f.result));
  assert.equal(await refHead(f.root,receipt.resource.protection_ref),f.result.delivery.head_commit);assert.equal((await git(f.root,'rev-parse','HEAD')).trim(),f.base);
});
test('identical operation key returns receipt; conflicting reuse refuses',async t=>{
  const f=await committed(t),operation=op(f.result),first=await f.manager.finalize(operation);assert.deepEqual(await f.manager.finalize(operation),first);
  await assert.rejects(f.manager.finalize({...operation,reason:'different'}),{code:'OPERATION_KEY_CONFLICT'});
});
test('retaining a task needs purpose owner and next action',async t=>{
  const f=await committed(t);await assert.rejects(f.manager.finalize(op(f.result,{disposition:'retained'})),{code:'RETENTION_CONTEXT_REQUIRED'});
  const receipt=await f.manager.finalize(op(f.result,{disposition:'retained',owner:'Codex',reason:'waiting for later integration',next_action:'integrate after API work'}));
  assert.equal(receipt.resource.state,'retained');assert.equal(await refHead(f.root,f.result.delivery.branch_ref),f.result.delivery.head_commit);
});
test('dirty task worktree is retained, not force-removed',async t=>{
  const f=await committed(t);await writeFile(join(f.result.delivery.worktree_path,'dirty.txt'),'do not delete');
  await assert.rejects(f.manager.finalize(op(f.result)),{code:'WORKTREE_NOT_CLEAN'});assert.equal(await readFile(join(f.result.delivery.worktree_path,'dirty.txt'),'utf8'),'do not delete');
});
test('ignored files require explicit repository cleanup too',async t=>{
  const f=await committed(t);await writeFile(join(f.root,'.git','info','exclude'),'ignored.data\n');await writeFile(join(f.result.delivery.worktree_path,'ignored.data'),'private');
  await assert.rejects(f.manager.finalize(op(f.result)),{code:'WORKTREE_NOT_CLEAN'});
});
test('locked worktree is not removed',async t=>{
  const f=await committed(t);await git(f.root,'worktree','lock',f.result.delivery.worktree_path);await assert.rejects(f.manager.finalize(op(f.result)),{code:'WORKTREE_UNSAFE'});
});
test('changed expected head refuses retirement',async t=>{
  const f=await committed(t);await assert.rejects(f.manager.finalize(op(f.result,{expected_head:f.base})),{code:'HEAD_CHANGED'});
});
test('false integration claim cannot authorize removal',async t=>{
  const f=await committed(t);await assert.rejects(f.manager.finalize(op(f.result,{disposition:'integrated',target_ref:'refs/heads/main',accepted_commit:f.base})),{code:'INTEGRATION_NOT_RETAINED'});
});
test('retiring one completed worker does not interrupt an active sibling',async t=>{
  const f=await fixture(t),gate=hold();let running=false;
  const c=f.coordinator({run:async input=>{if(input.request.request_key==='b'){running=true;await gate.promise;}return commitFile(input,input.request.request_key+'.txt');}});
  const a=await c.execute(f.implementation('a'),context()),b=c.execute(f.implementation('b'),context());await until(()=>running);
  const manager=new DispositionManager(f.root,'project',f.store,c);await manager.finalize(op(a));assert.equal(c.activeCount,1);gate.release();assert.equal((await b).delivery.status,'committed');
});
test('interrupted receipt persistence converges on retry without redoing work',async t=>{
  const f=await committed(t),original=f.store.writeOperation.bind(f.store);let failed=false;
  f.store.writeOperation=async (id,receipt)=>{if(receipt.state==='done'&&!failed){failed=true;throw Error('receipt disk failure');}return original(id,receipt);};
  const operation=op(f.result);await assert.rejects(f.manager.finalize(operation),/receipt disk failure/);
  const retried=await f.manager.finalize(operation);assert.equal(retried.state,'done');assert.equal(await refHead(f.root,retried.resource.protection_ref),f.result.delivery.head_commit);
});
test('evidence collection preserves request result and disposition receipts',async t=>{
  const f=await committed(t);await assert.rejects(cleanupTask({store:f.store,taskId:f.result.task_id}),{code:'RESOURCE_DISPOSITION_REQUIRED'});
  await f.manager.finalize(op(f.result));await cleanupTask({store:f.store,taskId:f.result.task_id});
  assert.ok(await f.store.readResult(f.result.task_id));assert.ok(await f.store.find({request_key:'work'}));assert.ok(await f.store.readOperation(f.result.task_id,'retire-'+f.result.task_id));
  assert.equal((await f.store.readResource(f.result.task_id)).state,'retired');
});
test('missing cleanup or archive authority refuses mutations',async t=>{
  const f=await committed(t);await assert.rejects(f.manager.finalize(op(f.result,{cleanup_authorized:false})),{code:'CLEANUP_AUTHORITY_REQUIRED'});await assert.rejects(f.manager.finalize(op(f.result,{archive_authorized:false})),{code:'ARCHIVE_AUTHORITY_REQUIRED'});
});
