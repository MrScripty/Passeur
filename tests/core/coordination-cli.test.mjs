import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, mkdir, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCoordinationRequestFile, authorizeCoordinationCliRequest, runCoordinationCli, COORDINATION_REQUEST_FILE_BYTES } from '../../.passeur-core/src/cli/coordination.js';
import { initialization, publicRequests } from '../fixtures/structural/public-requests.mjs';
import { authenticatedFixture, request, command, readRequest, key } from '../fixtures/structural/authenticated-peer.mjs';
const exec=promisify(execFile);
async function fileFixture(t,contents=JSON.stringify(request('identity'))) {
 const root=await mkdtemp(join(tmpdir(),'passeur-cli-request-')), path=join(root,'request with spaces.json');
 const log=async kind=>{if(process.env.PASSEUR_TEST_RESOURCE_LOG)await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,JSON.stringify({kind,root,test:t.name})+'\n')};
 await log('created');t.after(async()=>{await rm(root,{recursive:true});await assert.rejects(stat(root),{code:'ENOENT'});await log('removed')});
 await writeFile(path,contents,{mode:0o600});return {root,path};
}
test('request file captures one UTF-8 JSON document with whitespace',async t=>{
 const req=structuredClone(publicRequests.find(([_,r])=>r.command?.kind==='register_external_work')[1]);req.command.intent='Declared intent — 日本語';
 const f=await fileFixture(t,' \n'+JSON.stringify(req,null,2)+'\n');assert.deepEqual(await readCoordinationRequestFile(f.path),req);
});
for(const [name,contents] of [['empty',''],['invalid JSON','{'],['UTF-8',Buffer.from([0xff])],['BOM',Buffer.from([0xef,0xbb,0xbf,...Buffer.from('{}')])]]) test(`request file rejects ${name}`,async t=>{
 const f=await fileFixture(t,contents);await assert.rejects(readCoordinationRequestFile(f.path),{code:'COORDINATION_REQUEST_FILE_INVALID'});
});
test('request reader enforces encoded size before allocation and semantic size after JSON decoding',async t=>{
 const f=await fileFixture(t,' '.repeat(COORDINATION_REQUEST_FILE_BYTES+1));await assert.rejects(readCoordinationRequestFile(f.path),{code:'COORDINATION_REQUEST_FILE_LIMIT'});
 const req=structuredClone(publicRequests.find(([_,r])=>r.command?.kind==='register_external_work')[1]);req.command.intent='x'.repeat(4097);
 await writeFile(f.path,JSON.stringify(req));await assert.rejects(readCoordinationRequestFile(f.path));
});
test('symlinks and directories are rejected without reading another file',async t=>{
 const f=await fileFixture(t);const alias=join(f.root,'alias');await symlink(f.path,alias);
 await assert.rejects(readCoordinationRequestFile(alias),{code:'COORDINATION_REQUEST_FILE_UNSAFE'});
 await assert.rejects(readCoordinationRequestFile(f.root),{code:'COORDINATION_REQUEST_FILE_UNSAFE'});
 assert.deepEqual(await readCoordinationRequestFile(f.path),request('identity'));
});
test('FIFO rejection is nonblocking and preserves the object',async t=>{
 const f=await fileFixture(t);const fifo=join(f.root,'pipe');await exec('mkfifo',[fifo]);
 await assert.rejects(readCoordinationRequestFile(fifo),{code:'COORDINATION_REQUEST_FILE_UNSAFE'});assert.equal((await stat(fifo)).isFIFO(),true);
});
test('missing file has the filesystem-owned diagnostic',async t=>{
 const f=await fileFixture(t);await assert.rejects(readCoordinationRequestFile(join(f.root,'missing')),{code:'PATH_NOT_FOUND'});
});
test('commands and initialization require explicit confirmation before connect; reads do not',async t=>{
 const f=await fileFixture(t);let connections=0;
 const connect=async()=>{connections++;throw Error('read reached connection')};
 for(const req of [initialization,...publicRequests.filter(([_,r])=>r.kind==='command').map(([_,r])=>r)]){
  await writeFile(f.path,JSON.stringify(req));await assert.rejects(runCoordinationCli(f.path,false,connect),{code:'MUTATION_AUTHORITY_REQUIRED'});
 }
 assert.equal(connections,0);await writeFile(f.path,JSON.stringify(request('status')));
 await assert.rejects(runCoordinationCli(f.path,false,connect),/read reached connection/);assert.equal(connections,1);
});
test('malformed or self-authorizing requests cannot cause connection even with --yes',async t=>{
 const f=await fileFixture(t);let connections=0;const connect=async()=>{connections++;throw Error('unexpected')};
 for(const req of [{schema_version:1,kind:'identity',actor:'operator'},{schema_version:99,kind:'identity'},{...initialization,approved:true}]){
  await writeFile(f.path,JSON.stringify(req));await assert.rejects(runCoordinationCli(f.path,true,connect));
 }assert.equal(connections,0);
});
test('pre-cancelled CLI request does not open or connect',async()=>{
 const stop=new AbortController(),reason=Error('operator stopped');stop.abort(reason);let calls=0;
 await assert.rejects(runCoordinationCli('/not/opened',true,async()=>{calls++;throw Error('unexpected')},stop.signal),e=>e===reason);assert.equal(calls,0);
});
test('CLI request is stable if its file changes while connection is established',async t=>{
 const f=await authenticatedFixture(t),c=await f.client(),path=join(f.temp,'operator request.json');const req=request('identity');await writeFile(path,JSON.stringify(req));
 const reply=await runCoordinationCli(path,false,async()=>{await writeFile(path,JSON.stringify(initialization));return c});
 assert.equal(reply.kind,'identity');assert.equal(reply.parent_id,f.owner(f.operatorToken));assert.equal((await c.coordinate(request('status'))).state,'not_enabled');
});
test('operator CLI handler initializes through real authenticated runtime and does not load providers',async t=>{
 const f=await authenticatedFixture(t),c=await f.client(),path=join(f.temp,'init.json');await writeFile(path,JSON.stringify(request('initialize',{limits:f.limits})));
 const reply=await runCoordinationCli(path,true,async()=>c);assert.equal(reply.state,'ready');assert.equal(f.counts.profile,0);
 const first=await readFile(join(f.binding.storeRoot,'coordination/control.json'));
 assert.deepEqual(await runCoordinationCli(path,true,async()=>c),reply);assert.deepEqual(await readFile(join(f.binding.storeRoot,'coordination/control.json')),first);
});
test('operator confirmation cannot give a different authenticated parent initialization authority',async t=>{
 const f=await authenticatedFixture(t),c=await f.client('e'.repeat(64)),path=join(f.temp,'init.json');await writeFile(path,JSON.stringify(request('initialize',{limits:f.limits})));
 await assert.rejects(runCoordinationCli(path,true,async()=>c),{code:'COORDINATION_INITIALIZATION_FORBIDDEN'});
});
test('CLI registration reuses exact receipt on retry, not another registration',async t=>{
 const f=await authenticatedFixture(t),c=await f.client();await f.initialize(c);const path=join(f.temp,'command.json');await writeFile(path,JSON.stringify(f.register()));
 const a=await runCoordinationCli(path,true,async()=>c),b=await runCoordinationCli(path,true,async()=>c);assert.deepEqual(a,b);assert.equal((await f.disk()).works.length,1);
});
