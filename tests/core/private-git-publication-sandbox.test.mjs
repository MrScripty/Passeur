import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { prepareSandbox, probeBubblewrap } from '../../scripts/experiment-worker-sandbox.mjs';
import { fixture, git, done, wrapCoordinator } from './helpers.mjs';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { prepareWorkspace } from '../../.passeur-core/src/workspace/worktree.js';

const workerSource = fileURLToPath(new URL('../fixtures/private-git-worker.mjs', import.meta.url));
const capability = { schema_version: 1, mount_kind: 'canonical_common_dir' };
const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

function procIdentity(pid) {
  let statText;
  try { statText = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') throw Object.assign(new Error('PID stat is absent'), { code: 'PROCESS_ABSENT' });
    throw error;
  }
  const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
  return { pid, start: fields[19], parent: Number(fields[1]), namespace: readlinkSync(`/proc/${pid}/ns/pid`),
    executable: readlinkSync(`/proc/${pid}/exe`), bootId };
}
function childPids(pid) {
  const text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
  return text ? text.split(' ').map(Number) : [];
}
function observedTree(rootPid) {
  const queue = [rootPid], seen = new Set(), records = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const record = procIdentity(pid);
    records.push(record);
    queue.push(...childPids(pid));
  }
  return records;
}
function assertExactStopped(records, inspect = procIdentity) {
  if (records.length < 3 || new Set(records.map(record => record.pid)).size !== records.length ||
      records.some((record) => !record.start || record.bootId !== bootId)) return false;
  for (const record of records) {
    try {
      const current = inspect(record.pid);
      // PID reuse is an uncertainty, never evidence of the original process stopping safely.
      if (current.start !== record.start || current.bootId !== record.bootId) return false;
      return false;
    } catch (error) {
      if (error.code !== 'PROCESS_ABSENT') return false;
    }
  }
  return true;
}
async function waitFor(check, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('controlled observation timed out');
}
async function exitedWithin(exit, timeoutMs) {
  let timer;
  try { return await Promise.race([exit.then(() => true, () => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function disposableFixture() {
  // The generic fixture registers unconditional removal. This gate owns its root until stop is proven.
  const original = process.env.TMPDIR;
  process.env.TMPDIR = '/tmp';
  try { return await fixture({ after() {} }); }
  finally { if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original; }
}
async function disposeControlledFixture(f, { verifiedStop, succeeded }) {
  if (!verifiedStop || !succeeded) {
    assert.equal(existsSync(f.temp), true);
    process.stderr.write(`retained controlled sandbox fixture: ${f.temp}\n`);
    return 'retained';
  }
  await rm(f.temp, { recursive: true, force: true });
  assert.equal(existsSync(f.temp), false);
  return 'removed';
}
function controlled(f, run) {
  const worker = { private_git: capability, run: async input => {
    const turn_id = randomUUID();
    await input.onEvent({ kind: 'turn_started', turn_id });
    const result = await run(input);
    await input.onEvent({ kind: 'turn_settled', turn_id, terminal: result.status === 'completed' ? 'completed' : 'failed' });
    return result;
  } };
  const registry = new AgentRegistry(f.profile, { muse: { configure: () => ({ worker, modes: ['implement'], contract: 'controlled-sandbox/1', configuration: { model: 'fake' } }) } });
  return wrapCoordinator(new Coordinator(f.root, 'project', f.policy, f.store, registry, () => {}, undefined, 'controlled'), f.root, f.owner);
}

test('canonical private Git mount, network denial and observed stop precede Coordinator publication', { skip: process.platform !== 'linux' }, async () => {
  probeBubblewrap();
  const f = await disposableFixture();
  let verifiedStop = false, succeeded = false;
  try {
    const protectedRoot = join(f.temp, 'protected');
    const oracle = join(protectedRoot, 'oracle'), sibling = join(protectedRoot, 'sibling');
    await mkdir(oracle, { recursive: true }); await mkdir(sibling);
    await writeFile(join(oracle, 'marker'), 'oracle'); await writeFile(join(sibling, 'marker'), 'sibling');
    const siblingWorkspace = await prepareWorkspace(f.root, f.implementation('sibling'), f.policy, 'project', randomUUID());
    await writeFile(join(siblingWorkspace.path, 'sibling.txt'), 'private sibling bytes\n');
    await git(siblingWorkspace.path, 'add', 'sibling.txt');
    await git(siblingWorkspace.path, 'commit', '-qm', 'sibling work');
    const siblingHead = (await git(f.root, 'rev-parse', siblingWorkspace.branch)).trim();
    const hook = join(f.root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf hook > "$(dirname "$0")/hook-ran"\n'); await chmod(hook, 0o755);
    const sockets = new Set();
    const listener = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    let privateHead;
    let completedAssertions = false;
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
      });
      const hostPort = listener.address().port;
      await new Promise((resolve, reject) => {
        const socket = net.connect(hostPort, '127.0.0.1');
        let timer, settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error); else resolve();
        };
        timer = setTimeout(() => finish(new Error('host listener preflight timed out')), 1_000);
        socket.once('connect', () => finish());
        socket.once('error', finish);
      });
      const c = controlled(f, async input => {
        assert.deepEqual(input.private_git?.mount_kind, 'canonical_common_dir');
        const view = input.private_git.view;
        const source = view.private_common_dir;
        const controlRoot = f.store.taskDir(input.task_id);
        assert.ok(source.startsWith(`${controlRoot}/`));
        await writeFile(join(controlRoot, 'canary'), 'control');
        const workspace = input.workspace;
        const workerScript = join(workspace, 'private-git-worker.mjs');
        await copyFile(workerSource, workerScript);
        await symlink(oracle, join(workspace, 'oracle-link'));
        await symlink(sibling, join(workspace, 'sibling-link'));
        await symlink(siblingWorkspace.path, join(workspace, 'sibling-worktree-link'));
        const ready = join(workspace, 'worker-ready.json'), release = join(workspace, 'release');
        const descendantReady = join(workspace, 'descendant-ready'), workerStopped = join(workspace, 'worker-stopped');
        const workerConfig = { workspace, canonicalCommonDir: view.canonical_common_dir, adminRelative: view.admin_relative,
          branch: (await f.store.readResource(input.task_id)).branch_ref,
          deniedFiles: [join(oracle, 'marker'), join(sibling, 'marker'), join(siblingWorkspace.path, 'sibling.txt'),
            join(view.canonical_common_dir, siblingWorkspace.branch), join(controlRoot, 'canary')],
          symlinkFiles: [join(workspace, 'oracle-link', 'marker'), join(workspace, 'sibling-link', 'marker'),
            join(workspace, 'sibling-worktree-link', 'sibling.txt')],
          hostPort, siblingHead, workerReady: ready, descendantReady, release, workerStopped };
        const binding = { workspace, preserveWorkspacePath: true,
          denied: [protectedRoot, siblingWorkspace.path, controlRoot], privateGit: { view, controlRoot }, env: { HOME: workspace } };
        const command = ['/usr/bin/node', workerScript, JSON.stringify(workerConfig)];
        assert.throws(() => prepareSandbox({ ...binding, privateGit: { view: { ...view, canonical_common_dir: sibling }, controlRoot } }, command), /PRIVATE_GIT_INVALID/);
        assert.throws(() => prepareSandbox({ ...binding, privateGit: { view: { ...view, private_common_dir: sibling }, controlRoot } }, command), /PRIVATE_GIT_INVALID/);
        assert.throws(() => prepareSandbox({ ...binding, mounts: [{ mode: 'ro', source: controlRoot, target: '/mounts/control' }] }, command), /SOURCE_DENIED/);
        assert.throws(() => prepareSandbox({ ...binding, mounts: [{ mode: 'rw', source: source, target: '/mounts/git-alias' }] }, command), /SOURCE_DENIED|WRITE_OVERLAP/);
        const prepared = prepareSandbox(binding, command);
        assert.equal(prepared.privateGit.target, view.canonical_common_dir);
        const child = spawn(prepared.executable, prepared.args, { stdio: ['ignore', 'ignore', 'pipe'], env: {} });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
        const childExit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
        const launched = procIdentity(child.pid);
        let observed;
        try {
          const report = await waitFor(async () => existsSync(ready) && existsSync(descendantReady) ? JSON.parse(await readFile(ready, 'utf8')) : null);
          privateHead = report.head;
          assert.equal((await readFile(join(view.private_common_dir, workerConfig.branch), 'utf8')).trim(), privateHead);
          assert.notEqual(privateHead, f.base);
          assert.equal((await git(f.root, 'rev-parse', workerConfig.branch)).trim(), f.base);
          assert.equal(await f.store.readPrivatePublication(input.task_id), undefined);
          observed = observedTree(child.pid);
          assert.ok(observed.length >= 3, 'wrapper, worker and descendant must be observed');
          assert.ok(observed.some(record => record.pid === child.pid && record.executable.endsWith('/bwrap')));
          assert.ok(observed.some(record => record.executable.endsWith('/node') && observed.some(parent =>
            parent.pid === record.parent && parent.executable.endsWith('/node'))), 'owned Node descendant must be observed');
          await writeFile(release, 'release');
          if (!await exitedWithin(childExit, 5_000)) throw new Error('controlled worker did not exit after release');
          await waitFor(() => assertExactStopped(observed));
          assert.equal(await readFile(workerStopped, 'utf8'), 'stopped');
          for (const path of [ready, release, descendantReady, workerStopped]) await unlink(path);
          verifiedStop = true;
          return done();
        } catch (error) {
          // Failure cleanup releases this owned fake worker; it never becomes stop evidence.
          await writeFile(release, 'release').catch(() => {});
          const exited = await exitedWithin(childExit, 2_000);
          if (!exited) {
            try { if (procIdentity(child.pid).start === launched.start) child.kill('SIGTERM'); } catch { /* unknown identity: retain root */ }
          }
          process.stderr.write(`controlled sandbox failure: ${error.stack ?? error}; child stderr: ${stderr}\n`);
          return done({ status: 'failed', worker_stop: 'unconfirmed', error: { code: 'CONTROLLED_SANDBOX_UNCONFIRMED', message: String(error) } });
        }
      });
      const result = await c.execute(f.implementation('canonical-sandbox'));
      assert.equal(verifiedStop, true);
      assert.equal(result.delivery.status, 'committed');
      assert.equal(result.delivery.head_commit, privateHead);
      assert.equal(await readFile(join(result.delivery.worktree_path, 'worker.txt'), 'utf8'), 'exact controlled private bytes\n');
      const resource = await f.store.readResource(result.task_id);
      assert.equal(await readFile(join(resource.private_git.view.private_common_dir, 'hooks', 'hook-ran'), 'utf8'), 'hook');
      assert.equal(resource.private_git.state, 'published');
      assert.equal((await f.store.readPrivatePublication(result.task_id)).state, 'published');
      assert.equal(await readFile(join(oracle, 'marker'), 'utf8'), 'oracle');
      assert.equal(await readFile(join(sibling, 'marker'), 'utf8'), 'sibling');
      assert.equal(await readFile(join(siblingWorkspace.path, 'sibling.txt'), 'utf8'), 'private sibling bytes\n');
      assert.equal((await git(f.root, 'rev-parse', siblingWorkspace.branch)).trim(), siblingHead);
      completedAssertions = true;
    } finally {
      for (const socket of sockets) socket.destroy();
      if (listener.listening) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
    succeeded = completedAssertions;
  } finally {
    await disposeControlledFixture(f, { verifiedStop, succeeded });
  }
});

test('stop identity rejects live, reused, missing coverage and inspection failure', () => {
  const id = { pid: 1, start: '100', bootId };
  const records = [id, { ...id, pid: 2 }, { ...id, pid: 3 }];
  assert.equal(assertExactStopped(records, () => id), false);
  assert.equal(assertExactStopped(records, () => ({ ...id, start: '101' })), false);
  assert.equal(assertExactStopped(records, () => { throw Object.assign(new Error('permission'), { code: 'EACCES' }); }), false);
  assert.equal(assertExactStopped([id, id], () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), false);
  assert.equal(assertExactStopped(records, () => { throw Object.assign(new Error('late metadata vanished'), { code: 'ENOENT' }); }), false);
  assert.equal(assertExactStopped(records, () => { throw Object.assign(new Error('PID stat absent'), { code: 'PROCESS_ABSENT' }); }), true);
});

test('a live controlled descendant keeps Coordinator publication unconfirmed and retains its private root', async () => {
  const f = await disposableFixture();
  let child, childExit, observed;
  try {
    const c = controlled(f, async input => {
      assert.ok(input.private_git?.view);
      child = spawn('/bin/sleep', ['2'], { stdio: 'ignore' });
      childExit = new Promise(resolve => child.once('exit', resolve));
      observed = procIdentity(child.pid);
      assert.equal(procIdentity(child.pid).start, observed.start);
      return done({ worker_stop: 'unconfirmed' });
    });
    const result = await c.execute(f.implementation('live-descendant-unconfirmed'));
    assert.equal(result.worker_stop, 'unconfirmed');
    assert.notEqual(result.delivery.status, 'committed');
    const resource = await f.store.readResource(result.task_id);
    assert.equal(resource.private_git.state, 'prepared');
    assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
    assert.equal(existsSync(f.temp), true);
  } finally {
    const childStopped = childExit ? await exitedWithin(childExit, 5_000) : true;
    assert.equal(await disposeControlledFixture(f, { verifiedStop: false, succeeded: true }), 'retained');
    assert.equal(existsSync(f.temp), true);
    assert.equal(childStopped, true, 'owned negative-control child did not stop');
  }
});
