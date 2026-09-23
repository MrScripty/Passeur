// Actual compiled CLI/elected-service evidence; requires the complete pinned application build.
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceFixture, request } from '../fixtures/structural/service-fixture.mjs';
import { resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { launchService, readDescriptor } from '../../.passeur-core/src/service/bootstrap.js';
import { withAbort } from '../../.passeur-core/src/core/async.js';
const execute=promisify(execFile), cli=fileURLToPath(new URL('../../dist/src/cli.js',import.meta.url));
async function context(name){
 const t={name,after:onTestFinished};
 const f=await serviceFixture(t);await f.service.close();
 const stateRoot=join(f.temp,'cli-owned-state'), profilePath=join(f.temp,'unavailable-profile.json');
 const intent={project:f.root,stateRoot,profilePath}, binding=await resolveRepositoryBinding(intent,{},new AbortController().signal);
 const file=join(f.temp,'cli request.json');
 const args=['coordinate','--project',f.root,'--profile',profilePath,'--state-root',stateRoot,'--request',file];
 const run=extra=>execute(process.execPath,[cli,...args,...extra],{timeout:15000,maxBuffer:262144});
 return {...f,intent,binding,file,run};
}
test('actual CLI rejects absent consent and malformed payload before creating its state namespace',async()=>{
 const f=await context('CLI refusal before connection');await writeFile(f.file,JSON.stringify(request('initialize',{limits:f.limits})));
 await assert.rejects(f.run([]),e=>{assert.match(e.stderr,/MUTATION_AUTHORITY_REQUIRED/);return true});
 await assert.rejects(stat(f.binding.stateRoot),{code:'ENOENT'});
 await writeFile(f.file,JSON.stringify({...request('identity'),actor:'operator'}));
 await assert.rejects(f.run(['--yes']),e=>{assert.match(e.stderr,/COORDINATION_SERVICE_INVALID/);return true});
 await assert.rejects(stat(f.binding.stateRoot),{code:'ENOENT'});
},30000);
test('actual CLI initializes and reads using one persistent operator identity through the elected service',async()=>{
 const f=await context('CLI elected workflow'), launch=await launchService(f.binding,cli);
 const exit=once(launch.child,'exit');exit.catch(()=>{});
 f.sessions.push({async close(){launch.released();const [code]=await withAbort(exit,AbortSignal.timeout(15000));assert.equal(code,0);assert.equal(await readDescriptor(f.binding),undefined)}});
 await writeFile(f.file,JSON.stringify(request('initialize',{limits:f.limits})));
 const enabled=JSON.parse((await f.run(['--yes'])).stdout);assert.equal(enabled.state,'ready');
 await writeFile(f.file,JSON.stringify(request('identity')));
 const one=JSON.parse((await f.run([])).stdout),two=JSON.parse((await f.run([])).stdout);assert.equal(one.parent_id,two.parent_id);assert.equal(one.repository_id,f.binding.repositoryId);
 await writeFile(f.file,JSON.stringify(request('status')));assert.equal(JSON.parse((await f.run([])).stdout).epoch,enabled.epoch);
},30000);
