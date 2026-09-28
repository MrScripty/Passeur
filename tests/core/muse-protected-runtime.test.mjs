import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { protectedLaunch, captureProtectedHost, verifyProtectedStop,
  acceptProtectedCapture } from '../../dist/src/muse/protected-runtime.js';
import { prepareProtectedSessions, runProtectedGuest, runProtectedHost } from '../../dist/src/muse/protected-host.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'passeur-protected-runtime-test-'));
  const workspace = join(root, 'workspace'), canonical = join(root, 'canonical.git');
  const control = join(root, 'control'), privateDir = join(control, 'private-git');
  const runtime = join(root, 'runtime'), home = join(root, 'home');
  const relay = join(root, 'relay'), protectedRoot = join(root, 'protected');
  for (const path of [workspace, canonical, privateDir, runtime, home, relay, protectedRoot,
    join(privateDir, 'worktrees', 'task')]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, '.git'), `gitdir: ${canonical}/worktrees/task\n`);
  await writeFile(join(privateDir, 'worktrees', 'task', 'commondir'), '../..\n');
  for (const name of ['node', 'muse', 'protected-host.js']) await writeFile(join(runtime, name), name);
  await writeFile(join(relay, 'relay.sock'), 'synthetic socket path');
  const input = { workspace, request: { mode: 'implement' }, private_git: { schema_version: 1,
    mount_kind: 'canonical_common_dir', view: { private_common_dir: privateDir,
      canonical_common_dir: canonical, admin_relative: 'worktrees/task' } } };
  const config = { runtimeRoot: runtime, home, relayDirectory: relay,
    protectedRoots: [control, protectedRoot], nodeExecutable: join(runtime, 'node'),
    museExecutable: join(runtime, 'muse'), hostScript: join(runtime, 'protected-host.js'),
    relayHeaders: { 'x-passeur-run': 'run_test' } };
  return { root, input, config, control, privateDir, canonical, workspace,
    close: async () => rm(root, { recursive: true, force: true }) };
}

test('production launch owns exact private mount, isolated environment and host status path', async () => {
  const f = await fixture();
  try {
    const { hostOptions, statusFile, guestMuseExecutable } = protectedLaunch(f.input, f.config,
      ['serve', '--disable-sandbox']);
    assert.equal(hostOptions.museBin, f.config.nodeExecutable);
    assert.deepEqual(hostOptions.env, {});
    assert.ok(statusFile.startsWith(`${f.control}/`));
    const hostSpec = JSON.parse(Buffer.from(hostOptions.args[2], 'base64url').toString());
    const args = hostSpec.bwrapArgs;
    assert.equal(hostSpec.statusFile, statusFile);
    assert.ok(args.includes('--unshare-net'));
    assert.ok(args.includes('--die-with-parent'));
    assert.ok(args.includes('--clearenv'));
    assert.deepEqual(args.slice(args.indexOf('--bind') + 1, args.indexOf('--bind') + 3),
      [f.workspace, f.workspace]);
    assert.ok(args.join('\0').includes(`${f.privateDir}\0${f.canonical}`));
    assert.equal(args.includes(f.control), false);
    const guestSpec = JSON.parse(Buffer.from(args.at(-1), 'base64url').toString());
    assert.equal(guestMuseExecutable, '/mounts/runtime/muse');
    assert.equal(guestSpec.museBin, guestMuseExecutable);
    assert.deepEqual(guestSpec.museArgs, ['serve', '--disable-sandbox']);
    assert.deepEqual(guestSpec.relayHeaders, { 'x-passeur-run': 'run_test' });
  } finally { await f.close(); }
});

test('production launch refuses changed private Git authority before starting a host', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, '.git'), 'gitdir: /tmp/foreign/worktrees/task\n');
    assert.throws(() => protectedLaunch(f.input, f.config, ['serve', '--disable-sandbox']),
      { code: 'MUSE_PROTECTED_LAUNCH_INVALID' });
    await writeFile(join(f.workspace, '.git'), `gitdir: ${f.canonical}/worktrees/task\n`);
    assert.throws(() => protectedLaunch(f.input,
      { ...f.config, protectedRoots: [dirname(f.workspace)] }, ['serve', '--disable-sandbox']),
      { code: 'MUSE_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('production guest prepares an owned empty mode-0700 sessions path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-protected-sessions-test-'));
  try {
    prepareProtectedSessions(root);
    let path = root;
    for (const part of ['.local', 'share', 'muse', 'sessions']) {
      path = join(path, part);
      const entry = await lstat(path);
      assert.equal(entry.uid, process.getuid());
      assert.equal(entry.mode & 0o7777, 0o700);
    }
    assert.deepEqual(await readdir(path), []);
    assert.throws(() => prepareProtectedSessions(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production guest retires its relay after session-prep or native-spawn failure', async () => {
  for (const stage of ['sessions', 'spawn']) {
    const home = await mkdtemp(join(tmpdir(), 'passeur-protected-guest-stop-'));
    let retired = 0, spawns = 0;
    class FakeRelay extends EventEmitter {
      listening = false;
      listen(_port, _host, ready) { this.listening = true; ready(); return this; }
      address() { return { port: 12345 }; }
      closeAllConnections() { retired++; }
      close(done) { this.listening = false; retired++; done(); }
    }
    try {
      if (stage === 'sessions') await mkdir(join(home, '.local'), { mode: 0o755 });
      await assert.rejects(runProtectedGuest({ museBin: '/missing/muse', museArgs: ['serve'],
        relaySocket: '/missing/relay.sock', home, relayHeaders: {} },
      () => new FakeRelay(), () => { spawns++; throw Error('controlled native spawn failure'); }));
      assert.equal(retired, 2);
      assert.equal(spawns, stage === 'sessions' ? 0 : 1);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

async function streamingGuestFixture(onProviderRequest) {
  const home = await mkdtemp(join(tmpdir(), 'passeur-protected-stream-test-'));
  const socket = join(home, 'provider.sock');
  const provider = createServer(onProviderRequest);
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(socket, resolve);
  });
  let native, relayUrl, ready;
  const launched = new Promise(resolve => { ready = resolve; });
  const spawnNative = () => {
    native = new EventEmitter();
    native.stdin = new PassThrough();
    native.stdout = new PassThrough();
    native.stderr = new PassThrough();
    native.exitCode = null;
    native.signalCode = null;
    native.kill = () => false;
    relayUrl = JSON.parse(readFileSync(join(home, '.config/muse/settings.json'), 'utf8'))
      .endpoint_transport.base_url;
    ready();
    return native;
  };
  const guest = runProtectedGuest({ museBin: '/controlled/muse', museArgs: ['serve'],
    relaySocket: socket, home, relayHeaders: {} }, undefined, spawnNative);
  await Promise.race([launched, guest.then(() => { throw new Error('guest exited before native launch'); })]);
  const stop = async () => {
    native.exitCode = 0;
    native.emit('close', 0, null);
    assert.equal(await guest, 0);
  };
  const close = async () => {
    if (native.exitCode === null) await stop();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(home, { recursive: true, force: true });
  };
  return { relayUrl, stop, close };
}

function relayPost(url, onChunk = () => {}) {
  let settled = false;
  const result = new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: 'Bearer test',
      'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); onChunk(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('relay response aborted')));
    });
    req.on('error', reject);
    req.end('{}');
  }).finally(() => { settled = true; });
  return { result, get settled() { return settled; } };
}

async function assertRelayRetired(url) {
  await assert.rejects(relayPost(url).result, error =>
    error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET');
}

function afterCompleteProviderRequest(req, run) {
  const chunks = [];
  req.on('data', value => chunks.push(value));
  req.on('end', () => {
    assert.equal(Buffer.concat(chunks).toString(), '{}');
    run();
  });
}

async function within(promise, milliseconds = 2_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('relay observation timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('production guest forwards a provider response across slow first and interchunk waits', async () => {
  const f = await streamingGuestFixture((req, res) => {
    afterCompleteProviderRequest(req, () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('first');
      setTimeout(() => res.end('second'), 5_200);
    }, 5_200));
  });
  try {
    assert.equal(await relayPost(f.relayUrl).result, 'firstsecond');
    await f.stop();
    await assertRelayRetired(f.relayUrl);
  } finally { await f.close(); }
});

test('production guest closes partial responses and releases each active relay slot', async () => {
  let requestCount = 0;
  const f = await streamingGuestFixture((req, res) => {
    afterCompleteProviderRequest(req, () => {
      if (++requestCount <= 4) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('partial');
        setTimeout(() => res.socket.destroy(), 20);
      } else res.end('complete');
    });
  });
  try {
    for (let index = 0; index < 4; index++) {
      let chunks = 0;
      const client = relayPost(f.relayUrl, () => { chunks++; });
      await assert.rejects(within(client.result), error =>
        error.message !== 'relay observation timed out');
      assert.equal(chunks, 1);
    }
    assert.equal(await within(relayPost(f.relayUrl).result), 'complete');
    await f.stop();
    await assertRelayRetired(f.relayUrl);
  } finally { await f.close(); }
});

for (const wait of ['first response', 'interchunk']) {
  test(`production guest cancellation retires relay during ${wait} wait`, async () => {
    let receivedChunk;
    const chunk = new Promise(resolve => { receivedChunk = resolve; });
    let providerClosed;
    const closed = new Promise(resolve => { providerClosed = resolve; });
    const f = await streamingGuestFixture((req, res) => {
      res.once('close', providerClosed);
      afterCompleteProviderRequest(req, () => {
        if (wait === 'interchunk') res.write('first');
      });
    });
    try {
      const client = relayPost(f.relayUrl, receivedChunk);
      void client.result.catch(() => {});
      if (wait === 'interchunk') await chunk;
      await new Promise(resolve => setTimeout(resolve, 5_200));
      assert.equal(client.settled, false);
      await f.stop();
      await assert.rejects(client.result);
      await within(closed);
      await assertRelayRetired(f.relayUrl);
    } finally { await f.close(); }
  });
}

test('production SDK host reserves status FD 3 outside MSP stdio and writes exact terminal frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-protected-host-status-'));
  const statusFile = join(root, 'status.jsonl');
  let launched;
  const fakeSpawn = (command, args, options) => {
    launched = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.pid = 100;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => false;
    queueMicrotask(() => {
      child.stdio[3].write('{"child-pid":102}\n');
      child.stdio[3].write('{"exit-code":0}\n');
      child.stdio[3].end();
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  };
  try {
    const code = await runProtectedHost({ bwrapArgs: ['--unshare-pid', '--', '/guest/node'],
      statusFile }, fakeSpawn,
    { stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
    assert.equal(code, 0);
    assert.equal(launched.command, 'bwrap');
    assert.deepEqual(launched.args,
      ['--unshare-pid', '--json-status-fd', '3', '--', '/guest/node']);
    assert.deepEqual(launched.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
    assert.deepEqual((await readFile(statusFile, 'utf8')).trim().split('\n').map(JSON.parse),
      [{ kind: 'wrapper', pid: 100 }, { 'child-pid': 102 }, { 'exit-code': 0 },
        { kind: 'wrapper-exit', code: 0, signal: null }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function observedHost() {
  const wrapper = { pid: 100, parent: 1, start: '10', pidns: 'pid:[host]',
    netns: 'net:[host]', nspid: [100], exe: '/usr/bin/bwrap' };
  const init = { pid: 101, parent: 100, start: '11', pidns: 'pid:[guest]',
    netns: 'net:[guest]', nspid: [101, 1], exe: '/usr/bin/bwrap' };
  const child = { pid: 102, parent: 101, start: '12', pidns: 'pid:[guest]',
    netns: 'net:[guest]', nspid: [102, 2], exe: '/mounts/runtime/node' };
  const native = { pid: 103, parent: 102, start: '13', pidns: 'pid:[guest]',
    netns: 'net:[guest]', nspid: [103, 3], exe: '/mounts/runtime/muse' };
  const live = new Map([wrapper, init, child, native].map(value => [value.pid, value]));
  let status = [{ kind: 'wrapper', pid: wrapper.pid }, { 'child-pid': child.pid }];
  let closed = 0, stagedIno = 123;
  const io = {
    status: async () => status.map(value => JSON.stringify(value)).join('\n') + '\n',
    boot: async () => 'boot',
    identity: async pid => { const value = live.get(pid);
      if (!value) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return value; },
    members: async pidns => [...live.values()].filter(value => value.pidns === pidns),
    openNamespace: async () => ({ fd: 42, close: async () => { closed++; } }),
    heldNamespace: async () => 'pid:[guest]',
    executable: async path => ({ dev: 1, ino: path === '/proc/103/exe' ? 123 : stagedIno }),
  };
  return { io, live, wrapper, child, native, get closed() { return closed; },
    exit: () => { status = [...status, { 'exit-code': 0 },
      { kind: 'wrapper-exit', code: 0, signal: null }]; },
    changeChild: () => { status = [status[0], { 'child-pid': 999 }, ...status.slice(2)]; },
    changeWrapper: () => { status = [{ kind: 'wrapper', pid: 999 }, ...status.slice(1)]; },
    wrongInode: () => { stagedIno = 777; } };
}

test('production observer confirms only the exact captured namespace after status FD closes', async () => {
  const f = observedHost();
  const captured = await captureProtectedHost('status', '/mounts/runtime/muse', '/host/muse', f.io);
  assert.equal(captured.wrapperPid, f.wrapper.pid);
  assert.equal(captured.childPid, f.child.pid);
  f.exit();
  for (const pid of [...f.live.keys()]) f.live.delete(pid);
  assert.equal(await verifyProtectedStop(captured, 'status', f.io), true);
  assert.equal(f.closed, 1);
});

test('production observer rejects a surviving descendant and closes the namespace handle', async () => {
  const f = observedHost();
  const captured = await captureProtectedHost('status', '/mounts/runtime/muse', '/host/muse', f.io);
  f.exit();
  for (const pid of [...f.live.keys()]) if (pid !== f.native.pid) f.live.delete(pid);
  assert.equal(await verifyProtectedStop(captured, 'status', f.io), false);
  assert.equal(f.closed, 1);
});

test('production observer rejects substituted terminal child or wrapper status', async () => {
  for (const change of ['changeChild', 'changeWrapper']) {
    const f = observedHost();
    const captured = await captureProtectedHost('status', '/mounts/runtime/muse', '/host/muse', f.io);
    f.exit(); change === 'changeChild' ? f.changeChild() : f.changeWrapper();
    f.live.clear();
    assert.equal(await verifyProtectedStop(captured, 'status', f.io), false);
    assert.equal(f.closed, 1);
  }
});

test('production observer refuses an unbound native executable and releases its namespace', async () => {
  const f = observedHost();
  f.wrongInode();
  await assert.rejects(captureProtectedHost('status', '/mounts/runtime/muse', '/host/muse', f.io),
    { code: 'MUSE_PROTECTED_LAUNCH_INVALID' });
  assert.equal(f.closed, 1);
});

test('late captured startup releases its namespace after cancellation', async () => {
  const f = observedHost();
  const captured = await captureProtectedHost('status', '/mounts/runtime/muse', '/host/muse', f.io);
  await assert.rejects(acceptProtectedCapture(captured, true), { code: 'MUSE_STOP_UNCONFIRMED' });
  assert.equal(f.closed, 1);
});
