import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authenticatedFixture, request, key } from '../fixtures/structural/authenticated-peer.mjs';
import { managedFixture } from '../fixtures/structural/managed-fixture.mjs';
import { invokeCoordinationTool } from '../../.passeur-core/src/mcp/coordination-operations.js';

test('public managed-work handler traverses authenticated sockets to the runtime and real metadata store',async t=>{
  const f=await authenticatedFixture(t,{runtimeFixture:managedFixture}),owner=await f.client();await f.initialize(owner);
  const identity=await owner.coordinate(request('identity'));
  const task=await f.addTask({owner:identity.parent_id});
  const envelope={request:f.enrollRequest(task.id)};
  const result=await invokeCoordinationTool('passeur_work',envelope,owner);
  assert.equal(result.receipt.item_id,task.id);
  const work=await f.get(owner,'work',task.id);assert.equal(work.owner,identity.parent_id);assert.equal(work.managed.task_id,task.id);
  assert.deepEqual(await invokeCoordinationTool('passeur_work',envelope,owner),result);
  assert.equal(f.counts.profile,0);
});
test('authenticated peer cannot enroll another task by guessing its identifier or adding identity fields',async t=>{
  const f=await authenticatedFixture(t,{runtimeFixture:managedFixture}),owner=await f.client(),other=await f.client(randomBytes(32).toString('hex'));
  await f.initialize(owner);const id=await owner.coordinate(request('identity')),task=await f.addTask({owner:id.parent_id});
  await assert.rejects(other.coordinate(f.enrollRequest(task.id)),{code:'TASK_CONTROL_CONFLICT'});
  const forged=f.enrollRequest(task.id);forged.command.owner_id=id.parent_id;
  const before=f.countsWire().received;await assert.rejects(other.coordinate(forged),{code:'COORDINATION_INVALID'});assert.equal(f.countsWire().received,before);
  assert.equal((await f.disk()).schema_version,1);
});
test('lost authenticated enrollment response is recovered by key after reconnect without reenrolling',async t=>{
  const f=await authenticatedFixture(t,{runtimeFixture:managedFixture}),owner=await f.client();await f.initialize(owner);
  const identity=await owner.coordinate(request('identity')),task=await f.addTask({owner:identity.parent_id}),op=key();
  f.setDropReply(req=>req.command?.kind==='register_managed_work');
  await assert.rejects(owner.coordinate(f.enrollRequest(task.id,op)),{code:'SERVICE_DISCONNECTED'});
  f.setDropReply(undefined);const again=await f.client();
  const receipt=await again.coordinate(f.enrollRequest(task.id,op));assert.equal(receipt.receipt.item_id,task.id);assert.equal((await f.disk()).receipts.length,1);
});
