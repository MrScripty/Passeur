import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, chmod, link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, A, B, repo, limits, key, register, claim, post } from '../fixtures/structural/coordination-fixture.mjs';
import { CoordinationStore } from '../../.passeur-core/src/store/coordination-store.js';
import { CoordinationControl } from '../../.passeur-core/src/coordination/control.js';
import { decodeCommand, decodeControl, assertControlTransition } from '../../.passeur-core/src/contracts/coordination-control.js';
import { atomicJson } from '../../.passeur-core/src/store/atomic-json.js';
const run = promisify(execFile);
const childScript = fileURLToPath(new URL('../fixtures/structural/coordination-reopen.mjs', import.meta.url));
async function rootOnly(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-store-test-'));
  t.after(async () => {
    await rm(root, { recursive: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG, JSON.stringify({ root, disposition: 'removed-test-owned', kind: 'coordination-root' }) + '\n');
  });
  return root;
}

test('read-only open never initializes absent authority', async t => {
  const root = await rootOnly(t);
  await assert.rejects(CoordinationStore.open(root, repo, () => {}), { code: 'COORDINATION_NOT_ENABLED' });
  assert.deepEqual(await readdir(root), []);
});
test('explicit initialization publishes complete state and exact matching marker', async t => {
  const root = await rootOnly(t), store = await CoordinationStore.initialize(root, repo, limits, () => {});
  const state = await store.snapshot(), marker = JSON.parse(await readFile(join(root, 'coordination/initialized.json'), 'utf8'));
  assert.equal(state.revision, 0); assert.equal(state.epoch, marker.epoch); assert.equal(marker.repository_id, repo);
  const reopened = await CoordinationStore.initialize(root, repo, limits, () => {});
  assert.equal((await reopened.snapshot()).epoch, state.epoch);
  await reopened.close(); await store.close();
});
test('different limits require migration rather than silently reinitializing', async t => {
  const f = await fixture(t);
  await assert.rejects(CoordinationStore.initialize(f.root, repo, { ...limits, notes: 2 }, () => {}), { code: 'COORDINATION_CONFIG_CONFLICT' });
  assert.deepEqual((await f.disk()).limits, limits);
});
test('an empty existing coordination directory is incomplete, not a fresh store', async t => {
  const root = await rootOnly(t); await mkdir(join(root, 'coordination'), { mode: 0o700 });
  await assert.rejects(CoordinationStore.initialize(root, repo, limits, () => {}), { code: 'COORDINATION_STORE_INCOMPLETE' });
  assert.deepEqual(await readdir(join(root, 'coordination')), []);
});
for (const file of ['control.json', 'initialized.json']) {
  test(`missing ${file} is preserved as incomplete state`, async t => {
    const f = await fixture(t), path = join(f.root, 'coordination', file); await unlink(path);
    await assert.rejects(CoordinationStore.initialize(f.root, repo, limits, () => {}), { code: 'COORDINATION_STORE_INCOMPLETE' });
    await assert.rejects(access(path), { code: 'ENOENT' });
  });
}
test('corrupt, unsupported and foreign-repository states remain distinguishable and untouched', async t => {
  const f = await fixture(t), original = await readFile(f.file);
  await writeFile(f.file, '{truncated');
  await assert.rejects(CoordinationStore.open(f.root, repo, () => {}), { code: 'COORDINATION_RECORD_CORRUPT' });
  assert.equal(await readFile(f.file, 'utf8'), '{truncated');
  const future = JSON.parse(original); future.schema_version = 4; await writeFile(f.file, JSON.stringify(future));
  await assert.rejects(CoordinationStore.open(f.root, repo, () => {}), { code: 'COORDINATION_VERSION_UNSUPPORTED' });
  const foreign = JSON.parse(original); foreign.repository_id = 'other'; await writeFile(f.file, JSON.stringify(foreign));
  await assert.rejects(CoordinationStore.open(f.root, repo, () => {}), { code: 'COORDINATION_BINDING_CONFLICT' });
});
test('malformed cross-record state cannot be reopened or replaced by empty state', async t => {
  const f = await fixture(t); await f.control.execute(A, register());
  const value = await f.disk(); value.receipts[0].entity.id = key(); await writeFile(f.file, JSON.stringify(value));
  await assert.rejects(CoordinationStore.open(f.root, repo, () => {}), { code: 'COORDINATION_INVALID' });
  await assert.rejects(CoordinationStore.initialize(f.root, repo, limits, () => {}), { code: 'COORDINATION_INVALID' });
});
test('symlink and hardlink records cannot redirect control reads', async t => {
  const f = await fixture(t), other = join(f.root, 'other.json'); await rename(f.file, other); await symlink(other, f.file);
  await assert.rejects(f.store.snapshot(), { code: 'COORDINATION_PATH_UNSAFE' });
  await unlink(f.file); await link(other, f.file);
  await assert.rejects(f.store.snapshot(), { code: 'COORDINATION_PATH_UNSAFE' });
});
test('nonregular records and nonprivate paths are rejected without blocking', async t => {
  const f = await fixture(t); await unlink(f.file); await mkdir(f.file, { mode: 0o700 });
  await assert.rejects(f.store.snapshot(), { code: 'COORDINATION_PATH_UNSAFE' });
  await chmod(join(f.root, 'coordination'), 0o755);
  await assert.rejects(CoordinationStore.open(f.root, repo, () => {}), { code: 'COORDINATION_PATH_UNSAFE' });
});
test('replaced store directories and initialization epochs invalidate a live handle', async t => {
  const f = await fixture(t), path = join(f.root, 'coordination'); await rename(path, join(f.root, 'previous'));
  const replacement = await CoordinationStore.initialize(f.root, repo, limits, () => {});
  await assert.rejects(f.store.snapshot(), { code: 'COORDINATION_STORE_REPLACED' });
  await replacement.close();
});
test('an authority failure before acceptance leaves the store unchanged', async t => {
  let allowed = true;
  const f = await fixture(t, {}, () => { if (!allowed) throw Object.assign(Error('authority lost'), { code: 'AUTHORITY_LOST' }); });
  const before = await readFile(f.file); allowed = false;
  await assert.rejects(f.control.execute(A, register()), { code: 'AUTHORITY_LOST' });
  assert.deepEqual(await readFile(f.file), before);
});
test('publication failure blocks subsequent mutation until an explicit reopen', async t => {
  let armed = false, calls = 0;
  const authority = () => { if (armed && ++calls === 6) throw Object.assign(Error('lost before rename'), { code: 'AUTHORITY_LOST' }); };
  const f = await fixture(t, {}, authority), command = register(); armed = true;
  await assert.rejects(f.control.execute(A, command), { code: 'COORDINATION_PUBLICATION_UNCERTAIN' });
  assert.equal((await f.disk()).revision, 0);
  await assert.rejects(f.control.execute(A, command), { code: 'COORDINATION_REOPEN_REQUIRED' });
  armed = false;
  const store = await CoordinationStore.open(f.root, repo, authority), control = new CoordinationControl(store);
  const result = await control.execute(A, command); assert.equal(result.revision, 1); await control.close();
});
test('fresh process retry recovers a persisted receipt without duplicating a target claim', async t => {
  const f = await fixture(t), command = claim(), request = join(f.root, 'request.json');
  await writeFile(request, JSON.stringify({ repository: repo, actor: A, command }));
  await assert.rejects(run(process.execPath, [childScript, f.root, 'lose-receipt', request]), error => error.code === 74);
  const before = await f.disk(); assert.equal(before.cases.length, 1);
  const { stdout } = await run(process.execPath, [childScript, f.root, 'retry', request]);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.item_id, before.cases[0].id); assert.equal(receipt.revision, 1);
  assert.deepEqual(await f.disk(), before);
});
test('process interruption before rename retains old state; a later attempt is explicit', async t => {
  const f = await fixture(t), command = claim(), request = join(f.root, 'request.json');
  await writeFile(request, JSON.stringify({ repository: repo, actor: A, command }));
  await assert.rejects(run(process.execPath, [childScript, f.root, 'interrupt-before-rename', request]), error => error.code === 73);
  assert.equal((await f.disk()).revision, 0);
  const files = await readdir(join(f.root, 'coordination'));
  const stage = files.find(f => f.endsWith('.tmp')); assert.ok(stage);
  assert.equal(JSON.parse(await readFile(join(f.root, 'coordination', stage), 'utf8')).revision, 1);
  const { stdout } = await run(process.execPath, [childScript, f.root, 'retry', request]);
  assert.equal(JSON.parse(stdout).revision, 1); assert.equal((await f.disk()).cases.length, 1);
});
test('store snapshot is detached; unacknowledged in-memory edits do not mutate the file', async t => {
  const f = await fixture(t), snap = await f.store.snapshot(); snap.limits.notes = 1;
  assert.equal((await f.store.snapshot()).limits.notes, limits.notes);
});
test('revision-checked publication refuses a stale concurrent update', async t => {
  const f = await fixture(t), before = await f.store.snapshot();
  await f.control.execute(A, register());
  const current = await f.store.snapshot();
  await assert.rejects(f.store.publish(before, current), { code: 'COORDINATION_STALE_RECORD' });
  assert.deepEqual(await f.disk(), current);
});
test('immutable notes and accepted receipts cannot be rewritten by a new publication', async t => {
  const f = await fixture(t), w = await f.control.execute(A, register()), n = await f.control.execute(A, post(w.entity));
  const before = await f.store.snapshot(); await f.control.execute(A, claim()); const valid = await f.store.snapshot();
  const tampered = structuredClone(valid); tampered.notes[0].text = 'rewritten';
  assert.throws(() => assertControlTransition(before, tampered), { code: 'COORDINATION_INVALID' });
  const receipts = structuredClone(valid); receipts.receipts[0].key = 'replacement';
  assert.throws(() => assertControlTransition(before, receipts), { code: 'COORDINATION_INVALID' });
  assert.equal((await f.control.note(A, n.item_id)).text, 'attributed note');
});
test('the shared atomic writer preserves the old file until the rename boundary', async t => {
  const root = await rootOnly(t), path = join(root, 'record.json'); await atomicJson(path, { version: 1 });
  let calls = 0;
  await assert.rejects(atomicJson(path, { version: 2 }, () => { if (++calls === 4) throw Error('refuse rename'); }), /refuse rename/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1 });
  await atomicJson(path, { version: 2 }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2 });
});
test('complete decoding distinguishes unsupported operation from malformed data', () => {
  assert.throws(() => decodeCommand({ kind: 'merge', operation_key: 'not-supported' }), { code: 'COORDINATION_OPERATION_UNSUPPORTED' });
  assert.throws(() => decodeControl({ schema_version: 4 }, repo), { code: 'COORDINATION_VERSION_UNSUPPORTED' });
  assert.throws(() => decodeControl({ schema_version: null }, repo), { code: 'COORDINATION_INVALID' });
});

test('byte capacity also preserves a future close receipt', async t => {
  const f = await fixture(t, { notes: 128, receipts: 256, note_bytes: 16384 });
  const w = await f.control.execute(A, register());
  let full = false;
  for (let i = 0; i < 128; i++) {
    try { await f.control.execute(A, post(w.entity, { text: '\n'.repeat(16384) })); }
    catch (error) { assert.equal(error.code, 'COORDINATION_CAPACITY'); full = true; break; }
  }
  assert.equal(full, true);
  await f.control.execute(A, { kind: 'close_work', operation_key: key(), work_id: w.item_id, expected_revision: 1 });
  assert.equal((await f.control.work(A, w.item_id)).state, 'closed');
});

test('a FIFO record is rejected before waiting for a writer', async t => {
  const f = await fixture(t); await unlink(f.file); await run('mkfifo', [f.file]); await chmod(f.file, 0o600);
  await assert.rejects(f.store.snapshot(), { code: 'COORDINATION_PATH_UNSAFE' });
});
