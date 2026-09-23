import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { authenticatedFixture, request, command, readRequest, key, hold, git, BridgeError, authenticateServicePeer } from '../fixtures/structural/authenticated-peer.mjs';

const readReceipt = key => readRequest({ kind: 'receipt', operation_key: key });

test('authenticated client identity is derived from its private token and does not initialize metadata', async t => {
  const f = await authenticatedFixture(t), c = await f.client();
  const identity = await c.coordinate(request('identity'));
  assert.equal(identity.parent_id, f.owner(f.operatorToken)); assert.equal(identity.repository_id, f.binding.repositoryId);
  assert.equal((await c.coordinate(request('status'))).state, 'not_enabled');
  assert.equal(f.counts.acquire, 0); assert.equal(f.counts.profile, 0);
  await assert.rejects(access(join(f.binding.storeRoot, 'coordination')), { code: 'ENOENT' });
});
test('wrong service credential never reaches runtime metadata admission', async t => {
  const f = await authenticatedFixture(t);
  await assert.rejects(f.client(undefined, undefined, { token: '0'.repeat(64) }), { code: 'SERVICE_DISCONNECTED' });
  assert.equal(f.countsWire().received, 0); assert.equal(f.counts.acquire, 0);
  assert.ok(f.failures.includes('SERVICE_BINDING_CONFLICT'));
});
test('real operator identity initializes while a separate authenticated parent is denied', async t => {
  const f = await authenticatedFixture(t), other = await f.client(randomBytes(32).toString('hex'));
  await assert.rejects(f.initialize(other), { code: 'COORDINATION_INITIALIZATION_FORBIDDEN' });
  const operator = await f.client(); assert.equal((await f.initialize(operator)).state, 'ready');
  assert.equal(f.counts.profile, 0);
});
test('message actor or approval fields are rejected locally before any wire request', async t => {
  const f = await authenticatedFixture(t), c = await f.client(); const before = f.countsWire().received;
  await assert.rejects(c.coordinate({ ...request('identity'), parent_id: 'a'.repeat(64) }), { code: 'COORDINATION_SERVICE_INVALID' });
  await assert.rejects(c.coordinate({ ...request('initialize', { limits: f.limits }), approved: true }), { code: 'COORDINATION_SERVICE_INVALID' });
  assert.equal(f.countsWire().received, before);
});
test('different real worktrees enroll under distinct authenticated parents with explicit sharing', async t => {
  const f = await authenticatedFixture(t), a = await f.client(), linked = await f.linked('other'), b = await f.client(randomBytes(32).toString('hex'), linked);
  await f.initialize(a);
  const identity = await b.coordinate(request('identity'));
  const ar = await a.coordinate(f.register({ readers: [identity.parent_id] })), br = await b.coordinate(f.register());
  assert.notEqual(ar.receipt.item_id, br.receipt.item_id);
  const aw = await f.get(b, 'work', ar.receipt.item_id); assert.equal(aw.owner, f.owner(f.operatorToken));
  await assert.rejects(f.get(a, 'work', br.receipt.item_id), { code: 'COORDINATION_NOT_FOUND' });
});
test('real runtime managed-resource guard rejects an authenticated external enrollment', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const worker = await f.linked('managed'); f.managed(worker, 'refs/heads/managed');
  const b = await f.client(randomBytes(32).toString('hex'), worker);
  await assert.rejects(b.coordinate(f.register()), { code: 'COORDINATION_WORKSPACE_MANAGED' });
  assert.equal((await f.disk()).works.length, 0);
});
test('authenticated competing target requests have only one accepted owner', async t => {
  const f = await authenticatedFixture(t), a = await f.client(), b = await f.client(randomBytes(32).toString('hex'));
  await f.initialize(a);
  const results = await Promise.allSettled([a,b].map(c => c.coordinate(command({ kind: 'claim_target', operation_key: key(), target: 'refs/heads/main', members: [] }))));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await f.disk()).cases.filter(c => c.state === 'active').length, 1);
});
test('lost acknowledgment reconnects by the same token and operation key without duplicate work', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const req = f.register(); f.setDropReply(r => r.kind === 'command' && r.command.operation_key === req.command.operation_key);
  await assert.rejects(a.coordinate(req), { code: 'SERVICE_DISCONNECTED' });
  f.setDropReply(undefined); const again = await f.client();
  const saved = await f.get(again, 'receipt', req.command.operation_key); assert.ok(saved);
  const retry = await again.coordinate(req); assert.equal(retry.receipt.item_id, saved.item_id);
  assert.equal((await f.disk()).works.length, 1);
});
test('observer cancellation after runtime admission does not cancel publication or lose correlation', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const gate = f.gate(), entered = hold(), settled = hold(), req = f.register();
  f.setBeforeList(async () => { entered.release(); await gate.promise; });
  f.runtime.onSettled = () => settled.release();
  const stop = new AbortController(), work = a.coordinate(req, stop.signal); work.catch(() => {});
  await entered.promise; stop.abort(new BridgeError('TEST_OBSERVER_LEFT', 'left')); await assert.rejects(work, { code: 'TEST_OBSERVER_LEFT' });
  assert.equal(await f.runtime.hasObligations(), true); f.setBeforeList(undefined); gate.release(); await settled.promise;
  assert.ok(await f.get(a, 'receipt', req.command.operation_key)); assert.equal(a.connection.isClosed, false);
});
test('ordinary wire saturation preserves receipt capacity and keeps the connection usable', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const saved = await a.coordinate(f.register()), gate = f.gate(), allEntered = hold(); let entering = 0;
  f.setBeforeRoute(async req => { if (req.kind === 'identity') { if (++entering === 32) allEntered.release(); await gate.promise; } });
  const jobs = Array.from({length:32}, () => a.coordinate(request('identity'))); await allEntered.promise;
  await assert.rejects(a.coordinate(request('status')), { code: 'SERVICE_REQUEST_LIMIT' });
  assert.equal((await f.get(a, 'receipt', saved.receipt.key)).item_id, saved.receipt.item_id);
  gate.release(); const outcomes = await Promise.allSettled(jobs);
  assert.ok(outcomes.some(x => x.status === 'fulfilled'));
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'COORDINATION_SERVICE_CAPACITY');
  // Runtime capacity is independent and may reject the released burst; the connection remains usable.
  assert.equal(a.connection.isClosed, false);
  assert.equal((await a.coordinate(request('identity'))).kind, 'identity');
});
test('wrong repository and parent replies are rejected rather than returned as trusted metadata', async t => {
  const f = await authenticatedFixture(t), a = await f.client();
  f.setTransform((_r, value) => ({...value, repository_id:'0'.repeat(24)}));
  await assert.rejects(a.coordinate(request('identity')), { code:'COORDINATION_SERVICE_INVALID' });
  f.setTransform((_r, value) => ({...value, parent_id:'0'.repeat(64)}));
  await assert.rejects(a.coordinate(request('identity')), { code:'COORDINATION_SERVICE_INVALID' });
  f.setTransform(undefined); assert.equal((await a.coordinate(request('identity'))).parent_id, f.owner(f.operatorToken));
});
test('receipt content mismatch is rejected at the actual client destination boundary', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  f.setTransform((r,v) => r.kind === 'command' ? {...v, receipt:{...v.receipt,request_hash:'0'.repeat(64)}} : v);
  await assert.rejects(a.coordinate(command({kind:'claim_target',operation_key:key(),target:'refs/heads/main',members:[]})), {code:'COORDINATION_SERVICE_INVALID'});
});
test('a malformed continuation reply is rejected without poisoning later reads', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a); const saved=await a.coordinate(f.register());
  f.setTransform((r,v) => r.kind === 'read' ? {...v, next_offset:v.next_offset+1} : v);
  await assert.rejects(a.coordinate(readReceipt(saved.receipt.key)), {code:'COORDINATION_SERVICE_INVALID'});
  f.setTransform(undefined); assert.ok(await f.get(a,'receipt',saved.receipt.key));
});
test('mutating a request after submission cannot change its captured source or intent', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const req = f.register({intent:'original'}), work = a.coordinate(req); req.command.intent = 'changed';
  const saved = await work; assert.equal((await f.get(a,'work',saved.receipt.item_id)).intent, 'original');
});
test('already-cancelled request produces no wire effect', async t => {
  const f = await authenticatedFixture(t), a = await f.client(), stop = new AbortController(); stop.abort(new BridgeError('TEST_CANCELLED','before'));
  await assert.rejects(a.coordinate(request('identity'),stop.signal), {code:'TEST_CANCELLED'}); assert.equal(f.countsWire().received,0);
});
test('closed connection refuses new metadata promptly', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); a.close(); await a.connection.closed;
  await assert.rejects(a.coordinate(request('identity')), {code:'SERVICE_DISCONNECTED'});
});
test('handshake rejects foreign repository, state root, and profile without creating runtime state', async t => {
  const f = await authenticatedFixture(t);
  const hello = {kind:'hello',protocol:1,token:f.descriptor.token,owner_token:f.operatorToken,repository_id:f.binding.repositoryId,
    state_root:f.binding.stateRoot,profile_path:f.binding.profilePath,source_view:f.root};
  for(const change of [{repository_id:'0'.repeat(24)},{state_root:join(f.temp,'wrong')},{profile_path:join(f.temp,'wrong.json')}]) {
    await assert.rejects(authenticateServicePeer({...hello,...change},f.binding,f.descriptor.token),{code:'SERVICE_BINDING_CONFLICT'});
  }
  const foreign=join(f.temp,'foreign');await mkdir(foreign);await git(foreign,['init','-b','main']);
  await assert.rejects(authenticateServicePeer({...hello,source_view:foreign},f.binding,f.descriptor.token),{code:'SOURCE_VIEW_CONFLICT'});
  assert.equal(f.counts.acquire,0);
});
test('malformed or actor-bearing handshake never supplies a parent identity', async t => {
  const f = await authenticatedFixture(t), hello = {kind:'hello',protocol:1,token:f.descriptor.token,owner_token:f.operatorToken,
    repository_id:f.binding.repositoryId,state_root:f.binding.stateRoot,profile_path:f.binding.profilePath,source_view:f.root};
  for(const change of [{owner_token:'short'},{actor:'operator'},{protocol:2}]) {
    await assert.rejects(authenticateServicePeer({...hello,...change},f.binding,f.descriptor.token),{code:'SERVICE_HANDSHAKE_INVALID'});
  }
});

test('control-lane saturation is bounded independently and leaves ordinary observation available', async t => {
  const f = await authenticatedFixture(t), a = await f.client(); await f.initialize(a);
  const saved = await a.coordinate(f.register()), gate = f.gate(), entered = hold(); let count=0;
  f.setBeforeRoute(async r => {
    if(r.kind==='read' && r.selector.kind==='receipt') { if(++count===4)entered.release();await gate.promise; }
  });
  const jobs=Array.from({length:4},()=>a.coordinate(readReceipt(saved.receipt.key)));
  await entered.promise;
  await assert.rejects(a.coordinate(readReceipt(saved.receipt.key)),{code:'SERVICE_REQUEST_LIMIT'});
  assert.equal((await a.coordinate(request('identity'))).parent_id,f.owner(f.operatorToken));
  gate.release(); const results=await Promise.all(jobs);assert.equal(results.length,4);
  assert.equal(a.connection.isClosed,false);
});

test('captured handshake binding and token are immutable across asynchronous source validation', async t => {
  const f=await authenticatedFixture(t);
  const binding={...f.binding}, token=f.descriptor.token;
  const hello={kind:'hello',protocol:1,token,owner_token:f.operatorToken,repository_id:binding.repositoryId,
    state_root:binding.stateRoot,profile_path:binding.profilePath,source_view:f.root};
  const authenticated=authenticateServicePeer(hello,binding,token);
  hello.owner_token='a'.repeat(64); hello.source_view='/not/the/source';binding.repositoryId='0'.repeat(24);
  const peer=await authenticated;
  assert.equal(peer.actor.owner_id,f.owner(f.operatorToken));assert.equal(peer.source_view,f.root);
  assert.ok(Object.isFrozen(peer));assert.ok(Object.isFrozen(peer.actor));
});
