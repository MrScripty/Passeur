import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';
import { PasseurFrontend } from '../../.passeur-core/src/service/client.js';
import { resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { preparePaths } from '../../.passeur-core/src/service/bootstrap.js';
import { processIdentity } from '../../.passeur-core/src/service/process.js';
import { IpcConnection } from '../../.passeur-core/src/service/transport.js';
import { diagnosticInfo } from '../../.passeur-core/src/core/errors.js';
import { SERVICE_CONTRACT } from '../../.passeur-core/src/contracts/service.js';
import { decodeSharedProfile, effectiveProfileFingerprint } from '../../.passeur-core/src/core/profile.js';

async function attachmentFixture(t, profilePath) {
  const f = await serviceFixture(t);
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const selectedProfile = { schema_version: 3, execution: { implementation: { enabled: false } }, agents: [] };
  const selectedPath = profilePath ?? `${f.temp}/profile.json`;
  if (selectedPath.length < 2000) await writeFile(selectedPath, JSON.stringify(selectedProfile));
  const profileFingerprint = effectiveProfileFingerprint(decodeSharedProfile(selectedProfile));
  const intent = { project: f.root, stateRoot: f.state, profilePath: selectedPath };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const paths = await preparePaths(binding), generation = randomUUID();
  const descriptor = { protocol: 1, generation, repository_id: binding.repositoryId, state_root: binding.stateRoot,
    profile_path: binding.profilePath, service_contract: SERVICE_CONTRACT, profile_fingerprint: profileFingerprint,
    endpoint: paths.endpoint, token: randomBytes(32).toString('hex'),
    runtime: identity, process: await processIdentity() };
  const publish = async value => writeFile(paths.descriptor, JSON.stringify(value), { mode: 0o600 });
  const frontend = new PasseurFrontend(intent, identity, '/unused-cli');
  t.after(() => frontend.shutdown());
  return { ...f, identity, intent, binding, paths, descriptor, publish, frontend };
}

test('transient endpoint refusal and descriptor replacement recover before dispatch', async t => {
  const f = await attachmentFixture(t), peers = new Set();
  await f.publish({ ...f.descriptor, generation: randomUUID() });
  const connecting = f.frontend.call('status', {});
  await delay(70);
  await f.publish(f.descriptor);
  // Let the refused connection close and discovery consume the replacement
  // before publishing an endpoint for that new generation. A stale welcome is
  // intentionally terminal and has its own separate regression below.
  await delay(70);
  const server = createServer(socket => {
    const peer = new IpcConnection(socket, frame => {
      if (frame.kind === 'hello') return peer.send({ kind: 'welcome', protocol: 1, generation: f.descriptor.generation, client_id: randomUUID() });
      if (frame.kind === 'request') return peer.send({ kind: 'response', id: frame.id, generation: f.descriptor.generation,
        result: { schema_version: 1, generation: f.descriptor.generation, clients: 1, admission: 'open', repository: {
          schema_version: 1, runtime: f.identity,
          binding: { project_input: f.root, state_root: f.state, profile_path: f.intent.profilePath },
          coordination: { state: 'idle', authority: 'not_acquired' },
          execution: { profile: 'not_checked', provider: 'not_checked', approval: 'not_checked' },
        } } });
    });
    peers.add(peer);
  });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.paths.endpoint, resolve); });
  assert.equal((await connecting).generation, f.descriptor.generation);
  assert.equal(f.frontend.status().service.state, 'connected');
  for (const peer of peers) peer.close();
  await Promise.all([...peers].map(peer => peer.closed));
  await f.publish({ ...f.descriptor, runtime: { ...f.identity, build_id: 'other' } });
  await assert.rejects(f.frontend.call('status', {}), { code: 'SERVICE_BUILD_CONFLICT' });
  assert.equal(f.frontend.status().service.code, 'SERVICE_BUILD_CONFLICT');
});

test('a dispatched status request is not replayed after its reply is lost', async t => {
  const f = await attachmentFixture(t), peers = new Set();
  await f.publish(f.descriptor);
  let requests = 0, connections = 0;
  const server = createServer(socket => {
    connections++;
    const peer = new IpcConnection(socket, frame => {
      if (frame.kind === 'hello') return peer.send({ kind: 'welcome', protocol: 1, generation: f.descriptor.generation, client_id: randomUUID() });
      if (frame.kind === 'request') { requests++; peer.close(); }
    }); peers.add(peer);
  });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.paths.endpoint, resolve); });
  await assert.rejects(f.frontend.call('status', {}), { code: 'SERVICE_DISCONNECTED' });
  assert.equal(requests, 1); assert.equal(connections, 1);
  assert.equal(f.frontend.status().service.code, 'SERVICE_DISCONNECTED');
});

test('a transient status failure clears after a later successful observation', async t => {
  const f = await attachmentFixture(t), peers = new Set();
  await f.publish(f.descriptor);
  let requests = 0;
  const result = { schema_version: 1, generation: f.descriptor.generation, clients: 1, admission: 'open', repository: {
    schema_version: 1, runtime: f.identity,
    binding: { project_input: f.root, state_root: f.state, profile_path: f.intent.profilePath },
    coordination: { state: 'idle', authority: 'not_acquired' },
    execution: { profile: 'not_checked', provider: 'not_checked', approval: 'not_checked' },
  } };
  const server = createServer(socket => {
    const peer = new IpcConnection(socket, frame => {
      if (frame.kind === 'hello') return peer.send({ kind: 'welcome', protocol: 1, generation: f.descriptor.generation, client_id: randomUUID() });
      if (frame.kind !== 'request') return;
      requests++;
      if (requests === 3) return peer.send({ kind: 'failure', id: frame.id, generation: f.descriptor.generation,
        error: { code: 'SERVICE_TEMPORARY', message: 'temporary observation failure', stage: 'status.read', path: '/fixture', native_code: 'EIO', next_action: 'retry observation' } });
      return peer.send({ kind: 'response', id: frame.id, generation: f.descriptor.generation, result });
    }); peers.add(peer);
  });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.paths.endpoint, resolve); });
  await f.frontend.call('status', {});
  const unavailable = (await f.frontend.observeStatus()).service;
  assert.deepEqual(unavailable, { state: 'unavailable', code: 'SERVICE_TEMPORARY', message: 'temporary observation failure',
    stage: 'status.read', path: '/fixture', native_code: 'EIO', next_action: 'retry observation' });
  assert.equal((await f.frontend.observeStatus()).service.state, 'connected');
  assert.equal(requests, 4);
});

test('build and service-contract conflicts are terminal and recorded in frontend status', async t => {
  for (const field of ['build', 'contract']) {
    await t.test(field, async t => {
      const f = await attachmentFixture(t);
      await f.publish(field === 'build'
        ? { ...f.descriptor, runtime: { ...f.identity, build_id: 'other' } }
        : { ...f.descriptor, service_contract: 'unsupported-service-contract' });
      const code = field === 'build' ? 'SERVICE_BUILD_CONFLICT' : 'SERVICE_CONTRACT_CONFLICT';
      await assert.rejects(f.frontend.call('status', {}), { code });
      assert.deepEqual(f.frontend.status().service, { state: 'unavailable', code,
        message: f.frontend.status().service.message });
    });
  }
});

test('a stale welcome generation is terminal before any request is dispatched', async t => {
  const f = await attachmentFixture(t), peers = new Set();
  await f.publish(f.descriptor);
  let requests = 0;
  const server = createServer(socket => {
    const peer = new IpcConnection(socket, frame => {
      if (frame.kind === 'hello') return peer.send({ kind: 'welcome', protocol: 1, generation: randomUUID(), client_id: randomUUID() });
      if (frame.kind === 'request') requests++;
    }); peers.add(peer);
  });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.paths.endpoint, resolve); });
  await assert.rejects(f.frontend.call('status', {}), { code: 'SERVICE_GENERATION_CHANGED' });
  assert.equal(f.frontend.status().service.code, 'SERVICE_GENERATION_CHANGED');
  assert.equal(requests, 0);
});

test('binding failure is recorded even when discovery cannot start', async t => {
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const frontend = new PasseurFrontend({ project: '/nonexistent-passeur-attachment-project', stateRoot: '/tmp' }, identity, '/unused-cli');
  t.after(() => frontend.shutdown());
  await assert.rejects(frontend.call('status', {}));
  assert.equal(frontend.status().service.state, 'unavailable');
});
