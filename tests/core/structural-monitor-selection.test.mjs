import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, command, key, git } from '../fixtures/structural/service-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { responseSchemas } from '../../.passeur-core/src/contracts/service.js';

const identity = () => ({ package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid,
  started_at: new Date().toISOString() });

async function runtimeFixture(t) {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const owner = { owner_id: createHash('sha256').update(await operatorToken(binding, true)).digest('hex'), client_id: randomUUID() };
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  return { fixture, runtime, owner };
}

async function eventually(read, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = last = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`expected observation did not arrive: ${JSON.stringify(last)}`);
}

test('a 17-file declared subtree reaches a changed file beyond one analysis pass', async t => {
  const fixture = await serviceFixture(t);
  await mkdir(join(fixture.root, 'src'));
  for (let index = 0; index < 17; index++) {
    await writeFile(join(fixture.root, 'src', `file${String(index).padStart(2, '0')}.ts`),
      `export const value${index} = ${index};\n`);
  }
  await git(fixture.root, ['add', 'src']);
  await git(fixture.root, ['commit', '-m', 'test: seventeen source files']);
  const input = (await git(fixture.root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(fixture.root, 'src', 'file00.ts'), Buffer.from([0xff]));
  await writeFile(join(fixture.root, 'src', 'file16.ts'), 'export const value16 = 99;\n');
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const owner = { owner_id: createHash('sha256').update(await operatorToken(binding, true)).digest('hex'), client_id: randomUUID() };
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: input, intent: 'Observe the subtree', areas: [{ kind: 'subtree', path: 'src' }], readers: [] }), owner, fixture.root);
  const workId = registered.receipt.item_id;
  await runtime.coordinate(command({ kind: 'watch_source', operation_key: key(), work_id: workId,
    expected_revision: 1, watchers: [{ recipient: owner.owner_id,
      regions: [{ kind: 'file', path: 'src/file16.ts' }] }] }), owner, fixture.root);
  const first = await runtime.structuralRefresh(workId, owner);
  assert.equal(first.limitations.includes('analysis_path_budget_exceeded'), false);
  await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/file16.ts'));
  const current = await runtime.structuralCurrent(owner);
  const changed = current.reports.filter(report => report.path === 'src/file16.ts');
  assert.equal(changed.length, 1);
  assert.ok(current.reports.some(report => report.path === 'src/file01.ts'));
  assert.ok((await runtime.structuralNoticePull(owner, 0)).notices.some(notice => notice.artifact_id === changed[0].id));
  const finalStatus = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.limitations.includes('src/file00.ts:SOURCE_ENCODING_UNSUPPORTED') &&
    !status.limitations.includes('analysis_batch_pending'));
  assert.equal(finalStatus.state, 'incomplete');
  assert.ok(finalStatus.limitations.includes('analysis_inventory_batched'));
  await runtime.structuralRefresh(workId, owner);
  assert.equal((await runtime.structuralObservationStatus(workId, owner)).state, 'incomplete');
  await writeFile(join(fixture.root, 'src', 'file00.ts'), 'export const value0 = 0;\n');
  await runtime.structuralRefresh(workId, owner);
  const recovered = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.state === 'observed' && !status.limitations.includes('analysis_batch_pending'));
  assert.equal(recovered.limitations.includes('src/file00.ts:SOURCE_ENCODING_UNSUPPORTED'), false);
});

test('an authorized watch outside work areas observes changes and delivers a notice', async t => {
  const { fixture, runtime, owner } = await runtimeFixture(t);
  const input = await fixture.commit(fixture.root, 'watched.ts', 'export const watched = 1;\n');
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: input, intent: 'Observe one area and a separate watch',
    areas: [{ kind: 'file', path: 'source.ts' }], readers: [] }), owner, fixture.root);
  const workId = registered.receipt.item_id;
  await runtime.coordinate(command({ kind: 'watch_source', operation_key: key(), work_id: workId,
    expected_revision: 1, watchers: [{ recipient: owner.owner_id,
      regions: [{ kind: 'file', path: 'watched.ts' }] }] }), owner, fixture.root);
  await writeFile(join(fixture.root, 'watched.ts'), 'export const watched = 2;\n');
  const refreshed = await runtime.structuralRefresh(workId, owner);
  assert.notEqual(refreshed.status, 'incomplete', JSON.stringify(refreshed));
  const current = await eventually(() => runtime.structuralCurrent(owner), result =>
    result.reports.some(report => report.path === 'watched.ts'));
  const watched = current.reports.find(report => report.path === 'watched.ts');
  assert.ok(watched);
  const notices = await runtime.structuralNoticePull(owner, 0);
  assert.ok(notices.notices.some(notice => notice.artifact_id === watched.id));
});

test('more than 32 source failures remain a bounded incomplete status until recovery', async t => {
  const { fixture, runtime, owner } = await runtimeFixture(t);
  await mkdir(join(fixture.root, 'many'));
  for (let index = 0; index < 33; index++) {
    await writeFile(join(fixture.root, 'many', `file${String(index).padStart(2, '0')}.ts`),
      `export const value${index} = ${index};\n`);
  }
  await git(fixture.root, ['add', 'many']);
  await git(fixture.root, ['commit', '-m', 'test: many source files']);
  const input = (await git(fixture.root, ['rev-parse', 'HEAD'])).trim();
  for (let index = 0; index < 33; index++) {
    await writeFile(join(fixture.root, 'many', `file${String(index).padStart(2, '0')}.ts`), Buffer.from([0xff]));
  }
  const registered = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: input, intent: 'Observe many invalid captures', areas: [{ kind: 'subtree', path: 'many' }], readers: [] }), owner, fixture.root);
  const workId = registered.receipt.item_id;
  await runtime.structuralRefresh(workId, owner);
  const failed = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.state === 'incomplete' && !status.limitations.includes('analysis_batch_pending') &&
    status.limitations.some(limitation => limitation.startsWith('additional_observation_limitations:')));
  assert.ok(failed.limitations.length <= 32);
  assert.doesNotThrow(() => responseSchemas.structural_observation_status.parse(failed));
  for (let index = 0; index < 33; index++) {
    await writeFile(join(fixture.root, 'many', `file${String(index).padStart(2, '0')}.ts`),
      `export const value${index} = ${index};\n`);
  }
  await runtime.structuralRefresh(workId, owner);
  const recovered = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.state === 'observed' && !status.limitations.includes('analysis_batch_pending'));
  assert.equal(recovered.limitations.some(limitation => limitation.startsWith('additional_observation_limitations:')), false);
  assert.doesNotThrow(() => responseSchemas.structural_observation_status.parse(recovered));
});
