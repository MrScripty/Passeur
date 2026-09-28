import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { assertNoTurn, assertPortSeparation, classifyNoRoute, guestCommand, guestEnvironment,
  pinnedBinary, pinnedNode, qualify, retainHostRoot, sandboxConfig, stageRuntime, validateIdleRead,
  verifiedNativeNamespace, loopbackReady, parseBubblewrapStatus, verifyHostStop,
  validateResumeOutcome, qualifyFreshHostResume,
  assertHostAssociation,
  matchingShellResult, shellOutputMarkers, shellProbeCommand,
  rejectedToolSchemaShape, summarizedShellModel, recognizedReminderSchema, decodeShellOutcomeLine,
  startShellProvider, mainSchemaDiscovery, readFileSchemaDiscovery,
  verificationReminderSchemaDiscovery, verificationReminderAssociation,
  fixedVerificationPayload, fixedReadFileCall, readFileCallEvents,
  matchingReadFileResult, readFileDecoratedOutput, readFileResultEnvelopeShape,
  correlatedReadFileOutput, classifyProtectedOutput, protectedReadPath,
  qualifyNativeProtectedRead, qualifyNativeProtectedSymlinkRead, qualifyNativeProtectedProcRead,
  fixedBashCall, bashCallEvents, shellTextEvents,
  shellResultEnvelopeShape,
  fixedNoReminderPayload, reminderCallEvents,
  approvalSummary, validateShellReady, validateShellOutcome, validateReadFileSchemaOutcome,
  validateReadFileOutcome, qualifyNativeShell, qualifyNativeReadFileSchema, qualifyNativeReadFile,
  classifyDurableApprovalLog, readDurableApprovalLog,
  heldApprovalPresentation, validateHeldDecision, validateHeldInitialApproval, submitHeldDecision,
  validateHeldHandoff, validateHeldShellOutcome, qualifyNativeShellHeld, readHeldCliDecision,
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
  assert.equal(diagnosticMode(['--native-shell-held']), 'native-shell-held');
  assert.equal(diagnosticMode(['--native-read-file-schema']), 'native-read-file-schema');
  assert.equal(diagnosticMode(['--native-read-file']), 'native-read-file');
  assert.equal(diagnosticMode(['--native-protected-read']), 'native-protected-read');
  assert.equal(diagnosticMode(['--native-protected-read-symlink']), 'native-protected-read-symlink');
  assert.equal(diagnosticMode(['--native-protected-read-proc']), 'native-protected-read-proc');
  for (const args of [['--unknown'], ['--native-shell', '--extra']]) {
    assert.throws(() => diagnosticMode(args), { code: 'DIAGNOSTIC_MODE_INVALID' });
  }
  const command = shellProbeCommand('/tmp/fixture/workspace', '/tmp/fixture/protected', 'protected-canary');
  assert.match(command, /shell-canary/);
  assert.match(command, /dummy-auth=visible/);
  assert.match(command, /\/mounts\/home\/\.config\/muse\/auth\.json/);
  const result = { model: 'fixture-native-shell', previous_response_id: 'resp_native_shell_1',
    input: [{ type: 'function_call_output', call_id: 'call_native_shell_1',
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
  assert.equal(matchingShellResult({ ...result, input: [{ ...result.input[0], extra: 'unknown' }] }), false);
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

test('recognized reminder prelude records only its seven-field schema and never a payload', () => {
  const secret = 'secret-prompt-and-default-value';
  const properties = { decision: { type: 'string', enum: ['none', 'remind'], description: secret },
    reason: { type: ['string', 'null'], minLength: 0, maxLength: 120, default: secret },
    next_step: { anyOf: [{ type: 'string' }, { type: 'null' }], description: secret },
    detail: { type: 'string' }, code: { type: 'integer', minimum: 0, maximum: 10 },
    flag: { type: 'boolean' }, tags: { type: 'array', minItems: 0, maxItems: 3 } };
  const tool = { type: 'namespace', name: 'muse', tools: [{ type: 'function',
    name: 'submit_reminder_decision', description: secret, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties),
      additionalProperties: false } }] };
  const body = { model: 'fixture-native-shell', input: secret, tools: [tool] };
  const summary = recognizedReminderSchema(body);
  assert.equal(summary.function, 'submit_reminder_decision');
  assert.deepEqual(summary.required, Object.keys(properties));
  assert.deepEqual(summary.properties.find(property => property.name === 'decision').enum, ['none', 'remind']);
  assert.deepEqual(summary.properties.find(property => property.name === 'reason').types, ['string', 'null']);
  assert.equal(summary.properties.find(property => property.name === 'reason').nullable, true);
  assert.deepEqual(summary.properties.find(property => property.name === 'code').bounds,
    { minimum: 0, maximum: 10 });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 4_096);
  assert.equal(recognizedReminderSchema({ ...body, tools: [{ ...tool, name: 'wrong' }] }), null);
  assert.equal(recognizedReminderSchema({ ...body, tools: [{ ...tool, tools: [{ ...tool.tools[0], name: 'wrong' }] }] }), null);
  assert.throws(() => recognizedReminderSchema({ ...body, tools: [{ ...tool, tools: [{ ...tool.tools[0],
    parameters: { ...tool.tools[0].parameters, required: [...Object.keys(properties).slice(0, 6), 'unknown'] } }] }] }),
  { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
});

function fixedReminderRequest() {
  const properties = {
    advisory_text: { type: ['null', 'string'] },
    confidence: { type: ['null', 'string'], enum: ['low', 'medium', 'high'] },
    decision: { type: 'string', enum: ['remind', 'none'] },
    priority: { type: ['null', 'string'], enum: ['low', 'normal', 'high'] },
    reason: { type: 'string' }, skill_id: { type: ['null', 'string'] },
    visible_for_steps: { type: ['null', 'integer'], minimum: 1, maximum: 8 },
  };
  return { model: 'fixture-native-shell', input: 'NATIVE_SHELL_PROBE', tools: [{ type: 'namespace',
    name: 'muse', tools: [{ type: 'function', name: 'submit_reminder_decision', strict: true,
      parameters: { type: 'object', properties, required: Object.keys(properties),
        additionalProperties: false } }] }] };
}

test('fixed reminder payload is schema bound and its six SSE events preserve namespace identities', () => {
  const body = fixedReminderRequest();
  const payload = fixedNoReminderPayload(body);
  assert.deepEqual(payload, { advisory_text: null, confidence: 'low', decision: 'none',
    priority: 'normal', reason: 'Disposable scripted protocol probe; no skill reminder is being proposed.',
    skill_id: null, visible_for_steps: 1 });
  const events = reminderCallEvents(payload);
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.added',
    'response.function_call_arguments.delta', 'response.function_call_arguments.done',
    'response.output_item.done', 'response.completed']);
  assert.equal(events[1].item.namespace, 'muse');
  assert.equal(events[1].item.name, 'submit_reminder_decision');
  assert.equal(events[1].item.call_id, events[4].item.call_id);
  assert.equal(events[2].delta, events[3].arguments);
  assert.equal(events[3].arguments, events[4].item.arguments);
  assert.equal(events[5].response.output[0].id, events[1].item.id);
  assert.throws(() => fixedNoReminderPayload({ ...body, tools: [{ ...body.tools[0],
    tools: [{ ...body.tools[0].tools[0], name: 'wrong' }] }] }),
  { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const drift = fixedReminderRequest();
  drift.tools[0].tools[0].parameters.properties.confidence.enum = ['null', 'low'];
  assert.throws(() => fixedNoReminderPayload(drift), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const hiddenConstraint = fixedReminderRequest();
  hiddenConstraint.tools[0].tools[0].parameters.properties.reason.pattern = '^x$';
  assert.throws(() => fixedNoReminderPayload(hiddenConstraint), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const contradictory = fixedReminderRequest();
  contradictory.tools[0].tools[0].parameters.properties.advisory_text.anyOf = [{ type: 'string' }];
  assert.throws(() => fixedNoReminderPayload(contradictory), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const unknownType = fixedReminderRequest();
  unknownType.tools[0].tools[0].parameters.properties.advisory_text.type.push('UNREVIEWED_TYPE');
  assert.throws(() => fixedNoReminderPayload(unknownType), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const duplicateType = fixedReminderRequest();
  duplicateType.tools[0].tools[0].parameters.properties.advisory_text.type.push('string');
  assert.throws(() => fixedNoReminderPayload(duplicateType), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
});

function mainNativeRequest() {
  return { model: 'fixture-native-shell', input: 'NATIVE_SHELL_PROBE', tools: [{
    type: 'namespace', name: 'muse', tools: Array.from({ length: 25 }, (_, index) => ({
      type: 'function', name: index === 11 ? 'bash' : index === 12 ? 'bash_input' : `native_${index}`,
      ...(index === 11 ? { strict: false } : {}),
      parameters: { ...(index === 11 ? { additionalProperties: false } : {}),
        properties: index === 11 ? { command: { type: 'string' }, description: { type: 'string' },
          login: { type: 'boolean' }, max_output_tokens: { minimum: 1, type: 'integer' },
          sandbox_permissions: { enum: ['use_default', 'require_escalated'], type: 'string' },
          shell: { type: 'string' }, timeout_ms: { minimum: 1, type: 'integer' },
          tty: { type: 'boolean' }, workdir: { type: 'string' },
          yield_time_ms: { minimum: 0, type: 'integer' } } : { value: { type: 'string' } },
        required: index === 11 ? ['command', 'description'] : ['value'], type: 'object',
        ...(index === 11 ? {} : { additionalProperties: false }) },
    })) }] };
}

function readFileNativeRequest() {
  const body = mainNativeRequest();
  body.input = 'NATIVE_READ_FILE_SCHEMA_PROBE';
  body.tools[0].tools[1] = { type: 'function', name: 'read_file', strict: false,
    parameters: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, offset: { type: ['integer', 'null'], minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['path'] } };
  body.tools[0].tools[2].name = 'read_memory';
  body.tools[0].tools[3].name = 'read_skill';
  body.tools[0].tools[4].name = 'write_file';
  return body;
}

function verificationReminderRequest() {
  const body = fixedReminderRequest();
  body.input = 'NATIVE_READ_FILE_SCHEMA_PROBE';
  body.tools[0].tools[0].strict = false;
  body.tools[0].tools[0].parameters = { type: 'object', additionalProperties: false,
    properties: { decision: { type: 'string', enum: ['none', 'verify'] },
      reason: { type: ['string', 'null'], maxLength: 120 },
      confidence: { type: 'integer', minimum: 0, maximum: 10 } },
    required: ['decision', 'reason', 'confidence'] };
  return body;
}

function readFileProbeRequest() {
  const body = readFileNativeRequest();
  body.input = 'NATIVE_READ_FILE_PROBE';
  body.tools[0].tools[1].parameters = { type: 'object', additionalProperties: false,
    properties: { limit: { maximum: 2000, minimum: 1, type: 'integer' },
      offset: { minimum: 1, type: 'integer' }, path: { type: 'string' } },
    required: ['path'] };
  return body;
}

function verifiedVerificationRequest() {
  const body = verificationReminderRequest();
  body.tools[0].tools[0].strict = true;
  body.tools[0].tools[0].parameters = { type: 'object', additionalProperties: false,
    properties: { decision: { enum: ['remind', 'none'], type: 'string' },
      next_step: { type: ['null', 'string'] }, reason: { type: ['null', 'string'] } },
    required: ['decision', 'next_step', 'reason'] };
  return body;
}

function readFileResultRequest(output =
  'Read text file `/tmp/fixture/workspace/read-canary.txt`.\n1|PASSEUR_NATIVE_READ_CANARY') {
  return { model: 'fixture-native-shell', tools: readFileProbeRequest().tools, input: [
    { type: 'message', role: 'developer', content: 'fixed test developer content' },
    { type: 'message', role: 'user', content: 'fixed test user content' },
    { type: 'function_call', id: 'fc_native_read_file_1', call_id: 'call_native_read_file_1',
      name: 'muse.read_file', arguments: JSON.stringify({
        path: '/tmp/fixture/workspace/read-canary.txt', offset: 1, limit: 20 }) },
    { type: 'function_call_output', call_id: 'call_native_read_file_1', output },
  ] };
}

function installedProtectedError(path, workspace) {
  return `tool failed: No such file or directory (os error 2); requested absolute path "${path}"; ` +
    `resolved candidate "${path}"; Active Workspace Root "${workspace}". ` +
    'Relative paths resolve from the Active Workspace Root. Shell `cd`/`workdir` affects only that shell call ' +
    'and does not change this root. Absolute paths may be used only when the current filesystem policy allows them.';
}

test('protected result classifier keeps marker host-side and distinguishes only path-attributable denial', () => {
  const path = '/tmp/owned/protected/direct-read-target.txt';
  const workspace = '/tmp/owned/workspace';
  const marker = 'PASSEUR_PROTECTED_SYNTHETIC_SECRET';
  const exact = installedProtectedError(path, workspace);
  const installedRoot = '/tmp/passeur-muse-protected-read-F923Wy';
  const installed = installedProtectedError(join(installedRoot, 'protected', 'direct-read-target.txt'),
    join(installedRoot, 'workspace'));
  assert.equal(Buffer.byteLength(installed), 538);
  assert.equal(createHash('sha256').update(installed).digest('hex'),
    'f62b5c40ee913caf8e8229befbbc5ffa20038f7fe4d3eabc5f86b1c3d35d1b7b');
  const denied = classifyProtectedOutput(exact, path, workspace, marker);
  assert.equal(denied.class, 'not_found');
  assert.equal(denied.markerPresent, false);
  assert.equal(JSON.stringify(denied).includes(marker), false);
  assert.equal(classifyProtectedOutput(`Read text file \`${path}\`.\n1|${marker}`,
    path, workspace, marker).class,
    'marker_exposed');
  assert.equal(classifyProtectedOutput(`${exact}${marker}`, path, workspace, marker).class,
    'marker_exposed');
  for (const raw of ['Permission denied', exact.slice(13), `${exact}\n`,
    exact.replace('(os error 2)', '(os error 13)'),
    exact.replace(`requested absolute path "${path}"`, 'requested absolute path "/tmp/other"'),
    exact.replace(`resolved candidate "${path}"`, 'resolved candidate "/tmp/other"'),
    exact.replace(`Active Workspace Root "${workspace}"`, 'Active Workspace Root "/tmp/other"')]) {
    assert.equal(classifyProtectedOutput(raw, path, workspace, marker).class, 'unknown');
  }
  assert.throws(() => classifyProtectedOutput('x'.repeat(8193), path, workspace, marker),
    { code: 'NATIVE_PROTECTED_OUTPUT_INVALID' });
  const result = readFileResultRequest();
  result.input[2].arguments = JSON.stringify({ path, offset: 1, limit: 20 });
  result.input[3].output = exact;
  assert.equal(correlatedReadFileOutput(result, path), result.input[3].output);
  result.input[2].name = 'muse.bash';
  assert.equal(correlatedReadFileOutput(result, path), null);
});

test('protected route selector binds distinct requested paths and exact candidate diagnostics', () => {
  const workspace = '/tmp/owned/workspace';
  const root = '/tmp/owned/protected';
  const direct = `${root}/direct-read-target.txt`;
  const symlinkPath = `${workspace}/protected-link/direct-read-target.txt`;
  const procPath = `/proc/1/root${direct}`;
  assert.equal(protectedReadPath('direct', workspace, root), direct);
  assert.equal(protectedReadPath('symlink', workspace, root), symlinkPath);
  assert.equal(protectedReadPath('proc', workspace, root), procPath);
  assert.throws(() => protectedReadPath('foreign', workspace, root),
    { code: 'NATIVE_PROTECTED_ROUTE_INVALID' });
  const marker = 'PASSEUR_PROTECTED_SYNTHETIC_SECRET';
  for (const path of [symlinkPath, procPath]) {
    assert.equal(classifyProtectedOutput(installedProtectedError(path, workspace),
      path, workspace, marker).class, 'not_found');
    assert.equal(classifyProtectedOutput(installedProtectedError(path, workspace).replace(
      `resolved candidate "${path}"`, `resolved candidate "${direct}"`),
    path, workspace, marker).class, 'unknown');
    assert.equal(classifyProtectedOutput(installedProtectedError(path, workspace),
      direct, workspace, marker).class, 'unknown');
  }
});

test('protected provider accepts one fixed read and returns neutral text without echoing raw output', async () => {
  const targetPath = '/tmp/fixture/protected/direct-read-target.txt';
  const marker = 'PASSEUR_PROTECTED_SYNTHETIC_SECRET';
  const h = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath,
      '/tmp/fixture/workspace', marker).class });
  try {
    const main = readFileProbeRequest();
    main.input = 'NATIVE_PROTECTED_READ_PROBE';
    assert.equal((await h.post(main)).status, 200);
    const result = readFileResultRequest();
    result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
    const response = await h.post(result);
    assert.equal(response.status, 200);
    assert.equal(response.body.includes(marker), false);
    assert.equal(JSON.stringify(h.provider.requests).includes(marker), false);
    assert.equal(h.provider.requests[1].kind, 'matching_protected_read_result');
    assert.equal((await h.post(result)).status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_REQUEST_UNCLASSIFIED');
  } finally { await h.provider.close(); }
  const rejected = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath,
      '/tmp/fixture/workspace', marker).class });
  try {
    const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
    assert.equal((await rejected.post(main)).status, 200);
    const foreign = readFileResultRequest();
    foreign.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    foreign.input[2].name = 'muse.bash';
    foreign.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
    assert.equal((await rejected.post(foreign)).status, 422);
    assert.equal(rejected.provider.state.primaryCode, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
  } finally { await rejected.provider.close(); }
  const exposed = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath,
      '/tmp/fixture/workspace', marker).class });
  try {
    const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
    assert.equal((await exposed.post(main)).status, 200);
    const result = readFileResultRequest();
    result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    result.input[3].output = `Read text file \`${targetPath}\`.\n1|${marker}`;
    assert.equal((await exposed.post(result)).status, 422);
    assert.equal(exposed.provider.state.primaryCode, 'NATIVE_PROTECTED_MARKER_EXPOSED');
    assert.equal(JSON.stringify(exposed.provider.requests).includes(marker), false);
  } finally { await exposed.provider.close(); }
  const bounded = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath,
      '/tmp/fixture/workspace', marker).class });
  try {
    const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
    assert.equal((await bounded.post(main)).status, 200);
    const result = readFileResultRequest();
    result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
    assert.equal((await bounded.post(result)).status, 200);
    const skill1 = fixedReminderRequest(); skill1.input = 'NATIVE_PROTECTED_READ_PROBE first skill';
    const skill2 = fixedReminderRequest(); skill2.input = 'NATIVE_PROTECTED_READ_PROBE second skill';
    const verify = verifiedVerificationRequest(); verify.input = 'NATIVE_PROTECTED_READ_PROBE verify';
    assert.equal((await bounded.post(skill1)).status, 200);
    assert.equal((await bounded.post(verify)).status, 200);
    assert.equal((await bounded.post(skill2)).status, 200);
    assert.equal((await bounded.post(skill2)).status, 429);
    assert.equal(bounded.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 2);
  } finally { await bounded.provider.close(); }
});

test('symlink and proc providers issue one selected read path and reject route substitution', async () => {
  const workspace = '/tmp/fixture/workspace';
  const root = '/tmp/fixture/protected';
  for (const route of ['symlink', 'proc']) {
    const targetPath = protectedReadPath(route, workspace, root);
    const h = await nativeProviderHarness({ protectedRead: true, targetPath,
      classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath, workspace,
        'PASSEUR_PROTECTED_SYNTHETIC_SECRET').class });
    try {
      const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
      const call = await h.post(main);
      assert.equal(call.status, 200);
      assert.equal(call.body.includes(targetPath), true);
      const foreign = readFileResultRequest();
      foreign.input[2].arguments = JSON.stringify({ path: protectedReadPath('direct', workspace, root),
        offset: 1, limit: 20 });
      foreign.input[3].output = installedProtectedError(targetPath, workspace);
      assert.equal((await h.post(foreign)).status, 422);
      assert.equal(h.provider.state.primaryCode, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
    } finally { await h.provider.close(); }
    const accepted = await nativeProviderHarness({ protectedRead: true, targetPath,
      classifyProtectedRaw: raw => classifyProtectedOutput(raw, targetPath, workspace,
        'PASSEUR_PROTECTED_SYNTHETIC_SECRET').class });
    try {
      const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
      const skill1 = fixedReminderRequest(); skill1.input = 'NATIVE_PROTECTED_READ_PROBE first skill';
      const skill2 = fixedReminderRequest(); skill2.input = 'NATIVE_PROTECTED_READ_PROBE second skill';
      const result = readFileResultRequest();
      result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
      result.input[3].output = installedProtectedError(targetPath, workspace);
      assert.equal((await accepted.post(main)).status, 200);
      assert.equal((await accepted.post(skill1)).status, 200);
      assert.equal((await accepted.post(result)).status, 200);
      assert.equal((await accepted.post(skill2)).status, 200);
      assert.equal(accepted.provider.requests.filter(request =>
        request.kind === 'matching_protected_read_result').length, 1);
      assert.equal(accepted.provider.requests.find(request => request.ordinal === 2)?.callId,
        'call_native_reminder_2');
    } finally { await accepted.provider.close(); }
  }
});

test('protected classifier reservation rejects concurrent foreign and duplicate results before SSE', async () => {
  const targetPath = '/tmp/fixture/protected/direct-read-target.txt';
  for (const duplicate of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await nativeProviderHarness({ protectedRead: true, targetPath,
      classifyProtectedRaw: () => gate });
    try {
      const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
      assert.equal((await h.post(main)).status, 200);
      const result = readFileResultRequest();
      result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
      result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
      const first = h.post(result);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.provider.state.main, 'read-result-classifying');
      const intruder = duplicate ? structuredClone(result) :
        { model: 'fixture-native-shell', input: [] };
      const rejected = await h.post(intruder);
      assert.equal(rejected.status, 422);
      assert.equal(h.provider.state.primaryCode, 'NATIVE_READ_FILE_RESULT_REPLAY');
      release('not_found');
      const original = await first;
      assert.equal(original.status, 422);
      assert.equal(original.body, '');
      assert.equal(h.provider.requests.filter(request => request.kind ===
        'matching_protected_read_result').length, 0);
    } finally { release('unknown'); await h.provider.close(); }
  }
});

test('protected second skill admitted during classification waits for accepted marker-free result', async () => {
  const targetPath = '/tmp/fixture/protected/direct-read-target.txt';
  for (const className of ['not_found', 'marker_exposed']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await nativeProviderHarness({ protectedRead: true, targetPath,
      classifyProtectedRaw: () => gate });
    try {
      const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
      const skill1 = fixedReminderRequest(); skill1.input = 'NATIVE_PROTECTED_READ_PROBE first skill';
      const skill2 = fixedReminderRequest(); skill2.input = 'NATIVE_PROTECTED_READ_PROBE second skill';
      const result = readFileResultRequest();
      result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
      result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
      assert.equal((await h.post(main)).status, 200);
      assert.equal((await h.post(skill1)).status, 200);
      const first = h.post(result);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.provider.state.main, 'read-result-classifying');
      let secondDone = false;
      const second = h.post(skill2).then(value => { secondDone = true; return value; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(secondDone, false);
      assert.equal(h.provider.state.active, 2);
      release(className);
      const [readResponse, reminderResponse] = await Promise.all([first, second]);
      if (className === 'not_found') {
        assert.equal(readResponse.status, 200);
        assert.equal(reminderResponse.status, 200);
        assert.equal(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 2);
        assert.equal(h.provider.requests.find(request => request.ordinal === 2)?.callId,
          'call_native_reminder_2');
      } else {
        assert.equal(readResponse.status, 422);
        assert.equal(reminderResponse.status, 422);
        assert.equal(reminderResponse.body, '');
        assert.equal(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 1);
      }
    } finally { release('unknown'); await h.provider.close(); }
  }
});

test('protected second skill admission survives delayed body only after result acceptance', async () => {
  const targetPath = '/tmp/fixture/protected/direct-read-target.txt';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: () => gate });
  try {
    const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
    const skill1 = fixedReminderRequest(); skill1.input = 'NATIVE_PROTECTED_READ_PROBE first skill';
    const skill2 = fixedReminderRequest(); skill2.input = 'NATIVE_PROTECTED_READ_PROBE second skill';
    const result = readFileResultRequest();
    result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
    assert.equal((await h.post(main)).status, 200);
    assert.equal((await h.post(skill1)).status, 200);
    const first = h.post(result);
    await new Promise(resolve => setImmediate(resolve));
    const request = new Readable({ read() {} });
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, body: null, writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    const handling = h.handle(request, response);
    assert.equal(h.provider.state.active, 2);
    release('not_found');
    assert.equal((await first).status, 200);
    request.push(JSON.stringify(skill2)); request.push(null);
    await handling;
    assert.equal(response.status, 200);
    assert.equal(h.provider.requests.find(requestSummary => requestSummary.ordinal === 2)?.responseIndex, 4);
  } finally { release('unknown'); await h.provider.close(); }
});

test('third protected skill while result and second reminder wait aborts both responses', async () => {
  const targetPath = '/tmp/fixture/protected/direct-read-target.txt';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await nativeProviderHarness({ protectedRead: true, targetPath,
    classifyProtectedRaw: () => gate });
  try {
    const main = readFileProbeRequest(); main.input = 'NATIVE_PROTECTED_READ_PROBE';
    const skill1 = fixedReminderRequest(); skill1.input = 'NATIVE_PROTECTED_READ_PROBE first skill';
    const skill2 = fixedReminderRequest(); skill2.input = 'NATIVE_PROTECTED_READ_PROBE second skill';
    const skill3 = fixedReminderRequest(); skill3.input = 'NATIVE_PROTECTED_READ_PROBE third skill';
    const result = readFileResultRequest();
    result.input[2].arguments = JSON.stringify({ path: targetPath, offset: 1, limit: 20 });
    result.input[3].output = installedProtectedError(targetPath, '/tmp/fixture/workspace');
    assert.equal((await h.post(main)).status, 200);
    assert.equal((await h.post(skill1)).status, 200);
    const first = h.post(result);
    await new Promise(resolve => setImmediate(resolve));
    const second = h.post(skill2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.provider.state.active, 2);
    assert.equal((await h.post(skill3)).status, 429);
    release('not_found');
    assert.equal((await first).status, 422);
    assert.equal((await second).status, 422);
    assert.equal(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 1);
  } finally { release('unknown'); await h.provider.close(); }
});

async function nativeProviderHarness({ onShut, readFileSchemaOnly = false, readFileProbe = false,
  protectedRead = false, targetPath, classifyProtectedRaw } = {}) {
  let handle;
  const command = shellProbeCommand('/tmp/fixture/workspace', '/tmp/fixture/protected', 'protected-canary');
  const provider = await startShellProvider(31001, command, {
    readFileSchemaOnly, readFileProbe, protectedRead, targetPath, classifyProtectedRaw,
    workspace: '/tmp/fixture/workspace',
    makeServer: callback => { handle = callback; return {}; },
    waitListen: async () => 31002, shut: async () => { if (onShut) await onShut(handle); },
  });
  const postRaw = async raw => {
    const request = Readable.from([raw]);
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, body: null, writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    await handle(request, response);
    return response;
  };
  return { provider, handle, command, postRaw, post: body => postRaw(JSON.stringify(body)) };
}

function shellResultRequest(overrides = {}) {
  return { model: 'fixture-native-shell', previous_response_id: 'resp_native_shell_1',
    input: [{ type: 'function_call_output', call_id: 'call_native_shell_1',
      output: 'workspace=ok\ndirect=denied\nsymlink=denied\nproc=denied\ndummy-auth=absent\n' }], ...overrides };
}

test('main schema projector redacts drift and provider refuses a call', async () => {
  const secret = 'sk_test_12345_SUPPOSED_SECRET';
  const main = mainNativeRequest();
  main.tools[0].tools[0].name = secret;
  main.tools[0].tools[11].description = secret;
  main.tools[0].tools[11].parameters.properties.command.enum = [secret];
  const summary = mainSchemaDiscovery(main);
  assert.equal(summary.functionCount, 25);
  assert.equal(summary.functions.length, 25);
  assert.equal(summary.selected.name, 'bash');
  assert.equal(summary.selected.index, 11);
  assert.equal(summary.functions[12].name, '[other]');
  assert.equal(summary.identityValid, true);
  assert.equal(summary.selectedComplete, false);
  assert.deepEqual(summary.selected.schema.required, ['command', 'description']);
  assert.equal(summary.functions[0].name, '[other]');
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 16_384);
  assert.equal(mainSchemaDiscovery(mainNativeRequest()).selectedComplete, true);
  const unreviewed = mainNativeRequest();
  unreviewed.tools[0].tools[11].parameters.properties.command.pattern = secret;
  assert.equal(mainSchemaDiscovery(unreviewed).selectedComplete, false);
  const invalidType = mainNativeRequest();
  invalidType.tools[0].tools[11].parameters.properties.command.type = 'UNKNOWN_TYPE';
  assert.equal(mainSchemaDiscovery(invalidType).selectedComplete, false);
  const duplicateType = mainNativeRequest();
  duplicateType.tools[0].tools[11].parameters.properties.command.type = ['string', 'string'];
  assert.equal(mainSchemaDiscovery(duplicateType).selectedComplete, false);
  const h = await nativeProviderHarness();
  const response = await h.post(main);
  assert.equal(response.status, 422);
  assert.equal(response.body, '');
  assert.equal(h.provider.requests[0].rejection, 'NATIVE_BASH_SCHEMA_INVALID');
  assert.equal(h.provider.requests[0].callId, undefined);
  assert.deepEqual(await h.provider.rejection, { kind: 'provider_rejected', code: 'NATIVE_BASH_SCHEMA_INVALID' });
  await h.provider.close();
});

test('exact bash selection rejects missing, duplicate, moved and wrong namespace identity', () => {
  const changed = transform => { const request = mainNativeRequest(); transform(request); return mainSchemaDiscovery(request); };
  assert.equal(changed(body => { body.tools[0].tools[11].name = 'bash_input'; }).selectedComplete, false);
  assert.equal(changed(body => { body.tools[0].tools[12].name = 'bash'; }).selectedComplete, false);
  assert.equal(changed(body => { [body.tools[0].tools[11], body.tools[0].tools[12]] =
    [body.tools[0].tools[12], body.tools[0].tools[11]]; }).selectedComplete, false);
  assert.equal(changed(body => { body.tools[0].name = 'other'; }), null);
});

test('read_file discovery selects only its exact catalog identity and retains bounded structure', () => {
  const body = readFileNativeRequest();
  const selected = readFileSchemaDiscovery(body);
  assert.equal(selected.identityValid, true);
  assert.equal(selected.selectedComplete, true);
  assert.equal(selected.readFileCount, 1);
  assert.equal(selected.selected.name, 'read_file');
  assert.equal(selected.selected.index, 1);
  assert.deepEqual(selected.selected.schema.required, ['path']);
  assert.deepEqual(selected.selected.schema.properties.map(field => field.name), ['path', 'offset', 'limit']);
  for (const index of [2, 3, 4, 11]) assert.equal(selected.functions[index].name, '[other]');
  for (const edit of [
    request => { request.tools[0].tools[1].name = 'read_memory'; },
    request => { request.tools[0].tools[2].name = 'read_file'; },
    request => { [request.tools[0].tools[1], request.tools[0].tools[2]] =
      [request.tools[0].tools[2], request.tools[0].tools[1]]; },
    request => { request.tools[0].tools[1].parameters.properties.path.pattern = '.*'; },
    request => { request.tools[0].tools[1].parameters.properties.path.type = 'mystery'; },
    request => { request.tools[0].tools[1].parameters.properties.sk_test_12345_SUPPOSED_SECRET = { type: 'string' }; },
  ]) {
    const changed = readFileNativeRequest();
    edit(changed);
    const summary = readFileSchemaDiscovery(changed);
    assert.equal(summary.selectedComplete, false);
    assert.equal(JSON.stringify(summary).includes('sk_test_12345_SUPPOSED_SECRET'), false);
  }
  assert.equal(readFileSchemaDiscovery({ ...body, input: 'NATIVE_SHELL_PROBE' }), null);
  assert.equal(readFileSchemaDiscovery({ ...body, tools: [{ ...body.tools[0], name: 'other' }] }), null);
});

test('read_file schema provider emits no call in either reminder order and bounds failures', async () => {
  const reminder = fixedReminderRequest();
  reminder.input = 'NATIVE_READ_FILE_SCHEMA_PROBE';
  for (const order of ['main-first', 'reminder-first']) {
    const h = await nativeProviderHarness({ readFileSchemaOnly: true });
    try {
      const requests = order === 'main-first' ? [readFileNativeRequest(), reminder] :
        [reminder, readFileNativeRequest()];
      const responses = [];
      for (const request of requests) responses.push(await h.post(request));
      assert.deepEqual(responses.map(response => response.status), [200, 200]);
      const mainResponse = responses[order === 'main-first' ? 0 : 1];
      const frames = mainResponse.body.split('\n\n').filter(Boolean)
        .map(line => JSON.parse(line.slice('data: '.length)));
      assert.equal(frames.length, 8);
      assert.equal(frames.some(frame => frame.type.includes('function_call') ||
        frame.item?.type === 'function_call'), false);
      assert.deepEqual(h.provider.requests.filter(request => request.path === '/responses')
        .map(request => request.kind).sort(), ['native_read_file_schema', 'native_reminder_call']);
      assert.equal(h.provider.state.main, 'schema-observed');
      assert.equal(h.provider.state.reminder, 'none-issued');
      assert.equal((await h.post(readFileNativeRequest())).status, 422);
      assert.equal(h.provider.state.primaryCode, 'NATIVE_MAIN_REPLAY');
    } finally { await h.provider.close(); }
  }
  const h = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    const over = await h.postRaw('x'.repeat(262_145));
    assert.equal(over.status, 413);
    assert.equal(h.provider.state.primaryCode, 'REQUEST_TOO_LARGE');
    assert.equal((await h.post(readFileNativeRequest())).status, 429);
    assert.equal(h.provider.requests.some(request => request.kind === 'native_read_file_schema'), false);
  } finally { await h.provider.close(); }
  const capped = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    capped.provider.state.outputBytes = 65_535;
    assert.equal((await capped.post(readFileNativeRequest())).status, 422);
    assert.equal(capped.provider.state.primaryCode, 'NATIVE_OUTPUT_BUDGET_EXCEEDED');
    assert.equal(capped.provider.requests[0].kind, undefined);
  } finally { await capped.provider.close(); }
});

test('verification reminder schema is distinct from the fixed seven-field payload', () => {
  const body = verificationReminderRequest();
  const summary = verificationReminderSchemaDiscovery(body);
  assert.equal(summary.selectedComplete, true);
  assert.equal(summary.reminderCount, 1);
  assert.equal(summary.selected.strict, false);
  assert.equal(summary.selected.schema.propertyCount, 3);
  assert.deepEqual(summary.selected.schema.required, ['decision', 'reason', 'confidence']);
  assert.deepEqual(summary.selected.schema.properties[0].schema.enum, ['none', 'verify']);
  assert.deepEqual(summary.selected.schema.properties[1].schema.type, ['string', 'null']);
  assert.deepEqual(summary.selected.schema.properties[2].schema, { type: 'integer', minimum: 0, maximum: 10 });
  assert.equal(verificationReminderSchemaDiscovery(fixedReminderRequest()), null);
  assert.throws(() => fixedNoReminderPayload(body), { code: 'NATIVE_REMINDER_SCHEMA_INVALID' });
  const secret = 'sk_test_12345_SUPPOSED_SECRET';
  const unsafe = verificationReminderRequest();
  unsafe.tools[0].tools[0].parameters.properties[secret] = { type: 'string' };
  const incomplete = verificationReminderSchemaDiscovery(unsafe);
  assert.equal(incomplete.selectedComplete, false);
  assert.equal(JSON.stringify(incomplete).includes(secret), false);
  const unsupported = verificationReminderRequest();
  unsupported.tools[0].tools[0].parameters.properties.reason.pattern = '.*';
  assert.equal(verificationReminderSchemaDiscovery(unsupported).selectedComplete, false);
  const duplicate = verificationReminderRequest();
  duplicate.tools[0].tools.push(structuredClone(duplicate.tools[0].tools[0]));
  assert.equal(verificationReminderSchemaDiscovery(duplicate), null);
  const foreign = verificationReminderRequest();
  foreign.tools[0].tools[0].name = 'read_file';
  assert.equal(verificationReminderSchemaDiscovery(foreign), null);
});

test('verification reminder association exposes only issued references and unknown child linkage', () => {
  const state = { main: 'schema-observed', reminder: 'none-issued' };
  const body = verificationReminderRequest();
  body.previous_response_id = 'resp_native_read_file_schema_1';
  body.input = [{ type: 'message', id: 'msg_native_read_file_schema_1', content: 'private prompt' },
    { type: 'function_call_output', call_id: 'call_native_reminder_1', output: 'private argument' }];
  const associated = verificationReminderAssociation(body, state, 3);
  assert.equal(associated.requestIndex, 3);
  assert.equal(associated.previousResponse, 'issued_main');
  assert.equal(associated.inputCount, 2);
  assert.deepEqual(associated.itemFacts.map(item => item.type), ['message', 'function_call_output']);
  assert.equal(associated.httpRelation, 'ambiguous');
  assert.equal(associated.nativeReminderChildRelation, 'unknown');
  assert.equal(JSON.stringify(associated).includes('private'), false);
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: 'foreign' }, state, 3)
    .httpRelation, 'foreign');
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: undefined,
    input: 'opaque text' }, state, 1).httpRelation, 'unknown');
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: 'resp_native_read_file_schema_1' },
    { main: 'unseen', reminder: 'unseen' }, 1).httpRelation, 'foreign');
  const afterRead = { main: 'read-call-issued', reminder: 'unseen' };
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: 'resp_native_read_file_1',
    input: [{ type: 'function_call_output', call_id: 'call_native_read_file_1' }] },
  afterRead, 2).httpRelation, 'issued_main');
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: 'resp_native_read_file_2',
    input: [{ type: 'message', id: 'msg_native_read_file_2' }] },
  { main: 'read-result-accepted', reminder: 'unseen' }, 4).httpRelation, 'issued_main');
  assert.equal(verificationReminderAssociation({ ...body, previous_response_id: 'resp_native_read_file_1' },
    { main: 'unseen', reminder: 'unseen' }, 1).httpRelation, 'foreign');
  const afterSecond = verificationReminderAssociation({ ...body,
    previous_response_id: 'resp_native_reminder_2',
    input: [{ type: 'function_call_output', call_id: 'call_native_reminder_2' }] },
  { main: 'read-result-accepted', reminder: 'second-issued', verification: 'unseen' }, 5);
  assert.equal(afterSecond.previousResponse, 'issued_reminder_2');
  assert.equal(afterSecond.httpRelation, 'issued_reminder');
  assert.equal(afterSecond.issuedAtRequest.reminder2, true);
});

test('verification reminder provider captures a bounded schema and emits no variant function response', async () => {
  for (const order of ['main-first', 'reminder-first']) {
    const h = await nativeProviderHarness({ readFileSchemaOnly: true });
    try {
      const first = order === 'main-first' ? readFileNativeRequest() :
        { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_SCHEMA_PROBE' };
      const second = order === 'main-first' ?
        { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_SCHEMA_PROBE' } : readFileNativeRequest();
      assert.equal((await h.post(first)).status, 200);
      assert.equal((await h.post(second)).status, 200);
      const variant = verificationReminderRequest();
      variant.previous_response_id = 'resp_native_read_file_schema_1';
      const response = await h.post(variant);
      assert.equal(response.status, 422);
      assert.equal(response.body, '');
      assert.equal(h.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_SCHEMA_ONLY');
      const recorded = h.provider.requests[2];
      assert.equal(recorded.kind, 'native_verification_reminder_schema');
      assert.equal(recorded.association.requestIndex, 3);
      assert.equal(recorded.association.previousResponse, 'issued_main');
      assert.equal(recorded.association.nativeReminderChildRelation, 'unknown');
      assert.equal(recorded.verificationSchema.selectedComplete, true);
      assert.equal(recorded.selectedNameSha256,
        '4a3837b69a6fc85cd9a85f75160accf94f068c870f8ff8b6f44e60d138080f45');
      assert.equal(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 1);
      assert.equal(h.provider.requests.filter(request => request.kind === 'native_tool_call').length, 0);
      assert.equal((await h.post(variant)).status, 429);
    } finally { await h.provider.close(); }
  }
  const h = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    const changed = verificationReminderRequest();
    changed.tools[0].tools[0].parameters.properties.reason.pattern = '.*';
    assert.equal((await h.post(changed)).status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_SCHEMA_INCOMPLETE');
    assert.equal(h.provider.requests[0].verificationSchema.selectedComplete, false);
  } finally { await h.provider.close(); }
  const foreign = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    const variant = verificationReminderRequest();
    variant.previous_response_id = 'foreign-response';
    assert.equal((await foreign.post(variant)).status, 422);
    assert.equal(foreign.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_ASSOCIATION_FOREIGN');
    assert.equal(foreign.provider.requests[0].association.httpRelation, 'foreign');
  } finally { await foreign.provider.close(); }
  const capped = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    capped.provider.state.outputBytes = 65_535;
    assert.equal((await capped.post(verificationReminderRequest())).status, 422);
    assert.equal(capped.provider.state.primaryCode, 'NATIVE_OUTPUT_BUDGET_EXCEEDED');
    assert.equal(capped.provider.requests[0].kind, undefined);
  } finally { await capped.provider.close(); }
  for (const edit of [
    body => { body.tools[0].tools.push(structuredClone(body.tools[0].tools[0])); },
    body => { body.tools[0].tools[0].name = 'submit_reminder_decision_changed'; },
  ]) {
    const changed = await nativeProviderHarness({ readFileSchemaOnly: true });
    try {
      const body = verificationReminderRequest();
      edit(body);
      assert.equal((await changed.post(body)).status, 422);
      assert.equal(changed.provider.state.primaryCode, 'NATIVE_REQUEST_UNCLASSIFIED');
      assert.equal(changed.provider.requests[0].kind, undefined);
    } finally { await changed.provider.close(); }
  }
  const omitted = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    const body = verificationReminderRequest();
    body.input = Array.from({ length: 17 }, () => ({ type: 'message' }));
    assert.equal((await omitted.post(body)).status, 422);
    assert.equal(omitted.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_ASSOCIATION_INCOMPLETE');
    assert.equal(omitted.provider.requests[0].association.omittedItems, 1);
  } finally { await omitted.provider.close(); }
});

test('verification association is bound at request admission across paused body completion', async () => {
  const h = await nativeProviderHarness({ readFileSchemaOnly: true });
  try {
    const first = new Readable({ read() {} });
    first.method = 'POST'; first.url = '/responses';
    const firstResponse = { status: null, body: null,
      writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    const pending = h.handle(first, firstResponse);
    assert.equal(h.provider.state.active, 1);
    assert.equal((await h.post(readFileNativeRequest())).status, 200);
    const variant = verificationReminderRequest();
    variant.previous_response_id = 'resp_native_read_file_schema_1';
    first.push(JSON.stringify(variant));
    first.push(null);
    await pending;
    assert.equal(firstResponse.status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_ASSOCIATION_FOREIGN');
    const recorded = h.provider.requests[0];
    assert.equal(recorded.responseIndex, 1);
    assert.equal(recorded.association.requestIndex, 1);
    assert.deepEqual(recorded.association.issuedAtRequest,
      { main: false, reminder: false, reminder2: false, verification: false });
    assert.equal(recorded.association.previousResponse, 'foreign');
    assert.equal(h.provider.requests[1].kind, 'native_read_file_schema');
  } finally { await h.provider.close(); }
});

test('fixed verification none and read_file calls bind exact schemas, paths and distinct IDs', () => {
  const verification = fixedVerificationPayload(verifiedVerificationRequest());
  assert.deepEqual(verification, { decision: 'none', next_step: null,
    reason: 'Disposable scripted protocol probe; no verification reminder is being proposed.' });
  assert.throws(() => fixedVerificationPayload(verificationReminderRequest()),
    { code: 'NATIVE_VERIFY_REMINDER_SCHEMA_INVALID' });
  const changed = verifiedVerificationRequest();
  changed.tools[0].tools[0].parameters.properties.reason.maxLength = 20;
  assert.throws(() => fixedVerificationPayload(changed), { code: 'NATIVE_VERIFY_REMINDER_SCHEMA_INVALID' });
  const selected = fixedReadFileCall(readFileProbeRequest(), '/tmp/fixture/workspace');
  assert.deepEqual(selected.arguments, { path: '/tmp/fixture/workspace/read-canary.txt', offset: 1, limit: 20 });
  assert.equal(JSON.stringify(selected).includes('protected'), false);
  assert.throws(() => fixedReadFileCall(readFileNativeRequest(), '/tmp/fixture/workspace'),
    { code: 'NATIVE_READ_FILE_SCHEMA_INVALID' });
  const readFrames = readFileCallEvents(selected.arguments);
  const verifyFrames = reminderCallEvents(verification, { responseId: 'resp_native_verify_reminder_1',
    itemId: 'fc_native_verify_reminder_1', callId: 'call_native_verify_reminder_1' });
  assert.deepEqual(readFrames.map(frame => frame.type), verifyFrames.map(frame => frame.type));
  assert.equal(readFrames[4].item.name, 'read_file');
  assert.equal(readFrames[4].item.namespace, 'muse');
  assert.equal(verifyFrames[4].item.name, 'submit_reminder_decision');
  assert.notEqual(readFrames[4].item.call_id, verifyFrames[4].item.call_id);
  assert.equal(readFileDecoratedOutput('/tmp/fixture/workspace'),
    'Read text file `/tmp/fixture/workspace/read-canary.txt`.\n1|PASSEUR_NATIVE_READ_CANARY');
  assert.equal(matchingReadFileResult(readFileResultRequest(), '/tmp/fixture/workspace'), true);
  assert.equal(matchingReadFileResult(readFileResultRequest('wrong'), '/tmp/fixture/workspace'), false);
  assert.equal(matchingReadFileResult({ ...readFileResultRequest(),
    input: [{ ...readFileResultRequest().input[0], extra: true }] }, '/tmp/fixture/workspace'), false);
  assert.equal(readFileResultEnvelopeShape(readFileResultRequest('private output')).items[3].exactCanary, false);
  assert.equal(JSON.stringify(readFileResultEnvelopeShape(readFileResultRequest('private output')))
    .includes('private output'), false);
});

test('read_file mismatch projects four native items without retaining arbitrary values', () => {
  const secret = 'sk_test_12345_SUPPOSED_SECRET';
  const output = `Read file: /tmp/fixture/workspace/read-canary.txt\n${secret}`;
  const body = { model: 'fixture-native-shell', input: [
    { type: 'message', role: 'assistant', id: secret,
      content: [{ type: 'output_text', text: secret }], [secret]: secret },
    { type: 'reasoning', id: 'fc_native_read_file_1', summary: secret },
    { type: 'function_call', name: 'read_file', namespace: 'muse',
      call_id: 'call_native_read_file_1', response_id: 'resp_native_read_file_1' },
    { type: 'function_call_output', call_id: 'call_native_read_file_1', output },
  ] };
  const issued = { main: 'read-call-issued', reminder: 'unseen', verification: 'unseen' };
  const shape = readFileResultEnvelopeShape(body, issued);
  assert.equal(shape.previousResponse, 'absent');
  assert.equal(shape.nativeChildAssociation, 'unknown');
  assert.equal(shape.inputCount, 4);
  assert.deepEqual(shape.items.map(item => item.type),
    ['message', 'reasoning', 'function_call', 'function_call_output']);
  assert.equal(shape.items[0].role, 'assistant');
  assert.equal(shape.items[0].unknownFieldCount, 1);
  assert.deepEqual(shape.items[0].contentParts, ['output_text']);
  assert.equal(shape.items[1].idRef, 'issued_read_item');
  assert.equal(shape.items[2].callId, 'issued_read_file');
  assert.equal(shape.items[2].responseRef, 'issued_read_response');
  assert.equal(shape.items[3].outputBytes, Buffer.byteLength(output));
  assert.equal(shape.items[3].outputSha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(shape.items[3].exactCanary, false);
  assert.deepEqual(shape.issuedAtRequest,
    { read: true, readText: false, skill: false, skill2: false, verification: false });
  assert.equal(JSON.stringify(shape).includes(secret), false);
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: secret })
    .previousResponse, 'foreign');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 7 })
    .previousResponse, 'invalid');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 'resp_native_read_file_2' },
    issued).previousResponse, 'known_unissued');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 'resp_native_reminder_1' },
    issued).previousResponse, 'known_unissued');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 'resp_native_verify_reminder_1' },
    issued).previousResponse, 'known_unissued');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 'resp_native_reminder_1' },
    { ...issued, reminder: 'none-issued' }).previousResponse, 'issued_skill_response');
  assert.equal(readFileResultEnvelopeShape({ ...body, previous_response_id: 'resp_native_verify_reminder_1' },
    { ...issued, verification: 'none-issued' }).previousResponse, 'issued_verify_response');
  const excess = readFileResultEnvelopeShape({ ...body, input: Array.from({ length: 200 }, () =>
    ({ type: secret, role: secret, name: secret, namespace: secret, content: Array.from(
      { length: 100 }, () => ({ type: secret, text: secret })), output: secret, [secret]: secret })) });
  assert.equal(excess.inputCount, 200);
  assert.ok(excess.omittedItems >= 192);
  assert.equal(excess.items[0].unknownFieldCount, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(excess)) <= 8192);
  assert.equal(JSON.stringify(excess).includes(secret), false);
});

test('read_file mismatch identifies HTTP name and fixed args without revealing values', () => {
  const workspace = '/tmp/fixture/workspace';
  const expected = { path: join(workspace, 'read-canary.txt'), offset: 1, limit: 20 };
  const body = { model: 'fixture-native-shell', input: [
    { type: 'message', role: 'developer', content: 'private developer prompt' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private user prompt' }] },
    { type: 'function_call', id: 'fc_native_read_file_1', call_id: 'call_native_read_file_1',
      name: 'muse.read_file', arguments: JSON.stringify(expected) },
    { type: 'function_call_output', call_id: 'call_native_read_file_1', output: 'private output' },
  ] };
  const issued = { main: 'read-call-issued' };
  const shape = readFileResultEnvelopeShape(body, issued, workspace);
  assert.deepEqual(shape.items.slice(0, 2).map(item => item.contentKind), ['string', 'array']);
  assert.deepEqual(shape.items[1].contentParts, ['input_text']);
  assert.equal(shape.items[2].nameClass, 'muse.read_file');
  assert.equal(shape.items[2].nameLength, 'muse.read_file'.length);
  assert.equal(shape.items[2].nameSha256,
    createHash('sha256').update('muse.read_file').digest('hex'));
  assert.equal(shape.items[2].argumentsType, 'string');
  assert.equal(shape.items[2].argumentsBytes, Buffer.byteLength(JSON.stringify(expected)));
  assert.equal(shape.items[2].argumentsWithinBound, true);
  assert.equal(shape.items[2].argumentsExactFixed, true);
  assert.equal(JSON.stringify(shape).includes(workspace), false);
  assert.equal(JSON.stringify(shape).includes('private'), false);
  const wrong = structuredClone(body);
  wrong.input[2].name = 'sk_test_12345_SUPPOSED_SECRET';
  wrong.input[2].arguments = JSON.stringify({ ...expected, path: '/tmp/private-secret' });
  const changed = readFileResultEnvelopeShape(wrong, issued, workspace);
  assert.equal(changed.items[2].nameClass, '[other]');
  assert.equal(changed.items[2].argumentsExactFixed, false);
  assert.equal(JSON.stringify(changed).includes('SUPPOSED_SECRET'), false);
  assert.equal(JSON.stringify(changed).includes('/tmp/private-secret'), false);
  wrong.input[2].arguments = 'x'.repeat(5000);
  const oversized = readFileResultEnvelopeShape(wrong, issued, workspace);
  assert.equal(oversized.items[2].argumentsWithinBound, false);
  assert.equal(oversized.items[2].argumentsExactFixed, false);
});

test('exact read result rejects changed roles, IDs, args, output and extra items', () => {
  const workspace = '/tmp/fixture/workspace';
  const original = readFileResultRequest();
  assert.equal(matchingReadFileResult(original, workspace), true);
  const edits = [
    body => { delete body.tools; },
    body => { body.tools[0].tools[1].parameters.properties.offset.minimum = 0; },
    body => { body.previous_response_id = null; },
    body => { body.input[0].role = 'user'; },
    body => { body.input[1].role = 'assistant'; },
    body => { body.input[0].content = [{ type: 'input_text', text: 'other' }]; },
    body => { body.input[1].content = ''; },
    body => { body.input[0].extra = true; },
    body => { body.input[1].id = 'foreign'; },
    body => { body.input[2].name = 'read_file'; },
    body => { body.input[2].name = 'muse.bash'; },
    body => { body.input[2].id = 'other'; },
    body => { body.input[2].call_id = 'other'; },
    body => { body.input[2].namespace = 'muse'; },
    body => { body.input[2].arguments = '{'; },
    body => { body.input[2].arguments = JSON.stringify({ path: '/tmp/other', offset: 1, limit: 20 }); },
    body => { body.input[2].arguments = JSON.stringify({
      path: '/tmp/fixture/workspace/read-canary.txt', offset: 0, limit: 20 }); },
    body => { body.input[2].arguments = JSON.stringify({
      path: '/tmp/fixture/workspace/read-canary.txt', offset: 1, limit: 21 }); },
    body => { body.input[2].arguments = JSON.stringify({
      path: '/tmp/fixture/workspace/read-canary.txt', offset: 1, limit: 20, extra: true }); },
    body => { body.input[3].call_id = 'call_native_reminder_1'; },
    body => { body.input[3].output += '\n'; },
    body => { body.input[3].output = body.input[3].output.replace('Read text file', 'Read file'); },
    body => { body.input[3].output = body.input[3].output.replace('read-canary.txt', 'other.txt'); },
    body => { body.input[3].output = body.input[3].output.replace('1|', '2|'); },
    body => { body.input[3].output = body.input[3].output.replace('PASSEUR', 'OTHER'); },
    body => { body.input[3].extra = true; },
    body => { body.input.push(structuredClone(body.input[3])); },
  ];
  for (const edit of edits) {
    const changed = structuredClone(original);
    edit(changed);
    assert.equal(matchingReadFileResult(changed, workspace), false);
  }
});

test('probe provider accepts one workspace read and both independent reminder schemas in bounded orders', async () => {
  const skill = { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE' };
  const cases = [
    [skill, readFileProbeRequest(), verifiedVerificationRequest(), readFileResultRequest()],
    [verifiedVerificationRequest(), readFileProbeRequest(), readFileResultRequest(), skill],
  ];
  for (const sequence of cases) {
    const h = await nativeProviderHarness({ readFileProbe: true });
    try {
      const responses = [];
      for (const request of sequence) responses.push(await h.post(request));
      assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
      assert.equal(h.provider.state.main, 'read-result-accepted');
      assert.equal(h.provider.state.reminder, 'none-issued');
      assert.equal(h.provider.state.verification, 'none-issued');
      const records = h.provider.requests;
      assert.deepEqual(records.filter(record => record.kind === 'native_read_file_call')
        .map(record => record.argumentKeys), [['path', 'offset', 'limit']]);
      assert.equal(records.filter(record => record.kind === 'matching_read_file_result').length, 1);
      assert.equal(records.filter(record => record.kind === 'native_verification_reminder_call').length, 1);
      assert.equal(records.filter(record => record.kind === 'native_reminder_call').length, 1);
      assert.equal(records.some(record => record.kind === 'native_tool_call'), false);
      const readBody = responses[sequence.findIndex(request => request?.tools?.[0]?.tools?.length === 25)].body;
      assert.equal(readBody.includes('"name":"read_file"'), true);
      assert.equal(readBody.includes('/tmp/fixture/workspace/read-canary.txt'), true);
      assert.equal(readBody.includes('protected-canary'), false);
      assert.equal((await h.post(readFileProbeRequest())).status, 422);
    } finally { await h.provider.close(); }
  }
});

test('probe retains four catalog and four Responses requests including the final result', async () => {
  const h = await nativeProviderHarness({ readFileProbe: true });
  try {
    for (let index = 0; index < 4; index++) {
      const request = Readable.from([]);
      request.method = 'GET'; request.url = '/muse-code/models';
      const response = { status: null, writeHead(status) { this.status = status; return this; },
        end() { return this; } };
      await h.handle(request, response);
      assert.equal(response.status, 200);
    }
    assert.equal((await h.post({ ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE' })).status, 200);
    assert.equal((await h.post(readFileProbeRequest())).status, 200);
    const verify = verifiedVerificationRequest();
    verify.previous_response_id = 'resp_native_read_file_1';
    assert.equal((await h.post(verify)).status, 200);
    assert.equal((await h.post(readFileResultRequest())).status, 200);
    assert.equal(h.provider.requests.length, 8);
    assert.equal(h.provider.requests[7].kind, 'matching_read_file_result');
    assert.equal(h.provider.requests[6].association.httpRelation, 'issued_main');
    assert.equal(h.provider.state.omittedRequests, 0);
  } finally { await h.provider.close(); }
});

test('probe accepts one distinct second skill reminder after read result in either verification order', async () => {
  const firstSkill = { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE first skill' };
  const secondSkill = { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE second skill' };
  for (const verifyFirst of [true, false]) {
    const h = await nativeProviderHarness({ readFileProbe: true });
    try {
      assert.equal((await h.post(firstSkill)).status, 200);
      assert.equal((await h.post(readFileProbeRequest())).status, 200);
      assert.equal((await h.post(readFileResultRequest())).status, 200);
      const tail = verifyFirst ? [verifiedVerificationRequest(), secondSkill] :
        [secondSkill, verifiedVerificationRequest()];
      const tailResponses = [];
      for (const body of tail) tailResponses.push(await h.post(body));
      assert.deepEqual(tailResponses.map(response => response.status), [200, 200]);
      const secondBody = tailResponses[verifyFirst ? 1 : 0].body;
      for (const identity of ['resp_native_reminder_2', 'fc_native_reminder_2',
        'call_native_reminder_2']) assert.equal(secondBody.includes(identity), true);
      const reminders = h.provider.requests.filter(request => request.kind === 'native_reminder_call');
      assert.deepEqual(reminders.map(request => [request.ordinal, request.responseId,
        request.itemId, request.callId]), [
        [1, 'resp_native_reminder_1', 'fc_native_reminder_1', 'call_native_reminder_1'],
        [2, 'resp_native_reminder_2', 'fc_native_reminder_2', 'call_native_reminder_2'],
      ]);
      assert.equal(reminders[0].payloadSha256, reminders[1].payloadSha256);
      assert.equal(reminders[1].association.issuedAtRequest.main, true);
      assert.equal(h.provider.requests.length, 5);
      assert.equal((await h.post(secondSkill)).status, 429);
    } finally { await h.provider.close(); }
  }
});

test('probe second skill gate rejects early, replayed and foreign requests', async () => {
  const first = { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE same skill' };
  const fresh = { ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE fresh skill' };
  for (const variant of ['early', 'replay', 'foreign', 'drift']) {
    const h = await nativeProviderHarness({ readFileProbe: true });
    try {
      assert.equal((await h.post(first)).status, 200);
      assert.equal((await h.post(readFileProbeRequest())).status, 200);
      if (variant !== 'early') assert.equal((await h.post(readFileResultRequest())).status, 200);
      const second = variant === 'replay' ? Object.fromEntries(Object.entries(first).reverse()) :
        structuredClone(fresh);
      if (variant === 'foreign') second.previous_response_id = 'foreign';
      if (variant === 'drift') second.tools[0].tools[0].parameters.properties.reason.type = 'integer';
      assert.equal((await h.post(second)).status, 422);
      assert.equal(h.provider.requests.at(-1).kind === 'native_reminder_call', false);
      assert.equal((await h.post(verifiedVerificationRequest())).status, 429);
    } finally { await h.provider.close(); }
  }
  const repeated = await nativeProviderHarness({ readFileProbe: true });
  try {
    assert.equal((await repeated.post({ ...fixedReminderRequest(),
      input: 'NATIVE_READ_FILE_PROBE first skill' })).status, 200);
    assert.equal((await repeated.post(readFileProbeRequest())).status, 200);
    assert.equal((await repeated.post(readFileResultRequest())).status, 200);
    assert.equal((await repeated.post(verifiedVerificationRequest())).status, 200);
    assert.equal((await repeated.post(verifiedVerificationRequest())).status, 422);
    assert.equal(repeated.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_REPLAY');
  } finally { await repeated.provider.close(); }
});

test('second skill and verification overlap after result within five POST and four GET', async () => {
  const h = await nativeProviderHarness({ readFileProbe: true });
  try {
    for (let index = 0; index < 4; index++) {
      const request = Readable.from([]);
      request.method = 'GET'; request.url = '/muse-code/models';
      const response = { status: null, writeHead(status) { this.status = status; return this; },
        end() { return this; } };
      await h.handle(request, response);
      assert.equal(response.status, 200);
    }
    assert.equal((await h.post({ ...fixedReminderRequest(),
      input: 'NATIVE_READ_FILE_PROBE first skill' })).status, 200);
    assert.equal((await h.post(readFileProbeRequest())).status, 200);
    assert.equal((await h.post(readFileResultRequest())).status, 200);
    const [skill, verification] = await Promise.all([
      h.post({ ...fixedReminderRequest(), input: 'NATIVE_READ_FILE_PROBE second skill' }),
      h.post(verifiedVerificationRequest()),
    ]);
    assert.deepEqual([skill.status, verification.status], [200, 200]);
    assert.equal(h.provider.requests.length, 9);
    assert.equal(h.provider.state.omittedRequests, 0);
    assert.equal(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 2);
    assert.equal((await h.post(verifiedVerificationRequest())).status, 429);
  } finally { await h.provider.close(); }
});

test('second skill admitted before read result cannot become eligible after delayed body', async () => {
  const h = await nativeProviderHarness({ readFileProbe: true });
  try {
    assert.equal((await h.post({ ...fixedReminderRequest(),
      input: 'NATIVE_READ_FILE_PROBE first skill' })).status, 200);
    assert.equal((await h.post(readFileProbeRequest())).status, 200);
    const request = new Readable({ read() {} });
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    const handling = h.handle(request, response);
    assert.equal(h.provider.state.active, 1);
    assert.equal((await h.post(readFileResultRequest())).status, 200);
    request.push(JSON.stringify({ ...fixedReminderRequest(),
      input: 'NATIVE_READ_FILE_PROBE second skill' }));
    request.push(null);
    await handling;
    assert.equal(response.status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_REMINDER_SEQUENCE_INVALID');
    assert.equal(h.provider.requests[2].responseIndex, 3);
    assert.equal(h.provider.requests[2].kind === 'native_reminder_call', false);
    assert.equal(h.provider.state.reminder, 'none-issued');
  } finally { await h.provider.close(); }
});

test('probe provider rejects result substitution, schema drift and unexpected verification references', async () => {
  const h = await nativeProviderHarness({ readFileProbe: true });
  try {
    assert.equal((await h.post(readFileProbeRequest())).status, 200);
    const wrong = readFileResultRequest('PASSEUR_NATIVE_READ_CANARY\nextra');
    assert.equal((await h.post(wrong)).status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
    assert.equal(h.provider.requests[1].resultEnvelope.items[3].exactCanary, false);
    assert.equal((await h.post(readFileResultRequest())).status, 429);
  } finally { await h.provider.close(); }
  const structural = await nativeProviderHarness({ readFileProbe: true });
  try {
    assert.equal((await structural.post(readFileProbeRequest())).status, 200);
    const body = { model: 'fixture-native-shell', input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private prompt' }] },
      { type: 'reasoning', summary: 'private reasoning' },
      { type: 'function_call', name: 'muse.read_file', call_id: 'call_native_read_file_1',
        id: 'fc_native_read_file_1', arguments: JSON.stringify({
          path: '/tmp/fixture/workspace/read-canary.txt', offset: 1, limit: 20 }) },
      { type: 'function_call_output', call_id: 'call_native_read_file_1',
        output: 'decorated synthetic output' },
    ] };
    assert.equal((await structural.post(body)).status, 422);
    const rejected = structural.provider.requests[1];
    assert.equal(rejected.responseIndex, 2);
    assert.equal(rejected.resultEnvelope.previousResponse, 'absent');
    assert.equal(rejected.resultEnvelope.items.length, 4);
    assert.equal(rejected.resultEnvelope.items[3].outputSha256,
      createHash('sha256').update('decorated synthetic output').digest('hex'));
    assert.equal(rejected.resultEnvelope.items[2].nameClass, 'muse.read_file');
    assert.equal(rejected.resultEnvelope.items[2].argumentsExactFixed, true);
    assert.equal(JSON.stringify(rejected).includes('private'), false);
    assert.equal((await structural.post(readFileResultRequest())).status, 429);
    assert.equal(structural.provider.state.main, 'read-call-issued');
  } finally { await structural.provider.close(); }
  for (const edit of [
    body => { body.tools[0].tools[1].parameters.properties.offset.minimum = 0; },
    body => { body.tools[0].tools[1].name = 'read_memory'; },
  ]) {
    const changed = await nativeProviderHarness({ readFileProbe: true });
    try { const body = readFileProbeRequest(); edit(body);
      assert.equal((await changed.post(body)).status, 422);
      assert.equal(changed.provider.requests[0].kind === 'native_read_file_call', false);
    } finally { await changed.provider.close(); }
  }
  const foreign = await nativeProviderHarness({ readFileProbe: true });
  try { const body = verifiedVerificationRequest(); body.previous_response_id = 'foreign';
    assert.equal((await foreign.post(body)).status, 422);
    assert.equal(foreign.provider.state.primaryCode, 'NATIVE_VERIFY_REMINDER_ASSOCIATION_INVALID');
  } finally { await foreign.provider.close(); }
});

test('read result admitted before its call stays unissued when its body arrives late', async () => {
  const h = await nativeProviderHarness({ readFileProbe: true });
  try {
    const request = new Readable({ read() {} });
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    const handling = h.handle(request, response);
    assert.equal(h.provider.state.active, 1);
    assert.equal((await h.post(readFileProbeRequest())).status, 200);
    request.push(JSON.stringify(readFileResultRequest()));
    request.push(null);
    await handling;
    assert.equal(response.status, 422);
    assert.equal(h.provider.state.primaryCode, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
    assert.equal(h.provider.requests[0].responseIndex, 1);
    assert.equal(h.provider.requests[0].resultEnvelope.previousResponse, 'absent');
    assert.equal(h.provider.requests[0].resultEnvelope.items[2].callId, 'known_unissued');
    assert.deepEqual(h.provider.requests[0].resultEnvelope.issuedAtRequest,
      { read: false, readText: false, skill: false, skill2: false, verification: false });
    assert.equal(h.provider.state.main, 'read-call-issued');
  } finally { await h.provider.close(); }
});

test('selected bash schema retains distinct safe names, nested constraints and exact safe enums', () => {
  const body = mainNativeRequest();
  const selected = body.tools[0].tools[11];
  selected.strict = true;
  selected.parameters.properties.alpha_feature = { type: ['string', 'null'], enum: ['fast', 'slow', null],
    minLength: 1, maxLength: 32, description: 'hidden prompt' };
  selected.parameters.properties.beta_feature = { type: 'array', minItems: 0, maxItems: 3,
    items: { anyOf: [{ type: 'number', minimum: -1.5, maximum: 8.5 }, { type: 'null' }] } };
  selected.parameters.properties.max_output_tokens = { minimum: 1, type: 'integer' };
  selected.parameters.required.push('alpha_feature', 'beta_feature');
  const summary = mainSchemaDiscovery(body);
  assert.equal(summary.selectedComplete, true);
  assert.equal(summary.selected.strict, true);
  assert.deepEqual(summary.selected.schema.required,
    ['command', 'description', 'alpha_feature', 'beta_feature']);
  assert.deepEqual(summary.selected.schema.properties.slice(-2).map(field => field.name),
    ['alpha_feature', 'beta_feature']);
  assert.deepEqual(summary.selected.schema.properties.find(field => field.name === 'alpha_feature').schema.enum,
    ['fast', 'slow', null]);
  assert.deepEqual(summary.selected.schema.properties.find(field => field.name === 'beta_feature').schema.items.anyOf[0].minimum, -1.5);
  assert.deepEqual(summary.selected.schema.properties.find(field => field.name === 'max_output_tokens'),
    { name: 'max_output_tokens', schema: { minimum: 1, type: 'integer' } });
  assert.equal(JSON.stringify(summary).includes('hidden prompt'), false);
});

test('unsafe identifiers, unsupported constraints, depth and budget remain incomplete', () => {
  const secret = 'sk_test_12345_SUPPOSED_SECRET';
  const unsafe = mainNativeRequest();
  unsafe.tools[0].tools[11].parameters.properties[secret] = { type: 'string' };
  unsafe.tools[0].tools[11].parameters.required.push(secret);
  const unsafeSummary = mainSchemaDiscovery(unsafe);
  assert.equal(unsafeSummary.selectedComplete, false);
  assert.equal(JSON.stringify(unsafeSummary).includes(secret), false);
  assert.notDeepEqual(unsafeSummary.selected.schema.properties.at(-1).name,
    unsafeSummary.selected.schema.properties.at(-2).name);
  const deep = mainNativeRequest();
  let nested = deep.tools[0].tools[11].parameters.properties.command;
  for (let index = 0; index < 9; index++) { nested.items = { type: 'array' }; nested = nested.items; }
  assert.equal(mainSchemaDiscovery(deep).selectedComplete, false);
  const unsafeStrict = mainNativeRequest();
  unsafeStrict.tools[0].tools[11].strict = { secret };
  const strictSummary = mainSchemaDiscovery(unsafeStrict);
  assert.equal(strictSummary.selectedComplete, false);
  assert.equal(JSON.stringify(strictSummary).includes(secret), false);
  const budget = mainNativeRequest();
  budget.tools[0].tools[11].parameters.properties = Object.fromEntries(Array.from({ length: 32 }, (_, i) =>
    [`field_${i}`, { type: 'string', enum: Array.from({ length: 16 }, (_, j) =>
      `v${i}_${j}_${'x'.repeat(23)}`) }]));
  budget.tools[0].tools[11].parameters.required = Object.keys(budget.tools[0].tools[11].parameters.properties);
  const bounded = mainSchemaDiscovery(budget);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 16_384);
  assert.equal(bounded.selectedComplete, false);
  assert.equal(bounded.selectedTruncated, true);
});

test('reviewed bash schema admits only fixed command and description in six namespaced frames', async () => {
  const h = await nativeProviderHarness();
  const selected = fixedBashCall(mainNativeRequest(), h.command);
  assert.deepEqual(selected.arguments,
    { command: h.command, description: 'Disposable native shell qualification' });
  const events = bashCallEvents(selected.arguments);
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.added',
    'response.function_call_arguments.delta', 'response.function_call_arguments.done',
    'response.output_item.done', 'response.completed']);
  assert.equal(events[1].item.namespace, 'muse');
  assert.equal(events[1].item.name, 'bash');
  assert.equal(events[1].item.call_id, 'call_native_shell_1');
  assert.equal(events[2].delta, events[3].arguments);
  assert.equal(events[3].arguments, events[4].item.arguments);
  const response = await h.post(mainNativeRequest());
  assert.equal(response.status, 200);
  assert.equal((response.body.match(/data: /g) ?? []).length, 6);
  assert.equal(h.provider.requests[0].namespace, 'muse');
  assert.deepEqual(h.provider.requests[0].argumentKeys, ['command', 'description']);
  assert.equal(h.provider.requests[0].commandSha256, createHash('sha256').update(h.command).digest('hex'));
  await h.provider.close();
});

test('assistant SSE content part reconstructs before delta and completed item', () => {
  const events = shellTextEvents();
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.added',
    'response.content_part.added', 'response.output_text.delta', 'response.output_text.done',
    'response.content_part.done', 'response.output_item.done', 'response.completed']);
  const item = structuredClone(events[1].item);
  const added = events[2];
  assert.equal(added.item_id, item.id);
  assert.equal(added.content_index, 0);
  assert.deepEqual(added.part, { type: 'output_text', text: '', annotations: [] });
  item.content[added.content_index] = structuredClone(added.part);
  const delta = events[3];
  item.content[delta.content_index].text += delta.delta;
  assert.equal(item.content[0].text, events[4].text);
  assert.deepEqual(item.content[0], events[5].part);
  assert.deepEqual(item.content, events[6].item.content);
  assert.deepEqual(events[7].response.output[0], events[6].item);
});

test('bash schema drift and unknown result envelopes reject without assistant text', async () => {
  for (const alter of [
    body => { body.tools[0].tools[11].strict = true; },
    body => { body.tools[0].tools[11].parameters.required.pop(); },
    body => { body.tools[0].tools[11].parameters.properties.login.type = 'string'; },
    body => { body.tools[0].tools[11].parameters.properties.sandbox_permissions.enum.pop(); },
    body => { body.tools[0].tools[11].parameters.properties.timeout_ms.minimum = 0; },
  ]) {
    const h = await nativeProviderHarness();
    const body = mainNativeRequest(); alter(body);
    assert.throws(() => fixedBashCall(body, h.command), { code: 'NATIVE_BASH_SCHEMA_INVALID' });
    const response = await h.post(body);
    assert.equal(response.status, 422);
    assert.equal(response.body, '');
    assert.equal(h.provider.requests[0].callId, undefined);
    await h.provider.close();
  }
  const h = await nativeProviderHarness();
  assert.equal((await h.post(mainNativeRequest())).status, 200);
  const unknown = shellResultRequest({ input: [{ type: 'function_call_output',
    call_id: 'call_native_shell_1', output: { secret: 'sk_test_12345_SUPPOSED_SECRET' } }] });
  assert.equal(matchingShellResult(unknown), false);
  assert.equal(shellResultEnvelopeShape(unknown).items[0].outputType, 'object');
  const response = await h.post(unknown);
  assert.equal(response.status, 422);
  assert.equal(response.body, '');
  assert.equal(h.provider.requests[1].rejection, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(JSON.stringify(h.provider.requests).includes('sk_test_12345_SUPPOSED_SECRET'), false);
  assert.equal((await h.post(shellResultRequest())).status, 429);
  await h.provider.close();
  const crossed = await nativeProviderHarness();
  assert.equal((await crossed.post(mainNativeRequest())).status, 200);
  const crossResult = await crossed.post(shellResultRequest({ previous_response_id: 'resp_native_reminder_1' }));
  assert.equal(crossResult.status, 422);
  assert.equal(crossed.provider.requests[1].resultEnvelope.previousResponse, 'reminder');
  await crossed.provider.close();
});

test('main call, result and reminder accept independent orders and overlap', async () => {
  for (const order of ['main-first', 'reminder-first', 'concurrent', 'reminder-after-result',
    'result-reminder-overlap']) {
    const h = await nativeProviderHarness();
    const main = mainNativeRequest();
    const reminder = fixedReminderRequest();
    const results = order === 'main-first' ? [await h.post(main), await h.post(reminder)] :
      order === 'reminder-first' ? [await h.post(reminder), await h.post(main)] :
        order === 'concurrent' ? await Promise.all([h.post(main), h.post(reminder)]) :
          order === 'result-reminder-overlap' ? [await h.post(main),
            ...await Promise.all([h.post(shellResultRequest()), h.post(reminder)])] :
            [await h.post(main), await h.post(shellResultRequest()), await h.post(reminder)];
    assert.ok(results.every(result => result.status === 200));
    const reminderResponse = results.find(result => result.body.includes('submit_reminder_decision'));
    assert.equal((reminderResponse.body.match(/data: /g) ?? []).length, 6);
    assert.deepEqual(h.provider.requests.filter(request => request.kind === 'native_reminder_call').length, 1);
    assert.deepEqual(h.provider.requests.filter(request => request.kind === 'native_tool_call').length, 1);
    assert.equal(h.provider.state.main, ['reminder-after-result', 'result-reminder-overlap'].includes(order) ?
      'result-accepted' : 'call-issued');
    assert.equal(h.provider.state.reminder, 'none-issued');
    assert.equal(h.provider.state.failed, false);
    if (!['reminder-after-result', 'result-reminder-overlap'].includes(order)) {
      const result = await h.post(shellResultRequest());
      assert.equal(result.status, 200);
      assert.match(result.body, /Fixture shell result observed/);
    }
    assert.equal(h.provider.state.main, 'result-accepted');
    assert.equal(h.provider.requests.filter(request => request.kind === 'matching_tool_result').length, 1);
    assert.equal((await h.post(shellResultRequest())).status, 429);
    assert.equal(h.provider.requests[3].bytes, 0);
    await h.provider.close();
  }
});

test('duplicate, unknown and malformed requests fail closed under attempt and byte caps', async () => {
  const mainReplay = await nativeProviderHarness();
  assert.equal((await mainReplay.post(mainNativeRequest())).status, 200);
  assert.equal((await mainReplay.post(mainNativeRequest())).status, 422);
  assert.equal(mainReplay.provider.requests[1].rejection, 'NATIVE_MAIN_REPLAY');
  assert.equal(mainReplay.provider.state.failed, true);
  await mainReplay.provider.close();
  const duplicate = await nativeProviderHarness();
  assert.equal((await duplicate.post(fixedReminderRequest())).status, 200);
  assert.equal((await duplicate.post(fixedReminderRequest())).status, 422);
  assert.equal(duplicate.provider.state.failed, true);
  assert.equal((await duplicate.post(mainNativeRequest())).status, 429);
  await duplicate.provider.close();
  const correlated = await nativeProviderHarness();
  assert.equal((await correlated.post({ ...fixedReminderRequest(),
    previous_response_id: 'resp_native_shell_1' })).status, 422);
  assert.equal(correlated.provider.requests[0].rejection, 'NATIVE_REMINDER_SEQUENCE_INVALID');
  await correlated.provider.close();
  const unknown = await nativeProviderHarness();
  assert.equal((await unknown.post({ model: 'fixture-native-shell', tools: [], input: 'NATIVE_SHELL_PROBE' })).status, 422);
  assert.equal((await unknown.post(fixedReminderRequest())).status, 429);
  await unknown.provider.close();
  const wrongPath = await nativeProviderHarness();
  const pathRequest = Readable.from(['{}']);
  pathRequest.method = 'POST'; pathRequest.url = '/unexpected';
  const pathResponse = { status: null, writeHead(status) { this.status = status; return this; },
    end() { return this; } };
  await wrongPath.handle(pathRequest, pathResponse);
  assert.equal(pathResponse.status, 404);
  assert.equal((await wrongPath.post(fixedReminderRequest())).status, 429);
  await wrongPath.provider.close();
  const malformed = await nativeProviderHarness();
  assert.equal((await malformed.postRaw('{bad-json')).status, 400);
  assert.equal((await malformed.post(fixedReminderRequest())).status, 429);
  await malformed.provider.close();
  const near = await nativeProviderHarness();
  assert.equal((await near.post({ ...fixedReminderRequest(), input: `NATIVE_SHELL_PROBE${'x'.repeat(92_000)}` })).status, 200);
  assert.ok(near.provider.requests[0].bytes > 91_989);
  await near.provider.close();
  const installedSized = await nativeProviderHarness();
  assert.equal((await installedSized.post({ ...mainNativeRequest(),
    input: `NATIVE_SHELL_PROBE${'m'.repeat(92_000)}` })).status, 200);
  assert.equal((await installedSized.post({ ...fixedReminderRequest(),
    input: `NATIVE_SHELL_PROBE${'r'.repeat(43_000)}` })).status, 200);
  assert.equal((await installedSized.post(shellResultRequest())).status, 200);
  assert.ok(installedSized.provider.state.inputBytes > 135_000);
  assert.ok(installedSized.provider.state.outputBytes < 65_536);
  await installedSized.provider.close();
  const oversized = await nativeProviderHarness();
  assert.equal((await oversized.postRaw('x'.repeat(262_145))).status, 413);
  assert.equal(oversized.provider.requests[0].rejection, 'REQUEST_TOO_LARGE');
  assert.equal((await oversized.post(fixedReminderRequest())).status, 429);
  await oversized.provider.close();
});

test('active native request cap rejects a third request before consuming its body', async () => {
  const h = await nativeProviderHarness();
  const makePending = () => {
    const request = new Readable({ read() {} });
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, writeHead(status) { this.status = status; return this; },
      end() { return this; } };
    return { request, response, handling: h.handle(request, response) };
  };
  const first = makePending();
  const second = makePending();
  const third = makePending();
  await third.handling;
  assert.equal(third.response.status, 429);
  assert.equal(h.provider.requests[2].bytes, 0);
  first.request.push(JSON.stringify(mainNativeRequest())); first.request.push(null);
  second.request.push(JSON.stringify(fixedReminderRequest())); second.request.push(null);
  await Promise.all([first.handling, second.handling]);
  assert.equal(h.provider.state.failed, true);
  await h.provider.close();
});

test('provider freeze rejects and records a request arriving during shutdown hold', async () => {
  let lateStatus;
  const h = await nativeProviderHarness({ onShut: async handle => {
    const request = Readable.from([JSON.stringify(fixedReminderRequest())]);
    request.method = 'POST'; request.url = '/responses';
    const response = { status: null, writeHead(status) { this.status = status; return this; },
      end() { return this; } };
    await handle(request, response);
    lateStatus = response.status;
  } });
  assert.equal((await h.post(mainNativeRequest())).status, 200);
  assert.equal((await h.post(shellResultRequest())).status, 200);
  await h.provider.freeze();
  assert.equal(lateStatus, 429);
  assert.equal(h.provider.state.primaryCode, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  assert.equal(h.provider.requests[2].rejection, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  assert.equal(h.provider.state.main, 'result-accepted');
  await h.provider.close();
});

test('provider freeze drains an admitted reminder whose body completes during shutdown', async () => {
  let pending;
  const h = await nativeProviderHarness({ onShut: async () => {
    assert.equal(h.provider.state.admissionClosed, true);
    assert.equal(h.provider.state.active, 1);
    pending.request.push(JSON.stringify(fixedReminderRequest()));
    pending.request.push(null);
  } });
  assert.equal((await h.post(mainNativeRequest())).status, 200);
  const request = new Readable({ read() {} });
  request.method = 'POST'; request.url = '/responses';
  const response = { status: null, body: null, writeHead(status) { this.status = status; return this; },
    end(value = '') { this.body = value; return this; } };
  pending = { request, handling: h.handle(request, response) };
  assert.equal(h.provider.state.active, 1);
  await h.provider.freeze();
  await pending.handling;
  assert.equal(response.status, 200);
  assert.match(response.body, /submit_reminder_decision/);
  assert.equal(h.provider.state.active, 0);
  assert.equal(h.provider.state.failed, false);
  assert.equal(h.provider.state.primaryCode, undefined);
  assert.deepEqual(h.provider.requests.map(item => item.kind),
    ['native_tool_call', 'native_reminder_call']);
  await h.provider.close();
});

test('provider freeze bars a new request while attempt budget remains', async () => {
  const h = await nativeProviderHarness();
  assert.equal((await h.post(mainNativeRequest())).status, 200);
  await h.provider.freeze();
  const late = await h.post(fixedReminderRequest());
  assert.equal(late.status, 429);
  assert.equal(h.provider.requests[1].bytes, 0);
  assert.equal(h.provider.requests[1].rejection, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  assert.equal(h.provider.state.primaryCode, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  await h.provider.close();
});

test('catalog flood has bounded responses and retained request evidence', async () => {
  const h = await nativeProviderHarness();
  const get = async () => {
    const request = Readable.from([]);
    request.method = 'GET'; request.url = '/muse-code/models';
    const response = { status: null, body: '', writeHead(status) { this.status = status; return this; },
      end(value = '') { this.body = value; return this; } };
    await h.handle(request, response);
    return response;
  };
  const first = await Promise.all(Array.from({ length: 10 }, get));
  assert.deepEqual(first.map(response => response.status), [200, 200, 200, 200,
    429, 429, 429, 429, 429, 429]);
  for (let index = 0; index < 990; index++) await get();
  assert.equal(h.provider.requests.length, 8);
  assert.deepEqual(h.provider.requests[7], { kind: 'omitted_requests', count: 993 });
  assert.ok(h.provider.state.outputBytes < 65_536);
  assert.equal(h.provider.state.failed, true);
  assert.equal((await h.post(fixedReminderRequest())).status, 429);
  await h.provider.close();
});

test('shell output decoder retains a typed primary native guest failure', () => {
  const failure = { kind: 'guest_transport_error', stage: 'native_turn',
    code: 'NATIVE_REMINDER_SCHEMA_ONLY', message: 'schema-only stop', providerRequests: [] };
  assert.deepEqual(decodeShellOutcomeLine(JSON.stringify(failure)), failure);
  assert.throws(() => decodeShellOutcomeLine(JSON.stringify({ ...failure, code: 'bad secret' })),
    { code: 'GUEST_OUTPUT_INVALID' });
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
  const mainSchema = mainSchemaDiscovery(mainNativeRequest());
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
        namespace: 'muse', argumentKeys: ['command', 'description'], mainSchema,
        schemaSha256: createHash('sha256').update(JSON.stringify(mainSchema.selected)).digest('hex'),
        commandSha256: ready.commandSha256 },
      ...approval ? [] : [{ method: 'POST', path: '/responses', kind: 'matching_tool_result',
        model: 'fixture-native-shell', responseId: 'resp_native_shell_2', forCallId: 'call_native_shell_1',
        outputMarkers: { workspaceWritten: workspaceReportedWritten, dummyAuthVisible: false } }]],
    observations: { approvals: approval ? [approvalValue] : [], protocolErrors: [],
      items: approval ? [] : [{ itemId: 'item-1', turnId, callId: 'call_native_shell_1',
        tool: 'bash', status: 'completed', commandMatch: true, outputMarkers: true,
        dummyAuthVisible: false, workspaceReportedWritten }] } };
}

function readFileOutcomeFixture(ready, reminderFirst = false) {
  const turnId = '0199aabb-ccdd-7eef-8abc-0123456789ac';
  const mainSchema = readFileSchemaDiscovery(readFileNativeRequest());
  const main = { method: 'POST', path: '/responses', kind: 'native_read_file_schema',
    model: 'fixture-native-shell', responseId: 'resp_native_read_file_schema_1', mainSchema,
    schemaSha256: createHash('sha256').update(JSON.stringify(mainSchema.selected)).digest('hex') };
  const reminder = { method: 'POST', path: '/responses', kind: 'native_reminder_call',
    model: 'fixture-native-shell', responseId: 'resp_native_reminder_1',
    itemId: 'fc_native_reminder_1', callId: 'call_native_reminder_1',
    payloadSha256: createHash('sha256').update(JSON.stringify(fixedNoReminderPayload(fixedReminderRequest())))
      .digest('hex') };
  return { kind: 'native_read_file_schema_outcome', sessionId: ready.metadata.sessionId, turnId,
    turnAck: { status: 'accepted', disposition: 'started', startedNewTurn: true },
    commands: ['session/start', 'session/read', 'turn/start'],
    event: { kind: 'turn_completed', terminal: 'completed', turnId, sessionId: ready.metadata.sessionId },
    pending: null, observations: { approvals: [], items: [], reminders: reminderFirst ?
      [{ callId: 'call_native_reminder_1', turnId, status: 'completed' }] : [],
    protocolErrors: [], omitted: { approvals: 0, items: 0, reminders: 0, protocolErrors: 0 } },
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      ...reminderFirst ? [reminder, main] : [main] ] };
}

function readFileProbeOutcomeFixture(ready) {
  const turnId = '0199aabb-ccdd-7eef-8abc-0123456789ac';
  const workspace = ready.metadata.workspaceRoot;
  const mainSchema = readFileSchemaDiscovery(readFileProbeRequest(), 'NATIVE_READ_FILE_PROBE');
  const verificationSchema = verificationReminderSchemaDiscovery(verifiedVerificationRequest());
  const path = join(workspace, 'read-canary.txt');
  return { kind: 'native_read_file_outcome', sessionId: ready.metadata.sessionId, turnId,
    turnAck: { status: 'accepted', disposition: 'started', startedNewTurn: true },
    commands: ['session/start', 'session/read', 'turn/start'], pending: null,
    event: { kind: 'turn_completed', terminal: 'completed', turnId, sessionId: ready.metadata.sessionId },
    observations: { approvals: [], items: [{ itemId: 'item-read', turnId,
      callId: 'call_native_read_file_1', tool: 'read_file', status: 'completed',
      argsMatch: true, exactCanary: true,
      outputShape: { type: 'string', bytes: Buffer.byteLength(readFileDecoratedOutput(workspace)) } }],
    reminders: [], protocolErrors: [],
    omitted: { approvals: 0, items: 0, reminders: 0, protocolErrors: 0 } },
    providerRequests: [{ method: 'GET', path: '/muse-code/models' },
      { method: 'POST', path: '/responses', kind: 'native_read_file_call', model: 'fixture-native-shell',
        namespace: 'muse', responseId: 'resp_native_read_file_1', itemId: 'fc_native_read_file_1',
        callId: 'call_native_read_file_1', argumentKeys: ['path', 'offset', 'limit'], mainSchema,
        pathSha256: createHash('sha256').update(path).digest('hex'),
        schemaSha256: createHash('sha256').update(JSON.stringify(mainSchema.selected)).digest('hex') },
      { method: 'POST', path: '/responses', kind: 'native_verification_reminder_call',
        model: 'fixture-native-shell', responseId: 'resp_native_verify_reminder_1',
        itemId: 'fc_native_verify_reminder_1', callId: 'call_native_verify_reminder_1',
        verificationSchema, association: { httpRelation: 'unknown', omittedItems: 0 },
        payloadSha256: createHash('sha256').update(JSON.stringify(fixedVerificationPayload(verifiedVerificationRequest())))
          .digest('hex') },
      { method: 'POST', path: '/responses', kind: 'matching_read_file_result', model: 'fixture-native-shell',
        responseId: 'resp_native_read_file_2', forCallId: 'call_native_read_file_1', exactCanary: true,
        previousResponse: 'absent', inputCount: 4, callItemId: 'fc_native_read_file_1',
        functionName: 'muse.read_file', argumentsExactFixed: true,
        outputBytes: Buffer.byteLength(readFileDecoratedOutput(workspace)),
        outputSha256: createHash('sha256').update(readFileDecoratedOutput(workspace)).digest('hex'),
        nativeChildAssociation: 'unknown' }] };
}

test('read_file outcome requires exact call, result, reminders, turn and no approval', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  ready.readCanarySha256 = createHash('sha256').update('PASSEUR_NATIVE_READ_CANARY\n').digest('hex');
  const outcome = readFileProbeOutcomeFixture(ready);
  assert.equal(validateReadFileOutcome(ready, outcome, ready.metadata.workspaceRoot).kind,
    'native_workspace_read_observed');
  const full = structuredClone(outcome);
  full.providerRequests.splice(1, 0, ...Array.from({ length: 3 }, () =>
    ({ method: 'GET', path: '/muse-code/models' })));
  assert.equal(validateReadFileOutcome(ready, full, ready.metadata.workspaceRoot).kind,
    'native_workspace_read_observed');
  const observed = structuredClone(outcome);
  observed.observations.reminders = [{ callId: 'call_native_verify_reminder_1',
    turnId: observed.turnId, status: 'completed', tool: 'submit_reminder_decision', payloadMatch: true }];
  assert.equal(validateReadFileOutcome(ready, observed, ready.metadata.workspaceRoot).kind,
    'native_workspace_read_observed');
  for (const edit of [
    value => { value.providerRequests[1].pathSha256 = 'wrong'; },
    value => { value.providerRequests[3].forCallId = 'other'; },
    value => { value.providerRequests[3].functionName = 'read_file'; },
    value => { value.providerRequests[3].outputSha256 = 'other'; },
    value => { value.providerRequests[3].inputCount = 5; },
    value => { value.providerRequests.push(structuredClone(value.providerRequests[1])); },
    value => { value.observations.approvals.push({ kind: 'unexpected_read_approval' }); },
    value => { value.observations.items[0].exactCanary = false; },
    value => { value.observations.items[0].outputShape.bytes++; },
    value => { value.providerRequests[2].verificationSchema.selectedComplete = false; },
    value => { value.providerRequests[1].mainSchema.identityValid = false; },
    value => { value.providerRequests[2].verificationSchema.identityValid = false; },
    value => { value.observations.reminders = [{ callId: 'call_native_verify_reminder_1' },
      { callId: 'call_native_verify_reminder_1' }]; },
    value => { value.observations.reminders = [{ callId: 'call_native_verify_reminder_1',
      turnId: value.turnId, status: 'completed', tool: 'bash', payloadMatch: true }]; },
    value => { value.observations.reminders = [{ callId: 'call_native_verify_reminder_1',
      turnId: value.turnId, status: 'completed', tool: 'submit_reminder_decision', payloadMatch: false }]; },
    value => { value.observations.reminders = Array.from({ length: 2 }, () =>
      ({ callId: 'call_native_verify_reminder_1', turnId: value.turnId, status: 'completed',
        tool: 'submit_reminder_decision', payloadMatch: true })); },
    value => { value.observations.reminders = [{ callId: 'call_native_reminder_1',
      turnId: value.turnId, status: 'completed', tool: 'submit_reminder_decision', payloadMatch: true }]; },
    value => { value.event.turnId = 'foreign'; },
  ]) {
    const changed = structuredClone(outcome);
    edit(changed);
    assert.throws(() => validateReadFileOutcome(ready, changed, ready.metadata.workspaceRoot),
      { code: 'NATIVE_READ_FILE_OUTCOME_INVALID' });
  }
});

test('read_file outcome correlates two distinct skill reminders around the accepted result', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  ready.readCanarySha256 = createHash('sha256').update('PASSEUR_NATIVE_READ_CANARY\n').digest('hex');
  const outcome = readFileProbeOutcomeFixture(ready);
  const payloadSha256 = createHash('sha256').update(JSON.stringify(
    fixedNoReminderPayload(fixedReminderRequest()))).digest('hex');
  const first = { method: 'POST', path: '/responses', kind: 'native_reminder_call',
    model: 'fixture-native-shell', ordinal: 1, responseId: 'resp_native_reminder_1',
    itemId: 'fc_native_reminder_1', callId: 'call_native_reminder_1', payloadSha256 };
  const second = { method: 'POST', path: '/responses', kind: 'native_reminder_call',
    model: 'fixture-native-shell', ordinal: 2, responseId: 'resp_native_reminder_2',
    itemId: 'fc_native_reminder_2', callId: 'call_native_reminder_2', payloadSha256,
    association: { omittedItems: 0, httpRelation: 'issued_main',
      issuedAtRequest: { main: true, reminder: true, reminder2: false, verification: true } } };
  outcome.providerRequests.splice(1, 0, first);
  outcome.providerRequests.push(second);
  outcome.observations.reminders = [
    { callId: 'call_native_reminder_1', turnId: outcome.turnId, status: 'completed',
      tool: 'submit_reminder_decision', payloadMatch: true },
    { callId: 'call_native_reminder_2', turnId: outcome.turnId, status: 'completed',
      tool: 'submit_reminder_decision', payloadMatch: true },
  ];
  assert.equal(validateReadFileOutcome(ready, outcome, ready.metadata.workspaceRoot).kind,
    'native_workspace_read_observed');
  const verificationAfter = structuredClone(outcome);
  const [verification] = verificationAfter.providerRequests.splice(3, 1);
  verificationAfter.providerRequests.push(verification);
  assert.equal(validateReadFileOutcome(ready, verificationAfter, ready.metadata.workspaceRoot).kind,
    'native_workspace_read_observed');
  for (const edit of [
    value => { value.providerRequests.at(-1).callId = 'call_native_reminder_1'; },
    value => { value.providerRequests.at(-1).association.issuedAtRequest.main = false; },
    value => { value.providerRequests.at(-1).association.httpRelation = 'foreign'; },
    value => { value.observations.reminders[1].callId = 'call_native_reminder_1'; },
  ]) {
    const changed = structuredClone(outcome);
    edit(changed);
    assert.throws(() => validateReadFileOutcome(ready, changed, ready.metadata.workspaceRoot),
      { code: 'NATIVE_READ_FILE_OUTCOME_INVALID' });
  }
});

test('read_file outcome requires one schema, no native file call and exact turn', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  const outcome = readFileOutcomeFixture(ready);
  assert.equal(validateReadFileSchemaOutcome(ready, outcome).kind, 'native_read_file_schema_observed');
  const reminder = readFileOutcomeFixture(ready, true);
  assert.equal(validateReadFileSchemaOutcome(ready, reminder).kind, 'native_read_file_schema_observed');
  for (const edit of [
    value => { value.observations.items.push({ tool: 'read_file' }); },
    value => { value.providerRequests.push({ method: 'POST', path: '/responses', kind: 'native_tool_call' }); },
    value => { value.event.turnId = 'foreign'; },
    value => { value.providerRequests[1].mainSchema.identityValid = false; },
    value => { value.providerRequests[1].responseId = 'other'; },
  ]) {
    const changed = structuredClone(outcome);
    edit(changed);
    assert.throws(() => validateReadFileSchemaOutcome(ready, changed),
      { code: 'NATIVE_READ_FILE_SCHEMA_OUTCOME_INVALID' });
  }
  const incomplete = structuredClone(outcome);
  incomplete.providerRequests[1].mainSchema.selectedComplete = false;
  assert.equal(validateReadFileSchemaOutcome(ready, incomplete).kind, 'native_read_file_schema_incomplete');
  const missing = structuredClone(outcome);
  Object.assign(missing.providerRequests[1].mainSchema, { identityValid: false,
    readFileCount: 0, selected: null, selectedComplete: false });
  missing.providerRequests[1].schemaSha256 = null;
  assert.equal(validateReadFileSchemaOutcome(ready, missing).kind, 'native_read_file_schema_incomplete');
});

test('read_file controller keeps schema observation separate from confirmed stop and primary error', async () => {
  const run = async ({ stopFails = false, guestFailure = false, incomplete = false,
    guestFailureCode = 'NATIVE_REQUEST_UNCLASSIFIED' } = {}) => {
    const result = await qualifyNativeReadFileSchema({
      stage: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
      startSentinel: async () => ({ port: 31001, close: async () => undefined }),
      probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
      launch: (_prepared, config) => {
        assert.equal(config.phase, 'read-file-schema');
        const ready = shellReadyFixture(config.workspace);
        const outcome = guestFailure ? { kind: 'guest_transport_error', stage: 'native_turn',
          code: guestFailureCode, message: 'unreviewed native request',
          providerRequests: [{ method: 'POST', path: '/responses', rejection: guestFailureCode }] } :
          readFileOutcomeFixture(ready);
        if (incomplete) outcome.providerRequests[1].mainSchema.selectedComplete = false;
        const done = { code: guestFailure ? 1 : 0, signal: null, timedOut: false, overflow: false,
          statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'], stderr: '',
          output: [JSON.stringify({ kind: 'guest_ready', result: ready }),
            JSON.stringify(guestFailure ? outcome : { kind: 'guest_outcome', result: outcome }),
            JSON.stringify(outcome)] };
        return { pid: 100, ready: Promise.resolve(ready),
          liveStatus: Promise.resolve({ child: 101, exit: null }), outcome: Promise.resolve(outcome),
          releaseTurn: () => undefined, releaseShutdown: () => undefined, abort: () => undefined,
          finished: Promise.resolve(done) };
      },
      capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
        supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
      stop: async () => { if (stopFails) throw Object.assign(new Error('survivor'),
        { code: 'STOP_SURVIVOR' }); return { kind: 'confirmed', pidns: 'pid:[1]' }; },
    });
    assert.equal(result.retainedFixtures.length, 1);
    await rm(result.retainedFixtures[0], { recursive: true, force: true });
    return result;
  };
  const observed = await run();
  assert.equal(observed.kind, 'native_read_file_schema_observed');
  assert.equal(observed.evidence.stop.kind, 'confirmed');
  assert.equal(observed.effects.shellAbsent, true);
  assert.equal((await run({ incomplete: true })).kind, 'native_read_file_schema_incomplete');
  const uncertain = await run({ stopFails: true });
  assert.equal(uncertain.code, 'STOP_SURVIVOR');
  assert.equal(uncertain.stopProof, 'unconfirmed');
  const primary = await run({ guestFailure: true, stopFails: true });
  assert.equal(primary.code, 'NATIVE_REQUEST_UNCLASSIFIED');
  assert.equal(primary.evidence.primaryGuestFailure.code, 'NATIVE_REQUEST_UNCLASSIFIED');
  assert.equal(primary.evidence.stopError.code, 'STOP_SURVIVOR');
  const discovery = await run({ guestFailure: true, stopFails: true,
    guestFailureCode: 'NATIVE_VERIFY_REMINDER_SCHEMA_ONLY' });
  assert.equal(discovery.code, 'NATIVE_VERIFY_REMINDER_SCHEMA_ONLY');
  assert.equal(discovery.evidence.primaryGuestFailure.code, 'NATIVE_VERIFY_REMINDER_SCHEMA_ONLY');
  assert.equal(discovery.evidence.stopError.code, 'STOP_SURVIVOR');
});

test('read_file probe controller requires exact canary, no shell effect and confirmed stop', async () => {
  const run = async ({ stopFails = false, guestFailure = false, alterCanary = false } = {}) => {
    const result = await qualifyNativeReadFile({
      stage: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
      startSentinel: async () => ({ port: 31001, close: async () => undefined }),
      probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
      launch: (_prepared, config) => {
        assert.equal(config.phase, 'read-file-probe');
        const ready = shellReadyFixture(config.workspace);
        ready.readCanarySha256 = createHash('sha256').update('PASSEUR_NATIVE_READ_CANARY\n').digest('hex');
        const outcome = guestFailure ? { kind: 'guest_transport_error', stage: 'native_turn',
          code: 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN', message: 'unknown native result',
          providerRequests: [{ method: 'POST', path: '/responses',
            rejection: 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN' }] } : readFileProbeOutcomeFixture(ready);
        if (alterCanary) outcome.providerRequests[1].pathSha256 = 'wrong';
        const done = { code: guestFailure ? 1 : 0, signal: null, timedOut: false, overflow: false,
          statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'], stderr: '',
          output: [JSON.stringify({ kind: 'guest_ready', result: ready }),
            JSON.stringify(guestFailure ? outcome : { kind: 'guest_outcome', result: outcome }),
            JSON.stringify(outcome)] };
        return { pid: 100, ready: Promise.resolve(ready),
          liveStatus: Promise.resolve({ child: 101, exit: null }), outcome: Promise.resolve(outcome),
          releaseTurn: () => undefined, releaseShutdown: () => undefined, abort: () => undefined,
          finished: Promise.resolve(done) };
      },
      capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
        supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
      stop: async () => { if (stopFails) throw Object.assign(new Error('survivor'),
        { code: 'STOP_SURVIVOR' }); return { kind: 'confirmed', pidns: 'pid:[1]' }; },
    });
    assert.equal(result.retainedFixtures.length, 1);
    await rm(result.retainedFixtures[0], { recursive: true, force: true });
    return result;
  };
  const observed = await run();
  assert.equal(observed.kind, 'native_workspace_read_observed');
  assert.equal(observed.evidence.stop.kind, 'confirmed');
  assert.equal(observed.effects.shellAbsent, true);
  assert.equal((await run({ alterCanary: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
  const uncertain = await run({ stopFails: true });
  assert.equal(uncertain.code, 'STOP_SURVIVOR');
  assert.equal(uncertain.stopProof, 'unconfirmed');
  const primary = await run({ stopFails: true, guestFailure: true });
  assert.equal(primary.code, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(primary.evidence.primaryGuestFailure.code, 'NATIVE_READ_FILE_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(primary.evidence.stopError.code, 'STOP_SURVIVOR');
});

test('protected read routes need correlated output, intact host controls and confirmed stop', async () => {
  const run = async ({ route = 'direct', output = 'denied', stopFails = false, changeControl = false,
    wrongCall = false, approval = false, nativeMismatch = false, wrongStatus = false,
    tamperLinkBefore = false, tamperLinkAfter = null, wrongProc = false,
    wrongProcNamespace = false,
    substitutePath = false, changedCandidate = false } = {}) => {
    let target;
    let workspace;
    let protectedRoot;
    const qualifier = route === 'direct' ? qualifyNativeProtectedRead :
      route === 'symlink' ? qualifyNativeProtectedSymlinkRead : qualifyNativeProtectedProcRead;
    const result = await qualifier({
      stage: async root => { const runtime = join(root, 'runtime'); await mkdir(runtime);
        if (tamperLinkBefore) { const link = join(root, 'workspace', 'protected-link');
          if (tamperLinkBefore === 'replace') {
            const replacement = join(root, 'workspace', 'new-protected-link');
            await symlink(join(root, 'protected'), replacement); await rename(replacement, link);
          } else { await rm(link); await symlink('/tmp/other', link); } }
        return runtime; },
      startSentinel: async () => ({ port: 31001, close: async () => undefined }),
      probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
      launch: (_prepared, config) => {
        assert.equal(config.phase, 'protected-read');
        assert.equal(config.protectedRoute, route);
        workspace = config.workspace;
        protectedRoot = config.protectedRoot;
        target = protectedReadPath(route, workspace, protectedRoot);
        const ready = shellReadyFixture(config.workspace);
        ready.commandSha256 = createHash('sha256').update('NATIVE_PROTECTED_READ_ONLY').digest('hex');
        if (route === 'proc') ready.procPid1 = { pid: 1,
          pidns: wrongProcNamespace ? 'pid:[foreign]' : 'pid:[fixture]',
          start: wrongProc ? 'wrong' : '12345' };
        let guest = readFileProbeOutcomeFixture(ready);
        guest.kind = 'native_protected_read_outcome';
        guest.observations.items[0].status = wrongStatus ? 'completed' : 'failed';
        const main = guest.providerRequests.find(request => request.kind === 'native_read_file_call');
        main.pathSha256 = createHash('sha256').update(substitutePath ?
          join(config.protectedRoot, 'direct-read-target.txt') : target).digest('hex');
        if (wrongCall) main.callId = 'foreign';
        if (approval) guest.observations.approvals.push({ kind: 'unexpected_read_approval' });
        const reported = guest.providerRequests.find(request => request.kind === 'matching_read_file_result');
        reported.kind = 'matching_protected_read_result';
        reported.exactCanary = false;
        const rawPromise = readFile(join(config.protectedRoot, 'direct-read-target.txt'), 'utf8').then(content => {
          const marker = content.trim();
          const raw = output === 'exposed' ? `Read text file \`${target}\`.\n1|${marker}` :
            output === 'denied' ? (changedCandidate ? installedProtectedError(target, config.workspace).replace(
              `resolved candidate "${target}"`,
              `resolved candidate "${join(config.protectedRoot, 'direct-read-target.txt')}"`) :
              installedProtectedError(target, config.workspace)) :
              'unfamiliar native error';
          reported.outputBytes = Buffer.byteLength(raw);
          reported.outputSha256 = createHash('sha256').update(raw).digest('hex');
          guest.observations.items[0].exactCanary = false;
          guest.observations.items[0].outputShape.bytes = Buffer.byteLength(raw);
          guest.observations.items[0].outputShape.sha256 = createHash('sha256').update(
            nativeMismatch ? `${raw.slice(0, -1)}X` : raw).digest('hex');
          if (output === 'exposed') {
            reported.kind = 'protected_read_result_classified';
            guest = { kind: 'guest_transport_error', stage: 'native_turn',
              code: 'NATIVE_PROTECTED_MARKER_EXPOSED',
              message: 'host classified protected content exposure',
              providerRequests: guest.providerRequests };
          }
          return config.classifyProtectedOutput(raw);
        });
        const done = rawPromise.then(() => ({ code: output === 'exposed' ? 1 : 0,
          signal: null, timedOut: false,
          overflow: false, statusClosed: true, statusLines: ['{"child-pid":101}', '{"exit-code":0}'],
          stderr: '', output: [JSON.stringify({ kind: 'guest_ready', result: ready }),
            JSON.stringify(guest.kind === 'guest_transport_error' ? guest :
              { kind: 'guest_outcome', result: guest }), JSON.stringify(guest)] }));
        return { pid: 100, ready: Promise.resolve(ready),
          liveStatus: Promise.resolve({ child: 101, exit: null }), outcome: done.then(() => guest),
          protectedResult: rawPromise, protectedFrameError: () => null,
          releaseTurn: () => undefined, releaseShutdown: () => undefined, abort: () => undefined,
          finished: done };
      },
      capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
        supervisor: { netns: 'net:[2]' }, pidns: 'pid:[fixture]', boot: 'boot-a',
        init: { nspid: [1], pidns: 'pid:[fixture]', start: '12345', netns: 'net:[2]', boot: 'boot-a' },
        fd: { close: async () => undefined } }),
      stop: async () => { if (changeControl) await writeFile(join(protectedRoot, 'direct-read-target.txt'), 'changed');
        if (tamperLinkAfter) {
          const link = join(workspace, 'protected-link');
          if (tamperLinkAfter === 'replace') {
            const replacement = join(workspace, 'new-protected-link');
            await symlink(protectedRoot, replacement); await rename(replacement, link);
          } else { await rm(link); await symlink('/tmp/other', link); }
        }
        if (stopFails) throw Object.assign(new Error('survivor'), { code: 'STOP_SURVIVOR' });
        return { kind: 'confirmed', pidns: 'pid:[1]' }; },
    });
    assert.equal(JSON.stringify(result).includes('PASSEUR_PROTECTED_'), false);
    await rm(result.retainedFixtures[0], { recursive: true, force: true });
    return result;
  };
  assert.equal((await run()).kind, 'native_protected_direct_read_denied');
  assert.equal((await run({ output: 'exposed' })).kind, 'native_protected_direct_read_exposed');
  assert.equal((await run({ output: 'other' })).kind, 'native_protected_direct_read_unknown');
  assert.equal((await run({ wrongCall: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
  assert.equal((await run({ approval: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
  assert.equal((await run({ nativeMismatch: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
  assert.equal((await run({ wrongStatus: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
  assert.equal((await run({ changeControl: true })).code, 'NATIVE_PROTECTED_CONTROL_CHANGED');
  assert.equal((await run({ stopFails: true })).code, 'STOP_SURVIVOR');
  for (const route of ['symlink', 'proc']) {
    assert.equal((await run({ route })).kind, `native_protected_${route}_read_denied`);
    assert.equal((await run({ route, changedCandidate: true })).kind,
      `native_protected_${route}_read_unknown`);
    assert.equal((await run({ route, substitutePath: true })).code, 'NATIVE_READ_FILE_OUTCOME_INVALID');
    assert.equal((await run({ route, output: 'exposed' })).kind,
      `native_protected_${route}_read_exposed`);
    assert.equal((await run({ route, stopFails: true })).code, 'STOP_SURVIVOR');
  }
  assert.equal((await run({ route: 'symlink', tamperLinkAfter: 'retarget' })).code,
    'NATIVE_PROTECTED_LINK_INVALID');
  assert.equal((await run({ route: 'symlink', tamperLinkAfter: 'replace' })).code,
    'NATIVE_PROTECTED_LINK_INVALID');
  assert.equal((await run({ route: 'proc', wrongProc: true })).code, 'NATIVE_PROC_PID1_UNBOUND');
  assert.equal((await run({ route: 'proc', wrongProcNamespace: true })).code,
    'NATIVE_PROC_PID1_UNBOUND');
  assert.equal((await run({ route: 'symlink', tamperLinkBefore: true })).code,
    'NATIVE_PROTECTED_LINK_INVALID');
  assert.equal((await run({ route: 'symlink', tamperLinkBefore: 'replace' })).code,
    'NATIVE_PROTECTED_LINK_INVALID');
});

test('protected control missing before launch prevents host start', async () => {
  let launched = false;
  const result = await qualifyNativeProtectedRead({
    stage: async root => { await rm(join(root, 'protected', 'direct-read-target.txt'));
      const runtime = join(root, 'runtime'); await mkdir(runtime); return runtime; },
    startSentinel: async () => ({ port: 31001, close: async () => undefined }),
    probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
    launch: () => { launched = true; assert.fail('missing control must block host launch'); },
  });
  assert.equal(launched, false);
  assert.equal(result.code, 'NATIVE_PROTECTED_CONTROL_INVALID');
  assert.equal(result.stopProof, 'unconfirmed');
  await rm(result.retainedFixtures[0], { recursive: true, force: true });
});

test('native approval presentation binds the exact fixed bash arguments without deciding it', () => {
  const command = shellProbeCommand('/tmp/fixture/workspace', '/tmp/fixture/protected', 'protected-canary');
  const approval = { approvalId: 'approval-1', sessionId: 'session-1', turnId: 'turn-1',
    toolCallId: 'call_native_shell_1', toolName: 'bash',
    currentRequirementId: { approvalId: 'approval-1', sourceIndex: 0 },
    availableChoices: [{ choiceId: 'deny', decision: 'denied', scope: 'once', label: 'Deny' }],
    rawArgs: JSON.stringify({ command, description: 'Disposable native shell qualification' }) };
  assert.equal(approvalSummary(approval, command).commandMatch, true);
  for (const rawArgs of [JSON.stringify({ command }),
    JSON.stringify({ command, description: 'Disposable native shell qualification', sandbox_permissions: 'require_escalated' }),
    JSON.stringify({ command: 'other', description: 'Disposable native shell qualification' })]) {
    assert.throws(() => approvalSummary({ ...approval, rawArgs }, command), { code: 'NATIVE_APPROVAL_INVALID' });
  }
});

test('held handoff shows full fixed command and guards one fresh current approval decision', async () => {
  const workspace = '/tmp/fixture/workspace';
  const protectedRoot = '/tmp/fixture/protected';
  const command = shellProbeCommand(workspace, protectedRoot, 'protected-canary');
  const raw = { approvalId: 'approval-1', sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab',
    turnId: '0199aabb-ccdd-7eef-8abc-0123456789ac', toolCallId: 'call_native_shell_1',
    toolName: 'bash', currentRequirementId: { approvalId: 'approval-1', sourceIndex: 0 },
    availableChoices: [{ choiceId: 'allow_once', decision: 'approved', scope: 'once', label: 'Allow once' },
      { choiceId: 'abort', decision: 'abort', scope: 'once', label: 'Reject' }],
    rawArgs: JSON.stringify({ command, description: 'Disposable native shell qualification' }) };
  const handoff = heldApprovalPresentation(raw, command, workspace, protectedRoot, 'protected-canary');
  const ready = shellReadyFixture(workspace);
  validateHeldHandoff(ready, handoff, command, workspace, protectedRoot, 'protected-canary');
  assert.equal(handoff.command, command);
  assert.equal(handoff.waitBudgetMs, 590_000);
  assert.ok(Date.parse(handoff.expiresAt) > Date.now());
  assert.equal(handoff.effects.protectedDirect, '/tmp/fixture/protected/protected-canary');
  const input = { kind: 'choice', handoffId: handoff.handoffId, sessionId: raw.sessionId,
    turnId: raw.turnId, callId: raw.toolCallId, approvalId: raw.approvalId,
    requirementId: raw.currentRequirementId, choiceId: 'allow_once' };
  assert.equal(validateHeldDecision(handoff, input).decision, 'approved');
  assert.deepEqual(validateHeldInitialApproval({ sessionId: raw.sessionId }, { turnId: raw.turnId },
    { kind: 'approval', approval: handoff.approval }, { approvals: [raw], userInputs: [] }, command),
  handoff.approval);
  assert.throws(() => validateHeldInitialApproval({ sessionId: raw.sessionId }, { turnId: 'other-turn' },
    { kind: 'approval', approval: handoff.approval }, { approvals: [raw], userInputs: [] }, command),
  { code: 'NATIVE_HELD_APPROVAL_STALE' });
  for (const change of [{ choiceId: 'unoffered' }, { approvalId: 'stale' },
    { sessionId: 'other' }, { requirementId: { ...input.requirementId, sourceIndex: 1 } },
    { handoffId: '0'.repeat(32) }]) {
    assert.throws(() => validateHeldDecision(handoff, { ...input, ...change }),
      { code: 'NATIVE_HELD_DECISION_INVALID' });
  }
  const calls = [];
  const state = { submitted: false };
  const connection = { request: async (method, params) => {
    calls.push([method, params]); return { approvals: [raw], userInputs: [] };
  }, mintCommandId: () => '0199aabb-ccdd-7eef-8abc-0123456789ad',
  command: async (method, params, options) => { calls.push([method, params, options]);
    return method === 'session/read' ? { session: { sessionId: raw.sessionId, activeTurnId: raw.turnId } } :
      { status: 'accepted', commandId: options.commandId, approvalId: raw.approvalId, terminal: true }; } };
  const submitted = await submitHeldDecision(connection, handoff, input, command, state);
  assert.equal(submitted.commandId, '0199aabb-ccdd-7eef-8abc-0123456789ad');
  assert.deepEqual(calls.map(call => call[0]), ['approval/listPending', 'session/read', 'approval/decide']);
  assert.deepEqual(calls[2][1], { approvalId: raw.approvalId, choiceId: 'allow_once',
    requirementId: raw.currentRequirementId, sessionId: raw.sessionId });
  assert.deepEqual(calls[2][2], { commandId: submitted.commandId, maxAttempts: 1 });
  await assert.rejects(submitHeldDecision(connection, handoff, input, command, state),
    { code: 'NATIVE_HELD_DUPLICATE_DECISION' });
  assert.equal(calls.length, 3);
  const stale = { ...connection, request: async () => ({ approvals: [{ ...raw,
    currentRequirementId: { approvalId: raw.approvalId, sourceIndex: 1 } }], userInputs: [] }) };
  await assert.rejects(submitHeldDecision(stale, handoff, input, command, { submitted: false }),
    { code: 'NATIVE_HELD_APPROVAL_STALE' });
  const extra = { ...connection, request: async () => ({ approvals: [raw, raw], userInputs: [] }) };
  await assert.rejects(submitHeldDecision(extra, handoff, input, command, { submitted: false }),
    { code: 'NATIVE_HELD_APPROVAL_STALE' });
  const changedTurn = { ...connection, command: async (method, params, options) =>
    method === 'session/read' ? { session: { sessionId: raw.sessionId, activeTurnId: 'other-turn' } } :
      { status: 'accepted', commandId: options.commandId, approvalId: raw.approvalId, terminal: true } };
  await assert.rejects(submitHeldDecision(changedTurn, handoff, input, command, { submitted: false }),
    { code: 'NATIVE_HELD_APPROVAL_STALE' });
  const ackOnly = { ...connection, command: async (method, params, options) => method === 'session/read' ?
    { session: { sessionId: raw.sessionId, activeTurnId: raw.turnId } } :
    { status: 'accepted', commandId: options.commandId, approvalId: raw.approvalId, terminal: true } };
  const accepted = await submitHeldDecision(ackOnly, handoff, input, command, { submitted: false });
  assert.equal(accepted.ack.status, 'accepted');
  const output = [];
  assert.equal(await readHeldCliDecision(handoff, Readable.from([]), { write: value => output.push(value) }), null);
  assert.match(output[0], /native_shell_live_handoff/);
});

test('native shell outcome rejects wrong turn, extra provider call and unanswered approval mismatch', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  validateShellReady(ready, ready.metadata.workspaceRoot, 31001);
  assert.equal(validateShellOutcome(ready, shellOutcomeFixture(ready)).kind, 'native_shell_effect_observed');
  const reminder = { method: 'POST', path: '/responses',
    kind: 'native_reminder_call', model: 'fixture-native-shell', responseId: 'resp_native_reminder_1',
    itemId: 'fc_native_reminder_1', callId: 'call_native_reminder_1',
    payloadSha256: createHash('sha256').update(JSON.stringify(fixedNoReminderPayload(fixedReminderRequest()))).digest('hex') };
  for (const index of [1, 2, 3]) {
    const withReminder = shellOutcomeFixture(ready);
    withReminder.providerRequests.splice(index, 0, structuredClone(reminder));
    assert.equal(validateShellOutcome(ready, withReminder).kind, 'native_shell_effect_observed');
  }
  const pendingPrelude = shellOutcomeFixture(ready, true);
  pendingPrelude.providerRequests.push(structuredClone(reminder));
  assert.equal(validateShellOutcome(ready, pendingPrelude).kind, 'native_shell_approval_pending');
  const wrongPrelude = shellOutcomeFixture(ready);
  wrongPrelude.providerRequests.splice(1, 0, structuredClone(reminder));
  wrongPrelude.providerRequests[1].callId = 'wrong';
  assert.throws(() => validateShellOutcome(ready, wrongPrelude), { code: 'NATIVE_SHELL_OUTCOME_INVALID' });
  const falseLink = shellOutcomeFixture(ready);
  falseLink.providerRequests[1].afterReminderCallId = 'call_native_reminder_1';
  assert.throws(() => validateShellOutcome(ready, falseLink), { code: 'NATIVE_SHELL_OUTCOME_INVALID' });
  const reversed = shellOutcomeFixture(ready);
  reversed.providerRequests.reverse();
  assert.throws(() => validateShellOutcome(ready, reversed), { code: 'NATIVE_SHELL_OUTCOME_INVALID' });
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
    { providerRequests: shellOutcomeFixture(ready).providerRequests.map(request =>
      request.method === 'GET' ? { ...request, rejection: 'NATIVE_CATALOG_BUDGET_EXCEEDED' } : request) },
    { observations: { ...shellOutcomeFixture(ready).observations, items: [{ ...shellOutcomeFixture(ready).observations.items[0], callId: 'wrong' }] } },
    { providerRequests: shellOutcomeFixture(ready).providerRequests.map(request =>
      request.kind === 'native_tool_call' ? { ...request, commandSha256: '0'.repeat(64) } : request) },
    { providerRequests: shellOutcomeFixture(ready).providerRequests.map(request =>
      request.kind === 'native_tool_call' ? { ...request, namespace: 'other' } : request) },
    { observations: { ...shellOutcomeFixture(ready).observations, omitted: { items: 1 } } },
  ]) assert.throws(() => validateShellOutcome(ready, { ...shellOutcomeFixture(ready), ...variant }),
    { code: 'NATIVE_SHELL_OUTCOME_INVALID' });
  assert.throws(() => validateShellOutcome(ready, { ...shellOutcomeFixture(ready, true),
    pending: { approvals: [], userInputs: [] } }), { code: 'NATIVE_APPROVAL_INVALID' });
});

test('held outcome requires resolved notification, tool result and terminal turn beyond ACK', () => {
  const ready = shellReadyFixture('/tmp/fixture/workspace');
  const pending = shellOutcomeFixture(ready, true);
  const completed = shellOutcomeFixture(ready);
  const command = shellProbeCommand('/tmp/fixture/workspace', '/tmp/fixture/protected', 'protected-canary');
  const approval = { ...pending.event.approval, choices: [
    { choiceId: 'allow_once', decision: 'approved', scope: 'once', label: 'Allow once' }] };
  const handoff = { kind: 'native_shell_live_approval', handoffId: 'a'.repeat(32),
    expiresAt: new Date(Date.now() + 590_000).toISOString(),
    approval, command };
  const commandId = '0199aabb-ccdd-7eef-8abc-0123456789ad';
  const decided = { ...completed, kind: 'native_shell_held_decided',
    event: { kind: 'approval', approval }, pending: { approvals: [approval], userInputs: [] },
    observations: { ...completed.observations, approvals: [approval] },
    held: { kind: 'decided', presentation: handoff,
      decision: { commandId, choice: approval.choices[0],
        ack: { status: 'accepted', terminal: true, commandId, approvalId: approval.approvalId } },
      resolved: { kind: 'approval/resolved', approvalId: approval.approvalId,
        sessionId: approval.sessionId, turnId: approval.turnId, decidedByCommandId: commandId,
        resolvedBy: 'user', decision: 'approved' },
      item: completed.observations.items[0], terminal: completed.event } };
  assert.equal(validateHeldShellOutcome(ready, decided).kind, 'native_shell_effect_observed');
  for (const variant of [
    { held: { ...decided.held, resolved: null } },
    { held: { ...decided.held, resolved: { ...decided.held.resolved, kind: 'approval/updated' } } },
    { held: { ...decided.held, resolved: { ...decided.held.resolved, decidedByCommandId: 'other' } } },
    { held: { ...decided.held, item: { ...decided.held.item, callId: 'other' } } },
    { held: { ...decided.held, terminal: { ...decided.held.terminal, turnId: 'other' } } },
    { observations: { ...decided.observations, approvals: [approval, approval] } },
  ]) assert.throws(() => validateHeldShellOutcome(ready, { ...decided, ...variant }),
    { code: 'NATIVE_HELD_OUTCOME_INVALID' });
  const abortChoice = { choiceId: 'abort', decision: 'abort', scope: 'once', label: 'Reject' };
  const abortApproval = { ...approval, choices: [abortChoice] };
  const abortItem = { ...completed.observations.items[0], outputMarkers: false,
    workspaceReportedWritten: null, dummyAuthVisible: null, abortDenial: true,
    outputShape: { type: 'string', bytes: Buffer.byteLength('tool denied: approval aborted'), lines: 1 } };
  const aborted = { ...decided, providerRequests: pending.providerRequests,
    event: { kind: 'approval', approval: abortApproval },
    pending: { approvals: [abortApproval], userInputs: [] },
    observations: { ...decided.observations, approvals: [abortApproval], items: [abortItem] },
    held: { ...decided.held, presentation: { ...handoff, approval: abortApproval },
      decision: { ...decided.held.decision, choice: abortChoice },
      resolved: { ...decided.held.resolved, decision: 'abort' }, item: abortItem,
      terminal: { ...decided.held.terminal, terminal: 'cancelled' } } };
  assert.equal(validateHeldShellOutcome(ready, aborted).kind, 'native_shell_held_rejected');
  for (const altered of [{ abortDenial: false, outputMarkers: true },
    { abortDenial: true, dummyAuthVisible: true },
    { abortDenial: true, workspaceReportedWritten: false }]) {
    const item = { ...abortItem, ...altered };
    assert.throws(() => validateHeldShellOutcome(ready, { ...aborted,
      observations: { ...aborted.observations, items: [item] },
      held: { ...aborted.held, item } }), { code: 'NATIVE_HELD_OUTCOME_INVALID' });
  }
});

function durableApprovalFixture({ sessionId, turnId, approvalId, command, workspace }) {
  const wrap = (sequence, kind, record, payloadType = 'runtime.session') => ({
    schema_version: 1, record_type: 'event', durability: 'durable',
    stream: { kind: 'session', id: sessionId }, sequence,
    payload_type: payloadType, payload_schema_version: kind === 'approval' ? 3 : 1,
    payload: { kind, run_id: turnId,
      ...(['approval_wait_effect', 'session_end'].includes(kind) ? { record } : { event: record }) },
  });
  return [
    wrap(1, 'approval', { kind: 'requested', pending_action_id: approvalId,
      tool_call_id: 'call_native_shell_1', tool_name: 'bash',
      run_stream: { kind: 'run', id: turnId }, session_stream: { kind: 'session', id: sessionId },
      approval_subject: { kind: 'shell_command', raw_command: command,
        canonical_workspace_root: workspace } }),
    wrap(2, 'approval_wait_effect', { kind: 'started', pending_action_id: approvalId,
      tool_call_id: 'call_native_shell_1', tool_name: 'bash', run_stream: { kind: 'run', id: turnId } },
    'approval_wait.effect.started'),
    wrap(3, 'approval', { kind: 'decision_applied', pending_action_id: approvalId,
      decision: 'abort', session_stream: { kind: 'session', id: sessionId } }),
    wrap(4, 'approval_wait_effect', { kind: 'terminal', pending_action_id: approvalId,
      outcome: { kind: 'aborted' } }, 'approval_wait.effect.terminal'),
    wrap(5, 'run', { kind: 'tool_result_batch_committed', results: [{
      tool_call_id: 'call_native_shell_1', text: 'tool denied: approval aborted' }] }),
    wrap(6, 'run', { kind: 'terminal', terminal: 'cancelled' }),
    wrap(7, 'session_end', { schema_version: 1, session_id: sessionId,
      exit_reason: 'clean' }, 'session.end'),
  ];
}

function durableBytes(entries) { return Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`); }

function durablePermissionFrame(sessionId) {
  const child = (index, payloadType, payload) => ({ child_index: index,
    record_json: JSON.stringify({ schema_version: 1, record_type: 'event', durability: 'durable',
      stream: { kind: 'session', id: sessionId }, sequence: index + 1,
      payload_type: payloadType, payload_schema_version: 1, payload }) });
  return { retained_frame: 'session_permission_transaction', frame_schema_version: 1,
    outer_log_ordinal: 1, transaction_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    children: [child(0, 'runtime.session.permission_format_declared',
      { format: 'profile_v1', schema_version: 1 }),
    child(1, 'runtime.session.permission_profile_committed', {
      actor: null, cause: null, command: null, definition_sha256: null,
      managed_ancestor_sha256: null, managed_enforcement: null,
      pending_action_cancellations: null, permission_epoch: 1,
      resolved_snapshot: null, resulting_snapshot_sha256: null,
      schema_version: 1, source: null,
    })], content_sha256: `sha256:${'0'.repeat(64)}` };
}

test('durable approval terminal requires exact ordered abort chain and bounded identity', () => {
  const identity = { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab',
    turnId: '0199aabb-ccdd-7eef-8abc-0123456789ac', approvalId: 'approval-1',
    command: 'fixed command', workspace: '/tmp/fixture/workspace' };
  const entries = durableApprovalFixture(identity);
  const accepted = classifyDurableApprovalLog(durableBytes(entries), identity);
  assert.equal(accepted.kind, 'native_shell_approval_aborted_on_shutdown');
  assert.equal(accepted.sequences.run_terminal, 6);
  assert.throws(() => classifyDurableApprovalLog(durableBytes(entries.slice(0, -2)), identity),
    { code: 'NATIVE_APPROVAL_LOG_TERMINAL_UNKNOWN' });
  const duplicate = structuredClone(entries);
  duplicate.splice(1, 0, { ...structuredClone(entries[0]), sequence: 2 });
  duplicate.slice(2).forEach(entry => { entry.sequence++; });
  assert.throws(() => classifyDurableApprovalLog(durableBytes(duplicate), identity),
    { code: 'NATIVE_APPROVAL_LOG_AMBIGUOUS' });
  const mismatched = structuredClone(entries);
  mismatched[2].payload.event.pending_action_id = 'other-approval';
  assert.throws(() => classifyDurableApprovalLog(durableBytes(mismatched), identity),
    { code: 'NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH' });
  for (const edit of [
    rows => { rows[0].schema_version = 999; },
    rows => { rows[0].payload_schema_version = 999; },
    rows => { rows[0].payload.event.run_stream.kind = 'session'; },
    rows => { rows[0].payload.event.session_stream.kind = 'run'; },
    rows => { rows[1].payload.record.run_stream.kind = 'session'; },
    rows => { rows[6].payload.record.exit_reason = 'crashed'; },
    rows => { rows[6].payload.kind = 'other'; },
    rows => { rows[6].payload.record.session_id = 'other-session'; },
    rows => { rows[0].payload.record = structuredClone(rows[0].payload.event); },
  ]) {
    const changed = structuredClone(entries);
    edit(changed);
    assert.throws(() => classifyDurableApprovalLog(durableBytes(changed), identity),
      { code: 'NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH' });
  }
  const appended = structuredClone(entries);
  appended.push({ ...structuredClone(entries[1]), sequence: 8 });
  assert.throws(() => classifyDurableApprovalLog(durableBytes(appended), identity),
    { code: 'NATIVE_APPROVAL_LOG_AMBIGUOUS' });
  const frame = durablePermissionFrame(identity.sessionId);
  const framedEntries = entries.map(entry => ({ ...structuredClone(entry), sequence: entry.sequence + 2 }));
  assert.equal(classifyDurableApprovalLog(durableBytes([frame, ...framedEntries]), identity).kind,
    'native_shell_approval_aborted_on_shutdown');
  for (const edit of [
    candidate => { candidate.children.pop(); },
    candidate => { candidate.children[0].record_json = '{'; },
    candidate => { const child = JSON.parse(candidate.children[0].record_json);
      child.stream.id = 'foreign-session'; candidate.children[0].record_json = JSON.stringify(child); },
    candidate => { candidate.children[0].record_json = JSON.stringify({
      ...structuredClone(framedEntries[0]), sequence: 1 }); },
  ]) {
    const changedFrame = structuredClone(frame);
    edit(changedFrame);
    assert.throws(() => classifyDurableApprovalLog(durableBytes([changedFrame, ...framedEntries]), identity),
      { code: /^NATIVE_APPROVAL_LOG_/ });
  }
  const afterRunTerminal = structuredClone(entries);
  afterRunTerminal[6].sequence = 8;
  afterRunTerminal.splice(6, 0, { ...structuredClone(entries[5]), sequence: 7,
    payload: { kind: 'run', run_id: identity.turnId, event: { kind: 'started' } } });
  assert.throws(() => classifyDurableApprovalLog(durableBytes(afterRunTerminal), identity),
    { code: 'NATIVE_APPROVAL_LOG_AMBIGUOUS' });
  assert.throws(() => classifyDurableApprovalLog(Buffer.alloc(1_048_577), identity),
    { code: 'NATIVE_APPROVAL_LOG_BOUNDS' });
  assert.throws(() => classifyDurableApprovalLog(Buffer.from('{}\n'), identity),
    { code: 'NATIVE_APPROVAL_LOG_IDENTITY_MISMATCH' });
});

test('durable approval reader confines the guest log path to its owned session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-approval-log-'));
  const identity = { sessionId: '0199aabb-ccdd-7eef-8abc-0123456789ab',
    turnId: '0199aabb-ccdd-7eef-8abc-0123456789ac', approvalId: 'approval-1',
    command: 'fixed command', workspace: join(root, 'workspace') };
  const guestPath = `/mounts/home/.local/share/muse/sessions/2026/09/28/${identity.sessionId}/session.jsonl`;
  const logPath = join(root, 'home', '.local', 'share', 'muse', 'sessions', '2026', '09', '28',
    identity.sessionId, 'session.jsonl');
  try {
    await mkdir(join(root, 'home', '.local', 'share', 'muse', 'sessions', '2026', '09', '28',
      identity.sessionId), { recursive: true });
    await writeFile(logPath, durableBytes(durableApprovalFixture(identity)));
    assert.equal((await readDurableApprovalLog(root, guestPath, identity)).kind,
      'native_shell_approval_aborted_on_shutdown');
    await assert.rejects(readDurableApprovalLog(root, '/mounts/home/../../etc/passwd', identity),
      { code: 'NATIVE_APPROVAL_LOG_PATH_INVALID' });
    await assert.rejects(readDurableApprovalLog(root, guestPath.replace(identity.sessionId, 'other-session'), identity),
      { code: 'NATIVE_APPROVAL_LOG_PATH_INVALID' });
    await writeFile(logPath, Buffer.alloc(1_048_577));
    await assert.rejects(readDurableApprovalLog(root, guestPath, identity),
      { code: 'NATIVE_APPROVAL_LOG_BOUNDS' });
    await rm(logPath);
    await symlink('/etc/passwd', logPath);
    await assert.rejects(readDurableApprovalLog(root, guestPath, identity),
      { code: 'NATIVE_APPROVAL_LOG_PATH_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native shell controller verifies effects, stop and durable approval terminal', async () => {
  const run = async ({ approval = false, writeShell = false, stopFails = false,
    workspaceReportedWritten = true, dummyAuthVisible = false, guestFailure = false,
    finishedReject = false, terminalInvalid = false, lateGuestFailure = false,
    approvalLog = 'abort', held = false, heldInput = null, heldDecided = false } = {}) => {
    let fixtureRoot;
    let fixtureReady;
    let fixtureOutcome;
    let sentDecision;
    const result = await (held ? qualifyNativeShellHeld : qualifyNativeShell)({
      ...(held ? { requestDecision: async handoff => typeof heldInput === 'function' ?
        heldInput(handoff) : heldInput } : {}),
      stage: async root => {
        fixtureRoot = root;
        const runtime = join(root, 'runtime');
        await mkdir(runtime);
        if (writeShell) await writeFile(join(root, 'workspace', 'shell-canary'), 'native-write');
        return runtime;
      },
      startSentinel: async () => ({ port: 31001, close: async () => undefined }),
      probe: async () => ({ kind: 'connected' }), checkBubblewrap: () => undefined,
      launch: (_prepared, config) => {
        const ready = shellReadyFixture(config.workspace);
        if (approval) ready.metadata.durableLogPath =
          `/mounts/home/.local/share/muse/sessions/2026/09/28/${ready.metadata.sessionId}/session.jsonl`;
        const outcome = guestFailure ? { kind: 'guest_transport_error', stage: 'native_turn',
          code: 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN', message: 'unknown result envelope',
          providerRequests: [{ method: 'POST', path: '/responses', kind: 'native_tool_call' },
            { method: 'POST', path: '/responses', rejection: 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN' }] } :
          shellOutcomeFixture(ready, approval, workspaceReportedWritten);
        if (heldDecided) {
          const allow = { choiceId: 'allow_once', decision: 'approved', scope: 'once', label: 'Allow once' };
          outcome.event.approval.choices = [allow];
          outcome.pending.approvals[0].choices = [allow];
          outcome.observations.approvals[0].choices = [allow];
        }
        fixtureReady = ready;
        fixtureOutcome = outcome;
        const rawApproval = approval ? { approvalId: outcome.event.approval.approvalId,
          sessionId: outcome.sessionId, turnId: outcome.turnId, toolCallId: 'call_native_shell_1',
          toolName: 'bash', availableChoices: outcome.event.approval.choices,
          currentRequirementId: outcome.event.approval.requirementId,
          rawArgs: JSON.stringify({ command: shellProbeCommand(config.workspace, config.protectedRoot,
            'protected-canary'), description: 'Disposable native shell qualification' }) } : null;
        const handoff = rawApproval ? heldApprovalPresentation(rawApproval,
          shellProbeCommand(config.workspace, config.protectedRoot, 'protected-canary'),
          config.workspace, config.protectedRoot, 'protected-canary') : null;
        if (heldDecided) {
          const completed = shellOutcomeFixture(ready);
          const commandId = '0199aabb-ccdd-7eef-8abc-0123456789ad';
          outcome.kind = 'native_shell_held_decided';
          outcome.providerRequests = completed.providerRequests;
          outcome.observations.items = completed.observations.items;
          outcome.held = { kind: 'decided', presentation: handoff,
            decision: { commandId, choice: handoff.approval.choices[0],
              ack: { status: 'accepted', terminal: true, commandId,
                approvalId: handoff.approval.approvalId } },
            resolved: { kind: 'approval/resolved', approvalId: handoff.approval.approvalId,
              sessionId: outcome.sessionId, turnId: outcome.turnId, decidedByCommandId: commandId,
              resolvedBy: 'user', decision: 'approved' },
            item: completed.observations.items[0], terminal: completed.event };
        }
        if (!approval && !guestFailure) {
          outcome.observations.items[0].dummyAuthVisible = dummyAuthVisible;
          outcome.providerRequests.find(request => request.kind === 'matching_tool_result').outputMarkers.dummyAuthVisible =
            dummyAuthVisible;
        }
        const finalOutcome = lateGuestFailure ? { kind: 'guest_transport_error', stage: 'native_turn',
          code: 'NATIVE_REQUEST_BUDGET_EXCEEDED', message: 'late provider request after provisional outcome',
          providerRequests: [...outcome.providerRequests,
            { method: 'POST', path: '/responses', rejection: 'NATIVE_REQUEST_BUDGET_EXCEEDED' }] } : outcome;
        const finished = finishedReject ? Promise.reject(Object.assign(new Error('host exit timed out'),
          { code: 'PROBE_DEADLINE' })) : Promise.resolve({ code: guestFailure || lateGuestFailure ? 1 : 0, signal: null,
          timedOut: false, overflow: false, statusClosed: true,
          statusLines: terminalInvalid ? ['{"child-pid":101}', 'bad-json'] :
            ['{"child-pid":101}', `{"exit-code":${guestFailure || lateGuestFailure ? 1 : 0}}`], stderr: '',
          output: [JSON.stringify({ kind: 'guest_ready', result: ready }),
            ...held && !guestFailure ? [JSON.stringify({ kind: 'guest_handoff', result: handoff })] : [],
            JSON.stringify(guestFailure ? outcome : { kind: 'guest_outcome', result: outcome }),
            JSON.stringify(finalOutcome)] });
        finished.catch(() => undefined);
        return { pid: 100, ready: Promise.resolve(ready),
          liveStatus: Promise.resolve({ child: 101, exit: null }), outcome: Promise.resolve(outcome),
          handoff: Promise.resolve(held && guestFailure ? outcome : handoff),
          sendDecision: value => { sentDecision = value; },
          releaseTurn: () => undefined, releaseShutdown: () => undefined, abort: () => undefined,
          finished };
      },
      capture: async () => ({ native: { nspid: [7], netns: 'net:[2]' },
        supervisor: { netns: 'net:[2]' }, fd: { close: async () => undefined } }),
      stop: async () => {
        if (stopFails) throw Object.assign(new Error('survivor'), { code: 'STOP_SURVIVOR' });
        if (approval && approvalLog !== 'absent') {
          const identity = { sessionId: fixtureReady.metadata.sessionId,
            turnId: fixtureOutcome.turnId, approvalId: fixtureOutcome.event.approval.approvalId,
            command: shellProbeCommand(join(fixtureRoot, 'workspace'), join(fixtureRoot, 'protected'),
              'protected-canary'), workspace: join(fixtureRoot, 'workspace') };
          const entries = durableApprovalFixture(identity);
          if (approvalLog === 'mismatch') entries[2].payload.event.pending_action_id = 'other-approval';
          if (approvalLog === 'ambiguous') entries.splice(1, 0, structuredClone(entries[0]));
          if (approvalLog === 'incomplete') entries.splice(2, 1);
          const path = join(fixtureRoot, 'home', '.local', 'share', 'muse', 'sessions',
            '2026', '09', '28', identity.sessionId);
          await mkdir(path, { recursive: true });
          await writeFile(join(path, 'session.jsonl'), durableBytes(entries));
        }
        return { kind: 'confirmed', pidns: 'pid:[1]' };
      },
    });
    result.testSentDecision = sentDecision;
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
  assert.equal(pending.kind, 'native_shell_approval_aborted_on_shutdown');
  assert.equal(pending.classified.kind, 'native_shell_approval_pending');
  assert.equal(pending.evidence.guestOutcome.pending.approvals.length, 1);
  assert.equal(pending.evidence.approvalTerminal.sequences.run_terminal, 6);
  const heldExpired = await run({ approval: true, held: true });
  assert.equal(heldExpired.kind, 'native_shell_approval_aborted_on_shutdown');
  assert.deepEqual(heldExpired.testSentDecision, { kind: 'expire' });
  assert.equal(heldExpired.evidence.stop.kind, 'confirmed');
  const heldInvalid = await run({ approval: true, held: true, heldInput: { kind: 'choice' } });
  assert.equal(heldInvalid.code, 'NATIVE_HELD_DECISION_INVALID');
  assert.deepEqual(heldInvalid.testSentDecision, { kind: 'expire' });
  assert.equal(heldInvalid.evidence.stop.kind, 'confirmed');
  const heldApproved = await run({ approval: true, held: true, heldDecided: true, writeShell: true,
    heldInput: handoff => ({ kind: 'choice', handoffId: handoff.handoffId,
      sessionId: handoff.approval.sessionId, turnId: handoff.approval.turnId,
      callId: handoff.approval.toolCallId, approvalId: handoff.approval.approvalId,
      requirementId: handoff.approval.requirementId, choiceId: 'allow_once' }) });
  assert.equal(heldApproved.kind, 'native_shell_effect_observed');
  assert.equal(heldApproved.testSentDecision.choiceId, 'allow_once');
  assert.equal(heldApproved.evidence.stop.kind, 'confirmed');
  for (const approvalLog of ['absent', 'mismatch', 'ambiguous', 'incomplete']) {
    const unknown = await run({ approval: true, approvalLog });
    assert.equal(unknown.kind, 'native_shell_approval_terminal_unknown');
    assert.equal(unknown.evidence.stop.kind, 'confirmed');
    assert.equal(unknown.classified.kind, 'native_shell_approval_pending');
    assert.match(unknown.evidence.approvalTerminalError.code, /^NATIVE_APPROVAL_LOG_/);
  }
  assert.equal((await run({ approval: true, writeShell: true })).code, 'NATIVE_SHELL_EFFECT_INVALID');
  const uncertain = await run({ writeShell: true, stopFails: true });
  assert.equal(uncertain.code, 'STOP_SURVIVOR');
  assert.equal(uncertain.stopProof, 'unconfirmed');
  const primary = await run({ guestFailure: true, stopFails: true });
  assert.equal(primary.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(primary.evidence.primaryGuestFailure.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(primary.evidence.stopError.code, 'STOP_SURVIVOR');
  assert.equal(primary.stopProof, 'unconfirmed');
  const heldPrimary = await run({ held: true, guestFailure: true, stopFails: true });
  assert.equal(heldPrimary.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(heldPrimary.evidence.primaryGuestFailure.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(heldPrimary.evidence.stopError.code, 'STOP_SURVIVOR');
  assert.equal(heldPrimary.testSentDecision, undefined);
  const completionFailed = await run({ guestFailure: true, finishedReject: true });
  assert.equal(completionFailed.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(completionFailed.evidence.primaryGuestFailure.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(completionFailed.evidence.secondaryError.code, 'PROBE_DEADLINE');
  assert.equal(completionFailed.stopProof, 'unconfirmed');
  const terminalFailed = await run({ guestFailure: true, terminalInvalid: true });
  assert.equal(terminalFailed.code, 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN');
  assert.equal(terminalFailed.evidence.terminalError.code, 'BWRAP_STATUS_INVALID');
  assert.equal(terminalFailed.stopProof, 'unconfirmed');
  const late = await run({ writeShell: true, lateGuestFailure: true });
  assert.equal(late.code, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  assert.equal(late.evidence.primaryGuestFailure.code, 'NATIVE_REQUEST_BUDGET_EXCEEDED');
  assert.equal(late.evidence.stop.kind, 'confirmed');
  assert.equal(late.evidence.guestOutcome.kind, 'guest_shell_outcome');
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

test('read_file schema transport releases turn and shutdown and rejects early child exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-read-file-transport-'));
  try {
    const fake = join(root, 'fake-bwrap');
    await writeFile(fake, `#!/bin/sh
read config
case "$config" in *read-file-schema*) ;; *) exit 3 ;; esac
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
read turn
[ "$turn" = turn ] || exit 4
printf '{"kind":"guest_outcome","result":{"kind":"native_read_file_schema_outcome"}}\\n'
read shutdown
[ "$shutdown" = shutdown ] || exit 5
printf '{"kind":"native_read_file_schema_outcome"}\\n'
printf '{"exit-code":0}\\n' >&3
`, { mode: 0o700 });
    const host = runStatusPhase({ executable: fake, args: ['--', 'ignored'] }, { phase: 'read-file-schema' });
    assert.equal((await host.ready).kind, 'guest_shell_ready');
    assert.equal((await host.liveStatus).child, 123);
    host.releaseTurn();
    assert.equal((await host.outcome).kind, 'native_read_file_schema_outcome');
    let finished = false;
    host.finished.then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(finished, false);
    host.releaseShutdown();
    const done = await host.finished;
    assert.equal(done.code, 0);
    assert.equal(done.output.length, 3);
    assert.equal(done.statusClosed, true);
    const early = join(root, 'early-bwrap');
    await writeFile(early, '#!/bin/sh\nprintf \'{"child-pid":123}\\n\' >&3\nexit 1\n',
      { mode: 0o700 });
    const failed = runStatusPhase({ executable: early, args: ['--', 'ignored'] },
      { phase: 'read-file-schema' });
    await assert.rejects(failed.ready, { code: 'GUEST_OUTPUT_INVALID' });
    await assert.rejects(failed.outcome, { code: 'GUEST_OUTPUT_INVALID' });
    assert.equal((await failed.finished).code, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('read_file probe transport preserves turn, outcome and shutdown handshakes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-read-file-probe-transport-'));
  try {
    const fake = join(root, 'fake-bwrap');
    await writeFile(fake, `#!/bin/sh
read config
case "$config" in *read-file-probe*) ;; *) exit 3 ;; esac
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
read turn
[ "$turn" = turn ] || exit 4
printf '{"kind":"guest_outcome","result":{"kind":"native_read_file_outcome"}}\\n'
read shutdown
[ "$shutdown" = shutdown ] || exit 5
printf '{"kind":"native_read_file_outcome"}\\n'
printf '{"exit-code":0}\\n' >&3
`, { mode: 0o700 });
    const host = runStatusPhase({ executable: fake, args: ['--', 'ignored'] },
      { phase: 'read-file-probe' });
    assert.equal((await host.ready).kind, 'guest_shell_ready');
    assert.equal((await host.liveStatus).child, 123);
    host.releaseTurn();
    assert.equal((await host.outcome).kind, 'native_read_file_outcome');
    host.releaseShutdown();
    const done = await host.finished;
    assert.equal(done.code, 0);
    assert.equal(done.statusClosed, true);
    assert.equal(done.output.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('protected transport classifies one raw frame before retention and rejects duplicate or absent frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-protected-transport-'));
  try {
    const make = async (name, frames) => {
      const fake = join(root, name);
      await writeFile(fake, `#!/bin/sh
read config
case "$config" in *PASSEUR_PROTECTED_SYNTHETIC_SECRET*) exit 8 ;; esac
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
read turn
${frames}
read shutdown
printf '{"kind":"native_protected_read_outcome"}\\n'
printf '{"exit-code":0}\\n' >&3
`, { mode: 0o700 });
      return fake;
    };
    const marker = 'PASSEUR_PROTECTED_SYNTHETIC_SECRET';
    const rawLine = JSON.stringify({ kind: 'guest_protected_raw', callId: 'call_native_read_file_1',
      output: `Read text file \`/tmp/target\`.\n1|${marker}` });
    const outcomeLine = JSON.stringify({ kind: 'guest_outcome',
      result: { kind: 'native_protected_read_outcome' } });
    const frame = line => `printf '%s\\n' '${line}'`;
    const classified = `${frame(rawLine)}\nread classification\ncase "$classification" in *protected_classification*) ;; *) exit 9 ;; esac`;
    const config = { phase: 'protected-read', classifyProtectedOutput: raw =>
      classifyProtectedOutput(raw, '/tmp/target', '/tmp/workspace', marker),
    protectedMarkerPresent: line => line.includes(marker) };
    const normal = runStatusPhase({ executable: await make('normal',
      `${classified}\n${frame(outcomeLine)}`), args: ['--', 'ignored'] }, config);
    assert.equal((await normal.ready).kind, 'guest_shell_ready');
    await normal.liveStatus;
    normal.releaseTurn();
    assert.equal((await normal.protectedResult).class, 'marker_exposed');
    assert.equal((await normal.outcome).kind, 'native_protected_read_outcome');
    normal.releaseShutdown();
    const done = await normal.finished;
    assert.equal(done.output.length, 3);
    assert.equal(JSON.stringify(done).includes(marker), false);
    assert.equal(normal.protectedFrameError(), null);
    const duplicate = runStatusPhase({ executable: await make('duplicate',
      `${classified}\n${frame(rawLine)}\n${frame(outcomeLine)}`), args: ['--', 'ignored'] }, config);
    await duplicate.ready;
    duplicate.releaseTurn();
    await duplicate.protectedResult;
    duplicate.releaseShutdown();
    const repeated = await duplicate.finished;
    assert.equal(duplicate.protectedFrameError().code, 'NATIVE_PROTECTED_FRAME_INVALID');
    assert.equal(JSON.stringify(repeated).includes(marker), false);
    const absent = runStatusPhase({ executable: await make('absent', frame(outcomeLine)),
      args: ['--', 'ignored'] }, config);
    await absent.ready;
    absent.releaseTurn();
    await assert.rejects(absent.protectedResult, { code: 'NATIVE_PROTECTED_FRAME_MISSING' });
    absent.releaseShutdown();
    await absent.finished;
    const early = join(root, 'early');
    await writeFile(early, `#!/bin/sh
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
exit 1
`, { mode: 0o700 });
    const exited = runStatusPhase({ executable: early, args: ['--', 'ignored'] }, config);
    await exited.ready;
    await assert.rejects(exited.protectedResult, { code: 'NATIVE_PROTECTED_FRAME_MISSING' });
    await assert.rejects(exited.outcome, { code: 'GUEST_OUTPUT_INVALID' });
    assert.equal((await exited.finished).code, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('held transport keeps the child alive until one host decision and explicit shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-held-transport-'));
  try {
    const fake = join(root, 'fake-bwrap');
    await writeFile(fake, `#!/bin/sh
read config
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
read turn
printf '{"kind":"guest_handoff","result":{"kind":"native_shell_live_approval"}}\\n'
read decision
printf '{"kind":"guest_outcome","result":{"kind":"native_shell_approval_pending"}}\\n'
read shutdown
printf '{"kind":"native_shell_approval_pending"}\\n'
printf '{"exit-code":0}\\n' >&3
`, { mode: 0o700 });
    const host = runStatusPhase({ executable: fake, args: ['--', 'ignored'] }, { phase: 'held-shell' });
    assert.equal((await host.ready).kind, 'guest_shell_ready');
    assert.equal((await host.liveStatus).child, 123);
    host.releaseTurn();
    assert.equal((await host.handoff).kind, 'native_shell_live_approval');
    let finished = false;
    host.finished.then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(finished, false);
    host.sendDecision({ kind: 'expire' });
    assert.equal((await host.outcome).kind, 'native_shell_approval_pending');
    assert.throws(() => host.sendDecision({ kind: 'expire' }),
      { code: 'NATIVE_HELD_DECISION_SEQUENCE' });
    host.releaseShutdown();
    const done = await host.finished;
    assert.equal(done.code, 0);
    assert.equal(done.output.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('held transport owns early handoff rejection and forwards typed pre-handoff guest failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-held-early-'));
  try {
    const early = join(root, 'early-bwrap');
    await writeFile(early, '#!/bin/sh\nprintf \'{"child-pid":123}\\n\' >&3\nexit 1\n',
      { mode: 0o700 });
    const first = runStatusPhase({ executable: early, args: ['--', 'ignored'] }, { phase: 'held-shell' });
    await assert.rejects(first.ready, { code: 'GUEST_OUTPUT_INVALID' });
    assert.equal((await first.finished).code, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    const failure = { kind: 'guest_transport_error', stage: 'native_turn',
      code: 'NATIVE_TOOL_RESULT_ENVELOPE_UNKNOWN', message: 'unreviewed result', providerRequests: [] };
    const beforeHandoff = join(root, 'before-handoff-bwrap');
    await writeFile(beforeHandoff, `#!/bin/sh
read config
printf '{"child-pid":123}\\n' >&3
printf '{"kind":"guest_ready","result":{"kind":"guest_shell_ready"}}\\n'
read turn
printf '%s\\n' '${JSON.stringify(failure)}'
printf '%s\\n' '${JSON.stringify(failure)}'
printf '{"exit-code":1}\\n' >&3
exit 1
`, { mode: 0o700 });
    const second = runStatusPhase({ executable: beforeHandoff, args: ['--', 'ignored'] }, { phase: 'held-shell' });
    assert.equal((await second.ready).kind, 'guest_shell_ready');
    second.releaseTurn();
    assert.deepEqual(await second.handoff, failure);
    assert.deepEqual(await second.outcome, failure);
    assert.equal((await second.finished).output.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
