import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceFixture, command, key, git } from '../fixtures/structural/service-fixture.mjs';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { preparePaths, readDescriptor } from '../../.passeur-core/src/service/bootstrap.js';
import { ServiceClient } from '../../.passeur-core/src/service/client.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

const identity = () => ({ package_version: 'fixture', build_id: 'fixture', mode: 'development',
  node_version: process.version, node_executable: process.execPath, pid: process.pid,
  started_at: new Date().toISOString() });

async function directRuntime(t) {
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const owner = { owner_id: createHash('sha256').update(await operatorToken(binding, true)).digest('hex'),
    client_id: randomUUID() };
  const runtime = new RepositoryRuntime(intent, identity());
  fixture.sessions.push({ close: () => runtime.shutdown() });
  await runtime.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits }, owner, fixture.root);
  return { fixture, runtime, owner };
}

async function register(runtime, fixture, owner, input, area) {
  const receipt = await runtime.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: input, intent: 'Observe filesystem event gaps', areas: [area], readers: [] }), owner, fixture.root);
  return receipt.receipt.item_id;
}

async function eventually(read, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`expected current observation did not arrive: ${JSON.stringify(last)}`);
}

test('elected service publishes directory rename from a real watcher through authenticated client calls', async t => {
  if (process.platform !== 'linux') return t.skip('Linux watcher only');
  const fixture = await serviceFixture(t);
  await fixture.service.close();
  await mkdir(join(fixture.root, 'src', 'old'), { recursive: true });
  await writeFile(join(fixture.root, 'src', 'old', 'item.ts'), 'export function before() { return 1; }\n');
  await git(fixture.root, ['add', 'src']);
  await git(fixture.root, ['commit', '-m', 'test: watched directory']);
  const input = (await git(fixture.root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(fixture.root, 'src', 'old', 'item.ts'), 'export function changed() { return 2; }\n');

  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const paths = await preparePaths(binding);
  const token = await operatorToken(binding, true);
  const config = join(fixture.temp, 'binding.json');
  await writeFile(config, JSON.stringify(intent));
  const peer = fileURLToPath(new URL('../fixtures/structural/elected-coordination-peer.mjs', import.meta.url));
  const child = spawn('flock', ['--nonblock', '--no-fork', paths.guard, process.execPath, peer, config],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'exit'); exit.catch(() => undefined);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const clients = [];
  fixture.sessions.push({ async close() {
    for (const client of clients) client.close();
    await Promise.all(clients.map(client => client.connection.closed));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
    }
  } });
  const ready = AbortSignal.timeout(10_000);
  let descriptor;
  while (!(descriptor = await readDescriptor(binding))) {
    assert.equal(child.exitCode, null, `elected service exited: ${stderr}`);
    await delay(10, undefined, { signal: ready });
  }
  const client = new ServiceClient(descriptor, binding, token);
  clients.push(client);
  await client.ready;
  await client.coordinate({ schema_version: 1, kind: 'initialize', limits: fixture.limits });
  const receipt = await client.coordinate(command({ kind: 'register_external_work', operation_key: key(),
    input_oid: input, intent: 'Observe a renamed directory', areas: [{ kind: 'subtree', path: 'src' }], readers: [] }));
  const workId = receipt.receipt.item_id;
  await client.call('structural_refresh', { work_id: workId });
  const before = await eventually(() => client.call('structural_current', {}), current =>
    current.reports.some(report => report.work_id === workId && report.path === 'src/old/item.ts'));
  const old = before.reports.find(report => report.work_id === workId && report.path === 'src/old/item.ts');

  await rename(join(fixture.root, 'src', 'old'), join(fixture.root, 'src', 'moved'));
  const after = await eventually(() => client.call('structural_current', {}), current =>
    current.reports.some(report => report.work_id === workId && report.path === 'src/moved/item.ts'));
  const moved = after.reports.find(report => report.work_id === workId && report.path === 'src/moved/item.ts');
  assert.ok(moved.id !== old.id);
  const detail = await client.call('structural_artifact_detail', { artifact_id: moved.id, side: 'observed',
    start_byte: 0, end_byte: Buffer.byteLength('export function changed() { return 2; }\n') });
  assert.equal(detail.text, 'export function changed() { return 2; }\n');
  const deleted = await eventually(() => client.call('structural_current', {}), current =>
    current.reports.some(report => report.work_id === workId && report.path === 'src/old/item.ts' && report.id !== old.id));
  const oldNow = deleted.reports.find(report => report.work_id === workId && report.path === 'src/old/item.ts');
  assert.match((await client.call('structural_artifact_report', { artifact_id: oldNow.id })).text,
    /status: missing_during_capture/);
});

test('direct runtime observes atomic replacement, directory rename, new file and deletion from real Linux events', async t => {
  if (process.platform !== 'linux') return t.skip('Linux watcher only');
  const { fixture, runtime, owner } = await directRuntime(t);
  await mkdir(join(fixture.root, 'src', 'old'), { recursive: true });
  await writeFile(join(fixture.root, 'src', 'old', 'item.ts'), 'export const before = 1;\n');
  await git(fixture.root, ['add', 'src']);
  await git(fixture.root, ['commit', '-m', 'test: watched directory']);
  const input = (await git(fixture.root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(fixture.root, 'src', 'old', 'item.ts'), 'export const before = 2;\n');
  const workId = await register(runtime, fixture, owner, input, { kind: 'subtree', path: 'src' });
  await runtime.structuralRefresh(workId, owner);
  const initial = await runtime.structuralCurrent(owner);
  assert.ok(initial.reports.some(report => report.path === 'src/old/item.ts'));

  await writeFile(join(fixture.root, 'src', 'old', 'replacement.ts'), 'export const replaced = 2;\n');
  await rename(join(fixture.root, 'src', 'old', 'replacement.ts'), join(fixture.root, 'src', 'old', 'item.ts'));
  const replaced = await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/old/item.ts' &&
      !initial.reports.some(previous => previous.id === report.id)));
  const replacementReport = replaced.reports.find(report => report.path === 'src/old/item.ts');
  assert.equal((await runtime.structuralArtifactDetail(owner, replacementReport.id, 'observed', 0,
    Buffer.byteLength('export const replaced = 2;\n'))).text, 'export const replaced = 2;\n');

  await rename(join(fixture.root, 'src', 'old'), join(fixture.root, 'src', 'moved'));
  const moved = await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/moved/item.ts'));
  assert.ok(moved.reports.some(report => report.path === 'src/old/item.ts'));
  await writeFile(join(fixture.root, 'src', 'moved', 'new.ts'), 'export const added = 3;\n');
  await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/moved/new.ts'));
  await rename(join(fixture.root, 'src', 'moved', 'new.ts'), join(fixture.root, 'src', 'moved', 'gone.ts'));
  await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/moved/gone.ts'));
  await unlink(join(fixture.root, 'src', 'moved', 'item.ts'));
  await runtime.structuralRefresh(workId, owner);
  const deleted = await eventually(() => runtime.structuralCurrent(owner), current =>
    current.reports.some(report => report.path === 'src/old/item.ts' && report.id !== replacementReport.id));
  assert.match((await runtime.structuralArtifactReport(owner,
    deleted.reports.find(report => report.path === 'src/old/item.ts').id)).text, /status: missing_during_capture/);
});

test('a real watcher with an omitted filename or error triggers bounded reconciliation', async t => {
  if (process.platform !== 'linux') return t.skip('Linux watcher only');
  const realWatch = fs.watch;
  const listeners = [];
  let dropEvents = false;
  fs.watch = function (path, options, listener) {
    const watcher = realWatch(path, options, (event, name) => {
      if (!dropEvents) listener(event, name);
    });
    listeners.push({ watcher, listener });
    return watcher;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.watch = realWatch; syncBuiltinESMExports(); });
  const { fixture, runtime, owner } = await directRuntime(t);
  await writeFile(join(fixture.root, 'source.ts'), 'export const before = 1;\n');
  const workId = await register(runtime, fixture, owner, fixture.base, { kind: 'file', path: 'source.ts' });
  await runtime.structuralRefresh(workId, owner);
  assert.ok(listeners.length > 0, 'a real fs.watch handle was installed');

  await writeFile(join(fixture.root, 'source.ts'), 'export const afterMissingName = 2;\n');
  listeners.at(-1).listener('change', null);
  const missing = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.limitations.includes('watch_event_name_missing'));
  assert.equal(missing.state, 'observed', JSON.stringify(missing));
  const current = await eventually(() => runtime.structuralCurrent(owner), result =>
    result.reports.some(report => report.path === 'source.ts' &&
      report.id !== undefined));
  assert.equal((await runtime.structuralArtifactDetail(owner, current.reports.find(report => report.path === 'source.ts').id,
    'observed', 0, Buffer.byteLength('export const afterMissingName = 2;\n'))).text,
    'export const afterMissingName = 2;\n');

  const latest = listeners.at(-1);
  await writeFile(join(fixture.root, 'source.ts'), 'export const afterWatchError = 3;\n');
  latest.watcher.emit('error', new Error('injected watcher delivery failure'));
  const failed = await eventually(() => runtime.structuralObservationStatus(workId, owner), status =>
    status.limitations.includes('watch_failed'));
  assert.equal(failed.state, 'observed', JSON.stringify(failed));
  const afterError = await eventually(() => runtime.structuralCurrent(owner), result =>
    result.reports.some(report => report.path === 'source.ts' && report.id !== current.reports[0].id));
  assert.equal((await runtime.structuralArtifactDetail(owner, afterError.reports.find(report => report.path === 'source.ts').id,
    'observed', 0, Buffer.byteLength('export const afterWatchError = 3;\n'))).text,
    'export const afterWatchError = 3;\n');

  const priorId = afterError.reports.find(report => report.path === 'source.ts').id;
  dropEvents = true;
  await writeFile(join(fixture.root, 'source.ts'), 'export const afterMissedEvent = 4;\n');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await runtime.structuralCurrent(owner)).reports.find(report => report.path === 'source.ts').id, priorId);
  await runtime.structuralRefresh(workId, owner);
  const reconciled = (await runtime.structuralCurrent(owner)).reports.find(report => report.path === 'source.ts');
  assert.notEqual(reconciled.id, priorId);
  assert.equal((await runtime.structuralArtifactDetail(owner, reconciled.id, 'observed', 0,
    Buffer.byteLength('export const afterMissedEvent = 4;\n'))).text, 'export const afterMissedEvent = 4;\n');
});

test('configured 128-handle watcher capacity is visible while explicit reconciliation remains usable', async t => {
  if (process.platform !== 'linux') return t.skip('Linux watcher only');
  const { fixture, runtime, owner } = await directRuntime(t);
  await mkdir(join(fixture.root, 'src'));
  await writeFile(join(fixture.root, 'src', 'value.ts'), 'export const value = 1;\n');
  for (let index = 0; index < 130; index++) {
    await mkdir(join(fixture.root, 'src', `dir${String(index).padStart(3, '0')}`));
  }
  await git(fixture.root, ['add', 'src/value.ts']);
  await git(fixture.root, ['commit', '-m', 'test: source with many directories']);
  const input = (await git(fixture.root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(fixture.root, 'src', 'value.ts'), 'export const value = 2;\n');
  const workId = await register(runtime, fixture, owner, input, { kind: 'subtree', path: 'src' });
  const first = await runtime.structuralRefresh(workId, owner);
  assert.ok(first.limitations.includes('watch_capacity_limit'), JSON.stringify(first));
  await writeFile(join(fixture.root, 'src', 'value.ts'), 'export const value = 3;\n');
  const refreshed = await runtime.structuralRefresh(workId, owner);
  assert.ok(refreshed.limitations.includes('watch_capacity_limit'), JSON.stringify(refreshed));
  const current = await runtime.structuralCurrent(owner);
  const report = current.reports.find(item => item.path === 'src/value.ts');
  assert.ok(report);
  assert.equal((await runtime.structuralArtifactDetail(owner, report.id, 'observed', 0,
    Buffer.byteLength('export const value = 3;\n'))).text, 'export const value = 3;\n');
});
