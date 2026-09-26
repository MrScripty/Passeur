import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceFixture, request, command, readRequest, key, git } from '../fixtures/structural/service-fixture.mjs';
import { resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { preparePaths, readDescriptor } from '../../.passeur-core/src/service/bootstrap.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';
import { ServiceClient } from '../../.passeur-core/src/service/client.js';

test('production authenticated service exposes an owner report while metadata readers remain source-denied', async t => {
  const f = await serviceFixture(t); await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'no-execution-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal), paths = await preparePaths(binding);
  const ownerToken = await operatorToken(binding, true), config = join(f.temp, 'binding.json');
  await writeFile(config, JSON.stringify(intent));
  const cli = fileURLToPath(new URL('../fixtures/structural/elected-coordination-peer.mjs', import.meta.url));
  const child = spawn('flock', ['--nonblock', '--no-fork', paths.guard, process.execPath, cli, config], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'exit'); exit.catch(() => undefined);
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const clients = [];
  f.sessions.push({ async close() {
    for (const client of clients) client.close();
    await Promise.all(clients.map(client => client.connection.closed));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
  } });
  const budget = AbortSignal.timeout(10000); let descriptor;
  while (!(descriptor = await readDescriptor(binding))) {
    assert.equal(child.exitCode, null, `Service exited before publishing: ${stderr}`);
    await delay(10, undefined, { signal: budget });
  }
  const owner = new ServiceClient(descriptor, binding, ownerToken); clients.push(owner); await owner.ready;
  const otherRoot = await f.linked('structural-other'), otherToken = randomBytes(32).toString('hex');
  const reader = new ServiceClient(descriptor, { ...binding, project: otherRoot }, otherToken); clients.push(reader); await reader.ready;
  await owner.coordinate(request('initialize', { limits: f.limits }));
  const readerId = createHash('sha256').update(otherToken).digest('hex');
  const sourceInput = 'export function run(x: number): number { return x; }\nconst stable: string = "private";\n';
  const observedSource = 'export function run(x: number): number { return x + 1; }\nconst stable: string = "private-observed";\n';
  const sourceInputOid = await f.commit(f.root, 'source.ts', sourceInput);
  await writeFile(join(f.root, 'source.ts'), observedSource);
  const registered = await owner.coordinate(f.registerRequest({ input_oid: sourceInputOid, readers: [readerId] }));
  const pendingReport = owner.call('structural_report', { work_id: registered.receipt.item_id });
  const pendingRead = owner.coordinate(readRequest({ kind: 'work', id: registered.receipt.item_id }));
  const pendingTasks = owner.call('tasks', { schema_version: 1 });
  assert.equal(await Promise.race([pendingTasks.then(() => 'task_control'), pendingReport.then(() => 'report')]), 'task_control');
  assert.deepEqual((await pendingTasks).tasks, []);
  assert.equal(await Promise.race([pendingRead.then(() => 'control_read'), pendingReport.then(() => 'report')]), 'control_read');
  const concurrentRead = await pendingRead;
  assert.equal(JSON.parse(concurrentRead.content).id, registered.receipt.item_id);
  const response = await pendingReport;
  assert.equal(response.schema_version, 1);
  assert.equal(response.reports.length, 1);
  assert.equal(response.reports[0].path, 'source.ts');
  assert.match(response.reports[0].text, /OBSERVED: "export function run\(x: number\): number"/);
  const inputInspection = await owner.call('structural_report', { work_id: registered.receipt.item_id, view: 'input' });
  assert.match(inputInspection.reports[0].text, /INSPECTION — one captured source/);
  assert.match(inputInspection.reports[0].text, /Declaration: "run"/);
  assert.match(inputInspection.reports[0].text, /Declaration: "stable"/);
  assert.equal(inputInspection.reports[0].text.includes('private'), false);
  assert.equal(inputInspection.reports[0].text.includes('declaration_unchanged'), false);
  const reportId = response.reports[0].report_id;
  await writeFile(join(f.root, 'source.ts'), 'export function replaced() {}\n');
  const detail = await owner.call('structural_detail', { work_id: registered.receipt.item_id, report_id: reportId,
    side: 'observed', start_byte: 0, end_byte: Buffer.byteLength(observedSource) });
  assert.equal(detail.text, observedSource);
  await assert.rejects(reader.call('structural_detail', { work_id: registered.receipt.item_id, report_id: reportId,
    side: 'observed', start_byte: 0, end_byte: 6 }), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(reader.call('structural_report', { work_id: registered.receipt.item_id }), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  const workPage = await owner.coordinate(readRequest({ kind: 'work', id: registered.receipt.item_id }));
  const work = JSON.parse(workPage.content);
  await owner.coordinate(command({ kind: 'close_work', operation_key: key(), work_id: work.id, expected_revision: work.revision }));
  await assert.rejects(owner.call('structural_detail', { work_id: work.id, report_id: reportId,
    side: 'observed', start_byte: 0, end_byte: 6 }), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(owner.call('structural_report', { work_id: work.id }), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });

  await mkdir(join(f.root, 'src'));
  const inputOid = await f.commit(f.root, 'src/before.mts', 'export function before(): number { return 1; }\n');
  await writeFile(join(f.root, 'src/before.mts'), 'export function after(): number { return 2; }\n');
  await writeFile(join(f.root, 'src/added.cts'), 'export function added(): number { return 3; }\n');
  const nested = join(f.root, 'src', 'vendor');
  await mkdir(nested);
  await git(nested, ['init', '-b', 'main']);
  await writeFile(join(nested, 'secret.ts'), 'export function nestedSecret(): string { return "nested bytes"; }\n');
  const subtree = await owner.coordinate(f.registerRequest({ input_oid: inputOid, areas: [{ kind: 'subtree', path: 'src' }] }));
  const publicSubtree = await owner.call('structural_report', { work_id: subtree.receipt.item_id });
  assert.deepEqual(publicSubtree.reports.map(row => [row.path, row.dialect]), [
    ['src/added.cts', 'typescript'], ['src/before.mts', 'typescript'],
  ]);
  assert.match(publicSubtree.reports[0].text, /OBSERVED: "export function added\(\): number"/);
  assert.ok(publicSubtree.limitations.includes('nested_repository_boundary'));
  assert.ok(!JSON.stringify(publicSubtree).includes('nestedSecret'));
  assert.ok(!JSON.stringify(publicSubtree).includes('nested bytes'));
});
