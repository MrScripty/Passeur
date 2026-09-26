import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedIds = Array.from({ length: 13 }, (_, index) => `L${String(index + 1).padStart(2, '0')}`);
const allowedPrograms = new Set(['cargo', 'rustc', 'node', 'python3', 'gcc', 'g++', 'dotnet',
  'java', 'javac', 'lua', 'luajit', 'kotlinc', 'kotlin', 'zig', 'odin', 'tsc']);
const deniedArguments = /(?:^|[/\\])(?:install|fetch|download|publish|restore)(?:$|[/\\])/i;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_MS = 20_000;
const MAX_CPU_MS = 60_000;
const MAX_RSS_BYTES = 2 * 1024 * 1024 * 1024;
const RESOURCE_SAMPLE_MS = 5;
const SANDBOX_PROGRAM = '/usr/bin/bwrap';
const SANDBOX_CHECK = '/usr/bin/true';
const NODE_MODULES_ROOT = join(projectRoot, 'node_modules');

export class QualificationError extends Error {
  constructor(code, message) { super(message); this.name = 'QualificationError'; this.code = code; }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
  !value.split(/[\\/]/).some(part => part === '..' || part === '' || part === '.') && !value.includes('\0');
const inside = (root, child) => {
  const path = resolve(root, child);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new QualificationError('MANIFEST_PATH', `Path escapes ${root}: ${child}`);
  return path;
};

async function fileInventory(root) {
  const result = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.set(path, sha256(await readFile(absolute)));
      else throw new QualificationError('UNSAFE_SOURCE', `Unsupported file type: ${path}`);
    }
  }
  await visit(root);
  return Object.fromEntries([...result].sort(([a], [b]) => a.localeCompare(b)));
}

export async function snapshotProtected(roots) {
  const snapshots = {};
  for (const [name, root] of Object.entries(roots)) {
    try { snapshots[name] = await fileInventory(root); }
    catch (error) {
      if (error.code === 'ENOENT') snapshots[name] = null;
      else throw error;
    }
  }
  return snapshots;
}

export function assertUnchanged(before, after) {
  for (const name of Object.keys(before)) {
    if (JSON.stringify(before[name]) !== JSON.stringify(after[name]))
      throw new QualificationError('PROTECTED_MUTATION', `Protected ${name} changed during qualification`);
  }
}

async function loadJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

export async function loadManifest(path) {
  const manifest = await loadJson(path);
  if (!isRecord(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.rows))
    throw new QualificationError('MANIFEST_SCHEMA', 'Expected fixture manifest schema_version 1 and rows array');
  const seen = new Set();
  for (const row of manifest.rows) {
    if (!isRecord(row) || !expectedIds.includes(row.id) || seen.has(row.id) || !safePath(row.root) ||
        !Array.isArray(row.sources) || !row.sources.length || !isRecord(row.build) ||
        !Array.isArray(row.runs) || !row.runs.length)
      throw new QualificationError('MANIFEST_SCHEMA', 'Each L01-L13 row needs a unique id, root, sources, build, and runs');
    if (!validIdentity(row.toolchain) || !validIdentity(row.entrypoint))
      throw new QualificationError('MANIFEST_SCHEMA', `${row.id} needs bounded toolchain and entrypoint identities`);
    seen.add(row.id);
    const paths = new Set();
    for (const source of row.sources) {
      if (!isRecord(source) || !safePath(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256) || paths.has(source.path))
        throw new QualificationError('MANIFEST_SCHEMA', `${row.id} source path/hash is invalid or duplicated`);
      paths.add(source.path);
    }
    const cases = new Set();
    for (const run of row.runs) {
      if (!isRecord(run) || typeof run.case_id !== 'string' || !run.case_id || cases.has(run.case_id))
        throw new QualificationError('MANIFEST_SCHEMA', `${row.id} run case id is invalid or duplicated`);
      if (!validInputArgv(run.input_argv))
        throw new QualificationError('MANIFEST_SCHEMA', `${row.id}/${run.case_id} needs nonempty input_argv`);
      cases.add(run.case_id);
      validateCommand(run, { rowId: row.id });
    }
    validateCommand(row.build, { build: true });
  }
  return manifest;
}

function validateCommand(command, { build = false, rowId } = {}) {
  if (!isRecord(command) || !Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 24 ||
      !command.argv.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 512 && !arg.includes('\0')) ||
      !safePath(command.cwd ?? '.') && command.cwd !== undefined ||
      command.timeout_ms !== undefined && (!Number.isInteger(command.timeout_ms) || command.timeout_ms < 1 || command.timeout_ms > MAX_COMMAND_MS))
    throw new QualificationError('MANIFEST_COMMAND', 'Command must be a bounded argv array and local cwd');
  // Only a build may declare one exact nonzero exit as unavailable evidence.
  // This never admits a run failure, a signal, or an output-budget failure.
  if (Object.hasOwn(command, 'blocked_exit_code') &&
      (!build || !Number.isInteger(command.blocked_exit_code) ||
       command.blocked_exit_code < 1 || command.blocked_exit_code > 255))
    throw new QualificationError('MANIFEST_COMMAND', 'blocked_exit_code must be a build-only integer from 1 to 255');
  // An inline dependency probe can catch a broken installed package and turn it
  // into an apparent missing-toolchain exit. A fixture build script must own 127.
  if (command.blocked_exit_code !== undefined && command.argv[0] === 'node' &&
      command.argv.some(arg => arg === '-e' || arg === '--eval' || arg.startsWith('--eval=')))
    throw new QualificationError('MANIFEST_COMMAND', 'blocked_exit_code requires a fixture build script, not inline evaluation');
  const program = command.argv[0];
  const localCompiledProgram = !build && (rowId === 'L09' || rowId === 'L10') &&
    /^\.\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(program);
  if (!(allowedPrograms.has(program) || localCompiledProgram) ||
      command.argv.some(arg => deniedArguments.test(arg)) ||
      command.argv.some(arg => /^(?:https?:|git\+|npm:|file:\/\/)/i.test(arg)))
    throw new QualificationError('MANIFEST_COMMAND', `Command is not an admitted local offline command: ${program}`);
}

const validInputArgv = value => Array.isArray(value) && value.length > 0 && value.length <= 24 &&
  value.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 512 && !arg.includes('\0'));

export function sandboxArguments(copy, cwd, argv, { rustToolchain } = {}) {
  const nodeInstall = dirname(dirname(process.execPath));
  const mounts = [];
  if (!nodeInstall.startsWith('/usr/')) mounts.push(nodeInstall);
  if (rustToolchain && !rustToolchain.startsWith('/usr/')) mounts.push(rustToolchain);
  const directories = new Set(['/etc', '/tmp', '/usr', '/usr/local']);
  for (const target of [...mounts, copy, join(copy, '.dotnet-runtime'), '/etc/ssl/certs']) {
    for (let parent = dirname(target); parent !== '/'; parent = dirname(parent)) {
      if (parent === '/usr' || parent.startsWith('/usr/')) break;
      directories.add(parent);
    }
  }
  const args = ['--unshare-net', '--unshare-pid', '--unshare-ipc', '--tmpfs', '/'];
  for (const directory of [...directories].sort((a, b) => a.length - b.length))
    args.push('--dir', directory);
  for (const directory of ['/usr/bin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/include', '/usr/share',
    '/usr/local/bin', '/usr/local/lib'])
    args.push('--ro-bind', directory, directory);
  args.push('--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind', '/etc/passwd', '/etc/passwd',
    '--ro-bind', '/etc/group', '/etc/group',
    '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
    '--ro-bind', '/etc/ssl/openssl.cnf', '/etc/ssl/openssl.cnf');
  for (const mount of mounts) args.push('--ro-bind', mount, mount);
  return [...args, '--proc', '/proc', '--dev', '/dev', '--bind', copy, copy,
    ...(existsSync(NODE_MODULES_ROOT) ? ['--ro-bind', NODE_MODULES_ROOT, join(copy, 'node_modules'),
      '--bind', join(copy, '.vite-temp'), join(copy, 'node_modules/.vite-temp')] : []),
    '--bind', join(copy, '.dotnet-runtime'), '/tmp/.dotnet',
    '--chdir', cwd, '--die-with-parent', '--new-session', '--', ...argv];
}

export function classifySandboxSetup(result) {
  if (result.resource_exceeded || result.resource_accounting_error)
    return { status: 'failed', reason: result.resource_exceeded ? 'resource_budget_exceeded' :
      'resource_accounting_failed', actual: result };
  return result.error || result.code !== 0 || result.signal || result.timed_out || result.overflow ?
    { status: 'blocked', reason: 'sandbox_setup_unavailable', actual: result } : { status: 'passed' };
}

function controlledEnvironment(copy) {
  const nodeBin = dirname(process.execPath);
  const env = {
    PATH: [join(copy, 'node_modules/.bin'), nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    HOME: copy, TMPDIR: copy, XDG_CACHE_HOME: join(copy, '.cache'),
    CARGO_NET_OFFLINE: 'true', CARGO_INCREMENTAL: '0', npm_config_offline: 'true',
    PIP_NO_INDEX: '1', PYTHONDONTWRITEBYTECODE: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
    DOTNET_CLI_HOME: join(copy, '.dotnet-home'), NUGET_PACKAGES: join(copy, '.nuget-packages'),
    DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(copy, '.dotnet-bundle'),
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', DOTNET_SDK_VULNERABILITY_CHECK_DISABLE: 'true',
    DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0',
    MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false'
  };
  return env;
}

export async function installedRustEnvironment(copy, {
  rustupHome = process.env.RUSTUP_HOME || join(homedir(), '.rustup'),
  systemDirectories = ['/usr/bin', '/usr/local/bin'] } = {}) {
  const trustedRustupToolchains = await realpath(join(homedir(), '.rustup', 'toolchains')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const selectedRustupToolchains = await realpath(join(rustupHome, 'toolchains')).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
    throw error;
  });
  const validatePair = async directory => {
    const paths = await Promise.all(['cargo', 'rustc'].map(async program => {
      const candidate = join(directory, program);
      if (!(await stat(candidate)).isFile()) return null;
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    }));
    if (paths.some(path => !path)) return null;
    const roots = paths.map(path => dirname(dirname(path)));
    if (roots[0] !== roots[1] ||
        !(roots[0] === '/usr' || roots[0].startsWith('/usr/local/') ||
          trustedRustupToolchains && roots[0].startsWith(`${trustedRustupToolchains}${sep}`) ||
          selectedRustupToolchains && roots[0].startsWith(`${selectedRustupToolchains}${sep}`))) return null;
    return { root: roots[0], rustc: paths[1] };
  };
  let pair;
  try {
    if (isAbsolute(rustupHome) && (await stat(rustupHome)).isDirectory()) {
      let toolchain = process.env.RUSTUP_TOOLCHAIN;
      if (!toolchain) {
        const settings = await readFile(join(rustupHome, 'settings.toml'), 'utf8');
        toolchain = /^default_toolchain\s*=\s*"([A-Za-z0-9][A-Za-z0-9_.-]{0,127})"\s*$/m.exec(settings)?.[1];
      }
      if (toolchain && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(toolchain)) {
        const root = await realpath(join(rustupHome, 'toolchains', toolchain));
        if (root.startsWith(`${await realpath(join(rustupHome, 'toolchains'))}${sep}`))
          pair = await validatePair(join(root, 'bin'));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
  }
  if (!pair) for (const directory of systemDirectories) {
    try { pair = await validatePair(directory); if (pair) break; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  }
  if (!pair) return null;
  return { toolchain: pair.root, env: { PATH: `${join(pair.root, 'bin')}${delimiter}${controlledEnvironment(copy).PATH}`,
    RUSTC: pair.rustc, RUSTFLAGS: '-C linker=gcc', CARGO_HOME: join(copy, '.cargo-home'),
    RUSTUP_HOME: join(copy, '.rustup-home') } };
}

let accountingUnits;
function kernelAccountingUnits() {
  if (accountingUnits) return accountingUnits;
  const getconf = name => {
    const result = spawnSync('/usr/bin/getconf', [name], { encoding: 'utf8', timeout: 1_000 });
    const value = Number(result.stdout?.trim());
    if (result.error || result.status !== 0 || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Cannot determine procfs accounting unit ${name}`);
    return value;
  };
  accountingUnits = { ticksPerSecond: getconf('CLK_TCK'), pageBytes: getconf('PAGESIZE') };
  return accountingUnits;
}

function processTreeUsage(rootPid, units) {
  const pending = [rootPid];
  const visited = new Set();
  let rssBytes = 0;
  let cpuTicks = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    let fields;
    try {
      const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
      fields = line.slice(line.lastIndexOf(') ') + 2).trim().split(/\s+/);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    const [userTicks, systemTicks, reapedUserTicks, reapedSystemTicks, residentPages] =
      [fields[11], fields[12], fields[13], fields[14], fields[21]].map(Number);
    if (![userTicks, systemTicks, reapedUserTicks, reapedSystemTicks, residentPages].every(Number.isSafeInteger))
      throw new Error(`Invalid procfs accounting for process ${pid}`);
    // cutime/cstime include children reaped since the previous sample. Count
    // each live process once; the parent's reaped ticks replace the departed
    // child's ticks rather than adding to an old per-PID observation.
    cpuTicks += userTicks + systemTicks + reapedUserTicks + reapedSystemTicks;
    rssBytes += residentPages * units.pageBytes;
    // Linux attributes a newly forked process to the thread that forked it.
    // Reading only task/<pid>/children misses descendants started by workers.
    let tasks;
    try { tasks = readdirSync(`/proc/${pid}/task`); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    for (const task of tasks) {
      try {
        const children = readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim();
        if (children) pending.push(...children.split(/\s+/).map(Number));
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      }
    }
  }
  const cpuMs = cpuTicks * 1_000 / units.ticksPerSecond;
  return { cpuMs, rssBytes };
}

// Linux retains waited-for child CPU in the monitor's cutime/cstime even after
// the child's proc entry disappears. This covers a whole tree reaped between
// live samples; the caller combines it with live usage using max, not addition.
export function waitedChildCpuMilliseconds() {
  const units = kernelAccountingUnits();
  const line = readFileSync('/proc/self/stat', 'utf8');
  const fields = line.slice(line.lastIndexOf(') ') + 2).trim().split(/\s+/);
  const userTicks = Number(fields[13]);
  const systemTicks = Number(fields[14]);
  if (![userTicks, systemTicks].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid procfs waited-child CPU accounting');
  if (!Number.isSafeInteger(userTicks + systemTicks))
    throw new Error('Invalid procfs waited-child CPU accounting');
  return (userTicks + systemTicks) * 1_000 / units.ticksPerSecond;
}

// The detached process owns one process group. Bubblewrap's private PID
// namespace contains descendants that change session; procfs accounting walks
// the full current tree, including CPU attributed to reaped children.
export function runBoundedProcess(program, argv, { cwd, env, timeout_ms = MAX_COMMAND_MS,
  max_cpu_ms = MAX_CPU_MS, max_rss_bytes = MAX_RSS_BYTES,
  resource_sample_ms = RESOURCE_SAMPLE_MS } = {}) {
  // /proc/self/stat counts every waited child of this monitor. Keep each
  // baseline-to-close interval exclusive among bounded calls so a concurrent
  // command cannot contribute to another command's terminal CPU delta.
  const run = boundedProcessTail.then(() => runBoundedProcessExclusive(program, argv,
    { cwd, env, timeout_ms, max_cpu_ms, max_rss_bytes, resource_sample_ms }));
  boundedProcessTail = run.then(() => undefined, () => undefined);
  return run;
}

let boundedProcessTail = Promise.resolve();

function runBoundedProcessExclusive(program, argv, { cwd, env, timeout_ms,
  max_cpu_ms, max_rss_bytes, resource_sample_ms }) {
  return new Promise(resolveResult => {
    let units;
    let waitedCpuBaselineMs;
    try {
      units = kernelAccountingUnits();
      waitedCpuBaselineMs = waitedChildCpuMilliseconds();
    }
    catch (error) { resolveResult({ resource_accounting_error: error.message }); return; }
    const child = spawn(program, argv, { cwd, env, detached: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [], bytes: 0, overflow: false };
    let timedOut = false;
    let resourceExceeded;
    let resourceAccountingError;
    let settled = false;
    let observedCpuMs = 0;
    // A caller can request faster sampling, but cannot widen the window in
    // which a short-lived process tree can exceed its CPU budget unseen.
    const sampleInterval = Math.max(1, Math.min(RESOURCE_SAMPLE_MS,
      Number.isFinite(resource_sample_ms) && resource_sample_ms > 0 ? resource_sample_ms : RESOURCE_SAMPLE_MS,
      max_cpu_ms / 4));
    const stopGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    const capture = key => chunk => {
      output.bytes += chunk.length;
      if (output.bytes > MAX_OUTPUT_BYTES) {
        output.overflow = true; stopGroup();
        child.stdout.destroy(); child.stderr.destroy();
      }
      else output[key].push(chunk);
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    const sampleResources = (terminate = true) => {
      if (!child.pid || resourceExceeded || resourceAccountingError) return;
      try {
        const usage = processTreeUsage(child.pid, units);
        observedCpuMs = Math.max(observedCpuMs, usage.cpuMs);
        resourceExceeded = observedCpuMs > max_cpu_ms ? 'cpu_time' :
          usage.rssBytes > max_rss_bytes ? 'rss' : undefined;
      } catch (error) { resourceAccountingError = error.message; }
      if (terminate && (resourceExceeded || resourceAccountingError)) {
        stopGroup();
        child.stdout.destroy(); child.stderr.destroy();
      }
    };
    const resourceTimer = setInterval(sampleResources, sampleInterval);
    const timer = setTimeout(() => {
      timedOut = true; stopGroup();
      // A child in another session may retain the inherited pipe descriptors.
      // The sandbox PID namespace owns its termination; close our pipe ends so
      // the observer still reaches a bounded result.
      child.stdout.destroy(); child.stderr.destroy();
    }, timeout_ms);
    child.on('error', error => {
      clearTimeout(timer); clearInterval(resourceTimer);
      if (!settled) { settled = true; resolveResult({ error: error.code ?? String(error) }); }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(resourceTimer);
      if (settled) return;
      // The process may still be visible briefly; take the final available
      // procfs observation before settling without signalling an exited group.
      sampleResources(false);
      try {
        const terminalCpuMs = waitedChildCpuMilliseconds() - waitedCpuBaselineMs;
        if (!Number.isFinite(terminalCpuMs) || terminalCpuMs < 0)
          throw new Error('Invalid terminal waited-child CPU delta');
        observedCpuMs = Math.max(observedCpuMs, terminalCpuMs);
        if (!resourceExceeded && observedCpuMs > max_cpu_ms) resourceExceeded = 'cpu_time';
      } catch (error) { resourceAccountingError = error.message; }
      settled = true;
      resolveResult({ code, signal, timed_out: timedOut, overflow: output.overflow,
        resource_exceeded: resourceExceeded, resource_accounting_error: resourceAccountingError,
        stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    });
  });
}

async function commandCwd(copy, command) {
  const cwd = inside(copy, command.cwd ?? '.');
  try {
    if (!(await stat(cwd)).isDirectory() || !inside(copy, relative(copy, await realpath(cwd))))
      throw new QualificationError('COMMAND_CWD', `Command cwd is not a copied directory: ${command.cwd}`);
    return cwd;
  } catch (error) {
    if (error.code === 'ENOENT') throw new QualificationError('COMMAND_CWD', `Missing command cwd: ${command.cwd ?? '.'}`);
    throw error;
  }
}

async function programAvailable(program, cwd, env) {
  const candidates = program.startsWith('./') ? [resolve(cwd, program)] :
    env.PATH.split(delimiter).map(directory => join(directory, program));
  for (const candidate of candidates) {
    try {
      if (program.startsWith('./') && !inside(cwd, relative(cwd, await realpath(candidate)))) continue;
      // The dependency tree is mounted over an empty copy-local directory only
      // after bwrap starts. Preflight the source corresponding to that mount.
      const installed = candidate === join(env.HOME, 'node_modules/.bin', program) ?
        join(NODE_MODULES_ROOT, '.bin', program) : candidate;
      if ((await stat(installed)).isFile()) { await access(installed, constants.X_OK); return true; }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  return false;
}

async function execute(command, copy, env, rustToolchain) {
  const cwd = await commandCwd(copy, command);
  const available = await programAvailable(command.argv[0], cwd, env);
  if (!available) return { error: 'ENOENT', argv: command.argv, cwd };
  return { ...await runBoundedProcess(SANDBOX_PROGRAM, sandboxArguments(copy, cwd, command.argv, { rustToolchain }),
    { cwd, env, timeout_ms: command.timeout_ms ?? MAX_COMMAND_MS }), argv: command.argv, cwd };
}

export function classifyCommand(result, expected) {
  if (result.resource_exceeded || result.resource_accounting_error)
    return { status: 'failed', reason: result.resource_exceeded ? 'resource_budget_exceeded' :
      'resource_accounting_failed', actual: result };
  if (result.error === 'ENOENT') return { status: 'failed', reason: 'run_executable_missing', actual: result };
  if (result.error) return { status: 'failed', reason: `spawn_error:${result.error}` };
  if (result.signal || result.overflow || result.timed_out) return { status: 'failed', reason: result.overflow ? 'output_budget_exceeded' : 'command_timeout_or_signal' };
  if (result.code !== (expected.exit_code ?? 0) || result.stdout !== expected.stdout ||
      result.stderr !== (expected.stderr ?? '')) return { status: 'failed', reason: 'exact_output_mismatch', actual: result };
  return { status: 'passed' };
}

export async function qualifyFixtureApps({ manifestPath = join(projectRoot, 'tests/fixture-apps/manifest.json'),
  oracleRoot = join(projectRoot, 'tests/oracles/fixture-apps'), appRoot = join(projectRoot, 'tests/fixture-apps'),
  runPreflight = runBoundedProcess } = {}) {
  const protectedRoots = { apps: appRoot, oracles: oracleRoot };
  const before = await snapshotProtected(protectedRoots);
  const results = [];
  let temporary;
  try {
    let manifest;
    try { manifest = await loadManifest(manifestPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { status: 'failed', rows: expectedIds.map(id => ({ id, status: 'failed', reason: 'manifest_missing' })) };
    }
    temporary = await mkdtemp(join(tmpdir(), 'passeur-fixture-qualification-'));
    for (const id of expectedIds) {
      const row = manifest.rows.find(item => item.id === id);
      if (!row) { results.push({ id, status: 'failed', reason: 'manifest_row_missing' }); continue; }
      const oraclePath = join(oracleRoot, `${id}.json`);
      let oracle;
      try { oracle = await loadJson(oraclePath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        results.push({ id, status: 'failed', reason: 'oracle_missing' }); continue;
      }
      if (!isRecord(oracle) || oracle.id !== id || !Array.isArray(oracle.functional) ||
          !oracle.functional.length || oracle.functional.some(item => !isRecord(item) ||
            typeof item.id !== 'string' || !item.id || !validInputArgv(item.argv) ||
            typeof item.stdout !== 'string' ||
            item.stderr !== undefined && typeof item.stderr !== 'string' ||
            item.exit_code !== undefined && !Number.isInteger(item.exit_code)) ||
          new Set(oracle.functional.map(item => item.id)).size !== oracle.functional.length)
        throw new QualificationError('ORACLE_SCHEMA', `${id} oracle needs nonempty unique functional cases with argv and exact output`);
      const cases = new Map(oracle.functional.map(item => [item.id, item]));
      if (row.runs.length !== cases.size || row.runs.some(run => {
        const expected = cases.get(run.case_id);
        return !expected || JSON.stringify(run.input_argv) !== JSON.stringify(expected.argv) ||
          JSON.stringify(run.argv.slice(-run.input_argv.length)) !== JSON.stringify(run.input_argv);
      })) {
        results.push({ id, status: 'failed', reason: 'functional_input_or_case_mismatch' }); continue;
      }
      const source = inside(appRoot, row.root);
      try { if (!(await lstat(source)).isDirectory()) throw new QualificationError('MANIFEST_PATH', `${id} root is not a directory`); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        results.push({ id, status: 'failed', reason: 'app_missing' }); continue;
      }
      const original = await fileInventory(source);
      const declared = Object.fromEntries(row.sources.map(item => [item.path, item.sha256]).sort(([a], [b]) => a.localeCompare(b)));
      if (JSON.stringify(original) !== JSON.stringify(declared)) {
        results.push({ id, status: 'failed', reason: 'source_manifest_hash_mismatch' }); continue;
      }
      const copy = join(temporary, `${id}-${basename(source)}`);
      await cp(source, copy, { recursive: true, force: false, errorOnExist: true });
      if (existsSync(NODE_MODULES_ROOT)) await mkdir(join(copy, 'node_modules'));
      if (existsSync(NODE_MODULES_ROOT)) await mkdir(join(copy, '.vite-temp'));
      await mkdir(join(copy, '.dotnet-runtime', 'shm'), { recursive: true });
      const env = controlledEnvironment(copy);
      let rustToolchain;
      if (row.build.argv[0] === 'cargo' || row.build.argv[0] === 'rustc') {
        const rust = await installedRustEnvironment(copy);
        if (!rust) {
          results.push({ id, status: 'blocked', reason: 'toolchain_unavailable', command: row.build.argv }); continue;
        }
        rustToolchain = rust.toolchain;
        Object.assign(env, rust.env);
        await mkdir(env.CARGO_HOME, { recursive: true });
        await mkdir(env.RUSTUP_HOME, { recursive: true });
      }
      let buildCwd;
      try { buildCwd = await commandCwd(copy, row.build); }
      catch (error) {
        if (error.code !== 'COMMAND_CWD') throw error;
        results.push({ id, status: 'failed', reason: 'build_cwd_missing', command: row.build.argv, detail: error.message }); continue;
      }
      if (!(await programAvailable(row.build.argv[0], buildCwd, env))) {
        results.push({ id, status: 'blocked', reason: 'toolchain_unavailable', command: row.build.argv }); continue;
      }
      const sandbox = await runPreflight(SANDBOX_PROGRAM,
        sandboxArguments(copy, buildCwd, [SANDBOX_CHECK], { rustToolchain }), { cwd: buildCwd, env, timeout_ms: 5_000 });
      const setup = classifySandboxSetup(sandbox);
      if (setup.status !== 'passed') { results.push({ id, ...setup }); continue; }
      const built = await execute(row.build, copy, env, rustToolchain);
      if (built.error) {
        results.push({ id, status: 'failed', reason: 'build_spawn_error', actual: built }); continue;
      }
      if (!built.signal && !built.overflow && !built.timed_out && !built.resource_exceeded &&
          !built.resource_accounting_error && built.code === row.build.blocked_exit_code) {
        results.push({ id, status: 'blocked', reason: 'declared_build_blocked_exit', actual: built }); continue;
      }
      if (built.code !== 0 || built.signal || built.overflow || built.timed_out ||
          built.resource_exceeded || built.resource_accounting_error) {
        results.push({ id, status: 'failed', reason: built.resource_exceeded ? 'resource_budget_exceeded' :
          built.resource_accounting_error ? 'resource_accounting_failed' : 'build_failed', actual: built }); continue;
      }
      const runs = [];
      for (const run of row.runs) {
        const expected = cases.get(run.case_id);
        try {
          runs.push({ case_id: run.case_id, ...classifyCommand(await execute(run, copy, env, rustToolchain), expected) });
        } catch (error) {
          if (error.code !== 'COMMAND_CWD') throw error;
          runs.push({ case_id: run.case_id, status: 'failed', reason: 'run_cwd_missing',
            command: run.argv, detail: error.message });
        }
      }
      if (runs.length !== cases.size || runs.some(item => !cases.has(item.case_id)))
        results.push({ id, status: 'failed', reason: 'functional_case_set_mismatch', runs });
      else results.push({ id, status: runs.some(item => item.status === 'failed') ? 'failed' :
        runs.some(item => item.status === 'blocked') ? 'blocked' : 'passed', runs });
    }
    return { status: results.some(item => item.status === 'failed') ? 'failed' :
      results.some(item => item.status === 'blocked') ? 'blocked' : 'passed', rows: results };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    assertUnchanged(before, await snapshotProtected(protectedRoots));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await qualifyFixtureApps();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'blocked' ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${error.code ?? 'QUALIFICATION_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
