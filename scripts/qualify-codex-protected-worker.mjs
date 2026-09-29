#!/usr/bin/env node
/** One disposable, no-account Coordinator task through the built production Codex adapter. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRegistry } from '../dist/src/agents/registry.js';
import { CodexAdapter } from '../dist/src/agents/codex/adapter.js';
import { Coordinator } from '../dist/src/core/coordinator.js';
import { TaskStore } from '../dist/src/store/task-store.js';
import { providerToml } from './qualify-codex-model-tools.mjs';
import { execSchema, sseCall, outputForCall } from './qualify-codex-model-exec.mjs';

export const ELF = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
export const MODEL = 'gpt-5.3-codex';
export const PROVIDER = 'passeur_fixture_loopback';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BODY = 262_144;
const FILE = 'protected-change.txt';
const CONTENT = 'exact protected Codex commit bytes\n';
const REPORT = `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: 'final',
  summary: 'Committed the fixed private Git change', assessment: 'met', blockers: [], questions: [], checks: [] })}`;

export const HOME_DENIAL_MARKERS = ['HOME_DIRECT_DENIED', 'HOME_SYMLINK_DENIED', 'HOME_PROC_DENIED'];
export function homeProbeOutputValid(output) {
  if (typeof output !== 'string') return false;
  const at = output.indexOf('\nOutput:\n');
  if (at < 0 || output.indexOf('\nOutput:\n', at + 1) !== -1) return false;
  const body = output.slice(at + '\nOutput:\n'.length);
  const prefix = `${HOME_DENIAL_MARKERS.join('\n')}\n`;
  return body.startsWith(prefix) && HOME_DENIAL_MARKERS.every(marker => !body.slice(prefix.length).includes(marker));
}
export function createHomeCanaryAfterFirstPost(state) {
  if (state.requests !== 1 || !state.first || state.homeCanaryReady ||
      typeof state.homeCanary !== 'string' || !/^[a-f0-9]{48}$/.test(state.homeCanary) ||
      typeof state.homeCanaryHostPath !== 'string') throw Error('home canary timing or identity invalid');
  writeFileSync(state.homeCanaryHostPath, state.homeCanary, { flag: 'wx', mode: 0o600 });
  state.homeCanaryReady = true;
}
async function homeCanaryHostIntact(path, expected) {
  const [bytes, info] = await Promise.all([
    readFile(path, 'utf8').catch(() => null), stat(path).catch(() => null),
  ]);
  return bytes === expected && info?.isFile() === true && (info.mode & 0o777) === 0o600;
}

export function fixedCommand(workspace, protectedPath, siblingPath, homeCanaryPath = null) {
  for (const path of [workspace, protectedPath, siblingPath, ...(homeCanaryPath ? [homeCanaryPath] : [])]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path)) throw Error('unsafe disposable fixture path');
  }
  const alias = join(workspace, 'protected-link');
  const homeAlias = join(workspace, 'home-link');
  const homeProbe = homeCanaryPath ?
    `cat ${join(workspace, 'watched.txt')} >/dev/null && ` +
    `! cat ${homeCanaryPath} >/dev/null 2>&1 && printf '${HOME_DENIAL_MARKERS[0]}\\n' && ` +
    `! cat ${homeAlias} >/dev/null 2>&1 && printf '${HOME_DENIAL_MARKERS[1]}\\n' && ` +
    `! cat /proc/self/root${homeCanaryPath} >/dev/null 2>&1 && ` +
    `printf '${HOME_DENIAL_MARKERS[2]}\\n' && rm -- ${homeAlias} && ` : '';
  return `test ! -e ${protectedPath} && test ! -e ${alias} && ` +
    `test ! -e /proc/self/root${protectedPath} && test ! -e ${siblingPath} && rm -- ${alias} && ` +
    homeProbe +
    `printf '%s\\n' 'exact protected Codex commit bytes' > ${join(workspace, FILE)} && ` +
    `git -C ${workspace} add -- ${FILE} && ` +
    `git -C ${workspace} -c user.name='Passeur Fixture' -c user.email='passeur-fixture@example.invalid' ` +
    `commit -m 'test: protected Codex native commit' && git -C ${workspace} status --porcelain`;
}

export function finalSse() {
  const response = { id: 'resp_passeur_protected_final' };
  const events = [
    { type: 'response.created', response },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_passeur_protected_final',
      content: [{ type: 'output_text', text: REPORT }] } },
    { type: 'response.completed', response: { ...response,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0,
        output_tokens_details: null, total_tokens: 0 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function protectedProfileToml(workspace, canonical, admin, port) {
  const base = providerToml(workspace, ELF, port, MODEL);
  const anchor = `${JSON.stringify(workspace)} = true\n`;
  const filesystemSection = '[permissions."passeur-boundary".filesystem.":workspace_roots"]';
  if (!base.includes(anchor) || !base.includes(filesystemSection) ||
      !admin.startsWith(`${canonical}/worktrees/`) || admin.slice(`${canonical}/worktrees/`.length).includes('/')) {
    throw Error('profile root or exact worktree admin dir missing');
  }
  return base.replace(anchor, `${anchor}${JSON.stringify(canonical)} = true\n`)
    .replace(filesystemSection, `${JSON.stringify(admin)} = "write"\n${filesystemSection}`);
}

export function exactOneFileTree(diff, entry, path, oid) {
  return diff === `A\t${path}` && entry === `100644 blob ${oid}\t${path}`;
}

export function providerSequenceResult(result, complete, mode) {
  if (!result || typeof result !== 'object') throw Error('native worker result missing');
  if (complete && (mode !== 'cancel' || result.status === 'cancelled')) return result;
  if (result.status !== 'completed') return result;
  const message = mode === 'cancel' ? 'Fixed cancellation provider sequence was not observed' :
    'Fixed provider sequence was not observed';
  return { status: 'failed', worker_stop: result.worker_stop ?? 'unconfirmed',
    worker_assessment: 'unknown', summary: message,
    error: { code: 'CODEX_PROVIDER_SEQUENCE_INVALID', message }, blockers: [], questions: [], checks: [] };
}
export function providerSequenceComplete(state, mode, correlated, homeIntact) {
  if (mode === 'cancel') return state.first && !state.failure && state.requests === 1;
  return state.first && state.second && !state.failure && state.requests === 2 && correlated &&
    (mode !== 'home-canary' || state.homeProbeMarkersValid && homeIntact);
}

export function fixedOutputDiagnostic(output, protectedCanary, siblingCanary, homeCanary = null) {
  if (output.status !== 'accepted') return { category: output.status, exitCode: null };
  const text = output.text;
  if (text.includes(protectedCanary) || text.includes(siblingCanary) ||
      homeCanary && text.includes(homeCanary)) return { category: 'canary_exposed', exitCode: null };
  const match = /Process exited with code ([0-9]{1,3})\b/.exec(text);
  const exitCode = match ? Number(match[1]) : null;
  const category = /(?:index\.lock|unable to create.*index|could not lock index)/i.test(text) &&
    /(?:Permission denied|Operation not permitted|Read-only file system)/i.test(text) ? 'git_index_write_denied' :
    /(?:Permission denied|Operation not permitted|Read-only file system)/i.test(text) ? 'permission_denied' :
    /\bfatal:\s/i.test(text) ? 'git_fatal' :
    exitCode === 0 ? 'exit_zero' : exitCode !== null ? 'exit_nonzero' : 'exit_unknown';
  return { category, exitCode };
}

// Codex 0.157.1 presents commandExecution.command through shlex 1.3.0 try_join.
// The fixed fixture command is ASCII; keep this projection closed to that alphabet.
export function nativePresentedFixedCommand(command) {
  if (!/^[\x20-\x7e]+$/.test(command)) throw Error('fixed native command contains unsupported bytes');
  let quoted = '';
  for (let offset = 0; offset < command.length;) {
    let allowed = command[offset] === '^' ? 2 : 7;
    let end = offset + (command[offset] === '^' ? 1 : 0);
    for (; end < command.length; end++) {
      const c = command[end];
      let next = allowed;
      if (!/[+./:@\]_0-9A-Za-z-]/.test(c)) next &= ~1;
      if (c === "'" || c === '^' || c === '\\') next &= ~2;
      if (c === '$' || c === '`' || c === '!' || c === '^') next &= ~4;
      if (next === 0) break;
      allowed = next;
    }
    const part = command.slice(offset, end);
    quoted += allowed & 1 ? part : allowed & 2 ? `'${part}'` :
      `"${part.replace(/["\\]/g, '\\$&')}"`;
    offset = end;
  }
  return `/usr/bin/bash -c ${quoted}`;
}

export function nativeCheckDiagnostic(result, expectedCommand, workspace) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const projected = checks.slice(0, 3).map(check => ({
    commandBytes: typeof check?.command === 'string' ? Buffer.byteLength(check.command) : null,
    commandForm: typeof check?.command !== 'string' ? 'missing' :
      check.command.startsWith('/usr/bin/bash -c ') ? 'usr_bash_c' :
      check.command.startsWith('/bin/bash -c ') ? 'bash_c' :
      check.command.startsWith('/bin/bash -lc ') ? 'bash_lc' : 'other',
    commandMatches: check?.command === expectedCommand,
    cwdMatches: check?.cwd === workspace,
    exitCode: Number.isSafeInteger(check?.exit_code) ? check.exit_code : null,
    runtimeObserved: check?.evidence === 'runtime_observed',
  }));
  return { nativeStatus: ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(result?.status) ? result.status : 'unknown',
    nativeErrorCode: typeof result?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code) ? result.error.code : null,
    count: checks.length, checks: projected,
    matches: checks.some(check => check?.command === expectedCommand && check?.cwd === workspace &&
      check?.exit_code === 0 && check?.evidence === 'runtime_observed') };
}

function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: {
  PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
} }).trim(); }
function gitBytes(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, env: {
  PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
} }); }

function provider(socketPath, workspace, protectedPath, siblingPath, state, mode) {
  const command = fixedCommand(workspace, protectedPath, siblingPath,
    mode === 'home-canary' ? state.homeCanaryGuestPath : null);
  const probe = { cmd: command, workspace };
  const server = createServer((request, response) => {
    const refuse = category => { state.failure ??= category; response.writeHead(400).end(); };
    if (request.method !== 'POST' || request.url !== '/v1/responses' || ++state.requests > 2) {
      refuse('unexpected_provider_request'); return;
    }
    if (request.headers['x-passeur-native-auth-present'] !== '0') {
      refuse('native_auth_header_present'); return;
    }
    let bytes = 0; const chunks = [];
    request.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BODY) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      let body;
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requestDigests.push({ sha256: sha(raw), bytes: Buffer.byteLength(raw) });
      if (raw.includes(state.protectedCanary) || raw.includes(state.siblingCanary) ||
          state.homeCanaryReady && raw.includes(state.homeCanary)) {
        refuse('protected_canary_exposed'); return;
      }
      try { body = JSON.parse(raw); }
      catch { refuse('provider_json_invalid'); return; }
      if (body.model !== MODEL || execSchema(body) !== 'accepted') { refuse('provider_tool_schema_invalid'); return; }
      if (state.requests === 1) {
        state.first = true;
        if (mode === 'cancel') return; // Keep the accepted native turn pending until task-owned cancellation.
        if (mode === 'home-canary') {
          try { createHomeCanaryAfterFirstPost(state); }
          catch { refuse('home_canary_creation_failed'); return; }
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseCall(0, probe));
        return;
      }
      const output = outputForCall(body, 0, probe, [probe]);
      state.outputDiagnostic = fixedOutputDiagnostic(output, state.protectedCanary, state.siblingCanary,
        state.homeCanaryReady ? state.homeCanary : null);
      state.homeProbeMarkersValid = mode === 'home-canary' ? homeProbeOutputValid(output.text) : null;
      if (output.status !== 'accepted' || typeof output.text !== 'string' || output.text.includes(state.protectedCanary) ||
          output.text.includes(state.siblingCanary) ||
          state.homeCanaryReady && output.text.includes(state.homeCanary) ||
          mode === 'home-canary' && !state.homeProbeMarkersValid ||
          !output.text.includes('Process exited with code 0')) {
        refuse('provider_tool_output_invalid'); return;
      }
      state.second = true; state.toolOutputSha256 = sha(output.text); state.toolOutputBytes = Buffer.byteLength(output.text);
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(finalSse());
    });
    request.on('error', () => { state.failure ??= 'provider_request_failed'; });
  });
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(socketPath, resolve);
  }), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function run(mode = 'commit') {
  if (!['commit', 'cancel', 'home-canary'].includes(mode)) throw Error('unsupported qualification mode');
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-protected-worker-'));
  const project = join(root, 'project'), worktrees = join(root, 'worktrees');
  const home = join(root, 'home'), relayDir = join(root, 'relay');
  const protectedDir = join(root, 'protected'), siblingDir = join(root, 'sibling');
  const report = { fixture: 'codex-protected-coordinator/1', mode, root, status: 'not_started',
    nativeSha256: null, nativeVersion: null, model: MODEL, provider: PROVIDER,
    credential: 'anonymous_fixed_synthetic', taskId: null, providerRequests: 0,
    hostCanariesIntact: false, workerStop: 'unconfirmed', privateBefore: null,
    privateAfter: null, canonicalAfter: null, hookRan: false, bytesExact: false,
    rootDisposition: 'retained_for_review' };
  const save = () => writeFile(join(root, 'bounded-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  let coordinator, store, receipt, owner, activeProviderState;
  const protectedCanary = randomBytes(24).toString('hex'), siblingCanary = randomBytes(24).toString('hex');
  const protectedPath = join(protectedDir, 'auth-canary'), siblingPath = join(siblingDir, 'sibling-canary');
  const homeCanary = randomBytes(24).toString('hex');
  const homeCanaryHostPath = join(home, 'credential-canary');
  const homeCanaryGuestPath = '/mounts/home/credential-canary';
  try {
    await Promise.all([project, worktrees, home, relayDir, protectedDir, siblingDir].map(path => mkdir(path, { mode: 0o700 })));
    report.nativeSha256 = sha(await readFile(ELF));
    report.nativeVersion = execFileSync(ELF, ['--version'], { encoding: 'utf8', timeout: 10_000,
      env: { HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }).trim();
    if (report.nativeSha256 !== '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970' ||
        report.nativeVersion !== 'codex-cli 0.157.1') {
      report.status = 'native_attestation_mismatch'; await save(); return report;
    }
    await writeFile(protectedPath, protectedCanary, { mode: 0o600 });
    await writeFile(siblingPath, siblingCanary, { mode: 0o600 });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 'passeur-fixture@example.invalid');
    git(project, 'config', 'user.name', 'Passeur Fixture');
    git(project, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(project, 'watched.txt'), 'before\n');
    git(project, 'add', '.'); git(project, 'commit', '-qm', 'test: base');
    const base = git(project, 'rev-parse', 'HEAD');
    const hook = join(project, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf hook-ran > "$(git rev-parse --git-common-dir)/hooks/hook-marker"\n');
    await chmod(hook, 0o755);
    const policy = { implementation: { enabled: true, worktree_root: worktrees },
      stop_grace_ms: 5_000, max_workers: 1, max_queued_tasks: 1, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
    const profile = { schema_version: 3, execution: policy, agents: [{ agent_id: 'codex', adapter_id: 'codex',
      description: 'Disposable protected Codex qualification', enabled: true, options: {} }] };
    owner = { owner_id: sha(randomUUID()), client_id: randomUUID() };
    store = new TaskStore(join(root, 'state')); await store.initialize();
    const worker = { private_git: { schema_version: 1, mount_kind: 'canonical_common_dir' },
      async run(input) {
        const canonical = input.private_git.view.canonical_common_dir;
        const socketPath = join(relayDir, 'provider.sock');
        const state = { requests: 0, first: false, second: false, failure: null, requestDigests: [],
          protectedCanary, siblingCanary, homeCanary,
          homeCanaryHostPath, homeCanaryGuestPath, homeCanaryReady: false };
        activeProviderState = state;
        const relayPort = 39173;
        const p = provider(socketPath, input.workspace, protectedPath, siblingPath, state, mode);
        let result;
        try {
          if (mode !== 'cancel') await symlink(protectedPath, join(input.workspace, 'protected-link'));
          if (mode === 'home-canary') await symlink(homeCanaryGuestPath, join(input.workspace, 'home-link'));
          await p.listen();
          const config = protectedProfileToml(input.workspace, canonical,
            join(canonical, input.private_git.view.admin_relative), relayPort);
          await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
          report.privateBefore = git(project, '--git-dir', input.private_git.view.private_common_dir,
            'rev-parse', `refs/heads/muse-bridge/${input.task_id}`);
          report.canonicalBefore = git(project, 'rev-parse', `refs/heads/muse-bridge/${input.task_id}`);
          report.privateResourceBefore = (await store.readResource(input.task_id))?.private_git?.state ?? null;
          result = await new CodexAdapter({ codex_bin: ELF, codex_home: home, model: MODEL,
            network_access: false, allow_command_escalation: false, subscription_confirmed: true,
            experimental_opt_in: true }, { syntheticProvider: PROVIDER, allowAnonymous: true,
            relay: { socketPath, port: relayPort } }).run(input);
        } finally { await p.close(); }
        report.providerRequests = state.requests;
        report.providerRequestDigests = state.requestDigests;
        report.providerFailure = state.failure;
        report.homeCanaryCreatedAfterFirstPost = mode === 'home-canary' ? state.homeCanaryReady : null;
        report.homeProbeMarkersValid = mode === 'home-canary' ? state.homeProbeMarkersValid === true : null;
        report.homeCanaryIntactBeforePublication = mode === 'home-canary' && state.homeCanaryReady ?
          await homeCanaryHostIntact(homeCanaryHostPath, homeCanary) : null;
        report.providerOutputDiagnostic = state.outputDiagnostic ?? null;
        report.providerOutput = state.second ? { sha256: state.toolOutputSha256, bytes: state.toolOutputBytes } : null;
        report.workerStop = result?.worker_stop ?? 'unconfirmed';
        report.nativeCheckDiagnostic = nativeCheckDiagnostic(result,
          nativePresentedFixedCommand(fixedCommand(input.workspace, protectedPath, siblingPath,
            mode === 'home-canary' ? homeCanaryGuestPath : null)), input.workspace);
        report.nativeCommandCorrelated = report.nativeCheckDiagnostic.matches;
        report.providerSequenceComplete = providerSequenceComplete(state, mode,
          report.nativeCommandCorrelated, report.homeCanaryIntactBeforePublication);
        return providerSequenceResult(result, report.providerSequenceComplete, mode);
      } };
    coordinator = new Coordinator(project, 'codex-protected-fixture', policy, store,
      new AgentRegistry(profile, { codex: { configure: () => ({ worker, modes: ['implement'],
        contract: 'codex-protected-installed-fixture/1', configuration: {} }) } }),
    () => {}, undefined, 'controlled');
    const assignment = { schema_version: 3, agent_id: 'codex', request_key: `protected-${randomUUID()}`,
      mode: 'implement', objective: 'Make one fixed hook-executed private commit', context: '',
      acceptance_criteria: ['fixed bytes and one private Git commit'], base_commit: base,
      target_ref: 'refs/heads/main' };
    receipt = await coordinator.submit({ schema_version: 1, source_view: project, assignment },
      owner, new AbortController().signal);
    report.taskId = receipt.task_id;
    if (mode === 'cancel') {
      const readyUntil = Date.now() + 30_000;
      while (Date.now() < readyUntil && !activeProviderState?.first && !await store.readResult(receipt.task_id)) await delay(100);
      report.cancelAfterProviderRequest = activeProviderState?.first === true;
      if (!await store.readResult(receipt.task_id)) {
        const control = await store.readControl(receipt.task_id);
        report.explicitCancel = await coordinator.cancel(receipt.task_id, owner, control.control_generation,
          `cancel-${randomUUID()}`, 'Explicit disposable protected Codex cancellation');
      }
    }
    const deadline = Date.now() + 90_000;
    let result;
    while (Date.now() < deadline) {
      result = await store.readResult(receipt.task_id);
      if (result) break;
      await delay(100);
    }
    if (!result) {
      const control = await store.readControl(receipt.task_id);
      report.explicitCancel = await coordinator.cancel(receipt.task_id, owner, control.control_generation,
        `cancel-${randomUUID()}`, 'Disposable protected Codex fixture observation deadline');
      while (!(result = await store.readResult(receipt.task_id))) await delay(100);
    }
    const resource = await store.readResource(receipt.task_id);
    report.executionStatus = result?.execution_status ?? 'pending';
    report.deliveryStatus = result?.delivery?.status ?? 'pending';
    report.workerStop = result?.worker_stop ?? report.workerStop;
    report.privateResourceState = resource?.private_git?.state ?? null;
    report.branchRef = resource?.branch_ref ?? null;
    report.privateAfter = resource?.private_git?.view ? git(project, '--git-dir', resource.private_git.view.private_common_dir,
      'rev-parse', resource.branch_ref) : null;
    report.canonicalAfter = resource?.branch_ref ? git(project, 'rev-parse', resource.branch_ref) : null;
    report.mainAfter = git(project, 'rev-parse', 'refs/heads/main');
    if (report.canonicalAfter && report.canonicalAfter !== base) {
      const ancestry = git(project, 'rev-list', '--parents', '-n', '1', report.canonicalAfter).split(' ');
      report.commitParentExact = ancestry.length === 2 && ancestry[0] === report.canonicalAfter && ancestry[1] === base;
      report.commitTree = git(project, 'rev-parse', `${report.canonicalAfter}^{tree}`);
      report.commitBytesExact = gitBytes(project, 'show', `${report.canonicalAfter}:${FILE}`).equals(Buffer.from(CONTENT));
      const expectedOid = execFileSync('/usr/bin/git', ['hash-object', '--stdin'], { cwd: project,
        input: CONTENT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: project,
          LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' } }).trim();
      report.commitTreeExact = exactOneFileTree(
        git(project, 'diff-tree', '--no-commit-id', '--name-status', '-r', base, report.canonicalAfter),
        git(project, 'ls-tree', report.canonicalAfter, '--', FILE), FILE, expectedOid);
    } else { report.commitParentExact = false; report.commitBytesExact = false; report.commitTreeExact = false; }
    report.hookRan = resource?.private_git?.view ? (await readFile(join(resource.private_git.view.private_common_dir,
      'hooks', 'hook-marker'), 'utf8').catch(() => '')) === 'hook-ran' : false;
    report.bytesExact = resource?.worktree_path ? (await readFile(join(resource.worktree_path, FILE), 'utf8').catch(() => '')) === CONTENT : false;
    report.hostCanariesIntact = (await readFile(protectedPath, 'utf8')) === protectedCanary &&
      (await readFile(siblingPath, 'utf8')) === siblingCanary;
    report.homeCanaryIntact = mode === 'home-canary' && report.homeCanaryCreatedAfterFirstPost ?
      await homeCanaryHostIntact(homeCanaryHostPath, homeCanary) : null;
    const commitValid = result?.execution_status === 'completed' && result.worker_stop === 'confirmed' &&
      result.delivery?.status === 'committed' && resource?.private_git?.state === 'published' &&
      report.privateResourceBefore === 'prepared' && report.branchRef === `refs/heads/muse-bridge/${receipt.task_id}` &&
      report.privateBefore === base && report.canonicalBefore === base &&
      report.privateAfter === report.canonicalAfter &&
      report.privateAfter !== base && report.mainAfter === base && report.commitParentExact &&
      report.commitBytesExact && report.commitTreeExact && report.hookRan && report.bytesExact && report.hostCanariesIntact &&
      report.providerRequests === 2 && report.nativeCommandCorrelated && !report.providerFailure;
    report.status = mode === 'cancel' ?
      result?.execution_status === 'cancelled' && result.worker_stop === 'confirmed' &&
      resource?.private_git?.state === 'prepared' && report.privateBefore === base &&
      report.privateAfter === base && report.canonicalAfter === base && report.mainAfter === base &&
      report.hostCanariesIntact && report.providerRequests === 1 && report.cancelAfterProviderRequest &&
      report.explicitCancel && !report.providerFailure ?
        'accepted_synthetic_cancellation' : 'incomplete' :
      commitValid && (mode !== 'home-canary' || report.homeCanaryIntact && report.homeProbeMarkersValid) ?
        (mode === 'home-canary' ? 'accepted_synthetic_home_canary' : 'accepted_synthetic_private_commit') : 'incomplete';
    await save();
    await coordinator.shutdown();
    return report;
  } catch (error) {
    report.status = 'fixture_error'; report.error = { code: error?.code ?? 'UNKNOWN', stage: 'qualification' };
    if (receipt && coordinator && store) {
      let result = await store.readResult(receipt.task_id).catch(() => undefined);
      if (!result) {
        const control = await store.readControl(receipt.task_id);
        report.explicitCancel = await coordinator.cancel(receipt.task_id, owner, control.control_generation,
          `cancel-${randomUUID()}`, 'Disposable protected Codex fixture failure');
        while (!(result = await store.readResult(receipt.task_id))) await delay(100);
      }
      report.workerStop = result.worker_stop;
      report.executionStatus = result.execution_status;
      await coordinator.shutdown();
    }
    await save();
    return report;
  }
}

if (process.argv[1]?.endsWith('/qualify-codex-protected-worker.mjs')) {
  const mode = process.argv[2] === '--cancel' ? 'cancel' : process.argv[2] === '--home-canary' ?
    'home-canary' : process.argv[2] === undefined ? 'commit' : 'invalid';
  const result = await run(mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ['accepted_synthetic_private_commit', 'accepted_synthetic_cancellation',
    'accepted_synthetic_home_canary'].includes(result.status) ? 0 : 1;
}
