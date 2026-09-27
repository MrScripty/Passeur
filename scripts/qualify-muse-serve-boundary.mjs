#!/usr/bin/env node
// Offline installed-host experiment. Every file and credential here is disposable.
import { MuseClient, readSessionDurability, spawnMspConnection } from '@muse-code/sdk';
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, runManagedProcess } from './qualify-muse-native-shell.mjs';

const EXPECTED = '1.4.0-R4302.1';
const DUMMY = 'passeur-disposable-dummy-key';
const MODEL = 'fixture-native-shell';
const TURN_MS = 20_000;
const STARTUP_MS = 15_000;
const CLOSE_MS = 8_000;

export async function within(stage, work, budgetMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${stage} exceeded ${budgetMs}ms`), { code: 'PROBE_DEADLINE' })), budgetMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function selectChoice(request, decision) {
  const wanted = decision === 'allow' ? 'approved' : 'denied';
  return request.availableChoices.find(choice => choice.decision === wanted && choice.scope === 'once')?.choiceId;
}

async function file(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function qualify({ muse = '/home/jeremy/.local/bin/muse', scenario = 'inside', decision = 'deny', runProcess = runManagedProcess } = {}) {
  const commands = {
    inside: 'printf shell-ran > shell-canary',
    git: 'printf git-ran > .git/probe',
    commit: 'printf shell-ran > shell-canary && git add shell-canary && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture-shell',
    auth: 'cat "$HOME/.config/muse/auth.json" > auth-canary; env > env-canary',
  };
  if (!(scenario in commands) || !['allow', 'deny'].includes(decision)) throw new Error('invalid scenario or decision');
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-serve-boundary-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin',
    MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8', TBH_CREDENTIAL_BACKEND: 'file',
    TBH_DISABLE_TELEMETRY: '1', MUSE_EXPERIMENTAL_SDK_ENABLED: 'on' };
  let fixture;
  let client;
  let handshake;
  let hostSpawnAttempted = false;
  let uncertainPreHostStop = false;
  let result;
  let stderr = '';
  let stage = 'version';
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace);
    const version = await runProcess(muse, ['--version'], { env, cwd: root });
    if (version.code !== 0 || !version.stdout.includes(EXPECTED)) {
      return { kind: 'native_version_mismatch', expected: EXPECTED, actual: version.stdout.trim(), stderr: version.stderr };
    }
    stage = 'workspace_setup';
    for (const args of [['init', '-q', workspace], ['-C', workspace, 'add', 'README.md']]) {
      if (args[0] === '-C') await writeFile(join(workspace, 'README.md'), 'disposable fixture\n');
      const step = await runProcess('git', args, { env, cwd: root });
      if (step.code !== 0) throw new Error(`git ${args[0]} failed: ${step.stderr}`);
    }
    const baseline = await runProcess('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { env, cwd: root });
    if (baseline.code !== 0) throw new Error(`baseline commit failed: ${baseline.stderr}`);
    await writeFile(join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf hook-ran > hook-canary\n');
    await chmod(join(workspace, '.git', 'hooks', 'pre-commit'), 0o755);
    stage = 'loopback_fixture';
    fixture = await startFixture(commands[scenario]);
    const configDir = join(home, '.config', 'muse');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'settings.json'), `${JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: fixture.url, auth: 'bearer' } })}\n`);
    await writeFile(join(configDir, 'auth.json'), `${JSON.stringify({ schema_version: 1, providers: { meta: { api_key: DUMMY } } })}\n`);
    const approvals = [];
    const approvalErrors = [];
    stage = 'host_spawn';
    hostSpawnAttempted = true;
    handshake = spawnMspConnection({ command: muse, args: ['serve'], cwd: workspace, env, shutdownTimeoutMs: 2_000,
      onStderr: chunk => { stderr = (stderr + chunk).slice(-4_000); } });
    const spawned = await within('host initialize', handshake.initialize({ clientInfo: {
      name: 'passeur_disposable_qualification', version: '0.1.0',
    } }), STARTUP_MS);
    client = new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
    stage = 'session_start';
    const session = await within('session/start', client.startSession({ workspaceRoot: workspace, modelId: MODEL,
      providerId: 'meta', approvalMode: 'onRequest' }), STARTUP_MS);
    session.onApproval(request => {
      const choice = selectChoice(request, decision);
      approvals.push({ approvalId: request.approvalId, toolName: request.toolName,
        choices: request.availableChoices.map(c => ({ decision: c.decision, scope: c.scope, label: c.label })),
        selected: choice ?? null });
      if (!choice) throw new Error('no requested once-only choice offered');
      return { choiceId: choice };
    });
    session.onApprovalError(error => { approvalErrors.push({ kind: error.kind, approvalId: error.approvalId }); });
    const prompt = `NATIVE_SHELL_PROBE: Use native bash to run the disposable ${scenario} command. Report its result.`;
    stage = 'model_turn';
    const turn = await within('turn/start', session.sendUserTurn({ input: [{ type: 'text', text: prompt }] }), STARTUP_MS);
    const items = [];
    const consume = (async () => { for await (const item of turn.items()) {
      if (item.kind === 'toolCall') items.push({ kind: item.kind, toolName: item.toolName, status: item.status,
        failureKind: item.failureKind, failureReason: item.failureReason?.slice(0, 300), outputRef: item.outputRef?.id });
    } })();
    consume.catch(() => undefined);
    const completed = await within('turn/completed', turn.completed, TURN_MS);
    await within('turn items', consume, STARTUP_MS);
    stage = 'observation';
    const files = { shell: await file(join(workspace, 'shell-canary')), git: await file(join(workspace, '.git', 'probe')),
      hook: await file(join(workspace, 'hook-canary')), auth: await file(join(workspace, 'auth-canary')),
      env: await file(join(workspace, 'env-canary')) };
    const head = await runProcess('git', ['-C', workspace, 'log', '-1', '--format=%H %s'], { env, cwd: root });
    result = { kind: 'observed', scenario, decision, sdkVersion: '1.3.0', nativeVersion: version.stdout.trim(),
      posture: 'serve/session onRequest; no sandbox override', requests: fixture.requests,
      approvals, approvalErrors, turn: completed, items, files: { ...files, auth: files.auth === null ? null : { dummyVisible: files.auth.includes(DUMMY) }, env: files.env === null ? null : { dummyVisible: files.env.includes(DUMMY), nonempty: files.env.length > 0 } },
      gitHead: head.stdout.trim(), stderr: stderr.slice(-1_000), retainedFixture: root,
      stopProof: 'descendants_unverified' };
    return result;
  } catch (error) {
    if (error.code === 'GROUP_NOT_STOPPED') uncertainPreHostStop = true;
    return { kind: 'qualification_error', stage, scenario, decision, code: error.code ?? error.name,
      message: String(error.message).slice(0, 1_000), sdkVersion: '1.3.0', stderr: stderr.slice(-2_000),
      requests: fixture?.requests, ...(hostSpawnAttempted || uncertainPreHostStop ? {
        retainedFixture: root, stopProof: 'descendants_unverified',
      } : {}) };
  } finally {
    if (handshake) {
      try { await within('host close', client ? client.close() : handshake.close(), CLOSE_MS); }
      catch (error) { process.stderr.write(`HOST_STOP_UNCERTAIN fixture retained at ${root}: ${error.message}\n`); }
    }
    if (fixture) await fixture.close();
    // The SDK's exit/close only observes the serve process, not its detached descendants.
    if (!hostSpawnAttempted && !uncertainPreHostStop) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await qualify({ scenario: process.argv[2] ?? 'inside', decision: process.argv[3] ?? 'deny' }), null, 2));
}
