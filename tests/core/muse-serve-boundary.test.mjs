import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createFixtureDirs, observedHostTree, observedHostQuiet, parseHostMarker, quickstartEnvironment,
  prepareSessionsDirectory, retainFixtureRoots, selectChoice, serveArgs, startRawSession, readRawSession, qualify, within, traceArgs,
  startNativeTrace, stopNativeTrace, failedTraceLeads } from '../../scripts/qualify-muse-serve-boundary.mjs';
import { daemonTraceArgs, discoverDaemonTrace, waitForDaemonTrace, stopDaemonTrace,
  pinnedNativeExecutable } from '../../scripts/qualify-muse-serve-boundary.mjs';

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
  assert.deepEqual(serveArgs('raw-precreated-sessions'), raw);
  assert.deepEqual(serveArgs('raw-precreated-read'), raw);
});

test('explicit sessions preseed records every actual private directory and mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'passeur-sessions-layout-test-'));
  try {
    const preparation = await prepareSessionsDirectory(home);
    assert.deepEqual(preparation, { condition: 'precreated_empty_sessions_directory', createdDirectories: [
      '.local', '.local/share', '.local/share/muse', '.local/share/muse/sessions',
    ].map(path => ({ path, mode: 0o700 })) });
    assert.deepEqual(await readdir(home), ['.local']);
    for (const { path } of preparation.createdDirectories) {
      const entry = await lstat(join(home, path));
      assert.equal(entry.isDirectory(), true);
      assert.equal(entry.uid, process.getuid());
      assert.equal(entry.mode & 0o7777, 0o700);
    }
    assert.deepEqual(await readdir(join(home, '.local/share/muse/sessions')), []);
    await assert.rejects(prepareSessionsDirectory(home), { code: 'SESSION_DIRECTORY_INVALID' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('sessions preseed rejects wrong type, owner, mode and nonempty leaf', async () => {
  for (const failure of ['type', 'owner', 'mode', 'nonempty']) {
    const home = await mkdtemp(join(tmpdir(), 'passeur-sessions-invalid-test-'));
    try {
      const inspect = async path => {
        const entry = await lstat(path);
        if (failure === 'nonempty' || !path.endsWith('/sessions')) return entry;
        return { isDirectory: () => failure !== 'type', uid: failure === 'owner' ? entry.uid + 1 : entry.uid,
          mode: failure === 'mode' ? 0o40755 : entry.mode };
      };
      await assert.rejects(prepareSessionsDirectory(home, { inspect,
        list: failure === 'nonempty' ? async () => ['unexpected'] : readdir,
      }), error => error.code === 'SESSION_DIRECTORY_INVALID' &&
        error.createdDirectories.length === 4);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test('only explicit mode prepares sessions before host spawn; failed preparation prevents launch', async () => {
  const holder = await mkdtemp(join(tmpdir(), 'passeur-sessions-mode-test-'));
  const muse = join(holder, 'muse');
  await writeFile(muse, '#!/bin/sh\nprintf "muse 1.4.0-R4302.1\\n"\n', { mode: 0o755 });
  const roots = [];
  try {
    for (const sessionStart of ['raw', 'raw-precreated-sessions', 'raw-precreated-read']) {
      let prepared = 0;
      const result = await qualify({ muse, sessionStart,
        startLoopbackFixture: async () => ({ url: 'http://127.0.0.1:1', requests: [], close: async () => undefined }),
        prepareSessions: async home => { prepared++;
          return prepareSessionsDirectory(home);
        },
        spawnConnection: ({ args, env }) => {
          assert.deepEqual(args, ['serve']);
          assert.equal(env.MUSE_NO_AUTO_UPDATE, '1');
          throw new Error('stop before initialize');
        },
      });
      assert.equal(prepared, sessionStart === 'raw' ? 0 : 1);
      assert.equal(result.stage, 'host_spawn');
      assert.equal(result.kind, 'qualification_error');
      assert.equal(result.stopProof, 'descendants_unverified');
      roots.push(...result.retainedFixtures);
      const home = join(result.retainedFixtures[0], 'home');
      assert.deepEqual(await readdir(home), sessionStart === 'raw' ? ['.config'] : ['.config', '.local']);
      assert.equal(result.sessionDirectoryPreparation?.createdDirectories.length,
        sessionStart === 'raw' ? undefined : 4);
    }
    let spawned = false;
    let invalidHome;
    const invalid = await qualify({ muse, sessionStart: 'raw-precreated-sessions',
      startLoopbackFixture: async () => ({ url: 'http://127.0.0.1:1', requests: [], close: async () => undefined }),
      prepareSessions: async home => { invalidHome = home; return prepareSessionsDirectory(home, {
        inspect: async path => { const entry = await lstat(path); return path.endsWith('/sessions')
          ? { isDirectory: () => true, uid: entry.uid, mode: 0o40755 } : entry; },
      }); },
      spawnConnection: () => { spawned = true; throw new Error('must not spawn'); },
    });
    assert.equal(spawned, false);
    assert.equal(invalid.kind, 'session_directory_invalid');
    assert.equal(invalid.code, 'SESSION_DIRECTORY_INVALID');
    assert.equal(invalid.stage, 'session_directory_preparation');
    assert.equal(invalid.hostArgs, undefined);
    assert.equal(invalid.retainedFixtures, undefined);
    assert.equal(invalid.sessionDirectoryPreparation.createdDirectories.length, 4);
    await assert.rejects(lstat(invalidHome), { code: 'ENOENT' });

    const retained = await qualify({ muse, sessionStart: 'raw-precreated-sessions',
      startLoopbackFixture: async () => ({ url: 'http://127.0.0.1:1', requests: [],
        close: async () => { throw new Error('fixture close uncertain'); } }),
      prepareSessions: async home => prepareSessionsDirectory(home, { list: async () => ['unexpected'] }),
      spawnConnection: () => { spawned = true; throw new Error('must not spawn'); },
    });
    assert.equal(spawned, false);
    assert.equal(retained.kind, 'session_directory_invalid');
    assert.equal((await lstat(retained.retainedFixtures[0])).isDirectory(), true);
    roots.push(...retained.retainedFixtures);
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(holder, { recursive: true, force: true });
  }
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

test('daemon wrapper arguments preserve native serve and metadata-only trace', () => {
  assert.deepEqual(daemonTraceArgs('/tmp/trace', '/opt/muse', serveArgs('raw-trace-daemon')),
    ['-D', '-I', '2', '-f', '-ttt', '-s', '128', '-e', 'trace=%file,%process',
      '-o', '/tmp/trace', '/opt/muse', 'serve']);
});

test('pinned native executable is adjacent to launcher with exact version, canonical path and digest', async () => {
  const holder = await mkdtemp(join(tmpdir(), 'passeur-native-identity-test-'));
  const launcher = join(holder, 'muse');
  const native = join(holder, 'muse-bin-1.4.0-R4302.1');
  const pinnedDigest = 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86';
  try {
    await writeFile(launcher, '#!/bin/sh\n');
    await writeFile(native, 'fixture binary');
    assert.equal(await pinnedNativeExecutable(launcher, { digest: async path => {
      assert.equal(path, native);
      return pinnedDigest;
    } }), native);
    await assert.rejects(pinnedNativeExecutable(launcher), { code: 'DAEMON_TRACE_UNAVAILABLE' });
    await assert.rejects(pinnedNativeExecutable(launcher, { digest: async () => '0'.repeat(64) }),
      { code: 'DAEMON_TRACE_UNAVAILABLE' });
    await rm(native);
    const wrong = join(holder, 'muse-bin-1.4.0-R9999');
    await writeFile(wrong, 'other version');
    await assert.rejects(pinnedNativeExecutable(launcher, { digest: async () => pinnedDigest }),
      { code: 'DAEMON_TRACE_UNAVAILABLE' });
    await symlink(wrong, native);
    await assert.rejects(pinnedNativeExecutable(launcher, { digest: async () => pinnedDigest }),
      { code: 'DAEMON_TRACE_UNAVAILABLE' });
  } finally { await rm(holder, { recursive: true, force: true }); }
});

function daemonPeers({ hostStart = '100', tracerStart = '200', tracerPid = 234,
  hostExecutable = '/opt/muse', tracerExecutable = '/usr/bin/strace', status = `TracerPid:\t${tracerPid}\n` } = {}) {
  const marker = procStat(123, { parent: 50, start: '100' });
  const readStat = async pid => pid === 123
    ? procStat(123, { parent: 50, start: hostStart })
    : procStat(234, { parent: 1, group: 234, session: 234, start: tracerStart });
  const readStatus = async () => status;
  const readExecutable = async pid => pid === 123 ? hostExecutable : tracerExecutable;
  return { marker, readStat, readStatus, readExecutable };
}

test('daemon discovery verifies host birth, executable, and attached tracer identity', async () => {
  const peer = daemonPeers();
  const identity = await discoverDaemonTrace(peer.marker, '/opt/muse', peer);
  assert.deepEqual(identity.tracer, { pid: 234, start: '200', executable: '/usr/bin/strace' });
  assert.equal(identity.host.parent, 50);
  for (const changed of [
    daemonPeers({ hostStart: '101' }), daemonPeers({ hostExecutable: '/opt/other' }),
    daemonPeers({ tracerExecutable: '/usr/bin/other' }), daemonPeers({ tracerPid: 0 }),
  ]) await assert.rejects(discoverDaemonTrace(changed.marker, '/opt/muse', changed));
});

test('daemon discovery retries a missing marker', async () => {
  let attempts = 0;
  const identity = await waitForDaemonTrace('/tmp/marker', '/opt/muse', {
    readMarker: async () => { if (attempts++ === 0) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return 'marker'; },
    discover: async marker => { assert.equal(marker, 'marker'); return { tracer: { pid: 234 } }; },
    wait: async () => undefined,
    budgetMs: 50,
  });
  assert.equal(identity.tracer.pid, 234);
  assert.equal(attempts, 2);
  await assert.rejects(waitForDaemonTrace('/tmp/marker', '/opt/muse', {
    readMarker: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
    wait: async () => undefined,
    budgetMs: 1,
  }), { code: 'DAEMON_TRACE_UNAVAILABLE' });
});

test('same host birth may move from launcher interpreter to pinned native executable', async () => {
  const peer = daemonPeers();
  let hostExecutableReads = 0;
  const identity = await waitForDaemonTrace('/tmp/marker', '/opt/muse', {
    readMarker: async () => peer.marker,
    discover: (marker, native) => discoverDaemonTrace(marker, native, { ...peer,
      readExecutable: async pid => pid === 123 && hostExecutableReads++ === 0
        ? '/usr/bin/bash' : peer.readExecutable(pid),
    }),
    wait: async () => undefined,
    budgetMs: 50,
  });
  assert.equal(hostExecutableReads, 2);
  assert.equal(identity.host.pid, 123);
  assert.equal(identity.host.start, '100');
  assert.equal(identity.tracer.pid, 234);
});

test('daemon stop signals only the verified tracer and observes detach plus terminal', async () => {
  const peer = daemonPeers();
  const identity = await discoverDaemonTrace(peer.marker, '/opt/muse', peer);
  let stopped = false;
  const signals = [];
  const result = await stopDaemonTrace(identity, { ...peer,
    readStat: async pid => pid === 234 && stopped
      ? procStat(234, { state: 'Z', start: '200' }) : peer.readStat(pid),
    readStatus: async () => stopped ? 'TracerPid:\t0\n' : 'TracerPid:\t234\n',
    signal: (pid, name) => { signals.push([pid, name]); stopped = true; },
  });
  assert.deepEqual(signals, [[234, 'SIGINT']]);
  assert.deepEqual(result, { state: 'observed', detached: true });
});

test('daemon stop refuses reused tracer, denied signal, unreadable proc and timeout', async () => {
  const peer = daemonPeers();
  const identity = await discoverDaemonTrace(peer.marker, '/opt/muse', peer);
  const reused = await stopDaemonTrace(identity, { ...peer,
    readStat: async pid => pid === 234 ? procStat(234, { start: '201' }) : peer.readStat(pid),
    signal: () => assert.fail('reused tracer was signaled'),
  });
  assert.deepEqual(reused, { state: 'uncertain', reason: 'identity_changed' });
  assert.deepEqual(await stopDaemonTrace(identity, { ...peer,
    signal: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
  }), { state: 'uncertain', reason: 'EPERM' });
  assert.deepEqual(await stopDaemonTrace(identity, { ...peer,
    readStatus: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
  }), { state: 'uncertain', reason: 'EACCES' });
  assert.deepEqual(await stopDaemonTrace(identity, { ...peer,
    readStat: async pid => pid === 234 ? procStat(234, { state: 'Z', start: '200' }) : peer.readStat(pid),
    readStatus: async () => 'TracerPid:\t0\n',
    signal: () => assert.fail('terminal tracer was signaled'),
  }), { state: 'observed', detached: true });
  let signaled = false;
  assert.deepEqual(await stopDaemonTrace(identity, { ...peer,
    readStat: async pid => pid === 234 && signaled
      ? procStat(234, { state: 'Z', start: '201' }) : peer.readStat(pid),
    readStatus: async () => signaled ? 'TracerPid:\t0\n' : 'TracerPid:\t234\n',
    signal: () => { signaled = true; },
  }), { state: 'uncertain', reason: 'tracer_reused' });
  assert.deepEqual(await stopDaemonTrace(identity, { ...peer, signal: () => undefined,
    wait: async () => undefined, budgetMs: 1,
  }), { state: 'uncertain', reason: 'stop_timeout' });
  assert.deepEqual(await stopDaemonTrace(undefined), { state: 'uncertain', reason: 'identity_unavailable' });
});

test('initialize failure still owns daemon discovery and stop before SDK close', async () => {
  const holder = await mkdtemp(join(tmpdir(), 'passeur-daemon-initialize-test-'));
  const muse = join(holder, 'muse');
  await writeFile(muse, '#!/bin/sh\nprintf "muse 1.4.0-R4302.1\\n"\n', { mode: 0o755 });
  const events = [];
  const identity = { host: { pid: 123, start: '100' },
    tracer: { pid: 234, start: '200', executable: '/usr/bin/strace' } };
  let resolveDiscovery;
  let result;
  try {
    result = await qualify({ muse, sessionStart: 'raw-trace-daemon',
      startLoopbackFixture: async () => ({ url: 'http://127.0.0.1:1', requests: [], close: async () => undefined }),
      resolveNativeExecutable: async launcher => {
        assert.equal(launcher, muse);
        events.push('native_attested');
        return '/opt/pinned-native';
      },
      spawnConnection: ({ command, args }) => {
        events.push('spawn');
        assert.deepEqual(args, ['serve']);
        return {
          initialize: async () => {
            const wrapper = await readFile(command, 'utf8');
            assert.match(wrapper, /exec strace '-D' '-I' '2'/);
            assert.match(wrapper, new RegExp(`'${muse}'`));
            assert.doesNotMatch(wrapper, /pinned-native/);
            events.push('initialize_failed');
            setTimeout(() => { events.push('discovered'); resolveDiscovery(identity); }, 5);
            throw new Error('injected initialize failure');
          },
          connection: { command: () => assert.fail('session/start was sent') },
          close: async () => { events.push('close'); },
        };
      },
      startDaemonDiscovery: (_marker, native) => {
        assert.equal(native, '/opt/pinned-native');
        events.push('discover_started');
        return new Promise(resolve => { resolveDiscovery = resolve; });
      },
      stopDaemon: async candidate => {
        assert.deepEqual(candidate, identity);
        events.push('stop');
        return { state: 'observed', detached: true };
      },
    });
    assert.equal(result.kind, 'qualification_error');
    assert.equal(result.stage, 'host_initialize');
    assert.deepEqual(events, ['native_attested', 'spawn', 'discover_started',
      'initialize_failed', 'discovered', 'stop', 'close']);
    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.trace.stop, { state: 'observed', detached: true });
    assert.equal((await stat(result.retainedFixtures[0])).isDirectory(), true);
    assert.equal(result.stopProof, 'descendants_unverified');
  } finally {
    if (result?.retainedFixtures) for (const root of result.retainedFixtures) {
      await rm(root, { recursive: true, force: true });
    }
    await rm(holder, { recursive: true, force: true });
  }
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

test('same-host session/read accepts only idle metadata and a canonical durable log under fresh HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'passeur-muse-read-test-'));
  const id = '0197134c-6a23-7a41-8a02-82f4a322f43f';
  const workspace = join(home, 'workspace');
  const log = join(home, 'session.jsonl');
  const started = { session: { sessionId: id, workspaceRoot: workspace } };
  const valid = { session: { sessionId: id, workspaceRoot: workspace, path: log,
    activeTurnId: null, turnCount: 0, status: 'idle' },
    pendingRequests: [], history: { mode: 'none', noneReason: 'excluded', items: null, snapshot: null },
    viewCursor: 'opaque-read-head' };
  const calls = [];
  const connection = value => ({ command: async (...args) => { calls.push(args); return value; } });
  try {
    await writeFile(log, 'durable record\n');
    assert.deepEqual(await readRawSession(connection(valid), started, workspace, home), valid);
    assert.deepEqual(calls, [['session/read', { sessionId: id, excludeItems: true }, { maxAttempts: 1 }]]);
    assert.equal((await readRawSession(connection({ ...valid, viewCursor: '' }), started, workspace, home)).viewCursor, '');
    for (const changed of [
      { session: { sessionId: 'wrong' } },
      { session: { workspaceRoot: '/tmp/wrong' } },
      { session: { path: '' } },
      { session: { path: home } },
      { session: { path: '/tmp/nonexistent-disposable-log' } },
      { session: { activeTurnId: 'turn' } },
      { session: { turnCount: 1 } },
      { pendingRequests: [{}] },
      { pendingRequests: null },
      { history: { mode: 'inline' } },
      { history: { noneReason: 'historyBudget' } },
      { history: { items: [] } },
      { history: { snapshot: {} } },
      { viewCursor: null },
    ]) {
      const response = { ...valid, ...changed, session: { ...valid.session, ...changed.session },
        history: { ...valid.history, ...changed.history } };
      await assert.rejects(readRawSession(connection(response), started, workspace, home),
        { code: 'INVALID_SESSION_READ' });
    }
    const outside = await mkdtemp(join(tmpdir(), 'passeur-muse-read-outside-'));
    try {
      const outsideLog = join(outside, 'session.jsonl');
      await writeFile(outsideLog, 'outside\n');
      await assert.rejects(readRawSession(connection({ ...valid,
        session: { ...valid.session, path: outsideLog } }), started, workspace, home),
      { code: 'INVALID_SESSION_READ' });
      const link = join(home, 'linked-log');
      await symlink(outsideLog, link);
      await assert.rejects(readRawSession(connection({ ...valid,
        session: { ...valid.session, path: link } }), started, workspace, home),
      { code: 'INVALID_SESSION_READ' });
    } finally { await rm(outside, { recursive: true, force: true }); }
    await assert.rejects(readRawSession({ command: async () => { throw new Error('read failed'); } },
      started, workspace, home), /read failed/);
    assert.equal(retainFixtureRoots({ hostSpawnAttempted: true, uncertainPreHostStop: false,
      fixtureClosed: true }), true);
  } finally { await rm(home, { recursive: true, force: true }); }
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
