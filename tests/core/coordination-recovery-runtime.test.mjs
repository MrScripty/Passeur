import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { authenticatedFixture, request, key } from '../fixtures/structural/authenticated-peer.mjs';
import { runtimeFixture } from '../fixtures/structural/runtime-fixture.mjs';
import { runCoordinationCli, authorizeCoordinationCliRequest } from '../../.passeur-core/src/cli/coordination.js';
import { decodeCoordinationRequest, decodeCoordinationReply } from '../../.passeur-core/src/contracts/coordination-service.js';
import { decodeCoordinationToolArguments, COORDINATION_TOOL_NAMES } from '../../.passeur-core/src/mcp/coordination-operations.js';
import { CoordinationService } from '../../.passeur-core/src/service/coordination.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

const inspect=(selector,fields={})=>request('recovery_read',{selector,offset:0,limit:8192,expected_hash:null,...fields});
const recover=recovery=>request('recover_metadata',{recovery});
const change=(epoch,w,extra={})=>({kind:'adopt_work',operation_key:key(),epoch,work_id:w.id,expected_owner:w.owner,
 expected_revision:w.revision,new_owner:'c'.repeat(64),statement:'Operator selected the replacement parent identity.',...extra});
async function view(c,selector,limit=8192){
 let offset=0,expected_hash=null,text='';
 while(true){const p=await c.coordinate(inspect(selector,{offset,expected_hash,limit}));text+=p.content;offset=p.next_offset;expected_hash=p.hash;if(p.eof)return JSON.parse(text);}
}
async function registered(f,client){const saved=await client.coordinate(f.registerRequest());return {saved,w:await f.get(client,'work',saved.receipt.item_id)};}

test('authenticated ordinary parents cannot inspect, recover, or supply their own operator authority',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),other=await f.client(randomBytes(32).toString('hex'));const initialized=await f.initialize(op);
 const {w}=await registered(f,other),before=await f.disk();
 for(const req of [inspect({kind:'inventory'}),recover(change(initialized.epoch,w))]) await assert.rejects(other.coordinate(req),{code:'COORDINATION_RECOVERY_FORBIDDEN'});
 await assert.rejects(op.coordinate({...recover(change(initialized.epoch,w)),approved:true}),{code:'COORDINATION_SERVICE_INVALID'});
 assert.deepEqual(await f.disk(),before);assert.equal(f.counts.profile,0);
});
test('operator can inspect all active metadata without changing v1 or exposing note bodies in inventory',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),other=await f.client(randomBytes(32).toString('hex'));await f.initialize(op);
 const {w}=await registered(f,other);const before=await f.disk();const v=await view(op,{kind:'inventory'},71);
 assert.equal(v.works[0].id,w.id);assert.equal(v.works[0].owner,w.owner);assert.equal('notes' in v,false);
 assert.deepEqual(await f.disk(),before);assert.equal(v.epoch,before.epoch);
});
test('authenticated operator adoption preserves Git state and original parent receipt while blocking old control',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),oldToken=randomBytes(32).toString('hex'),newToken=randomBytes(32).toString('hex');
 const old=await f.client(oldToken),fresh=await f.client(newToken);const enabled=await f.initialize(op),{saved,w}=await registered(f,old);
 const head=await f.commit(f.root,'other.ts','export const other = 1;\n');
 const cmd=change(enabled.epoch,w,{new_owner:f.owner(newToken)});await op.coordinate(recover(cmd));
 assert.equal((await f.get(fresh,'work',w.id)).owner,f.owner(newToken));
 await assert.rejects(old.coordinate(request('command',{command:{kind:'share_work',operation_key:key(),work_id:w.id,expected_revision:2,readers:[]}})),{code:'COORDINATION_NOT_FOUND'});
 assert.equal((await f.get(old,'receipt',saved.receipt.key)).item_id,w.id);
 assert.equal((await f.get(fresh,'work',w.id)).input_oid,f.base);
 const observed=(await import('../../.passeur-core/src/workspace/project.js')).git;
 assert.equal((await observed(f.root,['rev-parse','HEAD'])).trim(),head);assert.equal(f.counts.profile,0);
});
test('lost recovery acknowledgment reconnects by the same key without a second ownership change',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),old=await f.client(randomBytes(32).toString('hex'));const en=await f.initialize(op),{w}=await registered(f,old);
 const req=recover(change(en.epoch,w));f.setDropReply(q=>q.kind==='recover_metadata');
 await assert.rejects(op.coordinate(req),{code:'SERVICE_DISCONNECTED'});f.setDropReply(undefined);
 const again=await f.client(),saved=await view(again,{kind:'receipt',operation_key:req.recovery.operation_key});assert.ok(saved);
 assert.deepEqual((await again.coordinate(req)).receipt,saved);assert.equal((await f.disk()).recoveries.length,1);
});
test('recovery read authorization is rechecked on every continuation after operator-token rotation',async t=>{
 const f=await authenticatedFixture(t),op=await f.client();await f.initialize(op);await registered(f,op);
 const first=await op.coordinate(inspect({kind:'inventory'},{limit:32}));assert.equal(first.eof,false);
 await writeFile(join(f.binding.storeRoot,'operator-control.token'),randomBytes(32).toString('hex'));
 await assert.rejects(op.coordinate(inspect({kind:'inventory'},{offset:first.next_offset,expected_hash:first.hash,limit:32})),{code:'COORDINATION_RECOVERY_FORBIDDEN'});
});
test('changed inventory refuses mixed-version administrative pages',async t=>{
 const f=await authenticatedFixture(t),op=await f.client();const en=await f.initialize(op),{w}=await registered(f,op);
 const page=await op.coordinate(inspect({kind:'inventory'},{limit:64}));
 await op.coordinate(recover(change(en.epoch,w)));
 await assert.rejects(op.coordinate(inspect({kind:'inventory'},{offset:page.next_offset,expected_hash:page.hash,limit:64})),{code:'COORDINATION_VIEW_CHANGED'});
});
test('source disappearance does not prevent metadata-only recovery',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),old=await f.client(randomBytes(32).toString('hex'));const en=await f.initialize(op),{w}=await registered(f,old);
 await rm(f.root,{recursive:true});
 const c=change(en.epoch,w,{kind:'close_work'});delete c.new_owner;
 await op.coordinate(recover(c));
 assert.equal((await f.disk()).works[0].state,'closed');
});
test('recovery observer cancellation leaves the admitted runtime operation owned until it settles',async t=>{
 const f=await runtimeFixture(t);await f.initialize();const saved=await f.call(f.register());const w=await f.get('work',saved.receipt.item_id);const gate=f.gate();
 // Gate the real control store's initialization check through owned namespace I/O is not exposed;
 // use runtime preparation after restart to observe cancellation at its public admission boundary.
 await f.restart();f.setBeforeRecover(()=>gate.promise);const finished=f.gate();f.runtime.onSettled=()=>finished.release();
 const stop=new AbortController(),req=recover(change((await f.disk()).epoch,w));const pending=f.call(req,undefined,f.root,stop.signal);
 stop.abort(new Error('observer left'));await assert.rejects(pending,/observer left/);
 gate.release();await finished.promise;
 assert.equal((await f.disk()).works[0].owner,req.recovery.new_owner);
});
test('CLI rejects missing confirmation and settlement misuse before connection effects',async t=>{
 const f=await authenticatedFixture(t),file=join(f.temp,'recovery request.json');let connections=0;
 const c={kind:'settle_case',operation_key:key(),epoch:key(),case_id:key(),expected_owner:'a'.repeat(64),expected_revision:1,expected_generation:1,statement:'Operator inspected external execution; evidence in local log.'};
 await writeFile(file,JSON.stringify(recover(c)));const connect=async()=>{connections++;throw Error('must not connect');};
 await assert.rejects(runCoordinationCli(file,false,connect),{code:'MUTATION_AUTHORITY_REQUIRED'});
 await assert.rejects(runCoordinationCli(file,true,connect),{code:'COORDINATION_SETTLEMENT_CONFIRMATION_REQUIRED'});
 await writeFile(file,JSON.stringify(request('identity')));
 await assert.rejects(runCoordinationCli(file,true,connect,undefined,true),{code:'ARGUMENT_INAPPLICABLE'});assert.equal(connections,0);
 assert.deepEqual(authorizeCoordinationCliRequest(recover(c),true,true),recover(c));
});
test('CLI file-to-authenticated-runtime recovery uses one exact admitted request',async t=>{
 const f=await authenticatedFixture(t),op=await f.client(),old=await f.client(randomBytes(32).toString('hex'));const en=await f.initialize(op),{w}=await registered(f,old);
 const file=join(f.temp,'operator recovery.json'),req=recover(change(en.epoch,w));await writeFile(file,JSON.stringify(req));
 const reply=await runCoordinationCli(file,true,async()=>op);assert.equal(reply.kind,'recovery_receipt');assert.deepEqual(reply.receipt.command,req.recovery);
 assert.equal((await f.disk()).schema_version,2);
});
test('MCP groups refuse all operator-recovery requests without calling a frontend',()=>{
 const c=change(key(),{id:key(),owner:'a'.repeat(64),revision:1});
 for(const tool of COORDINATION_TOOL_NAMES)for(const req of [inspect({kind:'inventory'}),recover(c)])
  assert.throws(()=>decodeCoordinationToolArguments(tool,{request:req}),{code:'COORDINATION_OPERATOR_REQUIRED'});
});
test('reply decoding refuses a different operator, statement, or recovery receipt kind',()=>{
 const parent='a'.repeat(64),repository='b'.repeat(24),req=recover(change(key(),{id:key(),owner:parent,revision:1}));
 const receipt={operator:parent,command:req.recovery,revision:2,request_hash:canonicalHash({operator:parent,recovery:req.recovery})};
 const reply={schema_version:1,kind:'recovery_receipt',repository_id:repository,receipt};
 assert.deepEqual(decodeCoordinationReply(req,parent,repository,reply),reply);
 for(const changed of [{...reply,kind:'receipt'},{...reply,receipt:{...receipt,operator:'c'.repeat(64)}},{...reply,receipt:{...receipt,command:{...receipt.command,statement:'other'}}}]) assert.throws(()=>decodeCoordinationReply(req,parent,repository,changed));
 assert.throws(()=>decodeCoordinationRequest({...req,actor:parent}));
});


test('absent recovery capability is unavailable and a malformed callback cannot construct the service', async () => {
  const binding = { store_root: '/unused-recovery-capability', repository_id: 'a'.repeat(24) };
  const authority = { assertOwned() {}, async authorizeInitialization() {}, externalWorkspaces: { async assertExternalRegistration() {} } };
  const limits = { ordinary_requests: 1, control_requests: 1, max_source_operations: 1, max_worktrees: 8 };
  assert.throws(() => new CoordinationService(binding, { ...authority, authorizeRecovery: true }, limits), { code: 'COORDINATION_SERVICE_AUTHORITY_UNAVAILABLE' });
  const service = new CoordinationService(binding, authority, limits);
  try {
    await assert.rejects(service.handle({ owner_id: 'a'.repeat(64), source_view: '/unused' }, inspect({ kind: 'inventory' })), { code: 'COORDINATION_OPERATOR_AUTHORITY_UNAVAILABLE' });
    assert.equal(service.pendingCount, 0);
  } finally { await service.close(); }
});
