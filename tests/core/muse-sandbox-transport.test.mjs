import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoTurn, assertPortSeparation, classifyNoRoute, guestCommand, guestEnvironment,
  pinnedBinary, pinnedNode, qualify, retainHostRoot, sandboxConfig, stageRuntime, validateIdleRead,
  verifiedNativeNamespace, loopbackReady, parseBubblewrapStatus, verifyHostStop,
  validateResumeOutcome, qualifyFreshHostResume,
  assertHostAssociation,
  advertisedBash, matchingShellResult, shellOutputMarkers, shellProbeCommand,
  rejectedToolSchemaShape, summarizedShellModel,
  validateShellReady, validateShellOutcome, qualifyNativeShell,
  diagnosticMode,
  runStatusPhase,
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
  assert.equal(validateIdleRead(read, read, workspace, home).sessionId, sessionId);
  for (const variant of [{ session: { ...read.session, turnCount: 1 } },
    { session: { ...read.session, status: 'running' } },
    { session: { ...read.session, status: 'notLoaded' } },
    { history: { ...read.history, mode: 'full' } },
    { session: { ...read.session, path: '/home/jeremy/.local/muse/log' } },
    { pendingRequests: [{}] }]) {
    assert.throws(() => validateIdleRead(started, { ...read, ...variant }, workspace, home),
      { code: 'INVALID_SESSION_READ' });
    assert.throws(() => validateIdleRead({ ...read, ...variant }, { ...read, ...variant }, workspace, home),
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

test('Bubblewrap status accepts extensions but requires one ordered child and terminal exit', () => {
  assert.deepEqual(parseBubblewrapStatus(['{"future":true}', '{"child-pid":101,"pidns":"pid:[1]"}',
    '{"exit-code":0}', '{"later":"ignored"}']), { child: 101, exit: 0 });
  for (const lines of [['{'], ['{"exit-code":0}'], ['{"child-pid":"101"}'],
    ['{"child-pid":101}', '{"child-pid":102}'],
    ['{"child-pid":101}', '{"exit-code":0}', '{"exit-code":0}']]) {
    assert.throws(() => parseBubblewrapStatus(lines), { code: 'BWRAP_STATUS_INVALID' });
  }
});

test('stop gate rejects changed boot/start, unreadable scan and reparented survivor', async () => {
  const capture = { boot: 'boot-a', pidns: 'pid:[42]', statusChild: { pid: 101 },
    wrapper: { pid: 100, start: '10' }, members: [{ pid: 101, start: '11' }, { pid: 102, start: '12' }] };
  const status = { child: 101, exit: 0 };
  const exit = { code: 0, signal: null, timedOut: false, overflow: false, statusClosed: true };
  const gone = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  const options = { bootId: async () => 'boot-a', readStat: gone, scan: async () => [] };
  assert.equal((await verifyHostStop(capture, status, exit, options)).kind, 'confirmed');
  await assert.rejects(verifyHostStop(capture, status, exit, { ...options,
    bootId: async () => 'boot-b' }), { code: 'STOP_IDENTITY_INVALID' });
  await assert.rejects(verifyHostStop(capture, { child: 999, exit: 0 }, exit, options),
    { code: 'STOP_STATUS_INVALID' });
  await assert.rejects(verifyHostStop(capture, status, { ...exit, statusClosed: false }, options),
    { code: 'STOP_STATUS_INVALID' });
  await assert.rejects(verifyHostStop(capture, status, exit, { ...options,
    readStat: async pid => procStat(pid, { start: '99' }) }), { code: 'STOP_PID_REUSED' });
  await assert.rejects(verifyHostStop(capture, status, exit, { ...options,
    scan: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); } }),
    { code: 'EACCES' });
  // The member need not retain its original parent. Namespace membership is decisive.
  await assert.rejects(verifyHostStop(capture, status, exit, { ...options,
    scan: async () => [{ pid: 102, parent: 1, pidns: 'pid:[42]' }] }),
    { code: 'STOP_SURVIVOR' });
});

test('host association requires one init and native descendant in the pinned namespace', () => {
  const wrapper = { pid: 100, pidns: 'pid:[host]', netns: 'net:[host]' };
  const supervisor = { pid: 101, parent: 100, pidns: 'pid:[guest]', netns: 'net:[guest]',
    nspid: [101, 1], exe: '/runtime/node', start: '11' };
  const native = { pid: 102, parent: 101, pidns: 'pid:[guest]', netns: 'net:[guest]',
    nspid: [102, 7], exe: '/runtime/native', start: '12' };
  assert.equal(assertHostAssociation(wrapper, supervisor, [supervisor, native], '12', '/runtime/native', '/runtime/node').native.pid, 102);
  const reaper = { ...supervisor, pid: 103, nspid: [103, 1], exe: '/usr/bin/bwrap', start: '13' };
  const command = { ...supervisor, parent: 103, nspid: [101, 2] };
  assert.equal(assertHostAssociation(wrapper, reaper, [reaper, command, native], '12', '/runtime/native', '/runtime/node').init.pid, 103);
  for (const [child, members] of [
    [{ ...supervisor, parent: 1 }, [supervisor, native]],
    [supervisor, [native]],
    [supervisor, [supervisor, { ...native, parent: 1 }]],
    [supervisor, [supervisor, { ...native, netns: 'net:[host]' }]],
    [supervisor, [supervisor, native, { ...supervisor, pid: 103 }]],
  ]) assert.throws(() => assertHostAssociation(wrapper, child, members, '12', '/runtime/native', '/runtime/node'),
    { code: 'STOP_ASSOCIATION_INVALID' });
});

test('outer resume result checks the original durable identity and command scope', () => {
  const workspace = '/tmp/disposable/workspace';
  const home = '/mounts/home';
  const metadata = { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab', workspaceRoot: workspace,
    durableLogPath: `${home}/.local/share/muse/sessions/log.jsonl`, status: 'idle', turnCount: 0,
    activeTurnId: null, pendingCount: 0, history: 'none', viewCursor: '' };
  const shared = { nativeNamespace: 'net:[1]', guestNamespace: 'net:[1]',
    hostPort: 31001, guestPort: 31002,
    sentinel: { kind: 'error', code: 'ECONNREFUSED' }, external: { kind: 'error', code: 'ENETUNREACH' },
    canaries: { directAbsent: true, symlinkAbsent: true, procAbsent: true }, nativeCatalogGet: true,
    providerRequests: [{ method: 'GET', path: '/muse-code/models' }] };
  const first = { ...shared, kind: 'guest_transport_observed', metadata,
    directResponses: { attribution: 'direct_guest_client_text_only', status: 200 }, nativeTurnSubmitted: false,
    commands: ['session/start', 'session/read'], providerRequests: [...shared.providerRequests,
      { method: 'POST', path: '/responses', directMarker: true }] };
  const second = { ...shared, kind: 'guest_resume_observed', guestNamespace: 'net:[2]',
    nativeNamespace: 'net:[2]', metadata: { ...metadata }, resumeMetadata: { ...metadata },
    commands: ['session/resume', 'session/read'] };
  assert.equal(validateResumeOutcome(first, second, workspace, home).sessionId, metadata.sessionId);
  for (const variant of [{ metadata: { ...metadata, durableLogPath: `${home}/other` } },
    { metadata: { ...metadata, turnCount: 1 } }, { metadata: { ...metadata, viewCursor: null } },
    { hostPort: 32000 },
    { resumeMetadata: { ...metadata, turnCount: 1 } },
    { resumeMetadata: { ...metadata, pendingCount: 1 } },
    { resumeMetadata: { ...metadata, history: 'full' } },
    { sentinel: undefined }, { canaries: { a: true, b: true, c: true } },
    { commands: ['session/start', 'session/read'] },
    { providerRequests: [...second.providerRequests, { method: 'GET', path: '/unknown' }] },
    { providerRequests: [...second.providerRequests, { method: 'POST', path: '/responses' }] }]) {
    assert.throws(() => validateResumeOutcome(first, { ...second, ...variant }, workspace, home));
  }
});

test('uncertain first stop retains fixture and cannot launch a second host', async () => {
  let launches = 0;
  const guest = { kind: 'guest_transport_observed', nativeIdentity: { pid: 7, start: '123' },
    nativeNamespace: 'net:[2]', guestNamespace: 'net:[2]',
    hostPort: 30001, guestPort: 30002,
    sentinel: { kind: 'error', code: 'ECONNREFUSED' }, external: { kind: 'error', code: 'ENETUNREACH' },
    canaries: { directAbsent: true, symlinkAbsent: true, procAbsent: true }, nativeCatalogGet: true,
    commands: ['session/start', 'session/read'], nativeTurnSubmitted: false,
    directResponses: { attribution: 'direct_guest_client_text_only', status: 200 },
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      { method: 'POST', path: '/responses', directMarker: true }],
    metadata: { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab', workspaceRoot: '/tmp/disposable/workspace', history: 'none', activeTurnId: null,
      viewCursor: '',
      durableLogPath: '/mounts/home/.local/share/muse/sessions/log.jsonl', status: 'idle',
      turnCount: 0, pendingCount: 0 } };
  const result = await qualifyFreshHostResume({
    stage: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
    startSentinel: async () => ({ port: 30001, close: async () => undefined }),
    probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
    launch: (_prepared, config) => { launches++;
      guest.metadata.workspaceRoot = config.workspace;
      return { pid: 100, ready: Promise.resolve(guest), liveStatus: Promise.resolve({ child: 101, exit: null }),
        release: () => undefined, finished: Promise.resolve({ code: 0, signal: null, timedOut: false,
          overflow: false, statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'],
          output: [JSON.stringify({ kind: 'guest_ready', result: guest }), JSON.stringify(guest)] }) };
    },
    capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
      supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
    stop: async () => { throw Object.assign(new Error('incomplete scan'), { code: 'STOP_SCAN_INCOMPLETE' }); },
  });
  assert.equal(launches, 1);
  assert.equal(result.code, 'STOP_SCAN_INCOMPLETE');
  assert.equal(result.stopProof, 'unconfirmed');
  assert.equal(result.retainedFixtures.length, 1);
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('malformed first terminal output prevents the second launch even with declared stop', async () => {
  let launches = 0;
  const guest = { kind: 'guest_transport_observed', nativeIdentity: { pid: 7, start: '123' },
    nativeNamespace: 'net:[2]', guestNamespace: 'net:[2]',
    hostPort: 30001, guestPort: 30002,
    sentinel: { kind: 'error', code: 'ECONNREFUSED' }, external: { kind: 'error', code: 'ENETUNREACH' },
    canaries: { directAbsent: true, symlinkAbsent: true, procAbsent: true }, nativeCatalogGet: true,
    commands: ['session/start', 'session/read'], nativeTurnSubmitted: false,
    directResponses: { attribution: 'direct_guest_client_text_only', status: 200 },
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      { method: 'POST', path: '/responses', directMarker: true }],
    metadata: { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab', workspaceRoot: '/tmp/disposable/workspace', history: 'none', activeTurnId: null,
      viewCursor: '',
      durableLogPath: '/mounts/home/.local/share/muse/sessions/log.jsonl', status: 'idle',
      turnCount: 0, pendingCount: 0 } };
  const result = await qualifyFreshHostResume({
    stage: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
    startSentinel: async () => ({ port: 30001, close: async () => undefined }),
    probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
    launch: (_prepared, config) => { launches++;
      guest.metadata.workspaceRoot = config.workspace;
      return { pid: 100, ready: Promise.resolve(guest), liveStatus: Promise.resolve({ child: 101, exit: null }),
        release: () => undefined, finished: Promise.resolve({ code: 0, signal: null, timedOut: false,
          overflow: false, statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'],
          output: [JSON.stringify({ kind: 'guest_ready', result: guest }), '{'] }) };
    },
    capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
      supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
    stop: async () => ({ kind: 'confirmed', pidns: 'pid:[1]' }),
  });
  assert.equal(launches, 1);
  assert.equal(result.kind, 'fresh_host_idle_resume_error');
  assert.equal(result.stopProof, 'unconfirmed');
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('second-host readiness failure retains confirmed first-stop and both phase outputs', async () => {
  let launches = 0;
  const guest = { kind: 'guest_transport_observed', nativeIdentity: { pid: 7, start: '123' },
    nativeNamespace: 'net:[2]', guestNamespace: 'net:[2]', hostPort: 30001, guestPort: 30002,
    sentinel: { kind: 'error', code: 'ECONNREFUSED' }, external: { kind: 'error', code: 'ENETUNREACH' },
    canaries: { directAbsent: true, symlinkAbsent: true, procAbsent: true }, nativeCatalogGet: true,
    commands: ['session/start', 'session/read'], nativeTurnSubmitted: false,
    directResponses: { attribution: 'direct_guest_client_text_only', status: 200 },
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      { method: 'POST', path: '/responses', directMarker: true }],
    metadata: { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab',
      workspaceRoot: '', durableLogPath: '/mounts/home/.local/share/muse/sessions/log.jsonl',
      status: 'idle', turnCount: 0, activeTurnId: null, pendingCount: 0, history: 'none', viewCursor: '' } };
  const result = await qualifyFreshHostResume({
    stage: async root => {
      const runtime = join(root, 'runtime');
      const logs = join(root, 'home', '.local', 'share', 'muse', 'sessions');
      await mkdir(runtime);
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, 'log.jsonl'), 'fixture');
      return runtime;
    },
    startSentinel: async () => ({ port: 30001, close: async () => undefined }),
    probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
    launch: (_prepared, config) => {
      launches++;
      if (launches === 2) return { pid: 200,
        ready: Promise.reject(Object.assign(new Error('bad resume'), { code: 'GUEST_OUTPUT_INVALID' })),
        liveStatus: Promise.resolve({ child: 201, exit: null }), release: () => undefined,
        finished: Promise.resolve({ code: 1, signal: null, timedOut: false, overflow: false,
          statusClosed: true, statusLines: ['{"child-pid":201}', '{"exit-code":1}'],
          output: ['{"kind":"guest_transport_error","code":"INVALID_SESSION_READ"}'], stderr: '' }) };
      guest.metadata.workspaceRoot = config.workspace;
      return { pid: 100, ready: Promise.resolve(guest), liveStatus: Promise.resolve({ child: 101, exit: null }),
        release: () => undefined, finished: Promise.resolve({ code: 0, signal: null, timedOut: false,
          overflow: false, statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'],
          output: [JSON.stringify({ kind: 'guest_ready', result: guest }), JSON.stringify(guest)], stderr: '' }) };
    },
    capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
      supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
    stop: async () => ({ kind: 'confirmed', pidns: 'pid:[first]', boot: 'boot-a' }),
  });
  assert.equal(launches, 2);
  assert.equal(result.kind, 'fresh_host_idle_resume_error');
  assert.equal(result.evidence.firstStop.kind, 'confirmed');
  assert.equal(result.evidence.firstCompletion.code, 0);
  assert.equal(result.evidence.secondCompletion.code, 1);
  assert.equal(result.evidence.secondCompletion.output[0].includes('INVALID_SESSION_READ'), true);
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('native shell provider checks advertised bash schema and exact tool result correlation', async () => {
  assert.equal(diagnosticMode([]), 'idle-resume');
  assert.equal(diagnosticMode(['--native-shell']), 'native-shell');
  for (const args of [['--unknown'], ['--native-shell', '--extra']]) {
    assert.throws(() => diagnosticMode(args), { code: 'DIAGNOSTIC_MODE_INVALID' });
  }
  const command = shellProbeCommand('/tmp/fixture/workspace', '/tmp/fixture/protected', 'protected-canary');
  assert.match(command, /shell-canary/);
  assert.match(command, /dummy-auth=visible/);
  assert.match(command, /\/mounts\/home\/\.config\/muse\/auth\.json/);
  const tool = { type: 'function', name: 'bash', parameters: { type: 'object',
    properties: { command: { type: 'string' } }, required: ['command'] } };
  assert.deepEqual(advertisedBash({ model: 'fixture-native-shell', tools: [tool], fixtureCommand: command }),
    { name: 'bash', arguments: { command } });
  for (const malformed of [
    { ...tool, name: 'shell' },
    { ...tool, parameters: { ...tool.parameters, required: ['command', 'unknown'] } },
    { ...tool, parameters: { ...tool.parameters, properties: { command: { type: 'number' } } } },
    { ...tool, parameters: { ...tool.parameters, properties: { command: { type: 'string', enum: ['different'] } } } },
    { ...tool, parameters: { ...tool.parameters, not: {} } },
  ]) assert.throws(() => advertisedBash({ model: 'fixture-native-shell', tools: [malformed], fixtureCommand: command }),
    { code: 'NATIVE_TOOL_SCHEMA_INVALID' });
  const result = { input: [{ type: 'function_call_output', call_id: 'call_native_shell_1',
    output: 'workspace=ok\ndirect=denied\nsymlink=denied\nproc=denied\ndummy-auth=visible\n' }] };
  assert.equal(matchingShellResult(result), true);
  assert.deepEqual(shellOutputMarkers(result.input[0].output), { workspaceWritten: true, dummyAuthVisible: true });
  assert.deepEqual(shellOutputMarkers(result.input[0].output.replace('workspace=ok', 'workspace=failed')),
    { workspaceWritten: false, dummyAuthVisible: true });
  assert.equal(matchingShellResult({ input: [{ ...result.input[0], call_id: 'wrong' }] }), false);
  assert.equal(matchingShellResult({ input: [{ ...result.input[0], output: 'workspace=ok' }] }), false);
  assert.equal(matchingShellResult({ input: [{ ...result.input[0],
    output: result.input[0].output.replace('dummy-auth=visible', 'dummy-auth=leaked') }] }), false);
  assert.equal(matchingShellResult({ input: [result.input[0], { type: 'function_call_output',
    call_id: 'unrelated', output: result.input[0].output }] }), false);
  for (const extra of ['direct=visible\n', 'symlink=visible\n', 'proc=visible\n', 'unknown=extra\n', 'direct=denied\n']) {
    assert.equal(shellOutputMarkers(result.input[0].output + extra), null);
  }
});

test('rejected native tool schema retains bounded structure without values', () => {
  const secret = 'passeur-secret-description-and-argument';
  const secretKey = 'sk_test_12345_SUPPOSED_SECRET';
  const body = { input: [{ text: secret }], tools: [{ type: 'function', name: 'bash',
    description: secret, parameters: { type: 'object', not: { secret },
      properties: { command: { type: 'string', description: secret, enum: [secret] },
        [secretKey]: { type: 'string' } },
      required: ['command', secretKey] } }] };
  const shape = rejectedToolSchemaShape(body);
  assert.equal(shape.toolCount, 1);
  assert.equal(shape.tools[0].bashName, true);
  assert.equal(shape.tools[0].toolNameClass, 'bash');
  assert.equal(shape.tools[0].toolNameSha256, null);
  assert.deepEqual(shape.tools[0].parameterFields.find(([key]) => key === 'not'), ['not', 'object']);
  assert.deepEqual(shape.tools[0].properties[0].fields.find(([key]) => key === 'enum'), ['enum', 'array']);
  assert.equal(JSON.stringify(shape).includes(secret), false);
  assert.equal(JSON.stringify(shape).includes(secretKey), false);
  assert.equal(shape.tools[0].properties[1].name, '[other]');
  assert.equal(shape.tools[0].required[1], '[other]');
  assert.equal(summarizedShellModel('fixture-native-shell'), 'fixture-native-shell');
  assert.equal(summarizedShellModel({ secret }), 'invalid');
  assert.equal(summarizedShellModel(secret), 'invalid');
  const large = { tools: Array(8).fill(null).map((_, index) => ({ ...body.tools[0],
    parameters: { ...body.tools[0].parameters, properties: Object.fromEntries(
      Array.from({ length: 50 }, (_, number) => [`${secretKey}_${index}_${number}`,
        { type: 'string', description: secret.repeat(2) }])) } })) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 60_000);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65_536);
  const bounded = rejectedToolSchemaShape(large);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4_096);
  assert.ok(bounded.omitted.properties > 0);
  assert.equal(JSON.stringify(bounded).includes(secretKey), false);
  const unknownName = rejectedToolSchemaShape({ tools: [{ type: 'function', name: secretKey,
    input_schema: [], inputSchema: {}, schema: {}, capabilities: [], [secretKey]: [] }] });
  assert.equal(unknownName.tools[0].toolNameClass, 'other');
  assert.equal(unknownName.tools[0].toolNameLength, Buffer.byteLength(secretKey));
  assert.equal(unknownName.tools[0].toolNameSha256, createHash('sha256').update(secretKey).digest('hex'));
  assert.deepEqual(unknownName.tools[0].toolFields.slice(2, 6),
    [['input_schema', 'array'], ['inputSchema', 'object'], ['schema', 'object'], ['capabilities', 'array']]);
  assert.equal(JSON.stringify(unknownName).includes(secretKey), false);
  const grouped = rejectedToolSchemaShape({ tools: [{ type: 'muse', name: 'muse',
    description: secret, functions: [{ type: 'function', name: 'bash',
      description: secret, input_schema: { type: 'object' }, parameters: { type: 'object',
        properties: { command: { type: 'string', description: secret },
          [secretKey]: { type: 'string', enum: [secret] } },
        required: ['command', secretKey], additionalProperties: false } },
    { type: 'function', name: secretKey, [secretKey]: secret }] }] });
  assert.equal(grouped.tools[0].toolNameClass, 'muse');
  assert.equal(grouped.tools[0].toolTypeClass, 'muse');
  assert.equal(grouped.tools[0].arrayFields[0].key, 'functions');
  assert.equal(grouped.tools[0].arrayFields[0].count, 2);
  assert.equal(grouped.tools[0].arrayFields[0].entries[0].nameClass, 'bash');
  assert.deepEqual(grouped.tools[0].arrayFields[0].entries[0].fields.find(([key]) => key === 'input_schema'),
    ['input_schema', 'object']);
  const nested = grouped.tools[0].arrayFields[0].entries[0];
  assert.deepEqual(nested.parameterFields.find(([key]) => key === 'additionalProperties'),
    ['additionalProperties', 'boolean']);
  assert.equal(nested.propertyCount, 2);
  assert.equal(nested.properties[0].name, 'command');
  assert.equal(nested.properties[1].name, '[other]');
  assert.deepEqual(nested.required, ['command', '[other]']);
  assert.equal(grouped.tools[0].arrayFields[0].entries[1].nameClass, 'other');
  assert.equal(JSON.stringify(grouped).includes(secret), false);
  assert.equal(JSON.stringify(grouped).includes(secretKey), false);
  const manyGroups = rejectedToolSchemaShape({ tools: Array(8).fill(null).map(() => ({ type: 'muse',
    name: 'muse', functions: Array(12).fill(null).map(() => ({ type: 'function', name: 'bash',
      input_schema: {}, description: secret, [secretKey]: secret })) })) });
  assert.ok(Buffer.byteLength(JSON.stringify(manyGroups)) <= 4_096);
  assert.ok(manyGroups.omitted.arrayEntries > 0);
  assert.equal(JSON.stringify(manyGroups).includes(secretKey), false);
});

function shellReadyFixture(workspace) {
  const commandSha256 = createHash('sha256').update(shellProbeCommand(workspace,
    join(workspace, '..', 'protected'), 'protected-canary')).digest('hex');
  return { kind: 'guest_shell_ready', hostPort: 31001, guestPort: 31002,
    commandSha256,
    guestNamespace: 'net:[2]', nativeNamespace: 'net:[2]', nativeIdentity: { pid: 7, start: '123' },
    sentinel: { kind: 'error', code: 'ECONNREFUSED' }, external: { kind: 'error', code: 'ENETUNREACH' },
    canaries: { directAbsent: true, symlinkAbsent: true, procAbsent: true },
    posture: { approvalMode: 'onRequest', modelId: 'fixture-native-shell', providerId: 'meta',
      sandbox: 'native_default_no_override' },
    metadata: { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab', workspaceRoot: workspace,
      status: 'idle', turnCount: 0, activeTurnId: null, pendingCount: 0, history: 'none', viewCursor: '' },
    commands: ['session/start', 'session/read'],
    providerRequests: [{ method: 'GET', path: '/muse-code/models' }] };
}

function shellOutcomeFixture(ready, approval = false, workspaceReportedWritten = true) {
  const turnId = '0199aabb-ccdd-7eef-8abc-0123456789ac';
  const approvalValue = { approvalId: 'approval-1', sessionId: ready.metadata.sessionId,
    turnId, toolCallId: 'call_native_shell_1', toolName: 'bash', commandMatch: true,
    requirementId: { approvalId: 'approval-1', sourceIndex: 1 },
    choices: [{ choiceId: 'deny', decision: 'denied', scope: 'once', label: 'Deny' }] };
  return { kind: approval ? 'native_shell_approval_pending' : 'guest_shell_outcome',
    sessionId: ready.metadata.sessionId, turnId,
    turnAck: { status: 'accepted', disposition: 'started', startedNewTurn: true },
    commands: ['session/start', 'session/read', 'turn/start'],
    event: approval ? { kind: 'approval', approval: approvalValue } :
      { kind: 'turn_completed', terminal: 'completed', turnId, sessionId: ready.metadata.sessionId },
    pending: approval ? { approvals: [approvalValue], userInputs: [] } : null,
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      { method: 'POST', path: '/responses', kind: 'native_tool_call', model: 'fixture-native-shell',
        responseId: 'resp_native_shell_1', itemId: 'fc_native_shell_1', callId: 'call_native_shell_1',
        commandSha256: ready.commandSha256 },
      ...approval ? [] : [{ method: 'POST', path: '/responses', kind: 'matching_tool_result',
        model: 'fixture-native-shell', responseId: 'resp_native_shell_2', forCallId: 'call_native_shell_1' }]],
    observations: { approvals: approval ? [approvalValue] : [], protocolErrors: [],
      items: approval ? [] : [{ itemId: 'item-1', turnId, callId: 'call_native_shell_1',
        tool: 'bash', status: 'completed', commandMatch: true, outputMarkers: true,
        dummyAuthVisible: false, workspaceReportedWritten }] } };
}

test('native shell outcome rejects wrong turn, extra provider call and unanswered approval mismatch', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  validateShellReady(ready, ready.metadata.workspaceRoot, 31001);
  assert.equal(validateShellOutcome(ready, shellOutcomeFixture(ready)).kind, 'native_shell_effect_observed');
  assert.equal(validateShellOutcome(ready, shellOutcomeFixture(ready, false, false)).kind,
    'native_shell_denial_observed');
  assert.equal(validateShellOutcome(ready, shellOutcomeFixture(ready, true)).kind, 'native_shell_approval_pending');
  assert.throws(() => validateShellReady({ ...ready, hostPort: 32000 }, ready.metadata.workspaceRoot, 31001),
    { code: 'NATIVE_SHELL_READY_INVALID' });
  assert.throws(() => validateShellReady({ ...ready, commandSha256: 'bad' }, ready.metadata.workspaceRoot, 31001),
    { code: 'NATIVE_SHELL_READY_INVALID' });
  for (const variant of [
    { event: { kind: 'turn_completed', terminal: 'completed', turnId: 'wrong', sessionId: ready.metadata.sessionId } },
    { providerRequests: [...shellOutcomeFixture(ready).providerRequests, { method: 'POST', path: '/responses' }] },
    { observations: { ...shellOutcomeFixture(ready).observations, items: [{ ...shellOutcomeFixture(ready).observations.items[0], callId: 'wrong' }] } },
    { providerRequests: shellOutcomeFixture(ready).providerRequests.map(request =>
      request.kind === 'native_tool_call' ? { ...request, commandSha256: '0'.repeat(64) } : request) },
  ]) assert.throws(() => validateShellOutcome(ready, { ...shellOutcomeFixture(ready), ...variant }),
    { code: 'NATIVE_SHELL_OUTCOME_INVALID' });
  assert.throws(() => validateShellOutcome(ready, { ...shellOutcomeFixture(ready, true),
    pending: { approvals: [], userInputs: [] } }), { code: 'NATIVE_APPROVAL_INVALID' });
});

test('native shell controller verifies effects and requires stop even for pending approval', async () => {
  const run = async ({ approval = false, writeShell = false, stopFails = false,
    workspaceReportedWritten = true, dummyAuthVisible = false } = {}) => {
    const result = await qualifyNativeShell({
      stage: async root => {
        const runtime = join(root, 'runtime');
        await mkdir(runtime);
        if (writeShell) await writeFile(join(root, 'workspace', 'shell-canary'), 'native-write');
        return runtime;
      },
      startSentinel: async () => ({ port: 31001, close: async () => undefined }),
      probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
      launch: (_prepared, config) => {
        const ready = shellReadyFixture(config.workspace);
        const outcome = shellOutcomeFixture(ready, approval, workspaceReportedWritten);
        if (!approval) outcome.observations.items[0].dummyAuthVisible = dummyAuthVisible;
        return { pid: 100, ready: Promise.resolve(ready),
          liveStatus: Promise.resolve({ child: 101, exit: null }), outcome: Promise.resolve(outcome),
          releaseTurn: () => undefined, releaseShutdown: () => undefined, abort: () => undefined,
          finished: Promise.resolve({ code: 0, signal: null, timedOut: false, overflow: false,
            statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'], stderr: '',
            output: [JSON.stringify({ kind: 'guest_ready', result: ready }),
              JSON.stringify({ kind: 'guest_outcome', result: outcome }), JSON.stringify(outcome)] }) };
      },
      capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
        supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
      stop: async () => {
        if (stopFails) throw Object.assign(new Error('survivor'), { code: 'STOP_SURVIVOR' });
        return { kind: 'confirmed', pidns: 'pid:[1]' };
      },
    });
    await rm(result.retainedFixtures[0], { recursive: true, force: true });
    return result;
  };
  assert.equal((await run({ writeShell: true })).kind, 'native_shell_effect_observed');
  assert.equal((await run()).code, 'NATIVE_SHELL_EFFECT_INVALID');
  assert.equal((await run({ workspaceReportedWritten: false })).kind, 'native_shell_denial_observed');
  assert.equal((await run({ workspaceReportedWritten: false, writeShell: true })).code,
    'NATIVE_SHELL_EFFECT_INVALID');
  assert.equal((await run({ writeShell: true, dummyAuthVisible: true })).code,
    'NATIVE_SHELL_AUTH_VISIBLE');
  const pending = await run({ approval: true });
  assert.equal(pending.kind, 'native_shell_approval_pending');
  assert.equal(pending.evidence.guestOutcome.pending.approvals.length, 1);
  assert.equal((await run({ approval: true, writeShell: true })).code, 'NATIVE_SHELL_EFFECT_INVALID');
  const uncertain = await run({ writeShell: true, stopFails: true });
  assert.equal(uncertain.code, 'STOP_SURVIVOR');
  assert.equal(uncertain.stopProof, 'unconfirmed');
});

test('early shell child failure settles an unread bounded outcome without unhandled rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-shell-early-exit-'));
  try {
    const fake = join(root, 'fake-bwrap');
    await writeFile(fake, '#!/bin/sh\nprintf \'{"child-pid":123}\\n\' >&3\nprintf \'{"kind":"guest_transport_error"}\\n\'\nexit 1\n',
      { mode: 0o700 });
    const host = runStatusPhase({ executable: fake, args: ['--', 'ignored'] }, { phase: 'shell' });
    await assert.rejects(host.ready, { code: 'GUEST_OUTPUT_INVALID' });
    assert.equal((await host.liveStatus).child, 123);
    assert.equal((await host.finished).code, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});
