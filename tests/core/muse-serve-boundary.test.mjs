import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createFixtureDirs, observedHostTree, observedHostQuiet, parseHostMarker, quickstartEnvironment,
  retainFixtureRoots, selectChoice, serveArgs, startRawSession, qualify, within, traceArgs,
  startNativeTrace, stopNativeTrace, failedTraceLeads } from '../../scripts/qualify-muse-serve-boundary.mjs';

function procStat(pid, { state = 'S', parent = 1, group = pid, session = pid, start = '100' } = {}) {
  const fields = Array(20).fill('0');
  Object.assign(fields, { 0: state, 1: String(parent), 2: String(group), 3: String(session), 19: start });
  return `${pid} (muse) ${fields.join(' ')}`;
}

test('quickstart uses exact isolated environment and separate empty temp roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-quickstart-layout-test-'));
  let dirs;
  try {
    dirs = await createFixtureDirs(root, true);
    assert.equal(dirname(dirs.home), tmpdir());
    assert.equal(dirname(dirs.workspace), tmpdir());
    assert.notEqual(dirs.home, dirs.workspace);
    assert.deepEqual(await readdir(dirs.workspace), []);
    assert.deepEqual(quickstartEnvironment(dirs.home), {
      HOME: dirs.home, PATH: process.env.PATH ?? '/usr/bin:/bin', TBH_CREDENTIAL_BACKEND: 'file',
      TBH_DISABLE_TELEMETRY: '1', MUSE_EXPERIMENTAL_SDK_ENABLED: 'on',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (dirs) { await rm(dirs.home, { recursive: true, force: true }); await rm(dirs.workspace, { recursive: true, force: true }); }
  }
});

test('host marker binds birth identity to the SDK detached group before stop', () => {
  const birth = parseHostMarker(procStat(101, { start: '12345' }));
  const table = new Map([[101, birth]]);
  const identity = observedHostTree(birth.pid, table, birth.start);
  assert.equal(identity.group, 101);
  assert.equal(identity.start, '12345');
  assert.throws(() => observedHostTree(101, table, '12346'), { code: 'HOST_IDENTITY_UNVERIFIED' });
  assert.throws(() => observedHostTree(101, new Map([[101, { ...birth, group: 202 }]]), birth.start), {
    code: 'HOST_IDENTITY_UNVERIFIED',
  });
});

test('partial stop observation detects live group members and captured escaped descendants', () => {
  const leader = parseHostMarker(procStat(101, { start: '12345' }));
  const escaped = parseHostMarker(procStat(102, { parent: 101, group: 900, session: 900, start: '23456' }));
  const identity = observedHostTree(101, new Map([[101, leader], [102, escaped]]), leader.start);
  assert.equal(observedHostQuiet(identity, new Map(), false), false);
  assert.equal(observedHostQuiet(undefined, new Map(), true), false);
  assert.equal(observedHostQuiet(identity, new Map([[202, { ...escaped, pid: 202, group: 101 }]]), true), false);
  assert.equal(observedHostQuiet(identity, new Map([[102, escaped]]), true), false);
  assert.equal(observedHostQuiet(identity, new Map([[102, { ...escaped, start: '99999' }]]), true), true);
  assert.equal(observedHostQuiet(identity, new Map(), true), true);
  assert.equal(retainFixtureRoots({ hostSpawnAttempted: true, uncertainPreHostStop: false, fixtureClosed: true }), true);
  assert.equal(retainFixtureRoots({ hostSpawnAttempted: false, uncertainPreHostStop: false, fixtureClosed: true }), false);
});

test('approval routing selects only the offered once-only decision', () => {
  const request = { availableChoices: [
    { choiceId: 'session-allow', decision: 'approved', scope: 'session' },
    { choiceId: 'once-deny', decision: 'denied', scope: 'once' },
    { choiceId: 'once-allow', decision: 'approved', scope: 'once' },
  ] };
  assert.equal(selectChoice(request, 'allow'), 'once-allow');
  assert.equal(selectChoice(request, 'deny'), 'once-deny');
  assert.equal(selectChoice({ availableChoices: request.availableChoices.slice(0, 1) }, 'allow'), undefined);
});

test('raw memory-only selection changes only the host serve argument', () => {
  const raw = serveArgs('raw');
  assert.deepEqual(raw, ['serve']);
  assert.deepEqual(serveArgs('raw-memory'), [...raw, '--no-session-log']);
  for (const mode of ['facade', 'quickstart']) assert.deepEqual(serveArgs(mode), raw);
  assert.deepEqual(serveArgs('raw-trace'), raw);
});

test('native trace uses only timestamped file/process metadata and separately observes stop', async () => {
  const child = new EventEmitter();
  child.pid = 234;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => { assert.equal(signal, 'SIGINT'); queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  let args;
  const trace = await startNativeTrace({ pid: 123, start: 'birth' }, '/tmp/trace', {
    spawnTrace: (_command, supplied) => { args = supplied; return child; },
    readStatus: async () => 'TracerPid:\t234\n',
    verifyHost: async () => undefined,
    wait: async () => undefined,
    attachMs: 50,
  });
  // Production's verifier rechecks the host birth identity before the request.
  assert.deepEqual(args, traceArgs(123, '/tmp/trace'));
  assert.deepEqual(args, ['-f', '-ttt', '-s', '128', '-e', 'trace=%file,%process', '-o', '/tmp/trace', '-p', '123']);
  assert.equal(trace.attached, true);
  assert.deepEqual(await stopNativeTrace(trace), { state: 'observed', code: 0, signal: null });
});

test('failed tracer attachment remains unavailable and its exit is observed', async () => {
  const child = new EventEmitter();
  child.pid = 235;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const trace = await startNativeTrace({ pid: 123, start: 'birth' }, '/tmp/trace', {
    spawnTrace: () => { queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, null); }); return child; },
    readStatus: async () => 'TracerPid:\t0\n',
    wait: async () => undefined,
    attachMs: 50,
  });
  assert.equal(trace.attached, false);
  assert.deepEqual(await stopNativeTrace(trace), { state: 'observed', code: 1, signal: null });
});

test('EPERM signaling an attached tracer does not prove its exit', async () => {
  const child = new EventEmitter();
  child.pid = 236;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.emit('error', Object.assign(new Error('permission denied'), { code: 'EPERM' }));
    return false;
  };
  const trace = await startNativeTrace({ pid: 123, start: 'birth' }, '/tmp/trace', {
    spawnTrace: () => child,
    readStatus: async () => 'TracerPid:\t236\n',
    verifyHost: async () => undefined,
    wait: async () => undefined,
    attachMs: 50,
  });
  assert.equal(trace.attached, true);
  assert.deepEqual(await stopNativeTrace(trace), { state: 'uncertain' });
  assert.equal(trace.exit, null);
  assert.equal(trace.processError, 'EPERM');
});

test('failed trace leads expose only bounded disposable paths', () => {
  const source = [
    '777 1780000000.123 openat(AT_FDCWD, "/tmp/control/workspace/.git/index", O_RDONLY) = -1 ENOENT (No such file)',
    '1780000000.124 openat(AT_FDCWD, "/tmp/control/home/.config/muse/auth.json", O_RDONLY) = -1 EACCES (Permission denied)',
    '1780000000.125 openat(AT_FDCWD, "/home/person/private", O_RDONLY) = -1 EACCES (Permission denied)',
    '1780000000.126 read(4, "credential-secret", 32) = -1 EPERM (Operation not permitted)',
  ].join('\n');
  assert.deepEqual(failedTraceLeads(source, [
    { name: 'home', path: '/tmp/control/home' }, { name: 'workspace', path: '/tmp/control/workspace' },
  ]), [{ syscall: 'openat', path: 'workspace/.git/index', errno: 'ENOENT' }]);
});

test('raw session start uses the quickstart command shape without overrides', async () => {
  const calls = [];
  const started = { session: { sessionId: '0197134c-6a23-7a41-8a02-82f4a322f43f', workspaceRoot: '/tmp/disposable-workspace' } };
  const connection = { command: async (...args) => { calls.push(args); return started; } };
  assert.deepEqual(await startRawSession(connection, '/tmp/disposable-workspace'), started);
  assert.deepEqual(calls, [[
    'session/start', { workspaceRoot: '/tmp/disposable-workspace' }, { maxAttempts: 1 },
  ]]);
});

test('raw session start rejects empty or malformed IDs and a wrong workspace', async () => {
  const workspaceRoot = '/tmp/disposable-workspace';
  for (const session of [
    { sessionId: '', workspaceRoot },
    { sessionId: 'fixture', workspaceRoot },
    { sessionId: '0197134c-6a23-4a41-8a02-82f4a322f43f', workspaceRoot },
    { sessionId: '0197134c-6a23-7a41-8a02-82f4a322f43f', workspaceRoot: '/tmp/another-workspace' },
  ]) {
    await assert.rejects(startRawSession({ command: async () => ({ session }) }, workspaceRoot), {
      code: 'INVALID_SESSION_START',
    });
  }
});

test('version mismatch returns a typed result and removes its disposable HOME', async () => {
  const holder = await mkdtemp(join(tmpdir(), 'passeur-muse-version-test-'));
  try {
    const marker = join(holder, 'home-path');
    const fakeMuse = join(holder, 'muse');
    await writeFile(fakeMuse, `#!/bin/sh\nprintf '%s' "$HOME" > '${marker}'\nprintf 'muse 0.0.0\\n'\n`, { mode: 0o755 });
    const result = await qualify({ muse: fakeMuse });
    assert.equal(result.kind, 'native_version_mismatch');
    assert.equal(result.expected, '1.4.0-R4302.1');
    const home = await readFile(marker, 'utf8');
    await assert.rejects(stat(dirname(home)), { code: 'ENOENT' });
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
});

test('an unverified pre-host process group retains the disposable fixture', async () => {
  const result = await qualify({ runProcess: async () => {
    throw Object.assign(new Error('group stop was not verified'), { code: 'GROUP_NOT_STOPPED' });
  } });
  try {
    assert.equal(result.kind, 'qualification_error');
    assert.equal(result.stage, 'version');
    assert.equal(result.code, 'GROUP_NOT_STOPPED');
    assert.equal(result.stopProof, 'descendants_unverified');
    assert.equal((await stat(result.retainedFixtures[0])).isDirectory(), true);
  } finally {
    // This test's injected failure started no process, so its fixture is safe to remove.
    if (result.retainedFixtures) for (const path of result.retainedFixtures) await rm(path, { recursive: true, force: true });
  }
});

test('quickstart uncertainty retains its control, HOME and workspace roots', async () => {
  const result = await qualify({ sessionStart: 'quickstart', runProcess: async () => {
    throw Object.assign(new Error('group stop was not verified'), { code: 'GROUP_NOT_STOPPED' });
  } });
  try {
    assert.equal(result.kind, 'qualification_error');
    assert.equal(result.code, 'GROUP_NOT_STOPPED');
    assert.equal(result.stopProof, 'descendants_unverified');
    assert.equal(result.retainedFixtures.length, 3);
    for (const path of result.retainedFixtures) assert.equal((await stat(path)).isDirectory(), true);
  } finally {
    // The injected failure started no process, so all three test roots are safe to remove.
    if (result.retainedFixtures) for (const path of result.retainedFixtures) await rm(path, { recursive: true, force: true });
  }
});

test('startup deadlines produce a typed timeout without waiting for a silent promise', async () => {
  await assert.rejects(within('host initialize', new Promise(() => undefined), 5), {
    code: 'PROBE_DEADLINE', message: 'host initialize exceeded 5ms',
  });
});
