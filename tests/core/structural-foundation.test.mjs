import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, access, appendFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { git, sourceStatus } from '../../.passeur-core/src/workspace/project.js';
import { prepareWorkspace, observeDelivery, worktreeEntries } from '../../.passeur-core/src/workspace/worktree.js';
import { FoundationStore, deferred } from '../fixtures/structural/foundation-store.mjs';

const actor = { owner_id: 'a'.repeat(64), client_id: '11111111-1111-4111-8111-111111111111' };
const quiet = () => new AbortController().signal;
function output(status = 'completed', stop = 'confirmed') {
  return { status, worker_stop: stop, worker_assessment: 'met', summary: 'controlled fixture',
    blockers: [], questions: [], checks: [], no_changes_reason: 'Fixture made no further change' };
}
async function fixture(t, worker, workers = 2) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-foundation-'));
  const project = join(root, 'repo'); await mkdir(project);
  await git(project, ['init', '-b', 'main']);
  await git(project, ['config', 'user.name', 'Passeur synthetic fixture']);
  await git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await git(project, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(project, 'base.txt'), 'committed input\n');
  await git(project, ['add', 'base.txt']); await git(project, ['commit', '-m', 'test: seed isolated input']);
  const base = (await git(project, ['rev-parse', 'HEAD'])).trim();
  const policy = { max_workers: workers, max_queued_tasks: 8, max_waiters: 16,
    max_pending_inputs: 4, max_control_receipts: 32, stop_grace_ms: 1000,
    implementation: { enabled: true, worktree_root: join(root, 'workers') } };
  const store = new FoundationStore(join(root, 'state'));
  const snapshot = { schema_version: 2, agent_id: 'fixture', adapter_id: 'fixture',
    adapter_contract: 'controlled-fixture-v1', configuration: {}, configuration_fingerprint: 'b'.repeat(64), policy };
  const registry = { select: () => ({ snapshot, worker: { run: worker } }) };
  const coordinator = new Coordinator(project, 'fixture-project', policy, store, registry);
  const assignment = (key) => ({ schema_version: 3, request_key: key, agent_id: 'fixture', mode: 'implement',
    objective: key, context: '', acceptance_criteria: ['controlled fixture'],
    base_commit: base, target_ref: 'refs/heads/main', allowed_paths: ['base.txt', 'result.txt'] });
  const submit = key => coordinator.submit({ schema_version: 1, source_view: project, assignment: assignment(key) }, actor, quiet());
  t.after(async () => {
    for (const record of await store.list()) {
      const state = await store.readControl(record.task_id);
      if (coordinator.isActive(record.task_id)) {
        await coordinator.cancel(record.task_id, actor, state.control_generation, `cleanup-${record.task_id}`, 'Dispose controlled fixture');
      }
    }
    await coordinator.shutdown();
    // This entire directory and its commits are disposable, test-created resources. No external worktree is touched.
    const entries = await worktreeEntries(project);
    assert.ok(entries.every(entry => entry.path === project || entry.path.startsWith(root + '/')));
    await writeFile(join(root, 'test-resource-disposition.json'), JSON.stringify(entries.map(e => ({
      path: e.path, head: e.head, disposition: 'discard-authorized-test-fixture' })), null, 2));
    await rm(root, { recursive: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    if (process.env.PASSEUR_TEST_RESOURCE_LOG) await appendFile(process.env.PASSEUR_TEST_RESOURCE_LOG,
      JSON.stringify({ test: t.name, root, worktrees: entries, outcome: 'removed-discard-authorized-test-fixture' }) + '\n');
  });
  return { root, project, base, policy, store, coordinator, assignment, submit };
}
async function finishTurn(input) {
  await input.onEvent({ kind: 'turn_started', turn_id: 'controlled-turn' });
  await input.onEvent({ kind: 'turn_settled', turn_id: 'controlled-turn', terminal: 'completed' });
  return output();
}
async function waitForFile(path) {
  const { dirname, basename } = await import('node:path');
  let watcher;
  try {
    await new Promise((resolve, reject) => {
      const check = () => { void access(path).then(resolve, error => { if (error.code !== 'ENOENT') reject(error); }); };
      watcher = watch(dirname(path), (_, name) => { if (name === basename(path)) check(); });
      watcher.on('error', reject); check();
    });
  } finally { watcher?.close(); }
}
async function observedWithin(promise, ms = 3000) {
  const timer = new AbortController();
  try { return await Promise.race([promise.then(() => true), delay(ms, false, { signal: timer.signal })]); }
  finally { timer.abort(); }
}

test('exact-base delegation preserves a dirty parent worktree and its index', { timeout: 10000 }, async t => {
  const f = await fixture(t, finishTurn);
  await writeFile(join(f.project, 'base.txt'), 'staged parent work\n');
  await git(f.project, ['add', 'base.txt']);
  await writeFile(join(f.project, 'base.txt'), 'unstaged parent work\n');
  await writeFile(join(f.project, 'private-parent.txt'), 'untracked parent work\n');
  const initial = await sourceStatus(f.project, true);
  const staged = await git(f.project, ['show', ':base.txt']);
  const receipt = await f.submit('dirty-parent');
  await f.coordinator.waitForIdle();
  const result = await f.store.readResult(receipt.task_id);
  assert.equal(result.execution_status, 'completed', JSON.stringify(result.error));
  assert.equal(result.delivery.base_commit, f.base);
  assert.equal(await readFile(join(result.delivery.worktree_path, 'base.txt'), 'utf8'), 'committed input\n');
  await assert.rejects(readFile(join(result.delivery.worktree_path, 'private-parent.txt')), { code: 'ENOENT' });
  assert.deepEqual(await sourceStatus(f.project, true), initial);
  assert.equal(await git(f.project, ['show', ':base.txt']), staged);
  assert.equal(await readFile(join(f.project, 'base.txt'), 'utf8'), 'unstaged parent work\n');
  assert.equal((await git(f.project, ['rev-parse', 'main'])).trim(), f.base);
});

test('explicit cancellation retains committed delivery and actual diff/manifest after confirmed stop', { timeout: 10000 }, async t => {
  const ready = deferred(); let committed;
  const f = await fixture(t, async input => {
    await input.onEvent({ kind: 'turn_started', turn_id: 'cancel-turn' });
    await writeFile(join(input.workspace, 'result.txt'), 'useful partial result\n');
    await git(input.workspace, ['add', 'result.txt']);
    await git(input.workspace, ['commit', '-m', 'test: retain controlled partial result']);
    committed = (await git(input.workspace, ['rev-parse', 'HEAD'])).trim();
    ready.resolve();
    if (!input.signal.aborted) await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return output('cancelled');
  });
  const receipt = await f.submit('cancelled-delivery'); await ready.promise;
  await f.coordinator.cancel(receipt.task_id, actor, receipt.control_generation, 'cancel-partial', 'Owner stopped fixture');
  await f.coordinator.waitForIdle();
  const result = await f.store.readResult(receipt.task_id);
  assert.equal(result.execution_status, 'cancelled');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(result.error, undefined, 'Collection must not inherit the aborted execution signal');
  assert.equal(result.delivery.status, 'committed');
  assert.equal(result.delivery.head_commit, committed);
  assert.deepEqual(result.changed_files, ['result.txt']);
  const manifest = JSON.parse(await readFile(join(f.store.taskDir(receipt.task_id), 'artifacts/manifest.json'), 'utf8'));
  assert.equal(manifest.head_commit, committed);
  assert.equal(manifest.files[0].path, 'result.txt');
  assert.match(await readFile(join(f.store.taskDir(receipt.task_id), 'artifacts/changes.diff'), 'utf8'), /useful partial result/);
  assert.equal((await f.store.readControl(receipt.task_id)).phase, 'terminal');
});

test('unconfirmed native stop still refuses stable collection and freezes replacement work', { timeout: 10000 }, async t => {
  const f = await fixture(t, async () => output('cancelled', 'unconfirmed'));
  const receipt = await f.submit('uncertain-stop'); await f.coordinator.waitForIdle();
  const result = await f.store.readResult(receipt.task_id);
  assert.equal(result.worker_stop, 'unconfirmed');
  assert.equal(result.delivery.status, 'incomplete');
  assert.deepEqual(result.artifacts, []);
  assert.equal((await f.store.readControl(receipt.task_id)).phase, 'needs_attention');
  await assert.rejects(f.submit('replacement'), { code: 'PROJECT_NEEDS_RECONCILIATION' });
});

test('a waiting checkout hook holds its task, not the repository administration mutex or sibling start', { timeout: 15000 }, async t => {
  const sibling = deferred();
  const f = await fixture(t, async input => { if (input.request.request_key === 'sibling') sibling.resolve(); return finishTurn(input); });
  const ready = join(f.root, 'hook-ready'), release = join(f.root, 'hook-release');
  const hookCode = join(f.root, 'checkout-hook.cjs');
  await writeFile(hookCode, `const fs=require('node:fs');const path=require('node:path');\n` +
    `const root=${JSON.stringify(f.root)};try{fs.mkdirSync(path.join(root,'hook-first'));}catch(e){if(e.code==='EEXIST')process.exit(0);throw e;}\n` +
    `fs.writeFileSync(${JSON.stringify(ready)},process.cwd());\n` +
    `while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);\n`);
  const hook = join(f.project, '.git/hooks/post-checkout');
  await writeFile(hook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hookCode)}\n`); await chmod(hook, 0o700);
  try {
    const first = await f.submit('hook-owner'); await waitForFile(ready);
    assert.equal(f.coordinator.isActive(first.task_id), true);
    assert.equal((await f.store.readResource(first.task_id)).state, 'creating');
    const second = await f.submit('sibling');
    assert.equal(await observedWithin(sibling.promise), true, 'A sibling must start while the other task is inside a hook');
    assert.equal(await observedWithin(f.coordinator.administration.run(() => undefined)), true);
    assert.equal(f.coordinator.isActive(first.task_id), true, 'Hook ownership is retained');
    assert.notEqual(first.task_id, second.task_id);
    await assert.rejects(access(release), { code: 'ENOENT' });
  } finally { await writeFile(release, 'explicit fixture release\n'); await f.coordinator.waitForIdle(); }
});

test('preparation cancellation remains effective even though final collection is independent', { timeout: 10000 }, async t => {
  const f = await fixture(t, finishTurn);
  const abort = new AbortController(); abort.abort(new Error('explicit preparation cancellation'));
  const id = randomUUID();
  await assert.rejects(prepareWorkspace(f.project, f.assignment('prepare-cancel'), f.policy, 'fixture-project', id, { signal: abort.signal }), /explicit preparation cancellation/);
  assert.equal((await worktreeEntries(f.project)).length, 1);
});

test('authority loss during creation intent prevents the Git worktree effect', { timeout: 10000 }, async t => {
  const f = await fixture(t, finishTurn); let authorized = true;
  await assert.rejects(prepareWorkspace(f.project, f.assignment('authority'), f.policy, 'fixture-project', randomUUID(), {
    assertAuthority: () => { if (!authorized) throw new Error('test authority lost'); },
    onIntent: async () => { authorized = false; },
  }), /test authority lost/);
  assert.equal((await worktreeEntries(f.project)).length, 1);
});

test('live review workspaces keep their explicit source view', { timeout: 10000 }, async t => {
  const f = await fixture(t, finishTurn);
  const workspace = await prepareWorkspace(f.project, { ...f.assignment('review'), mode: 'review' }, f.policy, 'fixture-project', randomUUID());
  assert.equal(workspace.kind, 'source_read_only'); assert.equal(workspace.path, f.project);
  assert.deepEqual(await observeDelivery(workspace), { status: 'not_applicable' });
});
