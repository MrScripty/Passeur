import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, git, done, hold, wrapCoordinator } from './helpers.mjs';
import { AgentRegistry } from '../../.passeur-core/src/agents/registry.js';
import { Coordinator } from '../../.passeur-core/src/core/coordinator.js';
import { reconcileStoredTasks, acknowledgeStoppedTask } from '../../.passeur-core/src/core/recovery.js';
import { DispositionManager } from '../../.passeur-core/src/core/disposition.js';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';

const exec = promisify(execFile);
const capability = { schema_version: 1, mount_kind: 'canonical_common_dir' };
function controlled(f, run, enabled = true, assertAuthority = () => {}) {
  const worker = { ...(enabled ? { private_git: capability } : {}), run: async input => {
    const turn_id = crypto.randomUUID();
    await input.onEvent({ kind: 'turn_started', turn_id });
    const result = await run(input);
    await input.onEvent({ kind: 'turn_settled', turn_id, terminal: result.status === 'completed' ? 'completed' : 'failed' });
    return result;
  } };
  const registry = new AgentRegistry(f.profile, { muse: { configure: () => ({
    worker, modes: ['implement'], contract: 'controlled-private/1', configuration: { model: 'model' },
  }) } });
  return wrapCoordinator(new Coordinator(f.root, 'project', f.policy, f.store, registry, assertAuthority, undefined, 'controlled'), f.root, f.owner);
}
async function privateCommit(input) {
  const admin = join(input.private_git.view.private_common_dir, input.private_git.view.admin_relative);
  await writeFile(join(input.workspace, 'worker.txt'), 'private commit bytes\n');
  for (const args of [['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'private work']]) {
    await exec('git', ['-C', input.workspace, ...args], { env: { ...process.env, GIT_DIR: admin } });
  }
  return (await exec('git', ['-C', input.workspace, 'rev-parse', 'HEAD'], { env: { ...process.env, GIT_DIR: admin } })).stdout.trim();
}
async function sharedIndexDigest(f) {
  return createHash('sha256').update(await readFile(join(f.root, '.git', 'index'))).digest('hex');
}
async function assertPrivatePublicationRefused(f, result, indexBefore, errorCode, executionStatus = 'failed') {
  const resource = await f.store.readResource(result.task_id);
  assert.equal(result.execution_status, executionStatus);
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(result.error.code, errorCode);
  assert.equal(result.delivery.status, 'incomplete');
  assert.deepEqual(result.changed_files, []);
  assert.equal(resource.schema_version, 2);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  assert.equal(await sharedIndexDigest(f), indexBefore);
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
  assert.equal(await readFile(join(resource.worktree_path, 'worker.txt'), 'utf8'), 'private commit bytes\n');
  return resource;
}

test('failed worker retains a private commit after confirmed stop without publication or delivery collection', async t => {
  const f = await fixture(t), indexBefore = await sharedIndexDigest(f);
  const c = controlled(f, async input => {
    await privateCommit(input);
    await input.onEvent({ kind: 'operation_started', id: 'candidate-validation', operation: 'candidate_validation' });
    await input.onEvent({ kind: 'operation_finished', id: 'candidate-validation' });
    return done({ status: 'failed', worker_assessment: 'unmet',
      error: { code: 'CANDIDATE_REJECTED', message: 'Disposable candidate validation failed' } });
  });
  const result = await c.execute(f.implementation('failed-private-commit'));
  await c.waitForIdle();
  const resource = await assertPrivatePublicationRefused(f, result, indexBefore, 'CANDIDATE_REJECTED');
  assert.equal(result.native_evidence.state, 'stopped');
  assert.deepEqual(result.native_evidence.obligations, []);
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(result.task_id)).phase, 'needs_attention');
  assert.equal((await reopened.readResource(result.task_id)).private_git.state, 'prepared');
  assert.equal(await reopened.readPrivatePublication(result.task_id), undefined);
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  assert.equal(await sharedIndexDigest(f), indexBefore);
});

test('Coordinator downgrade of a completed private worker cannot publish its commit', async t => {
  const f = await fixture(t), indexBefore = await sharedIndexDigest(f);
  f.store.listPeerOperations = async () => [{ disposition: 'started' }];
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('downgraded-private-commit'));
  await c.waitForIdle();
  await assertPrivatePublicationRefused(f, result, indexBefore, 'PEER_OPERATION_RECOVERY_REQUIRED', 'interrupted');
  assert.equal(result.native_evidence.state, 'stopped');
});

test('reserved peer completion withholds an ordinary hook commit before private publication intent', async t => {
  const f = await fixture(t), indexBefore = await sharedIndexDigest(f);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit'), marker = join(f.temp, 'peer-hook-ran');
  await writeFile(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`); await chmod(hook, 0o755);
  const c = controlled(f, async input => {
    await privateCommit(input);
    const state = await f.store.readControl(input.task_id), resource = await f.store.readResource(input.task_id);
    const record = await f.store.durableRequest(input.task_id);
    await c.controls.change(input.task_id, draft => Object.assign(draft, { schema_version: 3,
      peer_delivery_reservations: [{ schema_version: 1, operation_key: `extension:${crypto.randomUUID()}`,
        request_digest: createHash('sha256').update('peer commit').digest('hex'), case_id: crypto.randomUUID(),
        expected_case_revision: 1, case_revision: 2, case_generation: 1,
        recipient_task_id: input.task_id, recipient_run_id: state.native.run_id,
        recipient_control_generation: state.control_generation, recipient_workspace: resource.worktree_path,
        recipient_workspace_fingerprint: canonicalHash({ task_id: input.task_id, source_view: record.source_view,
          workspace: resource.worktree_path, base_commit: resource.base_commit, branch_ref: resource.branch_ref,
          target_ref: resource.target_ref }), source_work_id: crypto.randomUUID(), source_work_revision: 1,
        state: 'reserved' }] }));
    return done();
  });
  const result = await c.execute(f.implementation('reserved-private-commit'));
  await c.waitForIdle();
  assert.equal(result.error?.code, 'PEER_DELIVERY_RECOVERY_REQUIRED');
  await assertPrivatePublicationRefused(f, result, indexBefore, 'PEER_DELIVERY_RECOVERY_REQUIRED', 'interrupted');
  assert.equal(existsSync(marker), true);
  const control = await f.store.readControl(result.task_id);
  assert.equal(control.peer_delivery_reservations[0].state, 'reserved');
});

test('late native event after completion fence cannot publish an ordinary private commit', async t => {
  const f = await fixture(t), indexBefore = await sharedIndexDigest(f);
  let worker;
  const c = controlled(f, async input => { worker = input; await privateCommit(input); return done(); });
  const admit = c.controls.admitCompletion.bind(c.controls);
  c.controls.admitCompletion = async (...args) => {
    const admission = await admit(...args);
    assert.equal(admission.outcome, 'completed');
    await assert.rejects(worker.onEvent({ kind: 'turn_started', turn_id: 'late' }),
      { code: 'NATIVE_EVENT_AFTER_COMPLETION' });
    return admission;
  };
  const result = await c.execute(f.implementation('late-private-native-event'));
  await c.waitForIdle();
  assert.notEqual(result.execution_status, 'completed');
  assert.equal(result.worker_stop, 'confirmed');
  assert.equal(result.delivery.status, 'incomplete');
  assert.equal((await f.store.readResource(result.task_id)).private_git.state, 'prepared');
  assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
  assert.equal(await sharedIndexDigest(f), indexBefore);
  assert.equal((await git(f.root, 'rev-parse', (await f.store.readResource(result.task_id)).branch_ref)).trim(), f.base);
});

test('late native event after published private result retains immutable commit and freezes reconciliation', async t => {
  const f = await fixture(t);
  let worker;
  const c = controlled(f, async input => { worker = input; await privateCommit(input); return done(); });
  const writeResult = f.store.writeResult.bind(f.store);
  f.store.writeResult = async (...args) => {
    await writeResult(...args);
    await assert.rejects(worker.onEvent({ kind: 'turn_started', turn_id: 'after-private-write' }),
      { code: 'NATIVE_EVENT_AFTER_COMPLETION' });
  };
  const saved = await c.execute(f.implementation('late-after-private-result'));
  await c.waitForIdle();
  assert.equal(saved.execution_status, 'completed');
  assert.equal(saved.delivery.status, 'committed');
  assert.equal((await f.store.readControl(saved.task_id)).phase, 'needs_attention');
  assert.equal((await f.store.readControl(saved.task_id)).native.state, 'unknown');
  assert.equal((await f.store.readResource(saved.task_id)).private_git.state, 'published');
  assert.equal((await f.store.readPrivatePublication(saved.task_id)).state, 'published');
  assert.equal((await git(f.root, 'rev-parse', saved.delivery.branch_ref)).trim(), saved.delivery.head_commit);
  assert.match(await f.store.frozenReason(), /immutable result publication conflict/);
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.deepEqual(await reopened.readResult(saved.task_id), saved);
  assert.equal((await reopened.readControl(saved.task_id)).phase, 'needs_attention');
});

test('pending candidate validation obligation prevents private publication', async t => {
  const f = await fixture(t), indexBefore = await sharedIndexDigest(f);
  const c = controlled(f, async input => {
    await privateCommit(input);
    await input.onEvent({ kind: 'operation_started', id: 'candidate-validation', operation: 'candidate_validation' });
    return done();
  });
  const result = await c.execute(f.implementation('pending-candidate-validation'));
  await c.waitForIdle();
  await assertPrivatePublicationRefused(f, result, indexBefore, 'COMPLETION_EVIDENCE_MISSING');
  assert.deepEqual((await f.store.readControl(result.task_id)).native.obligations,
    [{ id: 'candidate-validation', kind: 'candidate_validation' }]);
});

test('controlled worker commits with ordinary hook in private Git and Coordinator publishes only after exact stop', async t => {
  const f = await fixture(t);
  const hook = join(f.root, '.git', 'hooks', 'pre-commit');
  const hookMarker = join(f.temp, 'hook-ran');
  await writeFile(hook, `#!/bin/sh\nprintf hook > '${hookMarker}'\n`);
  await chmod(hook, 0o755);
  let privateHead;
  const c = controlled(f, async input => {
    assert.deepEqual(input.private_git?.mount_kind, 'canonical_common_dir');
    const resource = await f.store.readResource(input.task_id);
    assert.equal(resource.schema_version, 2);
    assert.equal(resource.private_git.state, 'prepared');
    assert.equal(await git(f.root, 'rev-parse', resource.branch_ref).then(s => s.trim()), f.base);
    privateHead = await privateCommit(input);
    assert.equal(await git(f.root, 'rev-parse', resource.branch_ref).then(s => s.trim()), f.base);
    return done();
  });
  const result = await c.execute(f.implementation('controlled-private'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(result.execution_status, 'completed');
  assert.equal(result.delivery.status, 'committed');
  assert.equal(result.delivery.head_commit, privateHead);
  assert.equal(resource.private_git.state, 'published');
  assert.equal((await f.store.readPrivatePublication(result.task_id)).state, 'published');
  assert.equal(await git(f.root, 'rev-parse', resource.branch_ref).then(s => s.trim()), privateHead);
  assert.equal(await readFile(join(resource.worktree_path, 'worker.txt'), 'utf8'), 'private commit bytes\n');
  assert.equal(await readFile(hookMarker, 'utf8'), 'hook');
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(result.task_id)).phase, 'terminal');
  await assert.rejects(acknowledgeStoppedTask(reopened, result.task_id, 'owner', 'stopped'), { code: 'PRIVATE_PUBLICATION_RECONCILIATION_REQUIRED' });
  const manager = new DispositionManager(f.root, 'project', reopened, c);
  await assert.rejects(manager.finalize({ schema_version: 1, task_id: result.task_id, operation_key: 'retire',
    expected_branch_ref: resource.branch_ref, expected_head: privateHead, disposition: 'archived',
    cleanup_authorized: true, archive_authorized: true }), { code: 'PRIVATE_RESOURCE_RETIREMENT_UNAVAILABLE' });
});

test('unsupported controlled adapter fails before native startup', async t => {
  const f = await fixture(t);
  let started = false;
  const c = controlled(f, async () => { started = true; return done(); }, false);
  const result = await c.execute(f.implementation('unsupported-private'));
  assert.equal(started, false);
  assert.equal(result.execution_status, 'failed');
  assert.equal(result.error.code, 'PRIVATE_GIT_ADAPTER_UNSUPPORTED');
  assert.equal((await f.store.readResource(result.task_id)).state, 'not_applicable');
});

test('unknown native stop retains private resource and cannot be reconciled by stop assertion', async t => {
  const f = await fixture(t);
  const c = controlled(f, async input => {
    assert.ok(input.private_git);
    return done({ worker_stop: 'unconfirmed' });
  });
  const result = await c.execute(f.implementation('unknown-stop'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(resource.schema_version, 2);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal(result.delivery.status, 'incomplete');
  assert.notEqual(result.execution_status, 'completed');
  await assert.rejects(acknowledgeStoppedTask(f.store, result.task_id, 'owner', 'stopped'), { code: 'PRIVATE_PUBLICATION_RECONCILIATION_REQUIRED' });
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

test('interruption after persisted exact stop retains prepared resource without intent', async t => {
  const f = await fixture(t);
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const original = c.controls.change.bind(c.controls);
  let interrupted = false;
  c.controls.change = async (id, change) => {
    const value = await original(id, change);
    if (!interrupted && (await f.store.readControl(id)).native.state === 'stopped') {
      interrupted = true; throw Error('after persisted stop');
    }
    return value;
  };
  const result = await c.execute(f.implementation('stop-boundary'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(interrupted, true);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
  assert.equal(result.native_evidence.state, 'stopped');
  assert.equal(result.delivery.status, 'incomplete');
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

for (const field of ['run', 'generation']) {
  test(`changed ${field} identity before stop blocks Coordinator publication`, async t => {
    const f = await fixture(t);
    const c = controlled(f, async input => {
      await privateCommit(input);
      const control = await f.store.readControl(input.task_id);
      if (field === 'run') control.native.run_id = crypto.randomUUID();
      else control.control_generation++;
      await f.store.writeControl(input.task_id, control);
      return done();
    });
    const result = await c.execute(f.implementation(`changed-${field}`));
    const resource = await f.store.readResource(result.task_id);
    assert.equal(resource.private_git.state, 'prepared');
    assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
    assert.equal(result.delivery.status, 'incomplete');
    assert.notEqual(result.execution_status, 'completed');
    assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
    await c.waitForIdle();
  });
}

test('dirty private workspace blocks Coordinator before intent or canonical ref effects', async t => {
  const f = await fixture(t);
  const c = controlled(f, async input => {
    await privateCommit(input);
    await writeFile(join(input.workspace, 'worker.txt'), 'dirty after private commit\n');
    return done();
  });
  const result = await c.execute(f.implementation('dirty-private'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
  assert.equal(result.delivery.status, 'incomplete');
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), f.base);
  await c.waitForIdle();
});

test('interruption immediately after reserved marker retains ownership before private storage creation', async t => {
  const f = await fixture(t);
  const original = f.store.writeResource.bind(f.store);
  f.store.writeResource = async (id, resource) => {
    await original(id, resource);
    if (resource.schema_version === 2 && resource.private_git.state === 'reserved') throw Error('injected marker boundary');
  };
  const c = controlled(f, async () => { throw Error('worker must not start'); });
  const result = await c.execute(f.implementation('marker-boundary'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(resource.schema_version, 2);
  assert.equal(resource.private_git.state, 'reserved');
  assert.equal(result.delivery.status, 'incomplete');
  assert.notEqual(result.execution_status, 'completed');
  assert.equal(await f.store.readPrivatePublication(result.task_id), undefined);
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

test('interruption immediately after durable intent does not publish or infer replay on restart', async t => {
  const f = await fixture(t);
  const original = f.store.beginPrivatePublication.bind(f.store);
  f.store.beginPrivatePublication = async request => {
    await original(request);
    throw Error('injected intent boundary');
  };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('intent-boundary'));
  const resource = await f.store.readResource(result.task_id);
  assert.equal(resource.private_git.state, 'prepared');
  assert.equal((await f.store.readPrivatePublication(result.task_id)).state, 'intent');
  assert.equal(await git(f.root, 'rev-parse', resource.branch_ref).then(s => s.trim()), f.base);
  assert.equal(result.native_evidence.state, 'stopped');
  assert.equal(result.delivery.status, 'incomplete');
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(result.task_id)).phase, 'needs_attention');
  assert.equal(await git(f.root, 'rev-parse', resource.branch_ref).then(s => s.trim()), f.base);
  await assert.rejects(acknowledgeStoppedTask(reopened, result.task_id, 'owner', 'stopped'), { code: 'PRIVATE_PUBLICATION_RECONCILIATION_REQUIRED' });
});

test('default Coordinator keeps the ordinary worktree route', async t => {
  const f = await fixture(t);
  const c = f.coordinator({ run: async input => {
    await writeFile(join(input.workspace, 'ordinary.txt'), 'ordinary\n');
    await git(input.workspace, 'add', 'ordinary.txt');
    await git(input.workspace, 'commit', '-qm', 'ordinary work');
    return done();
  } });
  const result = await c.execute(f.implementation('ordinary-route'));
  assert.equal(result.delivery.status, 'committed');
  assert.equal((await f.store.readResource(result.task_id)).schema_version, 1);
});

test('adoption waits behind the exact private publication fence through durable settlement', async t => {
  const f = await fixture(t), entered = hold(), release = hold();
  const original = f.store.beginPrivatePublication.bind(f.store);
  f.store.beginPrivatePublication = async request => {
    const intent = await original(request);
    entered.release(); await release.promise;
    return intent;
  };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const receipt = await c.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation('adoption-race') }, f.owner, new AbortController().signal);
  await entered.promise;
  let adopted = false;
  const adoption = c.controls.adopt(receipt.task_id, f.owner, 'adopt-during-publication')
    .then(value => { adopted = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(adopted, false);
  assert.equal((await f.store.readControl(receipt.task_id)).control_generation, 1);
  release.release();
  await adoption;
  await c.waitForIdle();
  assert.equal((await f.store.readPrivatePublication(receipt.task_id)).state, 'published');
  assert.equal((await f.store.readResource(receipt.task_id)).private_git.state, 'published');
  assert.equal((await f.store.readControl(receipt.task_id)).control_generation, 2);
});

test('same-tree replacement after replay cannot become a committed private result', async t => {
  const f = await fixture(t);
  const original = f.store.writeResource.bind(f.store);
  f.store.writeResource = async (id, resource) => {
    await original(id, resource);
    if (resource.schema_version === 2 && resource.private_git.state === 'published') {
      await git(resource.worktree_path, 'commit', '--allow-empty', '-qm', 'same tree, different head');
    }
  };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('same-tree-replacement'));
  const publication = await f.store.readPrivatePublication(result.task_id);
  const resource = await f.store.readResource(result.task_id);
  const replacement = (await git(f.root, 'rev-parse', resource.branch_ref)).trim();
  assert.notEqual(replacement, publication.request.publication.new_head);
  assert.equal((await git(f.root, 'rev-parse', `${replacement}^{tree}`)).trim(), publication.request.publication.tree_oid);
  assert.equal(result.delivery.status, 'incomplete');
  assert.notEqual(result.execution_status, 'completed');
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

test('settlement interruption retains published candidate and unresolved marker across restart', async t => {
  const f = await fixture(t), original = f.store.settlePrivatePublication.bind(f.store);
  f.store.settlePrivatePublication = async (...args) => { const record = await original(...args); throw Error(`after ${record.state}`); };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('settlement-boundary'));
  assert.equal((await f.store.readPrivatePublication(result.task_id)).state, 'published');
  assert.equal((await f.store.readResource(result.task_id)).private_git.state, 'publication_intent');
  assert.equal(result.delivery.status, 'incomplete');
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

test('interruption after canonical ref CAS retains new-ref old-index state without result success', async t => {
  const f = await fixture(t);
  let taskId, interrupted = false;
  const authority = () => {
    if (!taskId || interrupted) return;
    const intentPath = join(f.store.taskDir(taskId), 'private-publication.json');
    if (!existsSync(intentPath)) return;
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    const publication = intent.request.publication;
    const branch = intent.request.workspace.branch;
    const head = spawnSync('git', ['-C', f.root, 'rev-parse', branch], { encoding: 'utf8' });
    const index = createHash('sha256').update(readFileSync(join(publication.canonical_admin_path, 'index'))).digest('hex');
    if (head.status === 0 && head.stdout.trim() === publication.new_head && index === publication.old_index_sha256) {
      interrupted = true; throw Error('after canonical ref CAS');
    }
  };
  const c = controlled(f, async input => { taskId = input.task_id; await privateCommit(input); return done(); }, true, authority);
  const result = await c.execute(f.implementation('ref-boundary'));
  const intent = await f.store.readPrivatePublication(result.task_id);
  const resource = await f.store.readResource(result.task_id);
  assert.equal(interrupted, true);
  assert.equal(intent.state, 'intent');
  assert.equal(resource.private_git.state, 'publication_intent');
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), intent.request.publication.new_head);
  assert.equal(createHash('sha256').update(await readFile(join(intent.request.publication.canonical_admin_path, 'index'))).digest('hex'),
    intent.request.publication.old_index_sha256);
  assert.equal(result.delivery.status, 'incomplete');
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
});

test('interruption after canonical index install retains exact intent without settlement', async t => {
  const f = await fixture(t), original = f.store.settlePrivatePublication.bind(f.store);
  f.store.settlePrivatePublication = async () => { throw Error('after canonical index installation'); };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('index-boundary'));
  const intent = await f.store.readPrivatePublication(result.task_id);
  const resource = await f.store.readResource(result.task_id);
  assert.equal(intent.state, 'intent');
  assert.equal(resource.private_git.state, 'publication_intent');
  assert.equal((await git(f.root, 'rev-parse', resource.branch_ref)).trim(), intent.request.publication.new_head);
  assert.equal(createHash('sha256').update(await readFile(join(intent.request.publication.canonical_admin_path, 'index'))).digest('hex'),
    intent.request.publication.new_index_sha256);
  assert.equal(result.delivery.status, 'incomplete');
  await reconcileStoredTasks(new TaskStore(f.state));
  assert.equal((await f.store.readControl(result.task_id)).phase, 'needs_attention');
  f.store.settlePrivatePublication = original;
});

test('reopen freezes after exact result write but before terminal control publication', async t => {
  const f = await fixture(t), original = f.store.writeResult.bind(f.store);
  f.store.writeResult = async (id, result) => { await original(id, result); throw Error('after result write'); };
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const receipt = await c.submit({ schema_version: 1, source_view: f.root,
    assignment: f.implementation('result-boundary') }, f.owner, new AbortController().signal);
  await c.waitForIdle();
  assert.equal((await f.store.readPrivatePublication(receipt.task_id)).state, 'published');
  assert.equal((await f.store.readResult(receipt.task_id)).delivery.status, 'committed');
  assert.equal((await f.store.readControl(receipt.task_id)).phase, 'needs_attention');
  assert.match(await f.store.frozenReason(), /immutable result publication conflict/);
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(receipt.task_id)).phase, 'needs_attention');
});

test('reopen rejects flags-only saved success with a different delivery head', async t => {
  const f = await fixture(t);
  const c = controlled(f, async input => { await privateCommit(input); return done(); });
  const result = await c.execute(f.implementation('saved-result-bypass'));
  assert.equal(result.delivery.status, 'committed');
  const path = join(f.store.taskDir(result.task_id), 'result.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.delivery.head_commit = f.base;
  saved.delivery.commits[saved.delivery.commits.length - 1] = f.base;
  await writeFile(path, `${JSON.stringify(saved)}\n`);
  const reopened = new TaskStore(f.state);
  await reconcileStoredTasks(reopened);
  assert.equal((await reopened.readControl(result.task_id)).phase, 'needs_attention');
});
