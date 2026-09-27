import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoTurn, assertPortSeparation, classifyNoRoute, guestCommand, guestEnvironment,
  pinnedBinary, pinnedNode, qualify, retainHostRoot, sandboxConfig, stageRuntime, validateIdleRead,
  verifiedNativeNamespace, loopbackReady,
} from '../../scripts/qualify-muse-sandbox-transport.mjs';
import { prepareSandbox } from '../../scripts/experiment-worker-sandbox.mjs';

test('guest runtime selection uses exact private mounts and an empty environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-transport-layout-'));
  try {
    const workspace = join(root, 'workspace');
    const runtime = join(root, 'runtime');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    await Promise.all([workspace, runtime, home, protectedRoot].map(path => mkdir(path)));
    const config = sandboxConfig({ workspace, runtime, home, protectedRoot });
    assert.deepEqual(config, { workspace, preserveWorkspacePath: true, denied: [protectedRoot], mounts: [
      { source: runtime, target: '/mounts/runtime', mode: 'ro' },
      { source: home, target: '/mounts/home', mode: 'rw' },
    ] });
    const prepared = prepareSandbox(config, guestCommand());
    assert.deepEqual(prepared.args.slice(0, 10), ['--unshare-user', '--unshare-pid', '--unshare-ipc',
      '--unshare-uts', '--unshare-net', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv', '--ro-bind']);
    assert.ok(prepared.args.includes('--unshare-net'));
    assert.ok(prepared.args.includes('--clearenv'));
    assert.ok(prepared.args.join(' ').includes(`--ro-bind ${runtime} /mounts/runtime`));
    assert.ok(prepared.args.join(' ').includes(`--bind ${home} /mounts/home`));
    assert.deepEqual(guestCommand(), ['/mounts/runtime/node', '/mounts/runtime/qualify-muse-sandbox-transport.mjs', '--guest']);
    assert.deepEqual(guestEnvironment(), { HOME: '/mounts/home', XDG_CONFIG_HOME: '/mounts/home/.config',
      XDG_DATA_HOME: '/mounts/home/.local/share', XDG_CACHE_HOME: '/mounts/home/.cache',
      TMPDIR: '/tmp', PATH: '/usr/bin:/bin', MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned native mismatch is rejected before any host launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-transport-pin-'));
  try {
    const muse = join(root, 'muse');
    const native = join(root, 'muse-bin-1.4.0-R4302.1');
    await writeFile(muse, 'launcher');
    await writeFile(native, 'wrong binary');
    await assert.rejects(pinnedBinary(muse), { code: 'NATIVE_BINARY_MISMATCH' });
    let checked = false;
    const result = await qualify({ muse, checkBubblewrap: () => { checked = true; } });
    assert.equal(result.kind, 'transport_error');
    assert.equal(result.code, 'NATIVE_BINARY_MISMATCH');
    assert.equal(result.hostStarted, false);
    assert.equal(checked, false);
    assert.equal(result.retainedFixtures.length, 1);
    await rm(result.retainedFixtures[0], { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned Node mismatch fails before sandbox launch', async () => {
  await assert.rejects(pinnedNode('/tmp/fake-node', { version: 'v18.19.1',
    canonicalize: async value => value, hash: async () => 'unused' }), { code: 'NODE_BINARY_MISMATCH' });
  await assert.rejects(pinnedNode('/tmp/fake-node', { version: 'v24.12.0',
    canonicalize: async value => value, hash: async () => 'bad' }), { code: 'NODE_BINARY_MISMATCH' });
  const result = await qualify({ stage: async root => {
    const native = join(root, 'fake-native');
    await writeFile(native, 'fixture');
    return stageRuntime(root, join(root, 'muse'), { resolveBinary: async () => native,
      hash: async () => 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86',
      resolveNode: () => pinnedNode('/tmp/fake-node', { version: 'v18.19.1' }),
    });
  }, checkBubblewrap: () => assert.fail('sandbox must not start') });
  assert.equal(result.code, 'NODE_BINARY_MISMATCH');
  assert.equal(result.hostStarted, false);
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('staging copies only the diagnostic, wrapper, SDK package and pinned native', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-transport-stage-'));
  const muse = join(root, 'muse');
  await writeFile(muse, 'launcher');
  try {
    const runtime = await stageRuntime(root, muse, { resolveBinary: async () => {
      const native = join(root, 'muse-bin-1.4.0-R4302.1');
      await writeFile(native, 'fixture');
      return native;
    }, copy: async (source, target) => {
      await writeFile(target, target.endsWith('muse-bin-1.4.0-R4302.1') ? 'fixture' : await readFile(source));
    } }).catch(error => error);
    assert.equal(runtime.code, 'NATIVE_BINARY_MISMATCH');
    assert.deepEqual((await readdir(join(root, 'runtime'))).sort(), [
      'experiment-worker-sandbox.mjs', 'muse-bin-1.4.0-R4302.1',
      'native-host-wrapper', 'qualify-muse-sandbox-transport.mjs', 'sdk',
    ]);
    assert.deepEqual((await readdir(join(root, 'runtime', 'sdk'))).sort(), ['dist', 'package.json']);
    assert.equal(await readFile(join(root, 'runtime', 'native-host-wrapper'), 'utf8').then(value =>
      value.includes('exec /mounts/runtime/muse-bin-1.4.0-R4302.1 "$@"')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('staged Node executable is exact guest command and file-ESM crypto is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-transport-node-'));
  try {
    const native = join(root, 'native');
    const node = join(root, 'node-source');
    await writeFile(native, 'native');
    await writeFile(node, 'node fixture', { mode: 0o700 });
    const runtime = await stageRuntime(root, join(root, 'muse'), {
      resolveBinary: async () => native,
      resolveNode: async () => node,
      hash: async path => path.endsWith('/node')
        ? '16143bdaa79716e871d3d9b2f50ce680bca293eba7f0c3fc1d004ed2258fc839'
        : 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86',
    });
    assert.equal(await readFile(join(runtime, 'node'), 'utf8'), 'node fixture');
    assert.notEqual((await lstat(join(runtime, 'node'))).mode & 0o111, 0);
    assert.deepEqual(guestCommand(), ['/mounts/runtime/node', '/mounts/runtime/qualify-muse-sandbox-transport.mjs', '--guest']);
    const sdk = JSON.parse(await readFile(join(runtime, 'sdk', 'package.json'), 'utf8'));
    assert.equal(sdk.engines.node, '>=20');
    // This test file itself runs as file ESM under the selected Node executable.
    assert.equal(typeof globalThis.crypto?.getRandomValues, 'function');
    assert.equal(await pinnedNode(), process.execPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function procStat(pid, { start = '12345', group = pid, session = pid, state = 'S' } = {}) {
  const fields = Array(20).fill('0');
  fields[0] = state;
  fields[2] = String(group);
  fields[3] = String(session);
  fields[19] = start;
  return `${pid} (muse native) ${fields.join(' ')}`;
}

test('wrapper birth marker binds native PID, executable, group and namespace after exec', async () => {
  const home = '/mounts/home';
  const native = '/mounts/runtime/muse-bin-1.4.0-R4302.1';
  const namespace = 'net:[123456]';
  const marker = procStat(101);
  const values = new Map([[`${home}/native.stat`, marker], [`${home}/native.netns`, `${namespace}\n`],
    ['/proc/101/stat', marker]]);
  const options = { read: async path => values.get(path), link: async path =>
    path.endsWith('/ns/net') ? namespace : native, canonicalize: async () => native };
  assert.deepEqual(await verifiedNativeNamespace(home, native, namespace, options),
    { pid: 101, start: '12345', group: 101, session: 101, namespace, executable: native });
  values.set('/proc/101/stat', procStat(101, { start: '12346' }));
  await assert.rejects(verifiedNativeNamespace(home, native, namespace, options), { code: 'NATIVE_IDENTITY_UNVERIFIED' });
  values.set('/proc/101/stat', procStat(101, { group: 202 }));
  await assert.rejects(verifiedNativeNamespace(home, native, namespace, options), { code: 'NATIVE_IDENTITY_UNVERIFIED' });
  values.set('/proc/101/stat', marker);
  await assert.rejects(verifiedNativeNamespace(home, native, namespace, {
    ...options, link: async path => path.endsWith('/exe') ? '/usr/bin/other' : namespace,
  }), { code: 'NATIVE_IDENTITY_UNVERIFIED' });
  await assert.rejects(verifiedNativeNamespace(home, native, namespace, {
    ...options, link: async path => path.endsWith('/ns/net') ? 'net:[987]' : native,
  }), { code: 'NATIVE_IDENTITY_UNVERIFIED' });
});

test('host and guest provider ports must differ and numeric no-route has a narrow meaning', () => {
  assertPortSeparation(31001, 31002);
  assert.throws(() => assertPortSeparation(31001, 31001), { code: 'PORT_SEPARATION_INVALID' });
  assert.equal(classifyNoRoute({ kind: 'error', code: 'ENETUNREACH' }), true);
  assert.equal(classifyNoRoute({ kind: 'error', code: 'EHOSTUNREACH' }), true);
  for (const probe of [{ kind: 'timeout' }, { kind: 'error', code: 'ENOTFOUND' },
    { kind: 'error', code: 'ECONNREFUSED' }, { kind: 'connected' }]) {
    assert.equal(classifyNoRoute(probe), false);
  }
});

test('read-only guest loopback observation accepts an already UP interface', () => {
  assert.equal(loopbackReady({ status: 0,
    stdout: '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n' }), true);
  assert.equal(loopbackReady({ status: 0, stdout: '1: lo: <UP,LOOPBACK> mtu 65536\n' }), true);
  for (const result of [
    { status: 1, stdout: '1: lo: <LOOPBACK,UP>\n' },
    { status: 0, stdout: '1: lo: <LOOPBACK> mtu 65536\n' },
    { status: 0, stdout: '2: eth0: <BROADCAST,UP> mtu 1500\n' },
    { status: 0, stdout: '1: lo: <LOOPBACK,LOWER_UP> mtu 65536\n' },
  ]) assert.equal(loopbackReady(result), false);
});

test('direct Responses is separately attributable and a native turn is rejected', () => {
  assertNoTurn(['session/start', 'session/read'], [{ method: 'GET', path: '/muse-code/models' }]);
  assert.throws(() => assertNoTurn(['session/start', 'turn/start'], []), { code: 'UNEXPECTED_TURN' });
  assert.throws(() => assertNoTurn(['session/start', 'session/read'],
    [{ method: 'POST', path: '/responses' }]), { code: 'UNEXPECTED_TURN' });
});

test('malformed or non-idle session/read fails closed', () => {
  const workspace = '/tmp/disposable/workspace';
  const home = '/mounts/home';
  const sessionId = '0199aabb-ccdd-7eef-8abc-0123456789ab';
  const started = { session: { sessionId, workspaceRoot: workspace } };
  const read = { session: { sessionId, workspaceRoot: workspace, activeTurnId: null,
    turnCount: 0, status: 'idle', path: `${home}/.local/share/muse/sessions/log.jsonl` },
  pendingRequests: [], history: { mode: 'none', noneReason: 'excluded', items: null, snapshot: null }, viewCursor: 'v0' };
  assert.equal(validateIdleRead(started, read, workspace, home).sessionId, sessionId);
  for (const variant of [{ session: { ...read.session, turnCount: 1 } },
    { session: { ...read.session, status: 'running' } },
    { session: { ...read.session, status: 'notLoaded' } },
    { history: { ...read.history, mode: 'full' } },
    { session: { ...read.session, path: '/home/jeremy/.local/muse/log' } },
    { pendingRequests: [{}] }]) {
    assert.throws(() => validateIdleRead(started, { ...read, ...variant }, workspace, home),
      { code: 'INVALID_SESSION_READ' });
  }
});

test('bounded failure retains a host-started fixture and reports no descendant proof', async () => {
  const result = await qualify({ stage: async () => {
    const root = await mkdtemp(join(tmpdir(), 'passeur-transport-stub-stage-'));
    return root;
  }, startSentinel: async () => ({ port: 30001, close: async () => undefined }),
  probe: async () => ({ kind: 'connected' }),
  checkBubblewrap: () => undefined, run: async () => ({ code: 1, output: '', errorOutput: 'failed' }) });
  assert.equal(result.kind, 'transport_error');
  assert.equal(result.code, 'GUEST_PROCESS_FAILED');
  assert.equal(result.hostStarted, true);
  assert.equal(result.stopProof, 'descendants_unverified');
  assert.equal(retainHostRoot(true), true);
  assert.equal(result.retainedFixtures.length, 1);
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('nonzero guest result retains its typed stage, code and provider facts', async () => {
  const guestFailure = { kind: 'guest_transport_error', stage: 'session_read', code: 'INVALID_SESSION_READ',
    message: 'invalid idle metadata', guestNamespace: 'net:[123]', guestPort: 31002,
    commands: ['session/start', 'session/read'],
    providerRequests: [{ method: 'GET', path: '/muse-code/models', bytes: 0 }] };
  const result = await qualify({ stage: async root => {
    const runtime = join(root, 'runtime');
    await mkdir(runtime);
    return runtime;
  }, startSentinel: async () => ({ port: 31001, close: async () => undefined }),
  probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
  run: async () => ({ code: 1, signal: null, output: JSON.stringify(guestFailure) }) });
  assert.equal(result.kind, 'transport_error');
  assert.equal(result.code, 'INVALID_SESSION_READ');
  assert.equal(result.guestFailure.stage, 'session_read');
  assert.deepEqual(result.guestFailure.providerRequests, guestFailure.providerRequests);
  assert.deepEqual(result.processExit, { code: 1, signal: null, timedOut: false, overflow: false });
  assert.equal(result.stopProof, 'descendants_unverified');
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});
