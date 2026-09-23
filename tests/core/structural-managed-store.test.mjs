// Real durable task control and Git workspace: source access follows task adoption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { serviceFixture, B, request, command, key, readRequest } from '../fixtures/structural/service-fixture.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { RepositoryRuntime, resolveRepositoryBinding } from '../../.passeur-core/src/core/repository-runtime.js';
import { initialControl } from '../../.passeur-core/src/core/task-control.js';
import { canonicalHash } from '../../.passeur-core/src/core/async.js';
import { LifecyclePolicySchema } from '../../.passeur-core/src/contracts/tasks.js';
import { AssignmentSchema } from '../../.passeur-core/src/contracts/agents.js';
import { baseResult } from '../../.passeur-core/src/core/result.js';
import { observeDelivery } from '../../.passeur-core/src/workspace/worktree.js';
import { operatorToken } from '../../.passeur-core/src/service/operator-token.js';

test('real TaskStore adoption revokes managed source report and retained detail without transferring metadata grant', async t => {
  const f = await serviceFixture(t);
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, 'absent-profile.json') };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const previousOwner = { owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID() };
  const successor = { owner_id: B.owner_id, client_id: randomUUID() };
  const taskId = randomUUID();
  const branch = `structural-managed-${taskId}`;
  const path = await f.linked(branch);
  const head = await f.commit(path, 'source.ts', 'export function run(reason?: string) { return reason; }\n');
  const assignment = AssignmentSchema.parse({ schema_version: 3, agent_id: 'fixture', request_key: key(),
    mode: 'implement', objective: 'Retain a structural source access witness', context: 'Disposable managed task',
    acceptance_criteria: ['Retain result'], allowed_paths: ['source.ts'], base_commit: f.base, target_ref: 'refs/heads/main' });
  const policy = LifecyclePolicySchema.parse({ implementation: { enabled: true, worktree_root: f.temp } });
  const execution = { schema_version: 2, agent_id: 'fixture', adapter_id: 'fixture', adapter_contract: 'fixture-contract',
    configuration: {}, configuration_fingerprint: canonicalHash({}), policy };
  const state = initialControl(taskId, previousOwner.owner_id);
  state.phase = 'terminal'; state.outcome = 'completed'; state.native.state = 'stopped'; state.native.coverage = 'turn_scoped';
  const admission = { schema_version: 4, task_id: taskId, project_id: binding.repositoryId,
    accepted_at: new Date().toISOString(), source_view: f.root, initial_owner: previousOwner.owner_id,
    request: assignment, execution,
    canonical_hash: canonicalHash({ schema_version: 1, source_view: f.root, assignment }) };
  // Create the durable records through their production codecs before acquiring the runtime lease.
  const store = new TaskStore(binding.storeRoot);
  await store.create(admission, state);
  const workspace = { kind: 'task_worktree', path, base_commit: f.base,
    branch: `refs/heads/${branch}`, target_ref: 'refs/heads/main' };
  await store.writeResult(taskId, { ...baseResult(taskId, assignment, execution, workspace),
    execution_status: 'completed', worker_stop: 'confirmed', native_evidence: state.native,
    delivery: await observeDelivery(workspace) });
  await store.writeResource(taskId, { schema_version: 1, task_id: taskId, project_id: binding.repositoryId,
    state: 'pending', worktree_path: path, branch_ref: workspace.branch, base_commit: f.base,
    head_commit: head, target_ref: 'refs/heads/main', updated_at: new Date().toISOString() });

  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development',
    node_version: process.version, node_executable: process.execPath, pid: process.pid,
    started_at: new Date().toISOString() };
  const runtime = new RepositoryRuntime(intent, identity);
  f.sessions.push({ close: () => runtime.shutdown() });
  const call = (req, actor = previousOwner) => runtime.coordinate(req, actor, f.root);
  await call(request('initialize', { limits: f.limits }));
  assert.equal((await call(command({ kind: 'register_managed_work', operation_key: key(), task_id: taskId })))
    .receipt.item_id, taskId);
  const work = JSON.parse((await call(readRequest({ kind: 'work', id: taskId }))).content);
  assert.equal(work.owner, previousOwner.owner_id);
  assert.equal(work.managed.control_generation, 1);

  const report = await runtime.structuralReport(taskId, previousOwner, f.root);
  assert.equal(report.reports.length, 1, JSON.stringify({ work, report }));
  assert.equal(report.reports[0].path, 'source.ts');
  const reportId = report.reports[0].report_id;
  const initialDetail = await runtime.structuralDetail(taskId, reportId, 'observed', 0, 6, previousOwner);
  assert.equal(initialDetail.text, 'export');

  const adoption = await runtime.attachTask({ task_id: taskId }, successor, key());
  assert.equal(adoption.receipt.outcome, 'adopted');
  assert.equal((await store.readControl(taskId)).owner_id, successor.owner_id);
  assert.equal((await store.readControl(taskId)).control_generation, 2);
  // Coordination metadata remains owned by the original principal; adoption is not a source grant.
  const unchangedWork = JSON.parse((await call(readRequest({ kind: 'work', id: taskId }))).content);
  assert.equal(unchangedWork.owner, previousOwner.owner_id);
  assert.equal(unchangedWork.managed.control_generation, 1);
  await assert.rejects(runtime.structuralReport(taskId, previousOwner, f.root), { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(runtime.structuralDetail(taskId, reportId, 'observed', 0, 6, previousOwner),
    { code: 'STRUCTURAL_SOURCE_FORBIDDEN' });
  await assert.rejects(runtime.structuralReport(taskId, successor, f.root), { code: 'COORDINATION_NOT_FOUND' });
  await assert.rejects(runtime.structuralDetail(taskId, reportId, 'observed', 0, 6, successor),
    { code: 'COORDINATION_NOT_FOUND' });
});
