#!/usr/bin/env node
/** Disposable, no-account command/exec check of the real protected worker mount. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../dist/src/agents/codex/transport.js';
import { protectedLaunch, captureProtectedStartup, settleProtectedStop } from '../dist/src/agents/codex/protected-runtime.js';
import { assertProtectedConfiguration, assertProtectedProfile, assertEmptySkills } from '../dist/src/agents/codex/protocol.js';
import { preparePrivateGitView } from '../.passeur-core/src/workspace/worktree.js';

const NATIVE = '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const HASH = '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970';
const HOST = fileURLToPath(new URL('../dist/src/agents/codex/protected-host.js', import.meta.url));
const PROFILE = 'passeur-boundary';
const CONTROL = 'workspace control\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { HOME: cwd, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1' } }).trim();

export function requireLive(args) {
  if (args.length !== 1 || args[0] !== '--live') throw Error('Explicit --live required');
}
// Pinned 0.157.1 experimental CommandExecParams: argv, cwd, permissionProfile,
// timeoutMs and outputBytesCap; permissionProfile cannot accompany sandboxPolicy.
export function commandRequest(path, workspace) {
  return { command: ['/usr/bin/cat', path], cwd: workspace, permissionProfile: PROFILE,
    timeoutMs: 10_000, outputBytesCap: 4096 };
}
export function classifyRead(result, path, canary, positive = false) {
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
      !Number.isSafeInteger(result.exitCode)) return 'uncertain';
  if (canary && (result.stdout.includes(canary) || result.stderr.includes(canary))) return 'exposed';
  if (positive) return result.exitCode === 0 && result.stdout === CONTROL && result.stderr === '' ? 'allowed' : 'uncertain';
  const error = result.stderr.trimEnd();
  if (result.stdout !== '' || result.exitCode === 0) return 'uncertain';
  const prefixes = [`/usr/bin/cat: ${path}: `, `cat: ${path}: `];
  return ['Permission denied', 'Operation not permitted', 'Access denied', 'No such file or directory', 'ENOENT']
    .some(reason => prefixes.some(prefix => error === `${prefix}${reason}`)) ? 'denied' : 'uncertain';
}
export async function intact(path, target, bytes, symlinkPath = false) {
  try {
    const info = await lstat(path);
    if (symlinkPath ? !info.isSymbolicLink() || await readlink(path) !== target :
      !info.isFile() || (info.mode & 0o777) !== 0o600) return false;
    return (await readFile(target)).equals(bytes);
  } catch { return false; }
}
export function resultStatus(evidence) {
  const expected = ['direct', 'direct', 'symlink', 'symlink', 'proc', 'proc'];
  return evidence.completed === true && evidence.preflight && evidence.control === 'allowed' && evidence.probes.length === 6 &&
    evidence.probes.every((probe, index) => probe.route === expected[index] && probe.target === index % 2 &&
      probe.before && probe.after && probe.observation === 'denied') &&
    evidence.namespaceStop === 'confirmed' ? 'native_boundary_passed' : 'incomplete';
}

function dummyAuth() {
  const token = randomBytes(16).toString('hex');
  const jwt = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.` +
    `${Buffer.from(JSON.stringify({ sub: `synthetic-${token}`, email: 'synthetic@example.invalid',
      exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account',
        chatgpt_plan_type: 'plus' } })).toString('base64url')}.synthetic`;
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: `synthetic-${token}`,
      account_id: 'synthetic-account' }, last_refresh: new Date().toISOString() });
}

export async function runLive(args) {
  requireLive(args);
  if (process.platform !== 'linux') throw Error('Linux protected runtime required');
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-real-native-boundary-'));
  const workspace = join(root, 'workspace'), project = join(root, 'project');
  const privateDir = join(root, 'control', 'private-git');
  const home = join(root, 'home');
  const sibling = join(root, 'held-sibling', 'assignment.txt');
  const oracle = join(root, 'held-oracle', 'answer.txt');
  const targets = [sibling, oracle];
  const bytes = targets.map(() => Buffer.from(`synthetic-${randomBytes(24).toString('hex')}\n`));
  const evidence = { completed: false, preflight: false, control: 'not_run', probes: [], transportClosed: false,
    namespaceStop: 'unconfirmed', rootRemoved: false };
  const report = { schema_version: 1, kind: 'real_protected_native_boundary', root,
    native_sha256: null, native_version: null, status: 'not_started', error_code: null, evidence };
  let transport, launch, captured;
  try {
    report.native_sha256 = sha(await readFile(NATIVE));
    const version = execFileSync(NATIVE, ['--version'], { encoding: 'utf8', timeout: 10_000,
      env: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }).trim();
    report.native_version = version === 'codex-cli 0.157.1' ? version : 'mismatch';
    if (report.native_sha256 !== HASH || report.native_version !== 'codex-cli 0.157.1') throw Object.assign(Error('Native mismatch'), { code: 'NATIVE_MISMATCH' });
    for (const path of [project, dirname(privateDir), home,
      ...targets.map(dirname)]) await mkdir(path, { recursive: true, mode: 0o700 });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'Passeur Fixture');
    git(project, 'config', 'user.email', 'passeur-fixture@example.invalid');
    git(project, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(project, 'allowed.txt'), CONTROL);
    git(project, 'add', '--', 'allowed.txt');
    git(project, 'commit', '-qm', 'test: native boundary baseline');
    const base = git(project, 'rev-parse', 'HEAD');
    const branch = `probe-${randomUUID()}`;
    git(project, 'worktree', 'add', '-q', '-b', branch, workspace, base);
    const view = await preparePrivateGitView(project, { kind: 'task_worktree', path: workspace,
      base_commit: base, branch: `refs/heads/${branch}` }, privateDir);
    const canonical = view.canonical_common_dir;
    const admin = join(canonical, view.admin_relative);
    if (git(project, 'remote') !== '') throw Object.assign(Error('Unexpected remote'), { code: 'REMOTE_PRESENT' });
    for (let index = 0; index < targets.length; index++) {
      await writeFile(targets[index], bytes[index], { mode: 0o600 });
      await symlink(targets[index], join(workspace, `held-${index}.link`));
    }
    await writeFile(join(home, 'auth.json'), dummyAuth(), { mode: 0o600 });
    await chmod(home, 0o700);
    const input = { workspace, request: { mode: 'implement' }, private_git: { schema_version: 1,
      mount_kind: 'canonical_common_dir', view } };
    const nativeArgs = ['-c', 'forced_login_method="chatgpt"', '-c', `default_permissions="${PROFILE}"`,
      '-c', 'model_provider="openai"', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false',
      '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.image_generation=false',
      '-c', 'web_search="disabled"', 'app-server'];
    launch = protectedLaunch(input, NATIVE, home, HOST, nativeArgs, undefined, undefined, false, true);
    transport = new CodexStdio({ command: launch.command, args: launch.args, cwd: workspace, env: launch.env,
      request: async () => { throw Error('Unexpected native request'); }, notification: () => {} });
    captured = await captureProtectedStartup(launch.statusFile, launch.nativePath, undefined, 'inherited');
    const signal = AbortSignal.timeout(25_000);
    const initialized = await transport.request('initialize', { clientInfo: { name: 'passeur_boundary_probe',
      title: 'Passeur boundary probe', version: '1' }, capabilities: { experimentalApi: true } }, signal);
    if (typeof initialized?.userAgent !== 'string') throw Error('Initialize response invalid');
    await transport.notify('initialized', undefined, signal);
    assertProtectedConfiguration(await transport.request('config/read', { includeLayers: true, cwd: workspace }, signal),
      PROFILE, false, { workspace, canonical, admin, native: NATIVE });
    assertProtectedProfile(await transport.request('permissionProfile/list', { cwd: workspace }, signal));
    assertEmptySkills(await transport.request('skills/list', { cwds: [workspace], forceReload: true }, signal), workspace);
    evidence.preflight = true;
    const controlReply = await transport.request('command/exec', commandRequest(join(workspace, 'allowed.txt'), workspace), signal);
    evidence.control = classifyRead(controlReply, join(workspace, 'allowed.txt'), '', true);
    if (evidence.control !== 'allowed') throw Object.assign(Error('Workspace control failed'), { code: 'CONTROL_FAILED' });
    for (const [route, index, path] of [
      ...targets.map((path, index) => ['direct', index, path]),
      ...targets.map((_, index) => ['symlink', index, join(workspace, `held-${index}.link`)]),
      ...targets.map((path, index) => ['proc', index, `/proc/self/root${path}`]),
    ]) {
      const target = targets[index], link = route === 'symlink';
      const before = await intact(link ? path : target, target, bytes[index], link);
      if (!before) { evidence.probes.push({ route, target: index, before, after: false, observation: 'uncertain' }); break; }
      const reply = await transport.request('command/exec', commandRequest(path, workspace), signal);
      const observation = classifyRead(reply, path, bytes[index].toString());
      const after = await intact(link ? path : target, target, bytes[index], link);
      evidence.probes.push({ route, target: index, before, after, observation });
      if (!after || observation !== 'denied') break;
    }
    if (evidence.probes.length === 6 && !(await Promise.all(targets.map(async (path, index) =>
      await intact(path, path, bytes[index]) &&
      await intact(join(workspace, `held-${index}.link`), path, bytes[index], true)))).every(Boolean)) {
      evidence.probes.at(-1).after = false;
    }
    evidence.completed = true;
  } catch (error) {
    report.error_code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'UNKNOWN';
  } finally {
    if (transport) evidence.transportClosed = await transport.close(15_000, 500);
    if (captured && launch) evidence.namespaceStop = await settleProtectedStop(captured, launch.statusFile, evidence.transportClosed);
    report.status = resultStatus(evidence);
    // Preserve every failed or uncertain fixture, even when its namespace stopped.
    if (report.status === 'native_boundary_passed' && evidence.namespaceStop === 'confirmed') {
      await rm(root, { recursive: true, force: true }); evidence.rootRemoved = true;
    }
    else await writeFile(join(root, 'bounded-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runLive(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'native_boundary_passed' ? 0 : 1;
}
