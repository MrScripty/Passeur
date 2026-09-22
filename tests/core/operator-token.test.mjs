import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile, symlink, stat, access, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'passeur-operator-')), storeRoot = join(temp, 'state');
  t.after(async () => {
    await rm(temp, { recursive: true }); await assert.rejects(access(temp), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,
      JSON.stringify({ test: t.name, root: temp, outcome: 'removed-discard-authorized-test-fixture' }) + '\n');
  });
  return { temp, storeRoot, path: join(storeRoot, 'operator-control.token') };
}
test('readonly operator lookup leaves an absent namespace absent', async t => {
  const f = await fixture(t); assert.equal(await operatorToken(f), undefined);
  await assert.rejects(access(f.storeRoot), { code: 'ENOENT' });
});
test('readonly operator lookup does not create a credential in an existing namespace', async t => {
  const f = await fixture(t); await mkdir(f.storeRoot, { mode: 0o700 });
  assert.equal(await operatorToken(f), undefined); await assert.rejects(access(f.path), { code: 'ENOENT' });
});
test('explicit creation persists one private credential and repeated creation preserves its value', async t => {
  const f = await fixture(t); const token = await operatorToken(f, true);
  assert.match(token, /^[a-f0-9]{64}$/); assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(await operatorToken(f), token); assert.equal(await operatorToken(f, true), token);
});
test('invalid credential bytes are rejected without repair or replacement', async t => {
  const f = await fixture(t); await operatorToken(f, true); await writeFile(f.path, 'z'.repeat(64));
  await assert.rejects(operatorToken(f, true), { code: 'CONTROL_CREDENTIAL_INVALID' });
  assert.equal(await readFile(f.path, 'utf8'), 'z'.repeat(64));
});
test('oversized and short credentials are rejected by their bounded size contract', async t => {
  const f = await fixture(t); await operatorToken(f, true);
  for (const value of ['a'.repeat(63), 'a'.repeat(65), 'a'.repeat(1024 * 1024)]) {
    await writeFile(f.path, value); await assert.rejects(operatorToken(f), { code: 'CONTROL_CREDENTIAL_INVALID' });
    assert.equal((await stat(f.path)).size, value.length);
  }
});
test('a symlink credential does not inherit authority from its target bytes', async t => {
  const f = await fixture(t); await mkdir(f.storeRoot, { mode: 0o700 });
  const target = join(f.temp, 'target'); await writeFile(target, 'a'.repeat(64), { mode: 0o600 }); await symlink(target, f.path);
  await assert.rejects(operatorToken(f), { code: 'SERVICE_PATH_UNSAFE' }); assert.equal(await readFile(target, 'utf8'), 'a'.repeat(64));
});
test('group-readable credentials and nonprivate namespaces are rejected', async t => {
  const f = await fixture(t); await operatorToken(f, true); await chmod(f.path, 0o640);
  await assert.rejects(operatorToken(f), { code: 'SERVICE_PATH_UNSAFE' });
  await chmod(f.path, 0o600); await chmod(f.storeRoot, 0o750);
  await assert.rejects(operatorToken(f), { code: 'SERVICE_PATH_UNSAFE' });
});
test('directory aliases cannot silently redirect the operator identity', async t => {
  const f = await fixture(t); await operatorToken(f, true); const alias = join(f.temp, 'alias'); await symlink(f.storeRoot, alias);
  await assert.rejects(operatorToken({ storeRoot: alias }), { code: 'SERVICE_PATH_UNSAFE' });
});
test('explicitly replaced valid credentials are observed without retaining an old cached token', async t => {
  const f = await fixture(t); const old = await operatorToken(f, true); const replacement = old === 'd'.repeat(64) ? 'e'.repeat(64) : 'd'.repeat(64);
  await writeFile(f.path, replacement); assert.equal(await operatorToken(f), replacement);
});
