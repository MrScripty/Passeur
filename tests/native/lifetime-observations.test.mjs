import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue } from '../../.passeur-native/src/approvals/native.js';
import { git } from '../../.passeur-native/src/workspace/project.js';
const hold=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
test('a cancelled presentation releases only its connection queue, not a pending native decision',async()=>{
  const queue=new ApprovalQueue(),first=hold(),entered=hold(),c=new AbortController();
  const a=queue.run(c.signal,async()=>{entered.resolve();return first.promise;});a.catch(()=>undefined);await entered.promise;
  c.abort(Error('presentation only'));await assert.rejects(a,/presentation only/);
  assert.equal(await queue.run(new AbortController().signal,async()=>"another presentation"),"another presentation");
  first.resolve('late answer');await tick();
});
test('an unanswered presentation remains pending beyond the former expiry',async t=>{
  const queue=new ApprovalQueue(),reply=hold(),entered=hold();let finished=false;
  t.mock.timers.enable({apis:['setTimeout']});
  const a=queue.run(new AbortController().signal,async()=>{entered.resolve();return reply.promise;}).then(v=>{finished=true;return v;});
  await entered.promise;t.mock.timers.tick(3_600_000);await tick();assert.equal(finished,false);
  reply.resolve('explicit answer');assert.equal(await a,'explicit answer');t.mock.timers.reset();
});
test('task-owned Git hook has no implicit ninety-second execution timer',{timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'passeur-long-hook-'));
  try{
    await git(root,['init','-q','-b','main']);await git(root,['config','user.name','Synthetic Test']);await git(root,['config','user.email','synthetic@example.invalid']);await git(root,['config','commit.gpgsign','false']);
    await writeFile(join(root,'seed'),'fixture');await git(root,['add','seed']);
    const hook=join(root,'.git/hooks/pre-commit');await writeFile(hook,'#!/bin/sh\nprintf ready > hook-ready\nwhile [ ! -e hook-release ]; do sleep 0.01; done\n');await chmod(hook,0o700);
    t.mock.timers.enable({apis:['setTimeout']});let finished=false;
    const commit=git(root,['commit','-qm','test: explicit hook completion']).then(v=>{finished=true;return v;});
    try{
      while(true){try{await readFile(join(root,'hook-ready'));break;}catch(e){if(e.code!=='ENOENT')throw e;await tick();}}
      t.mock.timers.tick(600_000);await tick();assert.equal(finished,false);
    }finally{await writeFile(join(root,'hook-release'),'continue');await commit;t.mock.timers.reset();}
    assert.ok((await git(root,['rev-parse','HEAD'])).trim());
  }finally{await rm(root,{recursive:true,force:true});}
});
