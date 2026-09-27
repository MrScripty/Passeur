import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPeerResolutionChanges } from '../../.passeur-core/src/coordination/peer-application.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = Object.freeze({ work_id: '11111111-1111-4111-8111-111111111111', work_revision: 2,
  input_oid: 'a'.repeat(40), selected_commit_oid: 'b'.repeat(40) });
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-peer-application-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src'));
  return root;
}
function input(root, changes, guard = async (expected, effect) => {
  assert.deepEqual(expected, [source]);
  return effect();
}) {
  return { workspaceRoot: root, scope: [{ kind: 'subtree', path: 'src' }], sources: [source],
    changes, withCurrentSources: guard };
}

test('application checks source tuple and preimage, then applies scoped bytes', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'src', 'a.txt'), 'old');
  const changes = [{ path: 'src/a.txt', before_sha256: sha('old'), after_base64: Buffer.from('new').toString('base64') },
    { path: 'src/b.txt', before_sha256: null, after_base64: Buffer.from('created').toString('base64') }];
  assert.equal((await applyPeerResolutionChanges(input(root, changes))).reason, 'invalid_input');
  const stale = await applyPeerResolutionChanges(input(root, [changes[0]], async () => { throw new Error('source revision changed'); }));
  assert.deepEqual(stale, { status: 'rejected', paths: ['src/a.txt'], reason: 'stale_source' });
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'old');
  const updated = await applyPeerResolutionChanges(input(root, [changes[0]]));
  assert.equal(updated.status, 'applied');
  assert.deepEqual(updated.verified_after, [{ path: 'src/a.txt', after_sha256: sha('new') }]);
  const created = await applyPeerResolutionChanges(input(root, [changes[1]]));
  assert.equal(created.status, 'applied');
  assert.deepEqual(created.verified_after, [{ path: 'src/b.txt', after_sha256: sha('created') }]);
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'new');
  assert.equal(await readFile(join(root, 'src', 'b.txt'), 'utf8'), 'created');
  assert.equal((await applyPeerResolutionChanges(input(root, [changes[0]]))).reason, 'preimage_changed');
});

test('application rejects escaped scope, wrong hash, and symlink traversal before effects', async t => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(root, 'src', 'safe.txt'), 'safe');
  await writeFile(join(outside, 'victim.txt'), 'outside');
  await symlink(outside, join(root, 'src', 'link'));
  const changed = { path: 'src/safe.txt', before_sha256: sha('wrong'), after_base64: Buffer.from('bad').toString('base64') };
  assert.equal((await applyPeerResolutionChanges(input(root, [changed]))).reason, 'preimage_changed');
  assert.equal((await applyPeerResolutionChanges(input(root, [{ ...changed, path: 'src/../victim.txt' }]))).reason, 'invalid_input');
  assert.equal((await applyPeerResolutionChanges(input(root, [{ ...changed, path: 'src/link/victim.txt', before_sha256: sha('outside') }]))).reason, 'preimage_changed');
  assert.equal(await readFile(join(root, 'src', 'safe.txt'), 'utf8'), 'safe');
  assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'outside');
});

test('application reports uncertain effect when publication guard fails after a write', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'src', 'a.txt'), 'old');
  const changes = [{ path: 'src/a.txt', before_sha256: sha('old'), after_base64: Buffer.from('new').toString('base64') }];
  const result = await applyPeerResolutionChanges(input(root, changes, async (_expected, effect) => {
    await effect();
    throw new Error('publication outcome lost');
  }));
  assert.equal(result.status, 'effect_unknown');
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'new');
});

test('application refuses a publication guard that skips the effect', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'src', 'a.txt'), 'old');
  const changes = [{ path: 'src/a.txt', before_sha256: sha('old'), after_base64: null }];
  const result = await applyPeerResolutionChanges(input(root, changes, async () => ({ status: 'applied', paths: ['src/a.txt'] })));
  assert.equal(result.status, 'rejected');
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'old');
  const deleted = await applyPeerResolutionChanges(input(root, changes));
  assert.equal(deleted.status, 'applied');
  assert.deepEqual(deleted.verified_after, [{ path: 'src/a.txt', after_sha256: null }]);
  await assert.rejects(readFile(join(root, 'src', 'a.txt')), { code: 'ENOENT' });
});
