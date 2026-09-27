import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { TaskStore } from '../../.passeur-core/src/store/task-store.js';
import { prepareWorkspace, preparePrivateGitView, preparePrivatePublication } from '../../.passeur-core/src/workspace/worktree.js';

export async function privatePublicationFixture(t) {
  const f = await fixture(t), taskId = randomUUID(), request = f.implementation('durable-publication');
  const workspace = await prepareWorkspace(f.root, request, f.policy, 'project', taskId);
  const view = await preparePrivateGitView(f.root, workspace, join(f.temp, 'private-git'));
  const admin = join(view.private_common_dir, view.admin_relative);
  await writeFile(join(workspace.path, 'worker.txt'), 'exact worker bytes\n');
  for (const args of [['add', 'worker.txt'], ['-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'ordinary worker commit']]) {
    const command = spawnSync('git', ['-C', workspace.path, ...args], { env: { ...process.env, GIT_DIR: admin }, encoding: 'utf8' });
    if (command.status !== 0) throw new Error(command.stderr);
  }
  const publication = await preparePrivatePublication(f.root, workspace, view, join(f.temp, 'quarantine'), 'confirmed');
  const control = f.initial(taskId);
  control.native = { ...control.native, state: 'stopped', coverage: 'turn_scoped', obligations: [] };
  await f.store.create(f.admission(request, taskId), control);
  const resource = { schema_version: 1, task_id: taskId, project_id: 'project', state: 'pending',
    worktree_path: workspace.path, branch_ref: workspace.branch, base_commit: workspace.base_commit, updated_at: new Date().toISOString() };
  await f.store.writeResource(taskId, resource);
  const privateGit = { schema_version: 1, state: 'reserved', private_common_dir: view.private_common_dir,
    quarantine_path: publication.quarantine_path, run_id: control.native.run_id, control_generation: control.control_generation };
  await f.store.writeResource(taskId, { ...resource, schema_version: 2, private_git: privateGit });
  await f.store.writeResource(taskId, { ...resource, schema_version: 2, private_git: { ...privateGit, state: 'prepared', view } });
  const intent = { schema_version: 1, operation_key: 'publish-1', task_id: taskId, request_key: request.request_key,
    run_id: control.native.run_id, control_generation: control.control_generation, source_view: f.root,
    workspace: { path: workspace.path, branch: workspace.branch, base_commit: workspace.base_commit }, view, publication };
  const identity = { task_id: taskId, operation_key: intent.operation_key, run_id: intent.run_id, control_generation: intent.control_generation };
  return { ...f, taskId, request, workspace, view, publication, intent, identity,
    reopen: () => new TaskStore(f.state), canonicalHead: async () => (await git(f.root, 'rev-parse', workspace.branch)).trim() };
}
