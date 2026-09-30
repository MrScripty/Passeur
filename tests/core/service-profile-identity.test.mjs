import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serviceFixture } from '../fixtures/structural/service-fixture.mjs';
import { PasseurFrontend, ServiceClient } from '../../.passeur-core/src/service/client.js';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { preparePaths } from '../../.passeur-core/src/service/bootstrap.js';
import { processIdentity } from '../../.passeur-core/src/service/process.js';
import { IpcConnection, decodeFrame } from '../../.passeur-core/src/service/transport.js';
import { authenticateServicePeer } from '../../.passeur-core/src/service/peer-auth.js';
import { SERVICE_CONTRACT, QUALIFIED_LEGACY_BUILD, DescriptorSchema, FailureSchema } from '../../.passeur-core/src/contracts/service.js';
import { diagnosticInfo, BridgeError } from '../../.passeur-core/src/core/errors.js';

const profile = { schema_version: 3, execution: { implementation: { enabled: false } },
  agents: [{ agent_id: 'fixture', adapter_id: 'fixture', options: { model: 'original', secret: 'never-output' } }] };
const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
async function fixture(t) {
  const f = await serviceFixture(t), profilePath = `${f.temp}/service-profile.json`;
  await writeFile(profilePath, JSON.stringify(profile));
  const intent = { project: f.root, stateRoot: f.state, profilePath };
  const runtime = new RepositoryRuntime(intent, identity);
  t.after(() => runtime.shutdown());
  const snapshot = await runtime.profileSnapshot();
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const paths = await preparePaths(binding), peers = new Set(), hellos = [];
  const descriptor = { protocol: 1, generation: randomUUID(), repository_id: binding.repositoryId,
    state_root: binding.stateRoot, profile_path: profilePath, profile_fingerprint: snapshot.fingerprint,
    service_contract: SERVICE_CONTRACT, endpoint: paths.endpoint, token: randomBytes(32).toString('hex'),
    runtime: identity, process: await processIdentity() };
  const server = createServer(socket => {
    const peer = new IpcConnection(socket, async frame => {
      if (frame.kind === 'hello') {
        hellos.push(frame);
        await authenticateServicePeer(frame, { ...binding, profileFingerprint: snapshot.fingerprint }, descriptor.token);
        return peer.send({ kind: 'welcome', protocol: 1, generation: descriptor.generation, client_id: randomUUID() });
      }
      if (frame.kind === 'request') return peer.send({ kind: 'response', id: frame.id, generation: descriptor.generation,
        result: frame.operation === 'agents' ? await runtime.agents(frame.arguments.offset, frame.arguments.limit)
          : { schema_version: 1, generation: descriptor.generation, service_contract: SERVICE_CONTRACT,
            profile_fingerprint: snapshot.fingerprint, profile_path: profilePath, clients: 1, admission: 'open', repository: runtime.status() } });
    });
    peers.add(peer);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, resolve); });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  const publish = value => writeFile(paths.descriptor, JSON.stringify(value), { mode: 0o600 });
  await publish(descriptor);
  const frontend = explicit => {
    const client = new PasseurFrontend({ project: f.root, stateRoot: f.state, ...(explicit ? { profilePath: explicit } : {}) }, identity, '/must-not-launch');
    t.after(() => client.shutdown()); return client;
  };
  return { ...f, descriptor, profilePath, snapshot, publish, frontend, hellos, runtime };
}

test('live unpinned catalog and prepare use retained profile without opening the prospective candidate', async t => {
  const f = await fixture(t);
  assert.ok(DescriptorSchema.safeParse(f.descriptor).success);
  assert.equal(DescriptorSchema.safeParse({ ...f.descriptor, profile_fingerprint: undefined }).success, false);
  await writeFile(f.profilePath, '{invalid after admission');
  const frontend = f.frontend();
  const [catalog, status] = await Promise.all([frontend.agents(0, 4), frontend.call('status', {})]);
  assert.equal(catalog.agents[0].agent_id, 'fixture');
  assert.equal(status.profile_fingerprint, f.snapshot.fingerprint);
  assert.ok(f.hellos.length >= 1);
  assert.ok(f.hellos.every(hello => hello.service_contract === SERVICE_CONTRACT && hello.profile_fingerprint === undefined && hello.profile_path === undefined));
  assert.equal(new Set(f.hellos.map(hello => hello.owner_token)).size, 1);
  assert.equal(f.runtime.status().coordination.authority, 'not_acquired');
  assert.equal(f.runtime.status().coordination.state, 'idle');
});

test('equal explicit profiles join at the original and different paths; changed same-path bytes conflict', async t => {
  const f = await fixture(t), equalPath = `${f.temp}/equal-profile.json`;
  await writeFile(equalPath, JSON.stringify(profile));
  for (const path of [f.profilePath, equalPath]) assert.equal((await f.frontend(path).call('status', {})).generation, f.descriptor.generation);
  await writeFile(f.profilePath, JSON.stringify({ ...profile, agents: [{ ...profile.agents[0], options: { model: 'changed', secret: 'never-output' } }] }));
  await assert.rejects(f.frontend(f.profilePath).call('status', {}), error => {
    const detail = diagnosticInfo(error);
    assert.equal(detail.code, 'SERVICE_PROFILE_CONFLICT');
    assert.equal(detail.requested_profile_path, f.profilePath);
    assert.equal(detail.service_profile_path, f.profilePath);
    assert.equal(detail.service_profile_fingerprint, f.snapshot.fingerprint);
    assert.notEqual(detail.requested_profile_fingerprint, f.snapshot.fingerprint);
    assert.equal(detail.service_generation, f.descriptor.generation);
    assert.ok(FailureSchema.safeParse(detail).success);
    assert.ok(!JSON.stringify(detail).includes('never-output'));
    return true;
  });
});

test('live incompatible services never fall back to an offline catalog', async t => {
  const f = await fixture(t);
  for (const [update, code] of [
    [{ runtime: { ...identity, build_id: 'unknown-build' } }, 'SERVICE_BUILD_CONFLICT'],
    [{ service_contract: 'unknown-contract' }, 'SERVICE_CONTRACT_CONFLICT'],
    [{ service_contract: undefined, profile_fingerprint: undefined }, 'SERVICE_BUILD_CONFLICT'],
  ]) {
    await f.publish({ ...f.descriptor, ...update });
    await assert.rejects(f.frontend().agents(0, 4), { code });
  }
});

test('a live service with an unreachable endpoint is unavailable, not an offline catalog', async t => {
  const f = await fixture(t);
  // The current process proves a live descriptor, while this unused socket path
  // exercises connection refusal without changing owner liveness.
  const { unlink } = await import('node:fs/promises');
  await unlink(f.descriptor.endpoint);
  await assert.rejects(f.frontend().agents(0, 4), { code: 'SERVICE_ATTACH_UNAVAILABLE' });
  assert.equal(f.runtime.status().coordination.authority, 'not_acquired');
});

test('verified absence permits offline catalog without creating service/election resources', async t => {
  const f = await serviceFixture(t), profilePath = `${f.temp}/profile.json`;
  await writeFile(profilePath, JSON.stringify(profile));
  const frontend = new PasseurFrontend({ project: f.root, stateRoot: f.state, profilePath }, identity, '/must-not-launch');
  t.after(() => frontend.shutdown());
  assert.equal((await frontend.agents(0, 4)).agents[0].agent_id, 'fixture');
  await assert.rejects(access(`${frontend.status().resolved.store_root}/service.json`), { code: 'ENOENT' });
  await assert.rejects(access(`${frontend.status().resolved.store_root}/service-election.lock`), { code: 'ENOENT' });
});

test('missing unpinned installation default reports configuration required before service launch', async t => {
  const f = await serviceFixture(t), previous = process.env.XDG_CONFIG_HOME;
  let frontend;
  try {
    process.env.XDG_CONFIG_HOME = `${f.temp}/isolated-config`;
    frontend = new PasseurFrontend({ project: f.root, stateRoot: f.state }, identity, '/must-not-launch');
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
  }
  t.after(() => frontend.shutdown());
  await assert.rejects(frontend.agents(0, 4), { code: 'PROFILE_CONFIGURATION_REQUIRED' });
  await assert.rejects(frontend.call('prepare', {}), error => {
    assert.equal(error.code, 'PROFILE_CONFIGURATION_REQUIRED');
    assert.equal(diagnosticInfo(error).native_code, 'ENOENT'); return true;
  });
  await assert.rejects(access(`${frontend.status().resolved.store_root}/service-election.lock`), { code: 'ENOENT' });
});

test('modern hello cannot carry legacy path provenance', () => {
  const hello = { kind: 'hello', protocol: 1, token: 'a'.repeat(64), owner_token: 'b'.repeat(64),
    repository_id: 'repo', source_view: '/repo', state_root: '/state' };
  assert.deepEqual(decodeFrame(hello), hello);
  assert.throws(() => decodeFrame({ ...hello, profile_fingerprint: `sha256:v1:${'c'.repeat(64)}` }), { code: 'SERVICE_HANDSHAKE_INVALID' });
  assert.throws(() => decodeFrame({ ...hello, service_contract: SERVICE_CONTRACT, profile_path: '/profile' }), { code: 'SERVICE_HANDSHAKE_INVALID' });
});

test('profile conflict diagnostics remain bounded across the strict failure contract', () => {
  const detail = diagnosticInfo(new BridgeError('SERVICE_PROFILE_CONFLICT', 'Profile differs', {
    requested_profile_path: `/tmp/${'r'.repeat(5000)}`, service_profile_path: `/tmp/${'s'.repeat(5000)}`,
    requested_profile_fingerprint: 'r'.repeat(500), service_profile_fingerprint: 's'.repeat(500), service_generation: randomUUID(),
  }));
  assert.equal(detail.requested_profile_path.length, 4096);
  assert.equal(detail.service_profile_path.length, 4096);
  assert.equal(detail.requested_profile_fingerprint.length, 128);
  assert.ok(FailureSchema.safeParse(detail).success);
});

// This is an actual installed prior artifact, never a current service with a relabeled build.
const legacyRoot = process.env.PASSEUR_LEGACY_RUNTIME ?? `/home/jeremy/.local/share/passeur/runtimes/${QUALIFIED_LEGACY_BUILD}`;
test('qualified actual prior build accepts strict legacy hello and preserves independent principals', async t => {
  try { await access(`${legacyRoot}/runtime-manifest.json`); } catch { t.skip('Actual qualified prior runtime artifact unavailable; old-build acceptance remains pending'); return; }
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(`${legacyRoot}/runtime-manifest.json`, 'utf8'));
  assert.equal(manifest.build_id, QUALIFIED_LEGACY_BUILD);
  assert.equal(manifest.source_revision, '6e61bd93e74686620f0cffc3e54bf00c8e5373f8');
  assert.equal(manifest.source_dirty, false);
  const prior = await import(pathToFileURL(`${legacyRoot}/dist/src/service/peer-auth.js`).href);
  const f = await serviceFixture(t), token = 'a'.repeat(64);
  const hello = { kind: 'hello', protocol: 1, token, owner_token: 'b'.repeat(64), repository_id: f.repositoryId,
    source_view: f.root, state_root: f.state, profile_path: `${f.temp}/original.json` };
  const binding = { repositoryId: f.repositoryId, stateRoot: f.state, profilePath: hello.profile_path };
  const first = await prior.authenticateServicePeer(hello, binding, token);
  const second = await prior.authenticateServicePeer({ ...hello, owner_token: 'c'.repeat(64) }, binding, token);
  assert.notEqual(first.actor.owner_id, second.actor.owner_id);
  await assert.rejects(prior.authenticateServicePeer({ ...hello, service_contract: SERVICE_CONTRACT }, binding, token), { code: 'SERVICE_HANDSHAKE_INVALID' });
  await assert.rejects(prior.authenticateServicePeer({ ...hello, profile_path: `${f.temp}/candidate.json` }, binding, token), { code: 'SERVICE_BINDING_CONFLICT' });
  const resolved = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state }, {}, new AbortController().signal);
  const paths = await preparePaths(resolved), generation = randomUUID(), peers = new Set();
  let observed;
  const server = createServer(socket => {
    const peer = new IpcConnection(socket, async frame => {
      observed = frame;
      const authenticated = await prior.authenticateServicePeer(frame, binding, token);
      return peer.send({ kind: 'welcome', protocol: 1, generation, client_id: authenticated.actor.client_id });
    });
    peers.add(peer);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, resolve); });
  t.after(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
  const descriptor = { protocol: 1, generation, repository_id: resolved.repositoryId, state_root: resolved.stateRoot,
    profile_path: hello.profile_path, endpoint: paths.endpoint, token,
    runtime: { ...identity, mode: 'installed', build_id: manifest.build_id, source_revision: manifest.source_revision },
    process: await processIdentity() };
  const client = new ServiceClient(descriptor, resolved, hello.owner_token);
  t.after(() => client.close()); await client.ready;
  assert.equal(observed.profile_path, hello.profile_path);
  assert.notEqual(observed.profile_path, resolved.profilePath);
  assert.equal(observed.service_contract, undefined);
  assert.throws(() => new ServiceClient({ ...descriptor, runtime: identity }, resolved, hello.owner_token), { code: 'SERVICE_BUILD_CONFLICT' });
  await writeFile(paths.descriptor, JSON.stringify(descriptor), { mode: 0o600 });
  const pinned = new PasseurFrontend({ project: f.root, stateRoot: f.state, profilePath: hello.profile_path }, identity, '/must-not-launch');
  t.after(() => pinned.shutdown());
  await assert.rejects(pinned.agents(0, 4), { code: 'SERVICE_PROFILE_IDENTITY_UNAVAILABLE' });
});
