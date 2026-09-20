import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git, done, context, commitFile } from './helpers.mjs';
import { observeDelivery, prepareWorkspace } from '../../.passeur-core/src/workspace/worktree.js';
import { repositoryIdentity } from '../../.passeur-core/src/workspace/project.js';
import { parseWorkerReport } from '../../.passeur-core/src/agents/report.js';
import { toolPayload, resultReceipt } from '../../.passeur-core/src/core/result.js';

test('worker commits invoke normal hooks; Passeur runs no application test gate', async t=>{
  const f=await fixture(t), marker=join(f.temp,'hooks.txt');
  const hook=join(f.root,'.git','hooks','pre-commit');await writeFile(hook,`#!/bin/sh\nprintf 'hook\\n' >> '${marker}'\n`);await chmod(hook,0o755);
  const c=f.coordinator({run:async input=>{
    await writeFile(join(input.workspace,'package.json'),JSON.stringify({scripts:{test:'exit 99'}}));
    await git(input.workspace,'add','package.json');await git(input.workspace,'commit','-qm','feat: unfinished component');return done();
  }});
  const result=await c.delegate(f.implementation('component'),context());
  assert.equal(result.delivery.status,'committed');assert.equal((await readFile(marker,'utf8')).trim(),'hook');
  assert.equal((await git(f.root,'rev-parse','HEAD')).trim(),f.base);assert.equal(await git(f.root,'status','--porcelain'),'');
});
test('rejecting hook is not bypassed or rerun by Passeur',async t=>{
  const f=await fixture(t),marker=join(f.temp,'rejects.txt'),hook=join(f.root,'.git','hooks','pre-commit');
  await writeFile(hook,`#!/bin/sh\nprintf 'rejected\\n' >> '${marker}'\nexit 1\n`);await chmod(hook,0o755);
  const c=f.coordinator({run:async input=>{try{return await commitFile(input);}catch{return done({status:'failed',blockers:['hook rejected']});}}});
  const result=await c.delegate(f.implementation('reject'),context());
  assert.equal(result.execution_status,'failed');assert.equal(result.delivery.status,'incomplete');assert.equal((await readFile(marker,'utf8')).trim(),'rejected');
});
test('uncommitted output is incomplete even when worker claims success',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async input=>{await writeFile(join(input.workspace,'uncommitted.txt'),'work');return done();}});
  const result=await c.delegate(f.implementation('missing-commit'),context());assert.equal(result.execution_status,'completed');assert.equal(result.delivery.status,'incomplete');
});
test('explicit no-change explanation plus unchanged Git facts is sufficient',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done({no_changes_reason:'The requested behavior already exists'})});
  const result=await c.delegate(f.implementation('noop'),context());assert.equal(result.delivery.status,'no_changes_needed');assert.equal(result.delivery.head_commit,f.base);
});
test('no explanation and no commit is incomplete',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done()});assert.equal((await c.delegate(f.implementation('no-explanation'),context())).delivery.status,'incomplete');
});
test('failed run can retain real commits without becoming successful',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async input=>{await commitFile(input);return done({status:'failed',summary:'additional request blocked'});}});
  const result=await c.delegate(f.implementation('partial'),context());assert.equal(result.delivery.status,'committed');assert.equal(result.execution_status,'failed');
});
test('full multi-commit range is reported from Git',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async input=>{await commitFile(input,'one.txt');await commitFile(input,'two.txt');return done();}});
  const result=await c.delegate(f.implementation('multi'),context());assert.equal(result.delivery.commits.length,2);assert.equal(result.delivery.commits.at(-1),result.delivery.head_commit);
});
test('referenced deletion still produces complete manifest and applicable patch',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async input=>{await unlink(join(input.workspace,'watched.txt'));await git(input.workspace,'add','-A');await git(input.workspace,'commit','-qm','feat: remove watched');return done();}});
  const result=await c.delegate(f.implementation('delete',{context_files:['watched.txt']}),context());
  assert.equal(result.error,undefined);assert.equal(result.delivery.status,'committed');assert.deepEqual(result.changed_files,['watched.txt']);
  const patch=result.artifacts.find(a=>a.id==='diff');await git(f.root,'apply','--check',join(f.store.taskDir(result.task_id),patch.path));
});
test('rename scope warning includes the old path',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async input=>{await mkdir(join(input.workspace,'allowed'));await rename(join(input.workspace,'watched.txt'),join(input.workspace,'allowed','new.txt'));await git(input.workspace,'add','-A');await git(input.workspace,'commit','-qm','feat: rename');return done();}});
  const result=await c.delegate(f.implementation('rename',{allowed_paths:['allowed']}),context());assert.match(result.blockers.join('\n'),/watched.txt/);assert.deepEqual(result.changed_files,['allowed/new.txt']);
});
test('quoted, arrow and newline filenames survive Git export',async t=>{
  const f=await fixture(t),name='a" -> b\n.txt',c=f.coordinator({run:input=>commitFile(input,name)});
  const result=await c.delegate(f.implementation('odd-path'),context());assert.equal(result.delivery.status,'committed');assert.deepEqual(result.changed_files,[name]);
});
test('genuine finalization failure preserves an already observed committed delivery',async t=>{
  const f=await fixture(t), original=f.store.writeResource.bind(f.store);let fail=false;
  f.store.writeResource=async (id,value)=>{if(fail&&value.head_commit)throw Error('finalization fault');return original(id,value);};
  const c=f.coordinator({run:async input=>{await commitFile(input);fail=true;return done();}});
  const result=await c.delegate(f.implementation('finalize-fails'),context());assert.equal(result.worker_stop,'confirmed');assert.equal(result.error.code,'FINALIZATION_FAILED');assert.equal(result.delivery.status,'committed');
});
test('implementation worktree root cannot be inside source',async t=>{
  const f=await fixture(t);await assert.rejects(prepareWorkspace(f.root,f.implementation('root'),{...f.policy,implementation:{...f.policy.implementation,worktree_root:join(f.root,'nested')}},'project',crypto.randomUUID()),{code:'INVALID_WORKTREE_ROOT'});
});
test('linked worktrees have the same repository owner identity',async t=>{
  const f=await fixture(t),linked=join(f.temp,'linked');await git(f.root,'worktree','add','-b','linked',linked,f.base);
  assert.deepEqual(await repositoryIdentity(f.root),await repositoryIdentity(linked));
});
test('reported checks remain worker claims and nonfinite exit codes stay unknown',()=>{
  const parsed=parseWorkerReport('PASSEUR_RESULT {"summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[{"command":"unit","cwd":"/work","exit_code":0}],"no_changes_reason":"already there"}');
  assert.equal(parsed.checks[0].evidence,'worker_reported');assert.equal(parsed.no_changes_reason,'already there');assert.throws(()=>parseWorkerReport('not json'),{code:'WORKER_REPORT_INVALID'});
});
test('aggregate receipts stay below the actual MCP payload limit',async t=>{
  const f=await fixture(t),c=f.coordinator({run:async()=>done({summary:'\\\n'.repeat(20000),blockers:['x'.repeat(10000)]})});
  const result=await c.delegate(f.request('big'),context());const payload=toolPayload({results:Array.from({length:8},()=>resultReceipt(result))});assert.ok(Buffer.byteLength(JSON.stringify(payload))<=24576);
});


test('aggregate receipts retain task identifiers when long Unicode evidence needs compaction', async t => {
  const { batchToolPayload } = await import('../../.passeur-core/src/core/result.js');
  const entries=Array.from({length:8},(_,i)=>({request_key:`task-${i}`,result:{task_id:crypto.randomUUID(),execution_status:'failed',worker_stop:'confirmed',delivery:{status:'committed',head_commit:'a'.repeat(40)},summary:'😀'.repeat(4096),error:{code:'FAILURE',message:'😀'.repeat(4096)}}}));
  const payload=batchToolPayload(entries,true),body=JSON.parse(payload.content[0].text);
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<=24576);assert.equal(body.results.length,8);
  assert.deepEqual(body.results.map(e=>e.result.task_id),entries.map(e=>e.result.task_id));
  assert.ok(body.results.every(e=>e.result.error.code==='FAILURE'));
});


test('paged evidence preserves UTF-8 byte boundaries and supports exact base64 ranges',async()=>{
  const { textChunk }=await import('../../.passeur-core/src/core/result.js');const data=Buffer.from('A😀B');
  const first=textChunk(data,3,'utf8');assert.deepEqual(first,{content:'A',bytes:1});
  const second=textChunk(data.subarray(first.bytes),5,'utf8');assert.equal(first.content+second.content,'A😀B');
  assert.equal(Buffer.from(textChunk(data,3,'base64').content,'base64').equals(data.subarray(0,3)),true);
  assert.throws(()=>textChunk(data.subarray(1),1,'utf8'),{code:'INVALID_TEXT_RANGE'});
});
