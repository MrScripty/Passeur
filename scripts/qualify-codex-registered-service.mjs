#!/usr/bin/env node
/** One disposable built-in Codex task through the installed shared service. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const sha = value => createHash('sha256').update(value).digest('hex');
const gitEnv = root => ({ PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' });
const execute = promisify(execFile);
const git = async (root, ...args) => (await execute('/usr/bin/git', args,
  { cwd: root, encoding: 'utf8', env: gitEnv(root) })).stdout.trim();
const reportName = 'registered-service-report.json';
const markerName = 'registered-service.txt';

export async function prepareFixture(codexBin, codexHome) {
  if (![codexBin, codexHome].every(isAbsolute)) throw Error('Codex binary and home must be absolute paths');
  const root = await mkdtemp('/tmp/passeur-registered-service-');
  const project = join(root, 'project'), vault = join(root, 'vault'), stateRoot = join(root, 'state');
  await Promise.all([mkdir(project, { mode: 0o700 }), mkdir(vault, { mode: 0o700 }), mkdir(stateRoot, { mode: 0o700 })]);
  const baseline = 'def total(unit_cents: int, quantity: int) -> int:\n    return unit_cents * quantity\n';
  const canaries = { outside: randomUUID(), repository: randomUUID() };
  await writeFile(join(project, 'quote.py'), baseline);
  await writeFile(join(vault, 'held-canary.txt'), `${canaries.outside}\n`, { mode: 0o600 });
  await writeFile(join(project, 'held-canary.txt'), `${canaries.repository}\n`, { mode: 0o600 });
  await git(project, 'init', '-q', '-b', 'main');
  // The fixture's own local policy must override ambient signing settings;
  // private Git preparation intentionally rejects required signing.
  await git(project, 'config', '--local', 'commit.gpgsign', 'false');
  await git(project, 'add', '--', 'quote.py', 'held-canary.txt');
  await git(project, '-c', 'user.name=Passeur Fixture', '-c', 'user.email=passeur-fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: disposable Python baseline');
  const base = await git(project, 'rev-parse', 'HEAD');
  const hook = join(project, '.git', 'hooks', 'commit-msg');
  await writeFile(hook, '#!/bin/sh\nset -eu\nprintf "\\nPasseur-Hook: registered-service\\n" >> "$1"\n');
  await chmod(hook, 0o755);
  const profilePath = join(root, 'profile.json');
  const profile = { schema_version: 3, execution: { stop_grace_ms: 5000, max_workers: 1,
    max_queued_tasks: 0, max_clients: 8, max_waiters: 16, max_pending_inputs: 4,
    max_control_receipts: 64, implementation: { enabled: true, worktree_root: join(root, 'worktrees') } },
  agents: [{ agent_id: 'codex', adapter_id: 'codex', description: 'Disposable registered protected Codex gate', enabled: true,
    options: { codex_bin: codexBin, codex_home: codexHome, model: 'gpt-6-astra', network_access: true,
      allow_command_escalation: false, use_caller_codex_home: true, experimental_real_protected: true,
      subscription_confirmed: true, experimental_opt_in: true } }] };
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  const requestKey = `registered-service-${randomUUID()}`;
  const assignment = { schema_version: 3, agent_id: 'codex', request_key: requestKey, mode: 'implement',
    objective: 'Make one ordinary Python change and commit it in the assigned disposable worktree',
    context: `Create ${markerName} containing exactly registered-service-ok followed by one newline. Run these two checks as shell commands from the worktree: python3 -c "import ast; from pathlib import Path; ast.parse(Path('quote.py').read_text())" and python3 -c "from pathlib import Path; assert Path('registered-service.txt').read_bytes() == b'registered-service-ok\\n'". Commit the change through ordinary Git with fixed synthetic identity Passeur Worker <passeur-worker@example.invalid>, for example using git -c user.name and -c user.email on the commit. Preserve hooks. Return a schema-2 PASSEUR_MESSAGE final envelope with summary, assessment, blockers, questions, and checks.`,
    acceptance_criteria: ['Only registered-service.txt changes from the committed base', 'The exact marker bytes are checked',
      'quote.py passes a Python check', 'An ordinary Git commit is created with the hook intact'],
    allowed_paths: [markerName], base_commit: base, target_ref: 'refs/heads/main' };
  const manifest = { root, project, vault, stateRoot, profilePath, base, requestKey,
    assignment_sha256: sha(JSON.stringify(assignment)), baseline_sha256: sha(baseline),
    canary_sha256: Object.fromEntries(Object.entries(canaries).map(([key, value]) => [key, sha(`${value}\n`)])),
    no_remote: await git(project, 'remote') === '' };
  if (!manifest.no_remote) throw Error('Disposable repository has a remote');
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, reportName), `${JSON.stringify({ schema_version: 1, qualification: 'nonpassing_retained',
    stage: 'prepared', ...manifest, task_id: null }, null, 2)}\n`, { mode: 0o600 });
  return { manifest, assignment };
}

export function toolBody(reply) {
  if (!reply || reply.isError) throw Error('Passeur tool returned an error; inspect retained service diagnostics');
  if (reply.structuredContent !== undefined) return reply.structuredContent;
  if (!Array.isArray(reply.content) || reply.content.length !== 1 || reply.content[0]?.type !== 'text') throw Error('Malformed Passeur tool response');
  return JSON.parse(reply.content[0].text);
}

export function readinessFailures(before, ready, manifest) {
  const failures = [];
  if (before?.frontend?.mode !== 'installed') failures.push('before.frontend.mode');
  if (ready?.frontend?.mode !== 'installed') failures.push('ready.frontend.mode');
  if (ready?.service?.state !== 'connected') failures.push('ready.service.state');
  if (ready?.service?.status?.repository?.coordination?.state !== 'ready') failures.push('ready.service.repository.coordination.state');
  if (ready?.service?.status?.admission !== 'open') failures.push('ready.service.admission');
  if (ready?.binding?.project_input !== manifest.project) failures.push('ready.binding.project_input');
  if (ready?.binding?.profile_path !== manifest.profilePath) failures.push('ready.binding.profile_path');
  if (ready?.binding?.state_root !== manifest.stateRoot) failures.push('ready.binding.state_root');
  return failures;
}

export async function observeBounded(call, initial, deadlineMs, now = Date.now) {
  let task = initial;
  while (now() < deadlineMs && !['terminal', 'needs_attention'].includes(task.phase) && task.inputs_count === 0) {
    const remaining = deadlineMs - now();
    const waitMs = Math.min(20_000, Math.max(0, remaining));
    const response = await call('passeur_wait', { schema_version: 1, task_id: task.task_id,
      after_revision: task.revision, wait_ms: waitMs }, waitMs + 10_000);
    if (!['changed', 'terminal', 'input_required', 'wait_elapsed'].includes(response.kind) || response.task.task_id !== task.task_id ||
        response.task.revision < task.revision) throw Error('Invalid task observation');
    task = response.task;
    if (response.kind === 'input_required') break;
  }
  return task;
}

export function classifyEvidence(evidence) {
  const result = evidence.result, delivery = result?.delivery;
  const checks = result?.checks;
  const successful = check => check?.evidence === 'runtime_observed' && check.exit_code === 0 && typeof check.command === 'string';
  const pythonCheck = checks?.some(check => successful(check) && check.command.includes('python3 -c') &&
    check.command.includes('ast.parse') && check.command.includes('quote.py'));
  const markerCheck = checks?.some(check => successful(check) && check.command.includes('python3 -c') &&
    check.command.includes('registered-service.txt') && check.command.includes('read_bytes()') &&
    check.command.includes('registered-service-ok'));
  return evidence.installed === true && evidence.same_generation === true && evidence.registered === true &&
    evidence.no_remote === true && evidence.main_unchanged === true && evidence.canaries_unchanged === true &&
    evidence.worktree_canary_unchanged === true && evidence.committed_marker_exact === true &&
    evidence.hook_ran === true && evidence.marker_exact === true && evidence.only_marker_changed === true &&
    evidence.private_ref_matches === true && evidence.canonical_ref_matches === true &&
    evidence.resource_state === 'retained' && evidence.private_publication_state === 'published' &&
    result?.task_id === evidence.task_id && result?.execution_status === 'completed' && result?.worker_stop === 'confirmed' &&
    result?.worker_assessment === 'met' && Array.isArray(result?.blockers) && result.blockers.length === 0 &&
    Array.isArray(result?.questions) && result.questions.length === 0 &&
    result?.native_evidence?.state === 'stopped' && result?.native_evidence?.coverage === 'turn_scoped' &&
    result?.native_evidence?.run_id === evidence.task_id && result?.native_evidence?.turn_id &&
    result?.native_evidence?.native_session_id && result?.native_evidence?.obligations?.length === 0 &&
    result?.model?.reported === 'gpt-6-astra' &&
    result?.identity?.snapshot?.agent_id === 'codex' && result?.identity?.snapshot?.adapter_id === 'codex' &&
    delivery?.status === 'committed' && delivery?.base_commit === evidence.base &&
    delivery?.branch_ref?.startsWith('refs/') && delivery?.head_commit === evidence.head &&
    Array.isArray(checks) && checks.length >= 2 && checks.every(check => check.exit_code === 0) &&
    pythonCheck === true && markerCheck === true ? 'single_worker_passed' : 'nonpassing_retained';
}

async function retainedResult(call, taskId) {
  let offset = 0;
  const chunks = [];
  while (true) {
    const page = await call('passeur_result', { task_id: taskId, section: 'result', encoding: 'utf8', offset, limit: 8192 });
    if (page.task_id !== taskId || page.offset !== offset || page.next_offset <= offset && !page.eof) throw Error('Invalid retained result page');
    chunks.push(page.content);
    if (page.eof) break;
    offset = page.next_offset;
    if (offset > 1_000_000) throw Error('Retained result exceeds qualifier bound');
  }
  return JSON.parse(chunks.join(''));
}

/** Read-only installed CLI fallback for needs-attention records that lack an MCP result slice. */
export async function needsAttentionDiagnostic(runtime, manifest, taskId, run = execute) {
  let stored;
  try {
    const reply = await run(process.execPath, [runtime, 'result', '--project', manifest.project,
      '--profile', manifest.profilePath, '--state-root', manifest.stateRoot, '--task', taskId],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 });
    stored = JSON.parse(reply.stdout);
  } catch { throw Error('INSTALLED_RESULT_UNAVAILABLE'); }
  const result = stored?.result, resource = stored?.resource;
  if (result?.task_id !== taskId || resource?.task_id !== taskId) throw Error('INSTALLED_RESULT_IDENTITY_MISMATCH');
  return {
    source: 'installed_read_only_cli',
    result: { schema_version: result.schema_version, task_id: result.task_id,
      execution_status: result.execution_status, worker_stop: result.worker_stop,
      worker_assessment: result.worker_assessment, error_code: result.error?.code ?? null,
      native: { run_id: result.native_evidence?.run_id ?? null, state: result.native_evidence?.state ?? null,
        coverage: result.native_evidence?.coverage ?? null, turn_id: result.native_evidence?.turn_id ?? null,
        native_session_id: result.native_evidence?.native_session_id ?? null },
      delivery_status: result.delivery?.status ?? null, checks_count: result.checks?.length ?? 0,
      blockers_count: result.blockers?.length ?? 0, questions_count: result.questions?.length ?? 0 },
    resource: { state: resource.state, private_git_state: resource.private_git?.state ?? null,
      branch_ref: resource.branch_ref ?? null, head_commit: resource.head_commit ?? null },
  };
}

export async function runLive({ runtime, codexBin, codexHome, observationMs = 600_000 }) {
  const { manifest, assignment } = await prepareFixture(codexBin, codexHome);
  const reportPath = join(manifest.root, reportName);
  const report = { schema_version: 1, qualification: 'nonpassing_retained', stage: 'prepared', ...manifest,
    task_id: null, frontend: null, service: null, result: null };
  const save = async () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const client = new Client({ name: 'passeur-codex-registered-service-qualifier', version: '1' }, { capabilities: {} });
  const args = [runtime, 'serve', '--project', manifest.project, '--profile', manifest.profilePath,
    '--state-root', manifest.stateRoot];
  const call = async (name, args, timeout = 30_000) => toolBody(await client.callTool({ name, arguments: args }, undefined, { timeout }));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: 'inherit' }));
    const listed = (await client.listTools()).tools.map(item => item.name);
    for (const name of ['passeur_status', 'passeur_prepare', 'passeur_agents', 'passeur_submit', 'passeur_tasks', 'passeur_wait', 'passeur_result']) {
      if (!listed.includes(name)) throw Error(`Installed tool missing: ${name}`);
    }
    const before = await call('passeur_status', {});
    report.frontend = before.frontend;
    report.binding = before.binding;
    report.stage = 'frontend_status'; await save();
    // A development CLI is a genuine preflight failure. Do not prepare a
    // service under it, and retain its exact nonsecret identity for diagnosis.
    if (before.frontend?.mode !== 'installed') {
      report.readiness_failures = ['before.frontend.mode'];
      throw Error(`FRONTEND_NOT_INSTALLED: mode=${before.frontend?.mode ?? 'missing'} build=${before.frontend?.build_id ?? 'missing'}`);
    }
    const ready = await call('passeur_prepare', {}, 100_000);
    report.readiness_failures = readinessFailures(before, ready, manifest);
    report.frontend = ready.frontend;
    report.binding = ready.binding;
    report.observed_service = ready.service?.state === 'connected' ? {
      generation: ready.service.status.generation, build_id: ready.service.status.repository.runtime.build_id,
      coordination: ready.service.status.repository.coordination.state, admission: ready.service.status.admission,
    } : { state: ready.service?.state ?? 'missing' };
    await save();
    if (report.readiness_failures.length) throw Error(`Installed service binding failed: ${report.readiness_failures.join(', ')}`);
    report.frontend = ready.frontend;
    report.service = { generation: ready.service.status.generation, runtime: ready.service.status.repository.runtime,
      repository_id: ready.service.status.repository.binding.repository_id };
    report.stage = 'prepared_service'; await save();
    const catalog = await call('passeur_agents', { offset: 0, limit: 4 });
    if (catalog.total !== 1 || catalog.agents?.[0]?.agent_id !== 'codex' || catalog.agents[0].adapter_id !== 'codex' ||
        catalog.agents[0].state !== 'configured' || !catalog.agents[0].modes.includes('implement')) throw Error('Built-in Codex registration is unavailable');
    report.registered = true;
    let receipt;
    try { receipt = await call('passeur_submit', { schema_version: 1, assignment }, 100_000); }
    catch (error) {
      report.submit_error = String(error?.message ?? error).slice(0, 256);
      const recovered = await call('passeur_tasks', { schema_version: 1, request_key: manifest.requestKey, offset: 0, limit: 8 });
      if (recovered.total !== 1 || recovered.tasks?.length !== 1) throw Error('Submission acknowledgment uncertain; original request key retained for recovery');
      receipt = { kind: 'accepted', task: recovered.tasks[0] };
    }
    if (receipt.kind !== 'accepted' || receipt.task?.request_key !== manifest.requestKey || receipt.task.agent_id !== 'codex') throw Error('Unexpected task receipt');
    report.task_id = receipt.task.task_id; report.stage = 'accepted'; report.last_observation = receipt.task; await save();
    const task = await observeBounded(call, receipt.task, Date.now() + observationMs);
    report.last_observation = task; report.stage = 'observed'; await save();
    const after = await call('passeur_status', {});
    report.same_generation = after.service?.state === 'connected' && after.service.status.generation === report.service.generation &&
      after.service.status.repository.runtime.build_id === report.service.runtime.build_id;
    if (task.phase === 'needs_attention') {
      try {
        const diagnostic = await needsAttentionDiagnostic(runtime, manifest, task.task_id);
        report.result_source = diagnostic.source;
        report.result = diagnostic.result;
        report.resource_state = diagnostic.resource.state;
        report.private_publication_state = diagnostic.resource.private_git_state;
        report.resource_branch_ref = diagnostic.resource.branch_ref;
        report.resource_head_commit = diagnostic.resource.head_commit;
        report.stage = 'needs_attention_retained';
      } catch (error) {
        report.result_read_error_code = error?.message === 'INSTALLED_RESULT_IDENTITY_MISMATCH'
          ? 'INSTALLED_RESULT_IDENTITY_MISMATCH' : 'INSTALLED_RESULT_UNAVAILABLE';
        report.stage = 'needs_attention_result_unavailable';
      }
      await save();
      return report;
    }
    if (['terminal', 'needs_attention'].includes(task.phase)) {
      const result = await retainedResult(call, task.task_id);
      report.result = { schema_version: result.schema_version, task_id: result.task_id, execution_status: result.execution_status,
        worker_stop: result.worker_stop, worker_assessment: result.worker_assessment,
        blockers: result.blockers, questions: result.questions, native_evidence: result.native_evidence, model: result.model,
        identity: result.identity, delivery: result.delivery, checks: result.checks,
        artifacts: result.artifacts?.map(artifact => ({ id: artifact.id, kind: artifact.kind, bytes: artifact.bytes })),
        changed_files: result.changed_files, error: result.error ? { code: result.error.code } : undefined };
      const head = result.delivery?.head_commit;
      const branch = result.delivery?.branch_ref;
      report.head = head;
      report.main_unchanged = await git(manifest.project, 'rev-parse', 'HEAD') === manifest.base;
      report.no_remote = await git(manifest.project, 'remote') === '';
      report.canaries_unchanged = sha(await readFile(join(manifest.vault, 'held-canary.txt'))) === manifest.canary_sha256.outside &&
        sha(await readFile(join(manifest.project, 'held-canary.txt'))) === manifest.canary_sha256.repository;
      report.hook_ran = Boolean(head && (await git(manifest.project, 'show', '-s', '--format=%B', head)).includes('Passeur-Hook: registered-service'));
      report.canonical_ref_matches = Boolean(head && branch && await git(manifest.project, 'rev-parse', '--verify', branch) === head);
      // The public inspect CLI is read-only and reports the retained resource. It
      // shares this installed build, profile and state; it does not start a worker.
      const inspection = JSON.parse((await execute(process.execPath, [runtime, 'inspect', '--project', manifest.project,
        '--profile', manifest.profilePath, '--state-root', manifest.stateRoot], { encoding: 'utf8', timeout: 30_000 })).stdout);
      const resource = inspection.tasks?.find(entry => entry.task_id === task.task_id)?.resource;
      report.resource_state = resource?.state ?? null;
      report.private_publication_state = resource?.private_git?.state ?? null;
      const privateCommon = resource?.private_git?.private_common_dir;
      report.private_ref_matches = Boolean(head && branch && privateCommon &&
        (await execute('/usr/bin/git', [`--git-dir=${privateCommon}`, 'rev-parse', '--verify', branch],
          { encoding: 'utf8', env: gitEnv(manifest.project) })).stdout.trim() === head);
      const worktree = result.delivery?.worktree_path;
      report.marker_exact = Boolean(worktree && (await readFile(join(worktree, markerName), 'utf8').catch(() => '')) === 'registered-service-ok\n');
      report.committed_marker_exact = Boolean(head &&
        (await execute('/usr/bin/git', ['show', `${head}:${markerName}`],
          { cwd: manifest.project, encoding: 'utf8', env: gitEnv(manifest.project) })).stdout === 'registered-service-ok\n');
      report.worktree_canary_unchanged = Boolean(worktree &&
        sha(await readFile(join(worktree, 'held-canary.txt')).catch(() => Buffer.alloc(0))) === manifest.canary_sha256.repository);
      report.only_marker_changed = Boolean(head && await git(manifest.project, 'diff', '--name-only', manifest.base, head) === markerName);
      report.qualification = classifyEvidence({ ...report, installed: true, base: manifest.base });
    }
    report.stage = 'finished_observation'; await save();
    return report;
  } catch (error) {
    report.stage = 'error'; report.error = { code: error?.code ?? 'QUALIFIER_ERROR', message: String(error?.message ?? error).slice(0, 512) };
    await save();
    return report;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { values } = parseArgs({ options: { runtime: { type: 'string' }, 'codex-bin': { type: 'string' },
      'codex-home': { type: 'string' }, run: { type: 'boolean' }, 'observe-ms': { type: 'string' } }, strict: true });
    if (!values.run || process.env.PASSEUR_LIVE_AGENTS !== '1') throw Error('Live gate requires --run and PASSEUR_LIVE_AGENTS=1 after independent review');
    for (const key of ['runtime', 'codex-bin', 'codex-home']) if (!values[key] || !isAbsolute(values[key])) throw Error(`--${key} requires an absolute path`);
    const observationMs = values['observe-ms'] === undefined ? 600_000 : Number(values['observe-ms']);
    if (!Number.isInteger(observationMs) || observationMs < 1_000 || observationMs > 1_800_000) throw Error('--observe-ms must be 1000..1800000');
    const report = await runLive({ runtime: values.runtime, codexBin: values['codex-bin'],
      codexHome: values['codex-home'], observationMs });
    console.log(JSON.stringify({ root: report.root, qualification: report.qualification, stage: report.stage,
      task_id: report.task_id, request_key: report.requestKey, service: report.service, report: join(report.root, reportName) }));
    if (report.qualification !== 'single_worker_passed') process.exitCode = 1;
  } catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1; }
}
