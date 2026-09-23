import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeAnalysisHelper } from '../../.passeur-native/src/observation/helper.js';
import { readCommittedFile, captureWorkingFile } from '../../.passeur-native/src/observation/source.js';
import { compareCapturedWork } from '../../.passeur-native/src/observation/comparison.js';

function captured(text, sequence = 1) {
  return { status: 'present', source: { kind: 'working_capture', repository_id: 'test-repository', object_format: 'sha1',
    workspace_id: 'test-workspace', workspace_generation: 1, capture_id: `capture-${sequence}`,
    capture_sequence: sequence, head_anchor: 'a'.repeat(40), path: 'example.ts' }, mode: '100644',
    content_sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text),
    text, consistency: 'sampled_file_not_atomic' };
}

test('native extraction runs in one owned child and returns a decoded source-bound result', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    const file = captured('export function f(x: number = 3): number { return x; }\n');
    const result = await helper.extract(file, 'typescript');
    assert.equal(result.coverage, 'complete');
    assert.equal(result.source.content_sha256, file.content_sha256);
    assert.equal(result.declarations[0].signature, 'export function f(x: number = <default>): number');
    assert.equal(result.declarations[0].range.start_byte, 0);
  } finally { await helper.close(); }
});

test('helper rejects malformed installed build identities before native admission', () => {
  assert.throws(() => new NativeAnalysisHelper('not-a-build-id'), { code: 'RUNTIME_IDENTITY_MISMATCH' });
});

test('installed build identity reaches the native child and rejects an unselected source tree', async () => {
  const helper = new NativeAnalysisHelper('f'.repeat(64));
  try {
    await assert.rejects(helper.extract(captured('function selected() {}'), 'typescript'), error =>
      error?.code === 'STRUCTURAL_ANALYSIS_INCOMPLETE' && /RUNTIME_MANIFEST_INVALID/.test(error.message));
  } finally { await helper.close(); }
});

test('analysis admission is bounded and close drains only observation jobs', async () => {
  const helper = new NativeAnalysisHelper();
  const file = captured('export function f() { return 1; }\n');
  const jobs = Array.from({ length: 5 }, (_, index) => helper.extract(captured(file.text, index + 1), 'typescript'));
  await assert.rejects(helper.extract(file, 'typescript'), { code: 'STRUCTURAL_ANALYSIS_CAPACITY' });
  const closed = helper.close();
  const outcomes = await Promise.allSettled(jobs);
  await closed;
  assert.equal(outcomes.length, 5);
  await assert.rejects(helper.extract(file, 'typescript'), { code: 'STRUCTURAL_HELPER_CLOSED' });
});

test('aborting an analysis kills only its helper generation and admits later analysis', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    const controller = new AbortController();
    const pending = helper.extract(captured('export function first() { return 1; }\n'), 'typescript', controller.signal);
    controller.abort(Object.assign(new Error('fixture cancelled analysis'), { code: 'FIXTURE_ANALYSIS_CANCELLED' }));
    await assert.rejects(pending, { code: 'FIXTURE_ANALYSIS_CANCELLED' });
    const next = await helper.extract(captured('export function second() { return 2; }\n', 2), 'typescript');
    assert.equal(next.declarations[0].name, 'second');
  } finally { await helper.close(); }
});

test('invalid captured source is rejected at admission or by the real child, then analysis restarts', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    const wrongLength = { ...captured('function f() { return 1; }'), byte_length: 1 };
    await assert.rejects(helper.extract(wrongLength, 'typescript'), { code: 'SOURCE_TOO_LARGE' });
    const wrongHash = { ...captured('function f() { return 1; }'), content_sha256: 'a'.repeat(64) };
    await assert.rejects(helper.extract(wrongHash, 'typescript'), { code: 'STRUCTURAL_HELPER_REQUEST_INVALID' });
    const recovered = await helper.extract(captured('function recovered() { return 2; }', 2), 'typescript');
    assert.equal(recovered.declarations[0].name, 'recovered');
  } finally { await helper.close(); }
});

test('supplemental spawn failure injection settles admission and close without a child exit', async () => {
  const helper = new NativeAnalysisHelper();
  const originalExecPath = process.execPath;
  let pending;
  try {
    process.execPath = '/tmp/passeur-missing-node-executable-for-spawn-test';
    pending = helper.extract(captured('function never_started() {}'), 'typescript');
  } finally { process.execPath = originalExecPath; }
  await assert.rejects(pending, { code: 'STRUCTURAL_HELPER_UNAVAILABLE' });
  await helper.close();
});

test('supplemental running-child error without close never releases a second helper slot', async () => {
  const helper = new NativeAnalysisHelper();
  const originalEmit = ChildProcess.prototype.emit;
  let target;
  let spawned = 0;
  ChildProcess.prototype.emit = function(event, ...args) {
    if (event === 'spawn' && this.spawnargs?.some(value => String(value).endsWith('/helper-main.js'))) {
      spawned += 1;
      if (!target) {
        target = this;
        const result = originalEmit.call(this, event, ...args);
        queueMicrotask(() => this.emit('error', new Error('injected running-child error')));
        return result;
      }
    }
    if (this === target && event === 'close') return false;
    return originalEmit.call(this, event, ...args);
  };
  try {
    const active = helper.extract(captured('function active() {}'), 'typescript');
    const waiting = helper.extract(captured('function waiting() {}', 2), 'typescript');
    await assert.rejects(active, { code: 'STRUCTURAL_HELPER_UNAVAILABLE' });
    await assert.rejects(waiting, { code: 'STRUCTURAL_HELPER_UNAVAILABLE' });
    assert.equal(spawned, 1);
    await helper.close();
  } finally {
    ChildProcess.prototype.emit = originalEmit;
    await helper.close();
  }
});

test('large native extraction returns an incomplete result without poisoning the next job', async () => {
  const helper = new NativeAnalysisHelper();
  try {
    const identifier = 'parameter_' + 'a'.repeat(500);
    const many = Array.from({ length: 1200 }, (_, index) => `function f${index}(${identifier}: number): number { return 1; }`).join('\n');
    await assert.rejects(helper.extract(captured(many), 'typescript'), { code: 'STRUCTURAL_ANALYSIS_INCOMPLETE' });
    const next = await helper.extract(captured('function available(): number { return 1; }', 2), 'typescript');
    assert.equal(next.declarations[0].name, 'available');
  } finally { await helper.close(); }
});

test('actual Git input and captured working source produce a task-attributed native report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-native-pair-'));
  const git = async (...args) => (await promisify(execFile)('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  const helper = new NativeAnalysisHelper();
  try {
    await git('init', '-q');
    await writeFile(join(root, 'example.ts'), 'export function f(x: number): number { return x; }\n');
    await git('add', 'example.ts');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
    const inputOid = await git('rev-parse', 'HEAD');
    await writeFile(join(root, 'example.ts'), 'export function f(x: string): string { return x + "!"; }\n');
    const input = await readCommittedFile(root, inputOid, 'example.ts', { max_bytes: 1024 });
    const observed = await captureWorkingFile({ root, workspace_id: 'fixture-workspace', workspace_generation: 1, capture_sequence: 1 },
      'example.ts', { max_bytes: 1024 });
    const result = await compareCapturedWork({ work_id: 'fixture-work', parent_id: 'fixture-parent', dialect: 'typescript', input, observed }, helper);
    assert.equal(result.report.comparison.changes.length, 1);
    assert.equal(result.report.comparison.changes[0].declaration_changed, true);
    assert.match(result.text, /INPUT — commit/);
    assert.match(result.text, /OBSERVED — capture/);
    assert.match(result.text, /x: string/);
    assert.match(result.text, /authorship is not established/);

    await writeFile(join(root, 'new.ts'), 'export function added() { return 1; }\n');
    const absent = await readCommittedFile(root, inputOid, 'new.ts', { max_bytes: 1024 });
    const added = await captureWorkingFile({ root, workspace_id: 'fixture-workspace', workspace_generation: 1, capture_sequence: 2 },
      'new.ts', { max_bytes: 1024 });
    const addition = await compareCapturedWork({ work_id: 'fixture-work', parent_id: 'fixture-parent', dialect: 'typescript', input: absent, observed: added }, helper);
    assert.equal(addition.report.comparison.changes[0].kind, 'added');
    assert.equal(addition.report.comparison.input.status, 'absent_in_commit');

    await writeFile(join(root, 'new.ts'), 'export function added(value: string): string { return value; }\n');
    const competingCapture = await captureWorkingFile({ root, workspace_id: 'fixture-workspace', workspace_generation: 1, capture_sequence: 4 },
      'new.ts', { max_bytes: 1024 });
    const competingAddition = await compareCapturedWork({ work_id: 'competing-work', parent_id: 'second-parent', dialect: 'typescript',
      input: absent, observed: competingCapture }, helper);
    assert.equal(competingAddition.report.comparison.changes[0].kind, 'added');
    assert.equal(competingAddition.report.work_id, 'competing-work');
    assert.notEqual(competingAddition.report.comparison.observed.content_sha256, addition.report.comparison.observed.content_sha256);

    await git('add', 'example.ts');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'second base');
    const secondBase = await git('rev-parse', 'HEAD');
    await writeFile(join(root, 'example.ts'), 'export function f(x: boolean): boolean { return x; }\n');
    const secondInput = await readCommittedFile(root, secondBase, 'example.ts', { max_bytes: 1024 });
    const secondObserved = await captureWorkingFile({ root, workspace_id: 'fixture-workspace', workspace_generation: 1, capture_sequence: 3 },
      'example.ts', { max_bytes: 1024 });
    const second = await compareCapturedWork({ work_id: 'different-base-work', parent_id: 'fixture-parent', dialect: 'typescript',
      input: secondInput, observed: secondObserved }, helper);
    assert.notEqual(second.report.comparison.input.source.commit_oid, result.report.comparison.input.source.commit_oid);
    assert.equal(second.report.comparison.input.source.commit_oid, secondBase);
    assert.equal(second.report.comparison.changes[0].declaration_changed, true);
  } finally { await helper.close(); await rm(root, { recursive: true, force: true }); }
});
