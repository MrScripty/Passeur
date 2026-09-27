#!/usr/bin/env node
// Disposable, no-account transport probe. The guest path runs only inside Bubblewrap.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, readdir, symlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';

const VERSION = '1.4.0-R4302.1';
const NATIVE_SHA256 = 'ad21c22965f8600b4473b4ab8354ff7cc483d4cb681b46f2952561d855c8ed86';
const SDK_VERSION = '1.3.0';
const NODE_VERSION = 'v24.12.0';
const NODE_SHA256 = '16143bdaa79716e871d3d9b2f50ce680bca293eba7f0c3fc1d004ed2258fc839';
const MODEL = 'fixture-transport-only';
const LIMIT = 65_536;
const DEADLINE_MS = 25_000;
const GUEST_RUNTIME = '/mounts/runtime';
const GUEST_HOME = '/mounts/home';

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function timeout(stage, promise, ms = DEADLINE_MS) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault('PROBE_DEADLINE', `${stage} exceeded ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function pinnedBinary(muse, { canonicalize = realpath, hash = digest } = {}) {
  const launcher = await canonicalize(muse);
  const native = join(dirname(launcher), `muse-bin-${VERSION}`);
  if (await canonicalize(native) !== native || await hash(native) !== NATIVE_SHA256) {
    throw fault('NATIVE_BINARY_MISMATCH', 'installed Muse binary path or digest differs from pinned identity');
  }
  return native;
}

export async function pinnedNode(executable = process.execPath, {
  canonicalize = realpath, hash = digest, version = process.version,
} = {}) {
  if (version !== NODE_VERSION) throw fault('NODE_BINARY_MISMATCH', 'host Node version differs from pinned guest runtime');
  const node = await canonicalize(executable);
  if (node !== executable || await hash(node) !== NODE_SHA256) {
    throw fault('NODE_BINARY_MISMATCH', 'host Node path or digest differs from pinned guest runtime');
  }
  return node;
}

export function guestEnvironment() {
  return { HOME: GUEST_HOME, XDG_CONFIG_HOME: `${GUEST_HOME}/.config`,
    XDG_DATA_HOME: `${GUEST_HOME}/.local/share`, XDG_CACHE_HOME: `${GUEST_HOME}/.cache`,
    TMPDIR: '/tmp', PATH: '/usr/bin:/bin', MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8' };
}

export function sandboxConfig({ workspace, runtime, home, protectedRoot }) {
  return { workspace, preserveWorkspacePath: true, denied: [protectedRoot], mounts: [
    { source: runtime, target: GUEST_RUNTIME, mode: 'ro' },
    { source: home, target: GUEST_HOME, mode: 'rw' },
  ] };
}

export function guestCommand() {
  return [`${GUEST_RUNTIME}/node`, `${GUEST_RUNTIME}/qualify-muse-sandbox-transport.mjs`, '--guest'];
}

export function assertPortSeparation(hostPort, guestPort) {
  if (!Number.isSafeInteger(hostPort) || !Number.isSafeInteger(guestPort) ||
      hostPort < 1 || guestPort < 1 || hostPort > 65535 || guestPort > 65535 || hostPort === guestPort) {
    throw fault('PORT_SEPARATION_INVALID', 'host sentinel and guest provider require distinct valid ports');
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function startHostSentinel() {
  const nonce = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16);
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/sentinel' ? 200 : 404, { 'content-type': 'text/plain' });
    response.end(request.url === '/sentinel' ? nonce : 'missing');
  });
  const port = await listen(server);
  return { port, nonce, close: () => close(server) };
}

export async function startGuestProvider(forbiddenPort) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    let body = '';
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > LIMIT) throw fault('REQUEST_TOO_LARGE', 'fixture request exceeds limit');
        body += chunk;
      }
    } catch {
      response.writeHead(413).end();
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* catalog GET has no JSON body */ }
    requests.push({ method: request.method, path: request.url, bytes,
      directMarker: request.url === '/responses' && parsed?.input === 'transport only' });
    if (request.method === 'GET' && request.url === '/muse-code/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', metadata: {
        'muse-code': { release_date: '2026-01-01', is_hidden: false,
          limit: { context: 1_000_000, output: 1024 } },
      } }] }));
    } else if (request.method === 'POST' && request.url === '/responses') {
      // Direct client text only. A native model turn is never submitted by this probe.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp_transport', object: 'response', model: MODEL,
        status: 'completed', output: [{ type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: 'Fixture transport only.' },
        ] }] }));
    } else {
      response.writeHead(501, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unsupported fixture path' } }));
    }
  });
  const port = await listen(server);
  try { assertPortSeparation(forbiddenPort, port); }
  catch (error) { await close(server); throw error; }
  return { port, requests, close: () => close(server) };
}

export async function tcpProbe(address, port, ms = 700) {
  return new Promise(resolveResult => {
    const socket = connect({ host: address, port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolveResult(value); };
    socket.once('connect', () => finish({ kind: 'connected' }));
    socket.once('error', error => finish({ kind: 'error', code: error.code ?? 'UNKNOWN' }));
    socket.setTimeout(ms, () => finish({ kind: 'timeout' }));
  });
}

export function classifyNoRoute(probe) {
  return probe.kind === 'error' && ['ENETUNREACH', 'EHOSTUNREACH'].includes(probe.code);
}

export function loopbackReady(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return false;
  const line = result.stdout.trim();
  return /^\d+: lo: <[^>]*\bLOOPBACK\b[^>]*\bUP\b[^>]*>/.test(line) ||
    /^\d+: lo: <[^>]*\bUP\b[^>]*\bLOOPBACK\b[^>]*>/.test(line);
}

export function assertNoTurn(commands, requests) {
  const allowed = commands[0] === 'session/resume' ? ['session/resume', 'session/read'] : ['session/start', 'session/read'];
  if (commands.length !== 2 || commands.some((value, index) => value !== allowed[index]) ||
      requests.some(({ method, path }) => method === 'POST' && path === '/responses')) {
    throw fault('UNEXPECTED_TURN', 'native command or provider request exceeded idle metadata allowlist');
  }
}

export function validateIdleRead(started, read, workspace, home) {
  const id = started?.session?.sessionId;
  const session = read?.session;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      started.session.workspaceRoot !== workspace || session?.sessionId !== id ||
      session?.workspaceRoot !== workspace || session?.activeTurnId !== null || session?.turnCount !== 0 ||
      session?.status !== 'idle' || !Array.isArray(read.pendingRequests) || read.pendingRequests.length !== 0 ||
      read.history?.mode !== 'none' || read.history?.noneReason !== 'excluded' ||
      read.history?.items !== null || read.history?.snapshot !== null ||
      typeof read.viewCursor !== 'string' || typeof session?.path !== 'string' ||
      !session.path.startsWith(`${home}/`)) {
    throw fault('INVALID_SESSION_READ', 'session/read did not return matching idle durable metadata');
  }
  return { sessionId: id, workspaceRoot: workspace, status: session.status,
    durableLogPath: session.path, turnCount: session.turnCount, activeTurnId: session.activeTurnId,
    pendingCount: read.pendingRequests.length, history: read.history.mode, viewCursor: read.viewCursor };
}

function procIdentity(stat) {
  const pid = Number(/^([1-9]\d*) \(/.exec(stat)?.[1]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group) ||
      !Number.isSafeInteger(session) || !/^\d+$/.test(start ?? '')) {
    throw fault('NATIVE_IDENTITY_UNVERIFIED', 'native PID marker or live process stat was invalid');
  }
  return { pid, group, session, start, state: fields[0] };
}

export async function verifiedNativeNamespace(home, native, guestNamespace, {
  read = readFile, link = readlink, canonicalize = realpath,
} = {}) {
  const marker = procIdentity(await read(join(home, 'native.stat'), 'utf8'));
  const live = procIdentity(await read(`/proc/${marker.pid}/stat`, 'utf8'));
  const markerNamespace = (await read(join(home, 'native.netns'), 'utf8')).trim();
  const currentNamespace = await link(`/proc/${marker.pid}/ns/net`);
  const executable = await link(`/proc/${marker.pid}/exe`);
  if (marker.pid !== live.pid || marker.start !== live.start ||
      live.state === 'Z' || live.state === 'X' || live.group !== live.pid || live.session !== live.pid ||
      marker.group !== marker.pid || marker.session !== marker.pid ||
      markerNamespace !== guestNamespace || currentNamespace !== guestNamespace ||
      executable !== await canonicalize(native)) {
    throw fault('NATIVE_IDENTITY_UNVERIFIED', 'native birth, process group, executable or namespace changed after wrapper exec');
  }
  return { pid: live.pid, start: live.start, group: live.group, session: live.session,
    namespace: currentNamespace, executable };
}

async function prepareSessions(home) {
  const made = [];
  let path = home;
  for (const part of ['.local', 'share', 'muse', 'sessions']) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 });
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o7777) !== 0o700) {
      throw fault('SESSION_DIRECTORY_INVALID', 'guest session directory owner/mode mismatch');
    }
    made.push(relative(home, path));
  }
  if ((await readdir(path)).length !== 0) throw fault('SESSION_DIRECTORY_INVALID', 'sessions directory is not empty');
  return made;
}

async function pathAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return true; throw error; }
}

export async function canaryChecks(protectedRoot, workspace, token) {
  const direct = join(protectedRoot, token);
  const linked = join(workspace, 'protected-link');
  const proc = `/proc/1/root${direct}`;
  return { directAbsent: await pathAbsent(direct), symlinkAbsent: await pathAbsent(join(linked, token)),
    procAbsent: await pathAbsent(proc) };
}

export async function guestRun(config) {
  const { spawnMspConnection } = await import(pathToFileURL(`${GUEST_RUNTIME}/sdk/dist/src/index.js`).href);
  const env = guestEnvironment();
  const workspace = config.workspace;
  const hostPort = config.hostPort;
  const native = `${GUEST_RUNTIME}/muse-bin-${VERSION}`;
  const namespace = await readlink('/proc/self/ns/net');
  const loopback = spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'], { encoding: 'utf8', timeout: 2_000 });
  if (!loopbackReady(loopback)) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback was not observed UP');
  const provider = await startGuestProvider(hostPort);
  let host;
  const commands = [];
  let stage = 'network';
  try {
    const sentinel = await tcpProbe('127.0.0.1', hostPort);
    const external = await tcpProbe('203.0.113.1', 443);
    if (sentinel.kind === 'connected' || !classifyNoRoute(external)) {
      throw fault('NETWORK_BOUNDARY_UNVERIFIED', 'guest loopback or numeric no-route condition was not established');
    }
    stage = 'canaries';
    const canaries = await canaryChecks(config.protectedRoot, workspace, config.canaryToken);
    if (Object.values(canaries).some(value => value !== true)) throw fault('PROTECTED_CANARY_VISIBLE', 'protected canary visible inside guest');
    stage = 'sessions';
    const sessionDirectories = config.phase === 'resume' ? [] : await prepareSessions(GUEST_HOME);
    const settings = join(GUEST_HOME, '.config', 'muse');
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'settings.json'), `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${provider.port}`, auth: 'bearer' } })}\n`, { mode: 0o600 });
    await writeFile(join(settings, 'auth.json'), `${JSON.stringify({ schema_version: 1,
      providers: { meta: { api_key: 'passeur-disposable-dummy-key' } } })}\n`, { mode: 0o600 });
    stage = 'host_initialize';
    host = spawnMspConnection({ command: `${GUEST_RUNTIME}/native-host-wrapper`, args: ['serve'], cwd: workspace, env,
      shutdownTimeoutMs: 2_000, onStderr: () => undefined });
    const initialized = await timeout('initialize', host.initialize({ clientInfo: {
      name: 'passeur_guest_transport_probe', version: '0.1.0',
    } }));
    const nativeIdentity = await verifiedNativeNamespace(GUEST_HOME, native, namespace);
    const nativeNamespace = nativeIdentity.namespace;
    stage = config.phase === 'resume' ? 'session_resume' : 'session_start';
    commands.push(config.phase === 'resume' ? 'session/resume' : 'session/start');
    const started = config.phase === 'resume'
      ? await timeout('session/resume', initialized.connection.command('session/resume',
        { sessionId: config.sessionId, excludeItems: true }, { maxAttempts: 1 }))
      : await timeout('session/start', initialized.connection.command('session/start',
        { workspaceRoot: workspace }, { maxAttempts: 1 }));
    const resumeMetadata = config.phase === 'resume'
      ? validateIdleRead(started, started, workspace, GUEST_HOME) : null;
    if (resumeMetadata && (resumeMetadata.sessionId !== config.sessionId ||
        resumeMetadata.durableLogPath !== config.logPath)) {
      throw fault('RESUME_IDENTITY_INVALID', 'resume envelope differs from original durable session');
    }
    stage = 'session_read';
    commands.push('session/read');
    const read = await timeout('session/read', initialized.connection.command('session/read',
      { sessionId: started?.session?.sessionId, excludeItems: true }, { maxAttempts: 1 }));
    const metadata = validateIdleRead(started, read, workspace, GUEST_HOME);
    const log = await realpath(metadata.durableLogPath);
    if (!log.startsWith(`${await realpath(GUEST_HOME)}/`) || !(await lstat(log)).isFile()) {
      throw fault('INVALID_SESSION_READ', 'durable log path escaped private guest HOME');
    }
    if (config.phase === 'resume') {
      if (metadata.sessionId !== config.sessionId || metadata.durableLogPath !== config.logPath) {
        throw fault('RESUME_IDENTITY_INVALID', 'resumed session or durable log differs from first host');
      }
      assertNoTurn(commands, provider.requests);
    } else assertNoTurn(commands, provider.requests);
    if (!provider.requests.some(request => request.method === 'GET' && request.path === '/muse-code/models')) {
      throw fault('NATIVE_CATALOG_MISSING', 'native host did not request guest catalog');
    }
    if (config.phase === 'resume') {
      const result = { kind: 'guest_resume_observed', stage, guestNamespace: namespace, nativeNamespace,
        nativeIdentity, hostPort, guestPort: provider.port, sentinel, external, canaries,
        sessionDirectories, metadata, resumeMetadata, nativeCatalogGet: true,
        commands, providerRequests: provider.requests };
      process.stdout.write(`${JSON.stringify({ kind: 'guest_ready', result })}\n`);
      if (await timeout('host release', config.release()) !== 'release') {
        throw fault('HOST_RELEASE_INVALID', 'resume host release was not authorized');
      }
      return result;
    }
    stage = 'direct_responses';
    const direct = await timeout('direct /responses', fetch(`http://127.0.0.1:${provider.port}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'transport only', tools: [] }),
    }));
    const directBody = await direct.json();
    if (direct.status !== 200 || directBody.id !== 'resp_transport' ||
        directBody.output?.[0]?.content?.[0]?.text !== 'Fixture transport only.') {
      throw fault('DIRECT_RESPONSE_INVALID', 'direct guest response fixture returned unexpected text response');
    }
    const responseRequests = provider.requests.filter(request => request.path === '/responses');
    if (responseRequests.length !== 1 || responseRequests[0].method !== 'POST' ||
        responseRequests[0].directMarker !== true) {
      throw fault('DIRECT_RESPONSE_ATTRIBUTION_INVALID', 'provider Responses request did not match the one direct client call');
    }
    const result = { kind: 'guest_transport_observed', stage, guestNamespace: namespace, nativeNamespace,
      nativeIdentity,
      hostPort, guestPort: provider.port, sentinel, external, canaries, sessionDirectories,
      metadata, nativeCatalogGet: true, directResponses: { attribution: 'direct_guest_client_text_only', status: direct.status },
      nativeTurnSubmitted: false, commands, providerRequests: provider.requests };
    if (config.phase === 'first') {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_ready', result })}\n`);
      if (await timeout('host release', config.release()) !== 'release') {
        throw fault('HOST_RELEASE_INVALID', 'first host release was not authorized');
      }
    }
    return result;
  } catch (error) {
    return { kind: 'guest_transport_error', stage, code: error.code ?? error.name,
      message: String(error.message).slice(0, 500), guestNamespace: namespace,
      hostPort, guestPort: provider.port, commands, providerRequests: provider.requests };
  } finally {
    try { if (host) await timeout('host close', host.close(), 5_000); } catch { /* stop remains unverified */ }
    try { await provider.close(); } catch { /* host retains fixture */ }
  }
}

async function runCaptured(command, args, { input = '', budgetMs = DEADLINE_MS } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let output = '';
    let errorOutput = '';
    let overflow = false;
    let timedOut = false;
    let hardStop;
    const stop = () => {
      child.kill('SIGTERM');
      hardStop ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, budgetMs);
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > LIMIT) { overflow = true; stop(); }
      return next.slice(0, LIMIT);
    };
    child.stdout.on('data', chunk => { output = append(output, chunk); });
    child.stderr.on('data', chunk => { errorOutput = append(errorOutput, chunk); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardStop);
      resolveResult({ code: null, error: error.code ?? error.name, output, errorOutput }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(hardStop);
      resolveResult({ code, signal, timedOut, overflow, output, errorOutput });
    });
    child.stdin.end(input);
  });
}

export async function stageRuntime(root, muse, { copy = copyFile, copyTree = cp,
  resolveBinary = pinnedBinary, resolveNode = pinnedNode, hash = digest } = {}) {
  const native = await resolveBinary(muse);
  const runtime = join(root, 'runtime');
  const packageRoot = resolve('node_modules/@muse-code/sdk');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== SDK_VERSION || packageJson.engines?.node !== '>=20' ||
      Object.keys(packageJson.dependencies ?? {}).length !== 0) {
    throw fault('SDK_MISMATCH', 'local SDK version or runtime dependency set differs from pinned package');
  }
  await mkdir(join(runtime, 'sdk'), { recursive: true, mode: 0o700 });
    await copy(fileURLToPath(import.meta.url), join(runtime, 'qualify-muse-sandbox-transport.mjs'));
    await copy(resolve('scripts/experiment-worker-sandbox.mjs'), join(runtime, 'experiment-worker-sandbox.mjs'));
  await copyTree(join(packageRoot, 'dist'), join(runtime, 'sdk', 'dist'), { recursive: true });
  await copy(join(packageRoot, 'package.json'), join(runtime, 'sdk', 'package.json'));
  await copy(native, join(runtime, `muse-bin-${VERSION}`));
  await writeFile(join(runtime, 'native-host-wrapper'), `#!/bin/sh\nset -eu\ncat /proc/$$/stat > ${GUEST_HOME}/native.stat\nreadlink /proc/$$/ns/net > ${GUEST_HOME}/native.netns\nexec ${GUEST_RUNTIME}/muse-bin-${VERSION} "$@"\n`, { mode: 0o700 });
  if (await hash(join(runtime, `muse-bin-${VERSION}`)) !== NATIVE_SHA256) {
    throw fault('NATIVE_BINARY_MISMATCH', 'staged Muse binary digest differs from pinned identity');
  }
  const node = await resolveNode();
  await copy(node, join(runtime, 'node'));
  const stagedNode = join(runtime, 'node');
  const nodeEntry = await lstat(stagedNode);
  if (await hash(stagedNode) !== NODE_SHA256 ||
      !nodeEntry.isFile() || (nodeEntry.mode & 0o111) === 0) {
    throw fault('NODE_BINARY_MISMATCH', 'staged Node binary digest, type or executable mode differs from pinned identity');
  }
  return runtime;
}

export function retainHostRoot(hostStarted) { return hostStarted; }

function hostStat(raw) {
  const identity = procIdentity(raw);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  if (!Number.isSafeInteger(parent)) throw fault('STOP_IDENTITY_INVALID', 'process parent was invalid');
  return { ...identity, parent };
}

async function processIdentity(pid, boot) {
  const base = `/proc/${pid}`;
  const [stat, exe, pidns, netns, status] = await Promise.all([
    readFile(`${base}/stat`, 'utf8'), readlink(`${base}/exe`), readlink(`${base}/ns/pid`),
    readlink(`${base}/ns/net`), readFile(`${base}/status`, 'utf8'),
  ]);
  const identity = hostStat(stat);
  if (identity.pid !== pid || ['Z', 'X'].includes(identity.state)) throw fault('STOP_IDENTITY_INVALID', 'process identity changed');
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (!nspid?.length || nspid.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw fault('STOP_IDENTITY_INVALID', 'namespace PID mapping was unavailable');
  }
  return { ...identity, boot, exe, pidns, netns, nspid };
}

export function parseBubblewrapStatus(lines) {
  const known = { child: null, exit: null };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { throw fault('BWRAP_STATUS_INVALID', 'malformed Bubblewrap status JSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw fault('BWRAP_STATUS_INVALID', 'invalid Bubblewrap status event');
    if (Object.hasOwn(event, 'child-pid')) {
      if (known.child !== null || !Number.isSafeInteger(event['child-pid']) || event['child-pid'] < 1 || known.exit !== null) {
        throw fault('BWRAP_STATUS_INVALID', 'duplicate or invalid Bubblewrap child PID');
      }
      known.child = event['child-pid'];
    }
    if (Object.hasOwn(event, 'exit-code')) {
      if (known.child === null || known.exit !== null || !Number.isSafeInteger(event['exit-code']) || event['exit-code'] < 0) {
        throw fault('BWRAP_STATUS_INVALID', 'duplicate or invalid Bubblewrap exit code');
      }
      known.exit = event['exit-code'];
    }
  }
  return known;
}

async function namespaceMembers(pidns, boot) {
  const entries = await readdir('/proc');
  const members = [];
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let namespace;
    try { namespace = await readlink(`/proc/${entry}/ns/pid`); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw fault('STOP_SCAN_INCOMPLETE', `PID namespace scan could not inspect ${entry}: ${error.code ?? error.name}`); }
    if (namespace === pidns) {
      try { members.push(await processIdentity(Number(entry), boot)); }
      catch (error) { throw fault('STOP_SCAN_INCOMPLETE', `namespace member ${entry} could not be inspected: ${error.code ?? error.name}`); }
    }
  }
  return members;
}

export async function captureHostIdentities(wrapperPid, childPid, nativeStart, nativeExe, supervisorExe) {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const wrapper = await processIdentity(wrapperPid, boot);
  const statusChild = await processIdentity(childPid, boot);
  if (statusChild.pidns === wrapper.pidns || statusChild.netns === wrapper.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child is not in the new namespaces');
  }
  const fd = await open(`/proc/${statusChild.pid}/ns/pid`, 'r');
  try {
    const pinned = await readlink(`/proc/self/fd/${fd.fd}`);
    if (pinned !== statusChild.pidns) throw fault('STOP_ASSOCIATION_INVALID', 'held namespace descriptor differs');
    const members = await namespaceMembers(pinned, boot);
    const { init, supervisor, native } = assertHostAssociation(wrapper, statusChild, members,
      nativeStart, nativeExe, supervisorExe);
    return { fd, boot, wrapper, statusChild, supervisor, init, native, members, pidns: pinned };
  } catch (error) { await fd.close(); throw error; }
}

export function assertHostAssociation(wrapper, statusChild, members, nativeStart, nativeExe, supervisorExe) {
  if (statusChild.pidns === wrapper.pidns || statusChild.netns === wrapper.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child is not in the new namespaces');
  }
  const init = members.filter(member => member.nspid?.at(-1) === 1);
  const native = members.filter(member => member.exe === nativeExe && member.start === nativeStart);
  const supervisor = members.filter(member => member.exe === supervisorExe);
  const observedChild = members.find(member => member.pid === statusChild.pid);
  if (init.length !== 1 || init[0].parent !== wrapper.pid || native.length !== 1 ||
      supervisor.length !== 1 || native[0].netns !== supervisor[0].netns ||
      !observedChild || observedChild.start !== statusChild.start ||
      observedChild.parent !== statusChild.parent || observedChild.exe !== statusChild.exe ||
      observedChild.pidns !== statusChild.pidns || observedChild.netns !== statusChild.netns) {
    throw fault('STOP_ASSOCIATION_INVALID', 'unique namespace init, supervisor or native was absent');
  }
  const byPid = new Map(members.map(member => [member.pid, member]));
  const descendsFrom = (process, target) => {
    let ancestor = process;
    const seen = new Set();
    while (ancestor.pid !== target.pid && byPid.has(ancestor.parent) && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid);
      ancestor = byPid.get(ancestor.parent);
    }
    return ancestor.pid === target.pid;
  };
  if (!descendsFrom(statusChild, init[0]) || !descendsFrom(supervisor[0], init[0]) ||
      !descendsFrom(native[0], supervisor[0])) {
    throw fault('STOP_ASSOCIATION_INVALID', 'Bubblewrap child or native ancestry differs from namespace init');
  }
  return { init: init[0], supervisor: supervisor[0], native: native[0] };
}

export async function verifyHostStop(capture, status, exit, {
  bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  scan = namespaceMembers,
} = {}) {
  const boot = await bootId();
  if (boot !== capture.boot) throw fault('STOP_IDENTITY_INVALID', 'host boot changed during diagnostic');
  if (status.child !== capture.statusChild.pid || status.exit !== 0 || exit.code !== 0 || exit.signal !== null ||
      exit.timedOut || exit.overflow || !exit.statusClosed) {
    throw fault('STOP_STATUS_INVALID', 'Bubblewrap status, closure or wrapper exit did not confirm clean stop');
  }
  for (const observed of [capture.wrapper, ...capture.members]) {
    let stat;
    try { stat = hostStat(await readStat(observed.pid)); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    if (stat.start !== observed.start) throw fault('STOP_PID_REUSED', `observed PID ${observed.pid} was reused`);
    throw fault('STOP_SURVIVOR', `observed PID ${observed.pid} remains present`);
  }
  if ((await scan(capture.pidns, boot)).length !== 0) {
    throw fault('STOP_SURVIVOR', 'a process remains in the held PID namespace');
  }
  return { kind: 'confirmed', boot, pidns: capture.pidns, observed: capture.members.length + 1 };
}

function runStatusPhase(prepared, config) {
  const separator = prepared.args.indexOf('--');
  if (separator < 0) throw fault('BWRAP_STATUS_INVALID', 'prepared sandbox lacks command delimiter');
  const args = [...prepared.args.slice(0, separator), '--json-status-fd', '3', ...prepared.args.slice(separator)];
  const child = spawn(prepared.executable, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {} });
  const output = [];
  const statusLines = [];
  let stderr = '';
  let statusClosed = false;
  let overflow = false;
  let timedOut = false;
  let readyResolve;
  let readyReject;
  let statusResolve;
  let statusReject;
  let released = false;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const liveStatus = new Promise((resolveStatus, rejectStatus) => { statusResolve = resolveStatus; statusReject = rejectStatus; });
  // Both promises have consumers from construction, including on early spawn failure.
  ready.catch(() => undefined);
  liveStatus.catch(() => undefined);
  const append = (array, line) => {
    array.push(line);
    if (Buffer.byteLength(array.join('\n')) > LIMIT) { overflow = true; child.kill('SIGTERM'); }
  };
  for (const stream of [child.stdout, child.stdio[3]]) {
    let bytes = 0;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > LIMIT) { overflow = true; stream.destroy(); child.kill('SIGTERM'); }
    });
  }
  createInterface({ input: child.stdout }).on('line', line => {
    append(output, line);
    if (['first', 'resume'].includes(config.phase) && output.length === 1) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind !== 'guest_ready' || parsed.result?.kind !==
            (config.phase === 'first' ? 'guest_transport_observed' : 'guest_resume_observed')) {
          throw fault('GUEST_OUTPUT_INVALID', 'first phase readiness was invalid');
        }
        readyResolve(parsed.result);
      } catch (error) { readyReject(error); }
    }
  });
  createInterface({ input: child.stdio[3] }).on('line', line => {
    append(statusLines, line);
    try { const status = parseBubblewrapStatus(statusLines); if (status.child) statusResolve(status); }
    catch (error) { statusReject(error); }
  });
  child.stdio[3].on('end', () => { statusClosed = true; });
  child.stderr.on('data', chunk => {
    if (Buffer.byteLength(stderr) + chunk.length > LIMIT) { overflow = true; child.kill('SIGTERM'); }
    stderr = (stderr + chunk.toString()).slice(0, LIMIT);
  });
  child.stdin.on('error', () => { /* child completion reports the failed phase */ });
  child.stdin.write(`${JSON.stringify(config)}\n`);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref(); }, DEADLINE_MS);
  const finished = new Promise(resolveResult => {
    child.once('error', error => {
      clearTimeout(timer);
      readyReject(error);
      statusReject(error);
      resolveResult({ code: null, signal: null, error: error.code ?? error.name, timedOut, overflow,
        output, stderr, statusLines, statusClosed });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (output.length === 0) readyReject(fault('GUEST_OUTPUT_INVALID', 'phase exited before readiness'));
      if (statusLines.length === 0) statusReject(fault('BWRAP_STATUS_INVALID', 'Bubblewrap exited without status'));
      resolveResult({ code, signal, timedOut, overflow, output, stderr, statusLines, statusClosed });
    });
  });
  return { pid: child.pid, ready: timeout('host readiness', ready),
    liveStatus: timeout('live Bubblewrap status', liveStatus),
    statusLines: () => [...statusLines],
    release: () => { if (!released) { released = true; child.stdin.end('release\n'); } }, finished };
}

function validatePhaseOutcome(phase, guest) {
    const requests = guest?.providerRequests;
    const canaries = guest?.canaries;
    if (guest?.kind !== (phase === 'first' ? 'guest_transport_observed' : 'guest_resume_observed') ||
        typeof guest.guestNamespace !== 'string' || !/^net:\[\d+\]$/.test(guest.guestNamespace) ||
        guest.nativeNamespace !== guest.guestNamespace ||
        !['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(guest.sentinel?.code) ||
        guest.sentinel?.kind !== 'error' || !classifyNoRoute(guest.external) ||
        !Number.isSafeInteger(guest.hostPort) || !Number.isSafeInteger(guest.guestPort) ||
        guest.hostPort < 1 || guest.guestPort < 1 || guest.hostPort === guest.guestPort ||
        !canaries || Object.keys(canaries).sort().join(',') !== 'directAbsent,procAbsent,symlinkAbsent' ||
        Object.values(canaries).some(value => value !== true) || guest.nativeCatalogGet !== true ||
        !Array.isArray(requests) || requests.filter(request =>
          request.method === 'GET' && request.path === '/muse-code/models').length < 1 ||
        typeof guest.metadata?.viewCursor !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guest.metadata?.sessionId ?? '') ||
        guest.metadata?.history !== 'none' || guest.metadata?.status !== 'idle' ||
        guest.metadata?.turnCount !== 0 || guest.metadata?.activeTurnId !== null ||
        guest.metadata?.pendingCount !== 0) {
      throw fault('PHASE_OUTCOME_INVALID', `${phase} guest boundary or catalog evidence invalid`);
    }
    if (requests.some(request => !(request.method === 'GET' && request.path === '/muse-code/models') &&
        !(phase === 'first' && request.method === 'POST' && request.path === '/responses' &&
          request.directMarker === true))) {
      throw fault('PHASE_OUTCOME_INVALID', `${phase} provider made an unallowed request`);
    }
    assertNoTurn(guest.commands, phase === 'first'
      ? requests.filter(request => request.path !== '/responses') : requests);
    if (phase === 'first' && (guest.commands[0] !== 'session/start' ||
        guest.directResponses?.attribution !== 'direct_guest_client_text_only' ||
        guest.directResponses.status !== 200 || guest.nativeTurnSubmitted !== false ||
        requests.filter(request => request.path === '/responses').length !== 1)) {
      throw fault('PHASE_OUTCOME_INVALID', 'first phase direct-client attribution invalid');
    }
    if (phase === 'resume' && (guest.commands[0] !== 'session/resume' ||
        requests.some(request => request.path === '/responses'))) {
      throw fault('PHASE_OUTCOME_INVALID', 'resume phase made an unallowed provider request');
    }
    if (phase === 'resume' && (!guest.resumeMetadata ||
        guest.resumeMetadata.sessionId !== guest.metadata.sessionId ||
        guest.resumeMetadata.workspaceRoot !== guest.metadata.workspaceRoot ||
        guest.resumeMetadata.durableLogPath !== guest.metadata.durableLogPath ||
        guest.resumeMetadata.status !== 'idle' || guest.resumeMetadata.turnCount !== 0 ||
        guest.resumeMetadata.activeTurnId !== null || guest.resumeMetadata.pendingCount !== 0 ||
        guest.resumeMetadata.history !== 'none' || typeof guest.resumeMetadata.viewCursor !== 'string')) {
      throw fault('PHASE_OUTCOME_INVALID', 'resume envelope was not idle metadata for the original session');
    }
}

export function validateResumeOutcome(first, second, workspace, home) {
  validatePhaseOutcome('first', first);
  validatePhaseOutcome('resume', second);
  if (first.metadata?.sessionId !== second.metadata?.sessionId ||
      first.metadata?.workspaceRoot !== workspace || second.metadata?.workspaceRoot !== workspace ||
      first.metadata?.durableLogPath !== second.metadata?.durableLogPath ||
      !first.metadata.durableLogPath.startsWith(`${home}/.local/share/muse/sessions/`) ||
      first.metadata.turnCount !== 0 || second.metadata.turnCount !== 0 ||
      first.metadata.activeTurnId !== null || second.metadata.activeTurnId !== null ||
      first.metadata.pendingCount !== 0 || second.metadata.pendingCount !== 0 ||
      first.metadata.history !== 'none' || second.metadata.history !== 'none' ||
      first.metadata.status !== 'idle' || second.metadata.status !== 'idle' ||
      first.hostPort !== second.hostPort ||
      first.guestNamespace === second.guestNamespace) {
    throw fault('RESUME_IDENTITY_INVALID', 'second host did not preserve idle durable session identity');
  }
  return { sessionId: first.metadata.sessionId, durableLogPath: first.metadata.durableLogPath };
}

export async function qualifyFreshHostResume({ muse = '/home/jeremy/.local/bin/muse',
  checkBubblewrap = probeBubblewrap, stage = stageRuntime, startSentinel = startHostSentinel,
  probe = tcpProbe, launch = runStatusPhase, capture = captureHostIdentities,
  stop = verifyHostStop } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-fresh-resume-'));
  let sentinel;
  let firstHost;
  let secondHost;
  let firstCapture;
  let secondCapture;
  let stageName = 'stage';
  let outcome;
  const evidence = {};
  try {
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const token = 'protected-canary';
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(protectedRoot)]);
    await writeFile(join(protectedRoot, token), 'host-only');
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(root, muse);
    sentinel = await startSentinel();
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable before first host');
    }
    const prepared = prepareSandbox(sandboxConfig({ workspace, runtime, home, protectedRoot }), guestCommand());
    checkBubblewrap();
    stageName = 'first_host';
    firstHost = launch(prepared, { phase: 'first', workspace, hostPort: sentinel.port, protectedRoot, canaryToken: token });
    const [firstReady, firstStatus] = await Promise.all([firstHost.ready, firstHost.liveStatus]);
    evidence.firstReady = firstReady;
    evidence.firstLiveStatus = firstStatus;
    validatePhaseOutcome('first', firstReady);
    if (firstReady.hostPort !== sentinel.port || firstReady.kind !== 'guest_transport_observed' ||
        firstReady.metadata?.status !== 'idle' || firstReady.metadata?.turnCount !== 0 ||
        firstReady.metadata?.pendingCount !== 0 ||
        firstReady.metadata?.workspaceRoot !== workspace ||
        firstReady.metadata?.history !== 'none' ||
        firstReady.metadata?.activeTurnId !== null ||
        typeof firstReady.metadata?.sessionId !== 'string' ||
        typeof firstReady.metadata?.durableLogPath !== 'string' ||
        !firstReady.metadata.durableLogPath.startsWith(`${GUEST_HOME}/.local/share/muse/sessions/`)) {
      throw fault('PHASE_OUTCOME_INVALID', 'first guest idle metadata invalid before resume admission');
    }
    if (!firstStatus.child || firstStatus.exit !== null) throw fault('BWRAP_STATUS_INVALID', 'live first host status missing child');
    firstCapture = await capture(firstHost.pid, firstStatus.child, firstReady.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-${VERSION}`, `${GUEST_RUNTIME}/node`);
    evidence.firstCapture = { boot: firstCapture.boot, pidns: firstCapture.pidns,
      wrapper: firstCapture.wrapper, statusChild: firstCapture.statusChild,
      init: firstCapture.init, supervisor: firstCapture.supervisor, native: firstCapture.native,
      memberCount: firstCapture.members?.length };
    if (firstCapture.native.nspid.at(-1) !== firstReady.nativeIdentity.pid ||
        firstCapture.native.netns !== firstReady.nativeNamespace ||
        firstCapture.supervisor.netns !== firstReady.guestNamespace) {
      throw fault('STOP_ASSOCIATION_INVALID', 'guest native marker differs from host observation');
    }
    firstHost.release();
    const firstDone = await timeout('first host exit', firstHost.finished, DEADLINE_MS + 3_000);
    evidence.firstExit = { code: firstDone.code, signal: firstDone.signal, timedOut: firstDone.timedOut,
      overflow: firstDone.overflow, statusClosed: firstDone.statusClosed };
    const firstTerminal = parseBubblewrapStatus(firstDone.statusLines);
    evidence.firstTerminal = firstTerminal;
    if (firstDone.output.length !== 2 || firstDone.code !== 0 || firstDone.timedOut || firstDone.overflow ||
        JSON.stringify(JSON.parse(firstDone.output[1])) !== JSON.stringify(firstReady)) {
      throw fault('GUEST_OUTPUT_INVALID', 'first phase terminal output differs from held readiness');
    }
    const firstStop = await timeout('first host stop scan', stop(firstCapture, firstTerminal, firstDone));
    evidence.firstStop = firstStop;
    await firstCapture.fd.close(); firstCapture = undefined;
    if (firstStop.kind !== 'confirmed') throw fault('STOP_UNCONFIRMED', 'first namespace stop was not confirmed');
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable at second-host gate');
    }
    const logRelative = relative(GUEST_HOME, firstReady.metadata.durableLogPath);
    if (resolve(GUEST_HOME, logRelative) !== firstReady.metadata.durableLogPath ||
        logRelative.startsWith('..')) {
      throw fault('RESUME_IDENTITY_INVALID', 'durable log path was not canonical inside private HOME');
    }
    const hostLog = join(home, logRelative);
    const firstLog = await lstat(hostLog);
    if (!firstLog.isFile()) throw fault('RESUME_IDENTITY_INVALID', 'first durable log is not a regular file');
    stageName = 'second_host';
    secondHost = launch(prepared, { phase: 'resume', workspace, hostPort: sentinel.port,
      protectedRoot, canaryToken: token, sessionId: firstReady.metadata.sessionId,
      logPath: firstReady.metadata.durableLogPath });
    const [secondReady, secondLive] = await Promise.all([secondHost.ready, secondHost.liveStatus]);
    evidence.secondReady = secondReady;
    evidence.secondLiveStatus = secondLive;
    if (secondReady.hostPort !== sentinel.port) {
      throw fault('PHASE_OUTCOME_INVALID', 'second guest did not probe the original host sentinel');
    }
    if (!secondLive.child || secondLive.exit !== null) throw fault('BWRAP_STATUS_INVALID', 'live second host status missing child');
    secondCapture = await capture(secondHost.pid, secondLive.child, secondReady.nativeIdentity.start,
      `${GUEST_RUNTIME}/muse-bin-${VERSION}`, `${GUEST_RUNTIME}/node`);
    evidence.secondCapture = { boot: secondCapture.boot, pidns: secondCapture.pidns,
      wrapper: secondCapture.wrapper, statusChild: secondCapture.statusChild,
      init: secondCapture.init, supervisor: secondCapture.supervisor, native: secondCapture.native,
      memberCount: secondCapture.members?.length };
    if (secondCapture.native.nspid.at(-1) !== secondReady.nativeIdentity.pid ||
        secondCapture.native.netns !== secondReady.nativeNamespace ||
        secondCapture.supervisor.netns !== secondReady.guestNamespace ||
        secondCapture.pidns === firstStop.pidns || secondCapture.boot !== firstStop.boot) {
      throw fault('STOP_ASSOCIATION_INVALID', 'second native host was not fresh or its marker differed');
    }
    secondHost.release();
    const secondDone = await timeout('second host exit', secondHost.finished, DEADLINE_MS + 3_000);
    evidence.secondExit = { code: secondDone.code, signal: secondDone.signal, timedOut: secondDone.timedOut,
      overflow: secondDone.overflow, statusClosed: secondDone.statusClosed };
    const secondStatus = parseBubblewrapStatus(secondDone.statusLines);
    evidence.secondTerminal = secondStatus;
    if (secondDone.output.length !== 2 || secondDone.code !== 0 || secondDone.timedOut || secondDone.overflow ||
        JSON.stringify(JSON.parse(secondDone.output[1])) !== JSON.stringify(secondReady)) {
      throw fault('GUEST_OUTPUT_INVALID', 'second phase terminal output invalid');
    }
    const resumed = validateResumeOutcome(firstReady, secondReady, workspace, GUEST_HOME);
    const secondLog = await lstat(hostLog);
    if (!secondLog.isFile() || secondLog.dev !== firstLog.dev || secondLog.ino !== firstLog.ino) {
      throw fault('RESUME_IDENTITY_INVALID', 'durable log inode changed across native hosts');
    }
    const secondStop = await timeout('second host stop scan', stop(secondCapture, secondStatus, secondDone));
    evidence.secondStop = secondStop;
    await secondCapture.fd.close(); secondCapture = undefined;
    if (secondStop.kind !== 'confirmed') throw fault('STOP_UNCONFIRMED', 'second namespace stop was not confirmed');
    if ((await probe('127.0.0.1', sentinel.port)).kind !== 'connected') {
      throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel unavailable after second host');
    }
    outcome = { kind: 'fresh_host_idle_resume_observed', resumed, first: firstReady, second: secondReady,
      firstStop, secondStop, evidence };
  } catch (error) {
    outcome = { kind: 'fresh_host_idle_resume_error', stage: stageName,
      code: error.code ?? error.name, message: String(error.message).slice(0, 500),
      stopProof: 'unconfirmed', evidence };
  } finally {
    if (firstHost) firstHost.release();
    if (secondHost) secondHost.release();
    for (const [name, host] of [['first', firstHost], ['second', secondHost]]) if (host) {
      try {
        const completed = await timeout('sandbox shutdown', host.finished, DEADLINE_MS + 3_000);
        evidence[`${name}Completion`] = { code: completed.code, signal: completed.signal,
          timedOut: completed.timedOut, overflow: completed.overflow, statusClosed: completed.statusClosed,
          statusLines: completed.statusLines, output: completed.output, stderr: completed.stderr };
      }
      catch { /* retained root and unconfirmed stop */ }
    }
    if (firstCapture) await firstCapture.fd.close();
    if (secondCapture) await secondCapture.fd.close();
    if (sentinel) try { await sentinel.close(); } catch { /* retained root */ }
  }
  outcome.retainedFixtures = [root];
  return outcome;
}

export async function qualify({ muse = '/home/jeremy/.local/bin/muse',
  checkBubblewrap = probeBubblewrap, run = runCaptured, stage = stageRuntime,
  startSentinel = startHostSentinel, probe = tcpProbe } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-sandbox-transport-'));
  let sentinel;
  let hostStarted = false;
  let stageName = 'stage';
  let outcome;
  try {
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const token = 'protected-canary';
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(protectedRoot)]);
    await writeFile(join(protectedRoot, token), 'host-only');
    // The symlink route must resolve to a host path that is absent in the guest.
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(root, muse);
    stageName = 'host_sentinel';
    sentinel = await startSentinel();
    const before = await probe('127.0.0.1', sentinel.port);
    if (before.kind !== 'connected') throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel was not reachable before guest');
    stageName = 'sandbox_prepare';
    const config = sandboxConfig({ workspace, runtime, home, protectedRoot });
    const prepared = prepareSandbox(config, guestCommand());
    checkBubblewrap();
    stageName = 'guest';
    hostStarted = true;
    const executed = await run(prepared.executable, prepared.args, {
      input: JSON.stringify({ workspace, hostPort: sentinel.port, protectedRoot, canaryToken: token }),
    });
    const after = await probe('127.0.0.1', sentinel.port);
    if (after.kind !== 'connected') throw fault('HOST_SENTINEL_UNAVAILABLE', 'host sentinel was not reachable after guest');
    const processExit = { code: executed.code, signal: executed.signal ?? null,
      timedOut: executed.timedOut === true, overflow: executed.overflow === true };
    if (processExit.timedOut || processExit.overflow) {
      throw Object.assign(fault('GUEST_PROCESS_FAILED', 'guest process exceeded its deadline or output limit'), { processExit });
    }
    let guest;
    try { guest = JSON.parse(executed.output); }
    catch { throw Object.assign(fault(executed.code === 0 ? 'GUEST_OUTPUT_INVALID' : 'GUEST_PROCESS_FAILED',
      'guest output was not one bounded JSON object'), { processExit }); }
    if (guest?.kind === 'guest_transport_error') {
      throw Object.assign(fault(guest.code ?? 'GUEST_TRANSPORT_FAILED', guest.message ?? 'guest transport failed'),
        { processExit, guestFailure: { stage: guest.stage ?? null, code: guest.code ?? null,
          guestNamespace: guest.guestNamespace ?? null, guestPort: guest.guestPort ?? null,
          commands: guest.commands ?? [], providerRequests: guest.providerRequests ?? [] } });
    }
    if (guest?.kind !== 'guest_transport_observed' || executed.code !== 0) {
      throw Object.assign(fault('GUEST_PROCESS_FAILED', 'guest result and process exit disagreed'), { processExit });
    }
    const hostNamespace = await readlink('/proc/self/ns/net');
    if (hostNamespace === guest.guestNamespace || guest.nativeNamespace !== guest.guestNamespace) {
      throw fault('NETWORK_NAMESPACE_INVALID', 'host, guest and native network namespace identities disagree');
    }
    outcome = { kind: 'transport_observed', hostNamespace, hostSentinel: { port: sentinel.port,
      before: before.kind, after: after.kind }, guest, stopProof: 'descendants_unverified' };
  } catch (error) {
    outcome = { kind: 'transport_error', stage: stageName, code: error.code ?? error.name,
      message: String(error.message).slice(0, 500),
      ...(error.processExit ? { processExit: error.processExit } : {}),
      ...(error.guestFailure ? { guestFailure: error.guestFailure } : {}),
      stopProof: 'descendants_unverified' };
  } finally {
    if (sentinel) try { await sentinel.close(); } catch { /* retained root */ }
  }
  // Every host-started fixture is deliberately retained: SDK close and wrapper
  // exit do not prove the absence of escaped descendants.
  outcome.retainedFixtures = [root];
  outcome.hostStarted = hostStarted;
  return outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--guest') {
    try {
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
      const first = await lines.next();
      if (first.done || Buffer.byteLength(first.value) > LIMIT) throw fault('GUEST_INPUT_TOO_LARGE', 'guest input missing or exceeds limit');
      const config = JSON.parse(first.value);
      config.release = async () => (await lines.next()).value;
      const result = await guestRun(config);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = ['guest_transport_observed', 'guest_resume_observed'].includes(result.kind) ? 0 : 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_transport_error', code: error.code ?? error.name,
        message: String(error.message).slice(0, 500) })}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stdout.write(`${JSON.stringify(await qualifyFreshHostResume())}\n`);
  }
}
