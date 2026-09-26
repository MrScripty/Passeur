import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { acquireRepositoryLease } from '../../.passeur-core/src/core/lease.js';
import { processIdentity } from '../../.passeur-core/src/service/process.js';

const noop = () => {};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-lease-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'state');
}
async function retainedLock(path, process, match = true) {
  await mkdir(path);
  await mkdir(`${path}.lock`);
  const info = await stat(`${path}.lock`, { bigint: true });
  await writeFile(`${path}.owner.json`,
    JSON.stringify({ version: 1, process, device: String(info.dev), inode: match ? String(info.ino) : '0' }), { mode: 0o600 });
}
async function retainedAtomicLock(path, process, contents = JSON.stringify({ version: 1, process })) {
  await mkdir(path);
  await writeFile(`${path}.lock`, contents, { mode: 0o600 });
}

test('an old heartbeat cannot displace a live owner', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  try {
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
    lease.assertOwned();
    assert.equal((await stat(`${path}.lock`)).isFile(), true);
  } finally {
    await lease.release();
  }
});

test('a dead owner is recovered only from matching lock and process evidence', async t => {
  const path = await fixture(t);
  const process = { ...await processIdentity(), pid: 2_000_000_000 };
  await retainedLock(path, process);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  assert.equal(lease.state, 'held');
  await lease.release();
});

test('unknown, malformed and mismatched lock records require reconciliation', async t => {
  const process = { ...await processIdentity(), pid: 2_000_000_000 };
  for (const kind of ['missing', 'malformed', 'mismatched']) {
    const path = await fixture(t);
    if (kind === 'missing') { await mkdir(path); await mkdir(`${path}.lock`); }
    else await retainedLock(path, process, kind !== 'mismatched');
    if (kind === 'malformed') {
      await writeFile(`${path}.owner.json`, '{');
    }
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
  }
});

test('a dead atomic owner record is recovered without a publication gap', async t => {
  const path = await fixture(t);
  const process = { ...await processIdentity(), pid: 2_000_000_000 };
  await retainedAtomicLock(path, process);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  assert.equal(lease.state, 'held');
  await lease.release();
});

test('failed post-link observation removes only this acquisition candidate', async t => {
  const path = await fixture(t);
  await assert.rejects(acquireRepositoryLease(path, {
    onCompromised: noop,
    faults: { afterAtomicLink: () => { throw new Error('injected observation failure'); } },
  }));
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  await lease.release();
});

test('failed post-link observation preserves a successor lock', async t => {
  const path = await fixture(t);
  const successor = await processIdentity();
  await assert.rejects(acquireRepositoryLease(path, {
    onCompromised: noop,
    faults: { afterAtomicLink: async () => {
      await unlink(`${path}.lock`);
      await writeFile(`${path}.lock`, JSON.stringify({ version: 1, process: successor }), { mode: 0o600 });
      throw new Error('injected observation failure');
    } },
  }));
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, 'utf8')).process, successor);
  await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
});

test('reclaim helper exit after validation leaves stale atomic and legacy locks intact', async t => {
  const dead = { ...await processIdentity(), pid: 2_000_000_000 };
  for (const kind of ['atomic', 'legacy']) {
    const path = await fixture(t);
    if (kind === 'atomic') await retainedAtomicLock(path, dead);
    else await retainedLock(path, dead);
    const before = await stat(`${path}.lock`, { bigint: true });
    await assert.rejects(acquireRepositoryLease(path, {
      onCompromised: noop, faults: { reclaimExitBeforeMutation: true },
    }), { code: 'PROJECT_IN_USE' });
    const after = await stat(`${path}.lock`, { bigint: true });
    assert.equal(after.ino, before.ino);
    const lease = await acquireRepositoryLease(path, { onCompromised: noop });
    await lease.release();
  }
});

test('aborting behind a held recovery guard promptly preserves the stale lock', async t => {
  const path = await fixture(t);
  const dead = { ...await processIdentity(), pid: 2_000_000_000 };
  await retainedAtomicLock(path, dead);
  const before = await stat(`${path}.lock`, { bigint: true });
  const guard = `${path}.lock.reclaim.guard`;
  await writeFile(guard, '', { mode: 0o600 });
  const holder = spawn('flock', ['--exclusive', '--no-fork', guard, process.execPath,
    '-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => holder.once('close', resolve));
  try {
    const ready = new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', chunk => resolve(String(chunk)));
      holder.once('close', () => reject(new Error('guard holder exited before readiness')));
    });
    assert.equal(await Promise.race([ready, delay(3000).then(() => { throw new Error('guard holder did not start'); })]), 'ready\n');

    const controller = new AbortController();
    const reason = new Error('preparation cancelled');
    const attempt = acquireRepositoryLease(path, { signal: controller.signal, onCompromised: noop });
    await delay(100);
    const started = Date.now();
    controller.abort(reason);
    await assert.rejects(Promise.race([
      attempt,
      delay(1500).then(() => { throw new Error('reclaim did not cancel promptly'); }),
    ]), error => error === reason);
    assert.ok(Date.now() - started < 1500);
    assert.equal((await stat(`${path}.lock`, { bigint: true })).ino, before.ino);
  } finally {
    holder.kill();
    await closed;
  }
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  await lease.release();
});

test('concurrent reclaimers leave the winning atomic and legacy leases held', async t => {
  const dead = { ...await processIdentity(), pid: 2_000_000_000 };
  for (const kind of ['atomic', 'legacy']) {
    const path = await fixture(t);
    if (kind === 'atomic') await retainedAtomicLock(path, dead);
    else await retainedLock(path, dead);

    // Hold the winner until every contender has completed. A second winner
    // means one reclaimer removed its live successor after checking the stale
    // inode, even if the replacement happened between that check and unlink.
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, () =>
      acquireRepositoryLease(path, { onCompromised: noop })));
    const winners = attempts.filter(result => result.status === 'fulfilled').map(result => result.value);
    try {
      assert.equal(winners.length, 1, `${kind}: exactly one reclaimer must acquire the lease`);
      assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'PROJECT_IN_USE').length, 15);
      winners[0].assertOwned();
      assert.equal((await stat(`${path}.lock`)).isFile(), true);
    } finally {
      await Promise.all(winners.map(lease => lease.release()));
    }
  }
});

test('a live atomic owner blocks recovery', async t => {
  const path = await fixture(t);
  await retainedAtomicLock(path, await processIdentity());
  await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
});

test('malformed atomic ownership evidence requires reconciliation', async t => {
  const path = await fixture(t);
  await retainedAtomicLock(path, await processIdentity(), '{');
  await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
});

test('ownership evidence with coerced process fields requires reconciliation', async t => {
  const process = await processIdentity();
  for (const replacement of [
    { pid: String(process.pid) },
    { boot_id: [process.boot_id] },
    { started: Number(process.started) },
  ]) {
    const path = await fixture(t);
    await retainedLock(path, { ...process, ...replacement });
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
  }
});

test('release removes the active lock and retains historical ownership evidence', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  assert.equal(JSON.parse(await readFile(`${path}.owner.json`, 'utf8')).process.pid, process.pid);
  await lease.release();
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(`${path}.owner.json`, 'utf8')).process.pid, process.pid);
  const next = await acquireRepositoryLease(path, { onCompromised: noop });
  await next.release();
});

test('production ownership evidence does not compromise the lease heartbeat', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  try {
    await delay(10_500);
    lease.assertOwned();
    assert.equal((await stat(`${path}.lock`)).isFile(), true);
  } finally {
    await lease.release();
  }
});
