import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, B, request, command, key } from '../fixtures/structural/service-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

test('runtime owner report uses the registered file and refuses a metadata reader', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const owner = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const reader = { owner_id: B.owner_id, client_id: randomUUID() };
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const runtime = new RepositoryRuntime(intent, identity); f.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate(request('initialize', { limits: f.limits }), owner, f.root);
  const receipt = await runtime.coordinate(f.registerRequest({ readers: [reader.owner_id] }), owner, f.root);
  const workId = receipt.receipt.item_id;
  await writeFile(join(f.root, 'source.ts'), 'export function run(x: number): number { return x; }\n');
  const pendingReport = runtime.structuralReport(workId, owner, f.root);
  await assert.rejects(runtime.structuralReport(workId, owner, f.root), { code: 'STRUCTURAL_ANALYSIS_CAPACITY' });
  const report = await pendingReport;
  assert.equal(report.schema_version, 1);
  assert.equal(report.reports.length, 1);
  assert.equal(report.reports[0].path, 'source.ts');
  assert.match(report.reports[0].text, /OBSERVED: "export function run\(x: number\): number"/);
  const reportId = report.reports[0].report_id;
  await writeFile(join(f.root, 'source.ts'), 'export function replaced() {}\n');
  const detail = await runtime.structuralDetail(workId, reportId, 'observed', 0,
    Buffer.byteLength('export function run(x: number): number { return x; }\n'), owner);
  assert.equal(detail.text, 'export function run(x: number): number { return x; }\n');
  await assert.rejects(runtime.structuralDetail(workId, reportId, 'observed', 0, 6, reader), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(runtime.structuralReport(workId, reader, f.root), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const afterCapacity = await runtime.structuralReport(workId, owner, f.root);
  assert.equal(afterCapacity.reports.length, 1);
  await runtime.coordinate(command({ kind: 'close_work', operation_key: key(), work_id: workId, expected_revision: 1 }), owner, f.root);

  await mkdir(join(f.root, 'src'));
  const inputOid = await f.commit(f.root, 'src/old.mts', 'export function before(): number { return 1; }\n');
  await writeFile(join(f.root, 'src/old.mts'), 'export function after(): number { return 2; }\n');
  await writeFile(join(f.root, 'src/new.cts'), 'export function added(): number { return 3; }\n');
  const subtree = await runtime.coordinate(f.registerRequest({ input_oid: inputOid, areas: [{ kind: 'subtree', path: 'src' }] }), owner, f.root);
  const subtreeReport = await runtime.structuralReport(subtree.receipt.item_id, owner, f.root);
  assert.deepEqual(subtreeReport.reports.map(row => [row.path, row.dialect]), [
    ['src/new.cts', 'typescript'], ['src/old.mts', 'typescript'],
  ]);
  assert.match(subtreeReport.reports[0].text, /OBSERVED: "export function added\(\): number"/);
  assert.match(subtreeReport.reports[1].text, /export function before\(\): number/);
  assert.match(subtreeReport.reports[1].text, /export function after\(\): number/);
});
