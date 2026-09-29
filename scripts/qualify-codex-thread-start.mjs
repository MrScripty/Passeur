#!/usr/bin/env node
/** Explicit, disposable caller-home probe. The only model-facing RPC is thread/start. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { captureProtectedStartup, protectedLaunch, settleProtectedStop } from '../dist/src/agents/codex/protected-runtime.js';
import { assertAccount, assertEmptySkills, assertProtectedConfiguration, assertProtectedProfile,
  protectedThreadStarted, object, text as protocolText } from '../dist/src/agents/codex/protocol.js';
import { preparePrivateGitView } from '../.passeur-core/src/workspace/worktree.js';

export const PIN = Object.freeze({ version: 'codex-cli 0.157.1',
  binary: '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970',
  companion: '67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0' });
const MODEL = 'gpt-6-astra';
const PROFILE = 'passeur-boundary';
const HOST = fileURLToPath(new URL('../dist/src/agents/codex/protected-host.js', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4096,
  env: { HOME: cwd, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1' } }).trim();

export function parseLive(args) {
  if (args.length !== 3 || args[0] !== '--live' || args[1] !== '--native' ||
      !args[2].startsWith('/')) throw Error('Explicit --live --native ABSOLUTE_PATH required');
  return args[2];
}
export function nativeArgs() {
  return ['-c', 'forced_login_method="chatgpt"', '-c', `default_permissions="${PROFILE}"`,
    '-c', 'model_provider="openai"', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false',
    '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', 'features.image_generation=false', '-c', 'web_search="disabled"', 'app-server'];
}
export function threadParams(workspace) {
  return { model: MODEL, modelProvider: 'openai', cwd: workspace, permissions: PROFILE,
    ephemeral: true, allowProviderModelFallback: false };
}
export function pinnedIdentity(binary, companion, version) {
  return binary === PIN.binary && companion === PIN.companion && version === PIN.version;
}
export async function verifyPinnedNative(native, home, io = { lstat, readFile, realpath, execFileSync }, expected = PIN) {
  const companion = join(dirname(native), 'codex-code-mode-host');
  const paths = [native, companion];
  for (const path of paths) {
    const info = await io.lstat(path);
    if (await io.realpath(path) !== path || !info.isFile() ||
        (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) {
      throw Error('Native identity mismatch');
    }
  }
  const binaryHash = sha(await io.readFile(native));
  const companionHash = sha(await io.readFile(companion));
  if (binaryHash !== expected.binary || companionHash !== expected.companion) {
    throw Error('Native identity mismatch');
  }
  // The version command is permitted only after both executable files match their pins.
  const version = io.execFileSync(native, ['--version'], { encoding: 'utf8', timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4096,
    env: { HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }).trim();
  if (version !== expected.version) throw Error('Native identity mismatch');
  return { binaryHash, companionHash, version };
}
const METHODS = Object.freeze(['initialize', 'account/read', 'config/read',
  'permissionProfile/list', 'skills/list', 'thread/start']);
export function assertFixtureMethod(method) {
  if (!METHODS.includes(method)) throw Error('Fixture method outside allowlist');
}
/** A finite protocol allowlist prevents an accidental prompt or follow-up RPC. */
export async function preflightAndStart(transport, signal, identity, progress = () => {}) {
  const { workspace, canonical, admin, native } = identity;
  const request = async (method, params) => {
    assertFixtureMethod(method);
    progress(method);
    return transport.request(method, params, signal);
  };
  const initialized = object(await request('initialize', { clientInfo: {
    name: 'passeur_codex_worker', title: 'Passeur worker', version: '0.1.0' },
    capabilities: { experimentalApi: true } }), 'initialize');
  protocolText(initialized.userAgent, 'initialize.userAgent', 1024);
  await transport.notify('initialized', undefined, signal);
  assertAccount(await request('account/read', { refreshToken: false }));
  const config = await request('config/read', { includeLayers: true, cwd: workspace });
  assertProtectedConfiguration(config, PROFILE, false, { workspace, canonical, admin, native });
  if (object(object(config, 'config/read').config, 'config').model_provider !== 'openai') {
    throw Error('Fixture provider mismatch');
  }
  assertProtectedProfile(await request('permissionProfile/list', { cwd: workspace }));
  assertEmptySkills(await request('skills/list', { cwds: [workspace], forceReload: true }), workspace);
  const response = await request('thread/start', threadParams(workspace));
  protectedThreadStarted(response, workspace, MODEL, 'openai');
  return true;
}
export function classify(report) {
  return report.stage === 'thread/start' && report.thread === 'matched' &&
    pinnedIdentity(report.native_sha256, report.companion_sha256, report.native_version) &&
    report.native_path === 'canonical_pinned' && report.caller_home === 'canonical_caller' &&
    report.workspace === 'disposable_private_git' &&
    report.namespace_stop === 'confirmed' && report.transport_closed === true &&
    report.protocol_clean === true && report.unexpected_native === false ? 'thread_start_passed' : 'incomplete';
}
export async function closeTransport(report, transport) {
  report.transport_closed = await transport.close(15_000, 500).catch(() => false);
  // A response can be followed by a malformed frame before close settles.
  report.protocol_clean = report.transport_closed && transport.operationFailure === undefined;
}
const category = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
export function safeReport(report) {
  // Construct a new projection. Native reply and Error objects never enter durable evidence.
  return { schema_version: 1, kind: 'codex_thread_start', root: report.root,
    status: category(report.status, ['thread_start_passed', 'incomplete'], 'incomplete'),
    stage: category(report.stage, METHODS, 'setup'),
    native_sha256: digest(report.native_sha256), companion_sha256: digest(report.companion_sha256),
    native_version: report.native_version === PIN.version ? PIN.version : 'mismatch',
    caller_home: category(report.caller_home, ['canonical_caller'], 'unverified'),
    native_path: category(report.native_path, ['canonical_candidate', 'canonical_pinned'], 'unverified'),
    workspace: category(report.workspace, ['disposable_private_git'], 'unverified'),
    thread: category(report.thread, ['not_started', 'matched'], 'not_started'),
    unexpected_native: report.unexpected_native === true, transport_closed: report.transport_closed === true,
    protocol_clean: report.protocol_clean === true,
    namespace_stop: category(report.namespace_stop, ['confirmed'], 'unconfirmed'),
    root_removed: report.root_removed === true };
}
export async function finalizeFixture(report, io = { rm, writeFile }) {
  report.status = classify(report);
  if (report.status === 'thread_start_passed') {
    try {
      await io.rm(report.root, { recursive: true, force: true });
      report.root_removed = true;
    } catch {
      report.status = 'incomplete';
    }
  }
  if (!report.root_removed) await io.writeFile(join(report.root, 'bounded-report.json'),
    `${JSON.stringify(safeReport(report), null, 2)}\n`, { mode: 0o600 });
  return safeReport(report);
}
export async function settleFixture(report, transport, launch, capture,
  io = { settleProtectedStop, finalizeFixture }) {
  if (transport) await closeTransport(report, transport);
  if (launch) report.namespace_stop = await io.settleProtectedStop(capture, launch.statusFile,
    report.transport_closed);
  return io.finalizeFixture(report);
}

export async function runLive(args) {
  const native = parseLive(args);
  if (process.platform !== 'linux') throw Error('Linux protected runtime required');
  // Exact caller path is required; no implicit HOME fallback or caller config/auth read.
  const caller = process.env.CODEX_HOME;
  if (!caller || await realpath(caller) !== caller) throw Error('Canonical caller CODEX_HOME required');
  if (await realpath(native) !== native) throw Error('Canonical native path required');
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-thread-start-'));
  const project = join(root, 'project'), workspace = join(root, 'workspace');
  const privateDir = join(root, 'control', 'private-git');
  const report = { root, status: 'incomplete', stage: 'setup', native_sha256: null,
    companion_sha256: null, native_version: null, caller_home: 'canonical_caller',
    native_path: 'canonical_candidate', workspace: 'disposable_private_git', thread: 'not_started',
    unexpected_native: false, transport_closed: false, protocol_clean: false,
    namespace_stop: 'unconfirmed', root_removed: false };
  let transport, launch, capture;
  try {
    const verified = await verifyPinnedNative(native, root);
    report.native_sha256 = verified.binaryHash;
    report.companion_sha256 = verified.companionHash;
    report.native_version = verified.version;
    report.native_path = 'canonical_pinned';
    await mkdir(project, { mode: 0o700 });
    await mkdir(dirname(privateDir), { mode: 0o700 });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'Passeur Fixture');
    git(project, 'config', 'user.email', 'passeur-fixture@example.invalid');
    git(project, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(project, 'fixture.txt'), 'disposable workspace\n', { mode: 0o600 });
    git(project, 'add', '--', 'fixture.txt'); git(project, 'commit', '-qm', 'test: fixture baseline');
    const base = git(project, 'rev-parse', 'HEAD');
    if (git(project, 'remote') !== '') throw Error('Unexpected Git remote');
    const branch = 'thread-start-fixture';
    git(project, 'worktree', 'add', '-q', '-b', branch, workspace, base);
    const view = await preparePrivateGitView(project, { kind: 'task_worktree', path: workspace,
      base_commit: base, branch: `refs/heads/${branch}` }, privateDir);
    const identity = { workspace, canonical: view.canonical_common_dir,
      admin: join(view.canonical_common_dir, view.admin_relative), native };
    launch = protectedLaunch({ workspace, request: { mode: 'implement' }, private_git: {
      schema_version: 1, mount_kind: 'canonical_common_dir', view } },
    native, caller, HOST, nativeArgs(), undefined, undefined, false, true);
    transport = new CodexStdio({ command: launch.command, args: launch.args,
      cwd: workspace, env: launch.env,
      request: async () => { report.unexpected_native = true; throw Error('Unexpected native request'); },
      notification: message => {
        if (['item/started', 'item/completed', 'turn/completed', 'serverRequest/resolved'].includes(message.method)) {
          report.unexpected_native = true; throw Error('Unexpected native turn event');
        }
      } });
    const signal = AbortSignal.timeout(25_000);
    if (launch.guestStartPermit) await transport.startProtectedGuest(signal);
    capture = await captureProtectedStartup(launch.statusFile, launch.nativePath, undefined, 'inherited');
    await preflightAndStart(transport, signal, identity, stage => { report.stage = stage; });
    report.thread = 'matched';
  } catch {
    // Failure type is stage plus bounded identity/stop categories; never retain raw native errors.
  } finally {
    await settleFixture(report, transport, launch, capture);
  }
  return safeReport(report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await runLive(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === 'thread_start_passed' ? 0 : 1;
  } catch {
    process.stderr.write('Thread-start fixture could not start\n');
    process.exitCode = 2;
  }
}
