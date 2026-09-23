import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { serviceFixture, request, command, key } from '../fixtures/structural/service-fixture.mjs';
import { resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { preparePaths, readDescriptor } from '../../.passeur-core/src/service/bootstrap.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { withAbort } from '../../.passeur-core/src/core/async.js';
import { ServiceClient } from '../../.passeur-core/src/service/client.js';

// Requires the real pinned application dependencies: no substitute schemas, lease or TaskStore.
test('elected service routes two authenticated metadata clients through the actual runtime and store', async t => {
  const f=await serviceFixture(t); await f.service.close();
  const intent={project:f.root,stateRoot:f.state,profilePath:join(f.temp,'no-execution-profile.json')};
  const binding=await resolveRepositoryBinding(intent,{},new AbortController().signal), paths=await preparePaths(binding);
  const token=await operatorToken(binding,true), config=join(f.temp,'binding.json'); await writeFile(config,JSON.stringify(intent));
  const cli=fileURLToPath(new URL('../fixtures/structural/elected-coordination-peer.mjs',import.meta.url));
  const peers=[], children=[];
  const launch=async()=>{
    const child=spawn('flock',['--nonblock','--no-fork',paths.guard,process.execPath,cli,config],{stdio:['pipe','ignore','pipe']});
    children.push(child); const exit=once(child,'exit'); exit.catch(()=>{});
    let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192)});
    const budget=AbortSignal.timeout(10000);let descriptor;
    while(!(descriptor=await readDescriptor(binding))){
      assert.equal(child.exitCode,null,`service failed: ${stderr}`);
      await delay(10,undefined,{signal:budget});
    }
    return {child,exit,descriptor,stderr:()=>stderr};
  };
  f.sessions.push({async close(){
    for(const peer of peers)peer.close();
    await Promise.all(peers.map(peer=>peer.connection.closed));
    for(const child of children){
      child.stdin.end();
      if(child.exitCode===null&&child.signalCode===null) await once(child,'exit',{signal:AbortSignal.timeout(10000)});
    }
  }});
  const service=await launch(), operator=new ServiceClient(service.descriptor,binding,token);peers.push(operator);await operator.ready;
  const otherToken=randomBytes(32).toString('hex'), otherRoot=await f.linked('elected-other');
  const other=new ServiceClient(service.descriptor,{...binding,project:otherRoot},otherToken);peers.push(other);await other.ready;
  assert.equal((await operator.call('status',{})).clients,2);
  await assert.rejects(other.coordinate(request('initialize',{limits:f.limits})),{code:'COORDINATION_INITIALIZATION_FORBIDDEN'});
  const enabled=await operator.coordinate(request('initialize',{limits:f.limits}));assert.equal(enabled.state,'ready');
  const a=await operator.coordinate(f.registerRequest()), b=await other.coordinate(f.registerRequest());
  assert.notEqual(a.receipt.item_id,b.receipt.item_id);
  const outcomes=await Promise.allSettled([operator,other].map(c=>c.coordinate(command({kind:'claim_target',operation_key:key(),target:'refs/heads/main',members:[]}))));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const disk=JSON.parse(await readFile(join(binding.storeRoot,'coordination/control.json'),'utf8'));
  assert.equal(disk.works.length,2);assert.equal(disk.cases.length,1);
  assert.equal((await operator.call('status',{})).repository.execution.profile,'not_checked');
  for(const c of peers)c.close();await Promise.all(peers.map(c=>c.connection.closed));service.child.stdin.end();
  const [code]=await withAbort(service.exit,AbortSignal.timeout(10000));assert.equal(code,0,service.stderr());
  assert.equal(await readDescriptor(binding),undefined);
  const reopened=await launch(), again=new ServiceClient(reopened.descriptor,binding,token);peers.push(again);await again.ready;
  assert.equal((await again.coordinate(request('status'))).epoch,enabled.epoch);
  assert.equal((await again.coordinate(f.registerRequest({operation_key:a.receipt.key}))).receipt.item_id,a.receipt.item_id);
});
