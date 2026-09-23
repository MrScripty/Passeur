import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertRequestCapacity, serviceRequestLane, CONNECTION_ORDINARY_REQUESTS, CONNECTION_CONTROL_REQUESTS } from '../../.passeur-core/src/service/request-capacity.js';
import { routeCoordination } from '../../.passeur-core/src/service/coordination-route.js';
const req = (kind, fields={}) => ({schema_version:1,kind,...fields});

test('ordinary and control capacities have independent finite ceilings', () => {
  const ordinary=Array.from({length:CONNECTION_ORDINARY_REQUESTS},()=>({lane:'ordinary'}));
  assert.throws(()=>assertRequestCapacity(ordinary,'ordinary'),{code:'SERVICE_REQUEST_LIMIT'});
  assert.doesNotThrow(()=>assertRequestCapacity(ordinary,'control'));
  const both=[...ordinary,...Array.from({length:CONNECTION_CONTROL_REQUESTS},()=>({lane:'control'}))];
  assert.throws(()=>assertRequestCapacity(both,'control'),{code:'SERVICE_REQUEST_LIMIT'});
  assert.doesNotThrow(()=>assertRequestCapacity(both.slice(1),'ordinary'));
});
test('metadata receipt and release commands select protected capacity using the canonical decoder', () => {
  const receipt=req('read',{selector:{kind:'receipt',operation_key:'saved'},offset:0,limit:256,expected_hash:null});
  assert.equal(serviceRequestLane('coordination',receipt),'control');
  const close=req('command',{command:{kind:'close_work',operation_key:'close',work_id:randomUUID(),expected_revision:1}});
  assert.equal(serviceRequestLane('coordination',close),'control');
  assert.equal(serviceRequestLane('coordination',req('identity')),'ordinary');
  assert.throws(()=>serviceRequestLane('coordination',{...receipt,actor:'operator'}),{code:'COORDINATION_SERVICE_INVALID'});
});
test('native control requests retain protected capacity independently of metadata requests', () => {
  for(const op of ['cancel','input_claim','input_answer','input_dismiss','attach','stop']) assert.equal(serviceRequestLane(op,{}),'control');
  for(const op of ['status','submit','submit_batch','wait','agents','tasks']) assert.equal(serviceRequestLane(op,{}),'ordinary');
});
test('metadata route rejects malformed requests before invoking runtime authority', async () => {
  let called=false; const runtime={async coordinate(){called=true;throw Error('unexpected')}};
  const peer={actor:{owner_id:'a'.repeat(64),client_id:randomUUID()},source_view:'/source'};
  await assert.rejects(routeCoordination(runtime,peer,'b'.repeat(24),{...req('identity'),owner_id:'c'.repeat(64)}),{code:'COORDINATION_SERVICE_INVALID'});
  assert.equal(called,false);
});
test('metadata route rejects destination corruption even when a runtime returns successfully', async () => {
  const peer={actor:{owner_id:'a'.repeat(64),client_id:randomUUID()},source_view:'/source'};
  const runtime={async coordinate(){return req('identity',{repository_id:'b'.repeat(24),parent_id:'c'.repeat(64)})}};
  await assert.rejects(routeCoordination(runtime,peer,'b'.repeat(24),req('identity')),{code:'COORDINATION_SERVICE_INVALID'});
});
