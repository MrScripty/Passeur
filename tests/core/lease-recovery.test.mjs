import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

test('an old heartbeat cannot displace a live owner', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  try {
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    await assert.rejects(acquireRepositoryLease(path, { onCompromised: noop }), { code: 'PROJECT_IN_USE' });
    lease.assertOwned();
    assert.equal((await readdir(`${path}.lock`)).length, 0);
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

test('release removes ownership evidence and leaves no lock', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  assert.equal(JSON.parse(await readFile(`${path}.owner.json`, 'utf8')).process.pid, process.pid);
  await lease.release();
  await assert.rejects(readdir(`${path}.lock`), { code: 'ENOENT' });
  await assert.rejects(readFile(`${path}.owner.json`, 'utf8'), { code: 'ENOENT' });
  const next = await acquireRepositoryLease(path, { onCompromised: noop });
  await next.release();
});

test('production ownership evidence does not compromise the lease heartbeat', async t => {
  const path = await fixture(t);
  const lease = await acquireRepositoryLease(path, { onCompromised: noop });
  try {
    await delay(10_500);
    lease.assertOwned();
    assert.equal((await readdir(`${path}.lock`)).length, 0);
  } finally {
    await lease.release();
  }
});
