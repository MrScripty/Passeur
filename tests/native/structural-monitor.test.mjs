import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationMonitor } from '../../.passeur-native/src/observation/monitor.js';
import { captureWorkingFile } from '../../.passeur-native/src/observation/source.js';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';

const exec = promisify(execFile);
async function git(root, ...args) { return (await exec('git', args, { cwd: root })).stdout.trim(); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-monitor-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Monitor Fixture');
  await git(root, 'config', 'user.email', 'monitor@example.invalid');
  await writeFile(join(root, 'example.ts'), 'export function sample(): number { return 1; }\n');
  await git(root, 'add', 'example.ts');
  await git(root, 'commit', '-qm', 'input');
  const input_commit_oid = await git(root, 'rev-parse', 'HEAD');
  return { root, input_commit_oid, work_id: 'work-a', work_revision: 1, control_generation: 1,
    workspace_id: 'workspace-a', workspace_generation: 1,
    areas: [{ kind: 'file', path: 'example.ts' }] };
}

function realAnalysis(helper, calls) {
  return async job => {
    calls.push(job);
    const file = await captureWorkingFile({ root: job.workspace.root, workspace_id: job.workspace.workspace_id,
      workspace_generation: job.workspace.workspace_generation, capture_sequence: job.generation,
      input_commit_oid: job.workspace.input_commit_oid }, 'example.ts', { max_bytes: 8 * 1024 * 1024, signal: job.signal });
    const extraction = await helper.extract(file, 'typescript', job.signal);
    return { kind: 'artifact', evidence_id: `${file.content_sha256}:${extraction.parser_identity}:${extraction.extractor_identity}`,
      artifact: extraction };
  };
}

async function until(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('expected filesystem observation did not arrive');
}

test('real Linux replacement save invalidates, reconciles, and publishes native extraction once', async t => {
  if (process.platform !== 'linux') return t.skip('Linux observation only');
  const workspace = await fixture(t);
  const helper = new NativeAnalysisHelper();
  const calls = [], published = [];
  const monitor = new ObservationMonitor({ analyze: realAnalysis(helper, calls),
    publish: async (_job, artifact, isCurrent) => {
      assert.equal(isCurrent(), true);
      published.push(artifact);
    } });
  try {
    const first = await monitor.attach(workspace);
    assert.equal(first.status, 'published');
    assert.equal(published[0].declarations[0].name, 'sample');
    const replacement = join(workspace.root, 'replacement.ts');
    await writeFile(replacement, 'export function renamed(): number { return 2; }\n');
    await rename(replacement, join(workspace.root, 'example.ts'));
    await until(() => monitor.status('work-a', 'workspace-a')?.generation > first.generation &&
      published.at(-1)?.declarations[0]?.name === 'renamed');
    assert.ok(calls.length >= 2);
    const count = published.length;
    const unchanged = await monitor.refresh('work-a', 'workspace-a');
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(published.length, count);
  } finally { await monitor.close(); await helper.close(); }
});

test('superseded real capture cannot publish and close drains observation without worker controls', async t => {
  if (process.platform !== 'linux') return t.skip('Linux observation only');
  const workspace = await fixture(t);
  const helper = new NativeAnalysisHelper();
  const calls = [], published = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstAnalysis;
  const firstStarted = new Promise(resolve => { firstAnalysis = resolve; });
  const monitor = new ObservationMonitor({
    analyze: async job => {
      const result = await realAnalysis(helper, calls)(job);
      if (calls.length === 1) { firstAnalysis(); await gate; }
      return result;
    },
    publish: async (job, artifact, isCurrent) => {
      assert.equal(isCurrent(), true);
      published.push([job.generation, artifact.declarations[0]?.name]);
    },
  });
  try {
    const attached = monitor.attach(workspace);
    await firstStarted;
    await writeFile(join(workspace.root, 'example.ts'), 'export function latest(): number { return 3; }\n');
    const refreshed = monitor.refresh('work-a', 'workspace-a');
    release();
    const [first, second] = await Promise.all([attached, refreshed]);
    assert.equal(first.generation, second.generation);
    assert.equal(second.status, 'published');
    assert.deepEqual(published.map(([, name]) => name), ['latest']);
    assert.ok(calls.length >= 2);
  } finally { release(); await monitor.close(); await helper.close(); }
});

test('aborting an attachment cancels active analysis and releases its watcher promptly', async t => {
  if (process.platform !== 'linux') return t.skip('Linux observation only');
  const workspace = await fixture(t);
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const monitor = new ObservationMonitor({
    analyze: job => new Promise(resolve => {
      entered();
      job.signal.addEventListener('abort', () => resolve({ kind: 'incomplete', limitation: 'cancelled' }), { once: true });
    }),
    publish: async () => { assert.fail('cancelled analysis must not publish'); },
  });
  try {
    const attached = monitor.attach(workspace, controller.signal);
    await started;
    controller.abort(new Error('source authority changed'));
    const result = await Promise.race([attached, new Promise((_, reject) => setTimeout(() => reject(new Error('attach did not cancel')), 2_000))]);
    assert.equal(result.status, 'superseded');
    assert.equal(monitor.status(workspace.work_id, workspace.workspace_id), undefined);
  } finally { await monitor.close(); }
});
