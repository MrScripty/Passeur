#!/usr/bin/env node
// Disposable synthetic-credential boundary. No installed Muse or real account is used here.
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { prepareSandbox, probeBubblewrap } from './experiment-worker-sandbox.mjs';
import { pinnedNode, tcpProbe, classifyNoRoute, loopbackReady, parseBubblewrapStatus } from './qualify-muse-sandbox-transport.mjs';
import { spawnSync } from 'node:child_process';

const DUMMY = 'passeur-disposable-dummy-key';
const MODEL = 'fixture-relay-model';
const GUEST_RUNTIME = '/mounts/runtime';
const GUEST_SOCKET = '/mounts/relay/relay.sock';
const REQUEST_LIMIT = 8_192;
const RESPONSE_LIMIT = 65_536;
const OUTPUT_LIMIT = 16_384;
const RUN_MS = 20_000;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
async function settleWithin(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault(code, `phase exceeded ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function send(response, status, code) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code } }));
}
function awaitListen(server, target) {
  return new Promise((resolveValue, reject) => {
    server.once('error', reject);
    server.listen(target, () => { server.off('error', reject); resolveValue(server.address()); });
  });
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolveValue, reject) => server.close(error => error ? reject(error) : resolveValue()));
}

export function requestDecision(request, body, policy) {
  const raw = request.rawHeaders ?? [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (seen.has(name)) return { ok: false, code: 'DUPLICATE_HEADER' };
    seen.add(name);
  }
  const allowed = new Set(['host', 'authorization', 'accept', 'content-type', 'content-length',
    'connection', 'transfer-encoding', 'x-passeur-run']);
  if (Object.keys(request.headers ?? {}).some(name => !allowed.has(name))) {
    return { ok: false, code: 'HEADER_REJECTED' };
  }
  const headers = request.headers ?? {};
  if (headers['x-passeur-run'] !== policy.runId ||
      headers.authorization !== `Bearer ${DUMMY}` ||
      headers.connection && !['close', 'keep-alive'].includes(headers.connection) ||
      headers['transfer-encoding'] && headers['transfer-encoding'] !== 'chunked' ||
      headers.host && !/^127\.0\.0\.1:\d+$/.test(headers.host)) {
    return { ok: false, code: 'RUN_OR_HEADER_REJECTED' };
  }
  if (request.method === 'GET' && request.url === '/muse-code/models' && body.length === 0) {
    return { ok: true, route: 'catalog', body: Buffer.alloc(0) };
  }
  if (request.method === 'POST' && request.url === '/responses' &&
      headers['content-type'] === 'application/json') {
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { return { ok: false, code: 'BODY_INVALID' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'input,model,tools' ||
        parsed.model !== policy.model || typeof parsed.input !== 'string' ||
        !policy.allowedInputs.includes(parsed.input) ||
        !Array.isArray(parsed.tools) || parsed.tools.length !== 0) {
      return { ok: false, code: 'MODEL_OR_BODY_REJECTED' };
    }
    // Forward a canonical projection, never the untrusted bytes that JSON.parse
    // accepted. Duplicate keys and discarded fields cannot ride upstream.
    return { ok: true, route: 'responses',
      body: Buffer.from(JSON.stringify({ model: policy.model, input: parsed.input, tools: [] })) };
  }
  return { ok: false, code: 'ROUTE_OR_METHOD_REJECTED' };
}

export async function assertSocketIdentity(socketPath, identity, inspect = lstat) {
  const current = await inspect(socketPath);
  if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino ||
      (current.mode & 0o777) !== 0o600) {
    throw fault('SOCKET_REPLACED', 'task relay socket identity or mode changed');
  }
}

export async function startBroker({ socketPath, upstreamOrigin, runId, bearer,
  model = MODEL, requestLimit = REQUEST_LIMIT, responseLimit = RESPONSE_LIMIT,
  concurrency = 2, deadlineMs = 3_000, allowedInputs = ['fixture'],
  perRouteBudget = 1,
  inspectSocket = assertSocketIdentity }) {
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
      !Number.isSafeInteger(Number(upstream.port)) || Number(upstream.port) < 1 ||
      upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password ||
      !/^[A-Za-z0-9_-]{12,80}$/.test(runId) ||
      typeof bearer !== 'string' || bearer.length < 24 || bearer === DUMMY ||
      !Array.isArray(allowedInputs) || allowedInputs.length < 1 || allowedInputs.length > 8 ||
      allowedInputs.some(value => typeof value !== 'string' || !/^[a-z]{1,32}$/.test(value)) ||
      !Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > REQUEST_LIMIT ||
      !Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > RESPONSE_LIMIT ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(perRouteBudget) || perRouteBudget < 1 || perRouteBudget > 8 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 5_000) {
    throw fault('BROKER_POLICY_INVALID', 'synthetic broker origin, run or bearer invalid');
  }
  const policy = { runId, model, allowedInputs };
  const evidence = { accepted: 0, rejected: 0, upstream: 0, disconnected: 0, responseLimit: 0, deadline: 0 };
  const routeUses = { catalog: 0, responses: 0 };
  let active = 0;
  let socketIdentity;
  const server = createServer(async (incoming, outgoing) => {
    incoming.setTimeout(deadlineMs, () => incoming.destroy(fault('GUEST_REQUEST_TIMEOUT', 'guest request timed out')));
    outgoing.setTimeout(deadlineMs, () => outgoing.destroy());
    if (active >= concurrency) { evidence.rejected++; send(outgoing, 429, 'CONCURRENCY_LIMIT'); return; }
    active++;
    let upstreamRequest;
    let deadlineExpired = false;
    let completed = false;
    const wholeDeadline = setTimeout(() => {
      if (completed) return;
      deadlineExpired = true;
      evidence.deadline++;
      incoming.destroy(fault('WHOLE_OPERATION_DEADLINE', 'relay operation timed out'));
      upstreamRequest?.destroy(fault('WHOLE_OPERATION_DEADLINE', 'relay operation timed out'));
      outgoing.destroy();
    }, deadlineMs);
    const finish = () => { if (completed) return; completed = true; active--; };
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) { evidence.disconnected++; upstreamRequest?.destroy(); }
      finish();
    });
    try {
      await inspectSocket(socketPath, socketIdentity);
      let bytes = 0;
      const chunks = [];
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > requestLimit) throw fault('REQUEST_LIMIT', 'guest request exceeded body budget');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const decision = requestDecision(incoming, body, policy);
      if (!decision.ok) { evidence.rejected++; send(outgoing, 403, decision.code); return; }
      if (routeUses[decision.route] >= perRouteBudget) {
        evidence.rejected++; send(outgoing, 429, 'ROUTE_BUDGET'); return;
      }
      routeUses[decision.route]++;
      evidence.accepted++;
      const route = decision.route === 'catalog' ? '/muse-code/models' : '/responses';
      const forwarded = decision.body;
      await new Promise(resolveValue => {
        upstreamRequest = httpRequest(new URL(route, upstream), { method: incoming.method,
          headers: { authorization: `Bearer ${bearer}`,
            ...(route === '/responses' ? { 'content-type': 'application/json' } : {}),
            'accept': 'application/json, text/event-stream', 'content-length': String(forwarded.length) },
          timeout: deadlineMs, agent: false }, upstreamResponse => {
          if (upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400 ||
              upstreamResponse.headers.location) {
            upstreamResponse.destroy(); evidence.rejected++; send(outgoing, 502, 'UPSTREAM_REDIRECT_REJECTED');
            resolveValue(); return;
          }
          const contentType = String(upstreamResponse.headers['content-type'] ?? '').split(';')[0];
          if (upstreamResponse.statusCode !== 200 || !['application/json', 'text/event-stream'].includes(contentType)) {
            upstreamResponse.destroy(); evidence.rejected++; send(outgoing, 502, 'UPSTREAM_RESPONSE_REJECTED');
            resolveValue(); return;
          }
          outgoing.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
          let total = 0;
          upstreamResponse.on('data', chunk => {
            total += chunk.length;
            if (total > responseLimit) {
              evidence.responseLimit++; upstreamRequest.destroy(); outgoing.destroy(); return;
            }
            if (!outgoing.write(chunk)) upstreamResponse.pause();
          });
          outgoing.on('drain', () => upstreamResponse.resume());
          upstreamResponse.once('end', () => { if (!outgoing.destroyed) outgoing.end(); resolveValue(); });
          upstreamResponse.once('error', () => { if (!outgoing.destroyed) outgoing.destroy(); resolveValue(); });
          outgoing.once('close', () => { upstreamResponse.destroy(); resolveValue(); });
        });
        upstreamRequest.once('error', () => { if (!outgoing.headersSent) send(outgoing, 502, 'UPSTREAM_UNAVAILABLE');
          else outgoing.destroy(); resolveValue(); });
        upstreamRequest.once('timeout', () => upstreamRequest.destroy(fault('UPSTREAM_TIMEOUT', 'upstream timed out')));
        evidence.upstream++;
        upstreamRequest.end(forwarded);
      });
    } catch (error) {
      evidence.rejected++;
      if (!deadlineExpired) send(outgoing, error.code === 'REQUEST_LIMIT' ? 413 : 503, error.code ?? 'BROKER_UNAVAILABLE');
    } finally { clearTimeout(wholeDeadline); if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end(); finish(); }
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = deadlineMs;
  server.headersTimeout = deadlineMs;
  await awaitListen(server, socketPath);
  await chmod(socketPath, 0o600);
  const entry = await lstat(socketPath);
  socketIdentity = { dev: entry.dev, ino: entry.ino };
  await assertSocketIdentity(socketPath, socketIdentity);
  return { socketPath, identity: socketIdentity, evidence, get listening() { return server.listening; },
    close: async () => {
      let replacement;
      let mismatch;
      try { await assertSocketIdentity(socketPath, socketIdentity); }
      catch (error) { mismatch = error; }
      if (mismatch) {
        // Node closes a pathname socket by unlinking its path. Move a replacement
        // aside before stopping the owned listener, then restore that exact object.
        try {
          const observed = await lstat(socketPath);
          const heldPath = `${socketPath}.held-${randomBytes(6).toString('hex')}`;
          await rename(socketPath, heldPath);
          replacement = { heldPath, dev: observed.dev, ino: observed.ino };
        } catch (error) { if (error.code !== 'ENOENT') mismatch = error; }
      }
      let closeError;
      try { await close(server); } catch (error) { closeError = error; }
      let preserved = true;
      if (replacement) {
        try {
          const occupied = await lstat(socketPath).then(() => true, error => error.code !== 'ENOENT');
          if (occupied) preserved = false;
          else {
            await rename(replacement.heldPath, socketPath);
            const restored = await lstat(socketPath);
            preserved = restored.dev === replacement.dev && restored.ino === replacement.ino;
          }
        } catch { preserved = false; }
      }
      if (mismatch || closeError || !preserved) {
        throw Object.assign(fault('SOCKET_STOP_UNVERIFIED', 'broker stopped with replaced or uncertain socket path'),
          { listenerStopped: !server.listening && !closeError, replacementPreserved: preserved });
      }
      if (await lstat(socketPath).then(() => true, error => error.code !== 'ENOENT')) {
        throw fault('SOCKET_STOP_UNVERIFIED', 'task relay socket path remained after close');
      }
    } };
}

export async function startGuestRelay(socketPath, runId) {
  const server = createServer((incoming, outgoing) => {
    incoming.setTimeout(3_000, () => incoming.destroy());
    outgoing.setTimeout(3_000, () => outgoing.destroy());
    const headers = { host: '127.0.0.1:1', authorization: `Bearer ${DUMMY}`,
      'x-passeur-run': runId, 'accept': 'application/json, text/event-stream',
      ...(incoming.headers['content-type'] ? { 'content-type': incoming.headers['content-type'] } : {}),
      ...(incoming.headers['content-length'] ? { 'content-length': incoming.headers['content-length'] } : {}),
    };
    const forwarding = httpRequest({ socketPath, method: incoming.method, path: incoming.url,
      headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] ?? 'application/json' });
      response.pipe(outgoing);
    });
    forwarding.once('error', () => { if (!outgoing.headersSent) send(outgoing, 502, 'SOCKET_UNAVAILABLE');
      else outgoing.destroy(); });
    outgoing.once('close', () => forwarding.destroy());
    incoming.pipe(forwarding);
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = 3_000;
  server.headersTimeout = 3_000;
  await awaitListen(server, { host: '127.0.0.1', port: 0 });
  return { port: server.address().port, close: () => close(server) };
}

async function fakeUpstream(bearer) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let bytes = 0;
    for await (const chunk of request) bytes += chunk.length;
    const correctBearer = request.headers.authorization === `Bearer ${bearer}`;
    seen.push({ route: request.url, method: request.method, correctBearer,
      dummyAbsent: !JSON.stringify(request.headers).includes(DUMMY), bytes });
    response.writeHead(correctBearer ? 200 : 401, { 'content-type': request.url === '/responses'
      ? 'text/event-stream' : 'application/json' });
    response.end(request.url === '/responses' ? 'data: {"type":"response.completed"}\n\n'
      : JSON.stringify({ object: 'list', data: [{ id: MODEL }] }));
  });
  await awaitListen(server, { host: '127.0.0.1', port: 0 });
  return { origin: `http://127.0.0.1:${server.address().port}/`, seen, close: () => close(server) };
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return true; throw error; }
}

export async function guestFixture(config) {
  const loopback = spawnSync('/usr/sbin/ip', ['-o', 'link', 'show', 'lo'], { encoding: 'utf8', timeout: 2_000 });
  if (!loopbackReady(loopback)) throw fault('GUEST_LOOPBACK_UNAVAILABLE', 'guest loopback not UP');
  const relay = await startGuestRelay(GUEST_SOCKET, config.runId);
  try {
    const settings = '/mounts/home/.config/muse';
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'settings.json'), `${JSON.stringify({ schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${relay.port}`, auth: 'bearer' } })}\n`, { mode: 0o600 });
    await writeFile(join(settings, 'auth.json'), `${JSON.stringify({ schema_version: 1,
      providers: { meta: { api_key: DUMMY } } })}\n`, { mode: 0o600 });
    const hostTcp = await tcpProbe('127.0.0.1', config.hostPort);
    const external = await tcpProbe('203.0.113.1', 443);
    if (hostTcp.kind === 'connected' || !classifyNoRoute(external)) throw fault('GUEST_NETWORK_UNVERIFIED', 'guest network boundary unverified');
    const canaries = { direct: await absent(join(config.protectedRoot, 'marker')),
      symlink: await absent(join(config.workspace, 'protected-link', 'marker')),
      proc: await absent(`/proc/1/root${config.protectedRoot}/marker`) };
    if (Object.values(canaries).some(value => !value)) throw fault('CANARY_VISIBLE', 'protected canary visible');
    const url = `http://127.0.0.1:${relay.port}`;
    const headers = { authorization: `Bearer ${DUMMY}` };
    const catalog = await fetch(`${url}/muse-code/models`, { headers });
    const catalogBody = await catalog.json();
    const response = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers,
      'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: 'fixture', tools: [] }) });
    const sse = await response.text();
    if (catalog.status !== 200 || catalogBody.data?.[0]?.id !== MODEL || response.status !== 200 ||
        !sse.includes('response.completed')) throw fault('GUEST_RELAY_FAILED', 'guest relay fixture response invalid');
    return { kind: 'guest_relay_observed', relayPort: relay.port, hostTcp, external, canaries,
      catalog: catalog.status, responses: response.status, guestNamespace: await readlink('/proc/self/ns/net') };
  } finally { await relay.close(); }
}

async function stage(root) {
  const runtime = join(root, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const node = await pinnedNode();
  await copyFile(node, join(runtime, 'node'));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(runtime, 'node'))) hash.update(chunk);
  const entry = await lstat(join(runtime, 'node'));
  if (hash.digest('hex') !== '16143bdaa79716e871d3d9b2f50ce680bca293eba7f0c3fc1d004ed2258fc839' ||
      !entry.isFile() || (entry.mode & 0o111) === 0) {
    throw fault('NODE_BINARY_MISMATCH', 'staged guest Node differs from pinned executable');
  }
  await copyFile(fileURLToPath(import.meta.url), join(runtime, 'qualify-muse-credential-relay.mjs'));
  await copyFile(resolve('scripts/experiment-worker-sandbox.mjs'), join(runtime, 'experiment-worker-sandbox.mjs'));
  await copyFile(resolve('scripts/qualify-muse-sandbox-transport.mjs'), join(runtime, 'qualify-muse-sandbox-transport.mjs'));
  return runtime;
}

export function relaySandboxConfig({ workspace, runtime, home, protectedRoot, socketDirectory }) {
  return { workspace, preserveWorkspacePath: true, denied: [protectedRoot], mounts: [
    { source: runtime, target: GUEST_RUNTIME, mode: 'ro' },
    { source: home, target: '/mounts/home', mode: 'rw' },
    { source: socketDirectory, target: '/mounts/relay', mode: 'ro' },
  ] };
}

function statIdentity(raw) {
  const pid = Number(/^([1-9]\d*) \(/.exec(raw)?.[1]);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || !/^\d+$/.test(start ?? '')) {
    throw fault('STOP_IDENTITY_INVALID', 'process stat could not be verified');
  }
  return { pid, parent, state: fields[0], start };
}
async function inspectProcess(pid) {
  const base = `/proc/${pid}`;
  const [stat, exe, pidns, netns, status] = await Promise.all([
    readFile(`${base}/stat`, 'utf8'), readlink(`${base}/exe`), readlink(`${base}/ns/pid`),
    readlink(`${base}/ns/net`), readFile(`${base}/status`, 'utf8'),
  ]);
  const identity = statIdentity(stat);
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
  if (identity.pid !== pid || ['Z', 'X'].includes(identity.state) || !nspid?.length ||
      nspid.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw fault('STOP_IDENTITY_INVALID', 'process identity or namespace PID changed');
  }
  return { ...identity, exe, pidns, netns, nspid };
}
async function membersOf(pidns) {
  const members = [];
  for (const entry of await readdir('/proc')) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let current;
    try { current = await readlink(`/proc/${entry}/ns/pid`); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (current === pidns) members.push(await inspectProcess(Number(entry)));
  }
  return members;
}

export async function captureFixtureProcesses(wrapperPid, statusChildPid, expectedNode) {
  const wrapper = await inspectProcess(wrapperPid);
  const statusChild = await inspectProcess(statusChildPid);
  if (wrapper.pidns === statusChild.pidns || wrapper.netns === statusChild.netns) {
    throw fault('STOP_ASSOCIATION_NAMESPACES', 'Bubblewrap child did not enter separate namespaces');
  }
  const fd = await open(`/proc/${statusChildPid}/ns/pid`, 'r');
  try {
    const pinned = await readlink(`/proc/self/fd/${fd.fd}`);
    if (pinned !== statusChild.pidns) throw fault('STOP_ASSOCIATION_PINNED', 'held namespace differs');
    const members = await membersOf(pinned);
    const node = members.filter(item => item.exe === `${GUEST_RUNTIME}/node`);
    const init = members.filter(item => item.nspid.at(-1) === 1);
    const sourceNode = await stat(expectedNode);
    const runningNode = node.length === 1 ? await stat(`/proc/${node[0].pid}/exe`) : null;
    if (node.length !== 1 || init.length !== 1 ||
        !members.some(item => item.pid === statusChildPid && item.start === statusChild.start) ||
        node[0].netns !== statusChild.netns || init[0].pid !== statusChildPid ||
        node[0].parent !== init[0].pid || !runningNode ||
        runningNode.dev !== sourceNode.dev || runningNode.ino !== sourceNode.ino) {
      throw Object.assign(fault('STOP_ASSOCIATION_MEMBERS', 'unique guest supervisor or namespace init absent'),
        { observation: { members: members.length, node: node.length, init: init.length,
          statusPresent: members.some(item => item.pid === statusChildPid && item.start === statusChild.start),
          netMatch: node.length === 1 && node[0].netns === statusChild.netns,
          initIsStatus: init.length === 1 && init[0].pid === statusChildPid,
          nodeParentIsInit: node.length === 1 && init.length === 1 && node[0].parent === init[0].pid,
          inodeMatch: !!runningNode && runningNode.dev === sourceNode.dev && runningNode.ino === sourceNode.ino } });
    }
    return { fd, pidns: pinned, wrapper, statusChild, members,
      boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
  } catch (error) { await fd.close(); throw error; }
}

export async function verifyFixtureStop(capture, status, exit, {
  bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'), scan = membersOf,
} = {}) {
  if (await bootId() !== capture.boot ||
      status.child !== capture.statusChild.pid || status.exit !== 0 ||
      exit.code !== 0 || exit.signal !== null || !exit.statusClosed || exit.timedOut || exit.overflow) {
    throw fault('STOP_STATUS_INVALID', 'Bubblewrap status or exit did not prove clean stop');
  }
  for (const observed of [capture.wrapper, ...capture.members]) {
    let stat;
    try { stat = statIdentity(await readStat(observed.pid)); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (stat.start !== observed.start) throw fault('STOP_PID_REUSED', 'observed PID was reused');
    throw fault('STOP_SURVIVOR', 'observed process remains');
  }
  if ((await scan(capture.pidns)).length !== 0) throw fault('STOP_SURVIVOR', 'guest namespace still has live members');
  return { kind: 'confirmed', observed: capture.members.length + 1 };
}

export async function qualify({ checkBubblewrap = probeBubblewrap, execute = executeGuest } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-credential-relay-'));
  // The exact copied Node executable is 116 MiB. Keep the tiny canonical
  // workspace under /tmp while staging only approved runtime bytes in tmpfs.
  let runtimeRoot;
  let upstream;
  let broker;
  let hostStarted = false;
  let stageName = 'prepare';
  let result;
  try {
    runtimeRoot = await mkdtemp('/dev/shm/passeur-muse-credential-relay-runtime-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const protectedRoot = join(root, 'protected');
    const socketDirectory = join(root, 'socket');
    await Promise.all([workspace, home, protectedRoot, socketDirectory].map(path => mkdir(path, { mode: 0o700 })));
    const marker = randomBytes(24);
    await writeFile(join(protectedRoot, 'marker'), marker);
    const markerEntry = await lstat(join(protectedRoot, 'marker'));
    await symlink(protectedRoot, join(workspace, 'protected-link'));
    const runtime = await stage(runtimeRoot);
    const runId = `run_${randomBytes(12).toString('hex')}`;
    const bearer = randomBytes(32).toString('hex');
    stageName = 'upstream';
    upstream = await fakeUpstream(bearer);
    const hostBefore = await tcpProbe('127.0.0.1', Number(new URL(upstream.origin).port));
    if (hostBefore.kind !== 'connected') throw fault('HOST_UPSTREAM_UNAVAILABLE', 'fake upstream unreachable before guest');
    stageName = 'broker';
    broker = await startBroker({ socketPath: join(socketDirectory, 'relay.sock'),
      upstreamOrigin: upstream.origin, runId, bearer });
    const config = relaySandboxConfig({ workspace, runtime, home, protectedRoot, socketDirectory });
    const prepared = prepareSandbox(config, [`${GUEST_RUNTIME}/node`,
      `${GUEST_RUNTIME}/qualify-muse-credential-relay.mjs`, '--guest']);
    checkBubblewrap();
    stageName = 'guest';
    hostStarted = true;
    const executed = await execute(prepared, { workspace, protectedRoot, runId,
      hostPort: Number(new URL(upstream.origin).port) }, join(runtime, 'node'));
    const hostAfter = await tcpProbe('127.0.0.1', Number(new URL(upstream.origin).port));
    if (hostAfter.kind !== 'connected') throw fault('HOST_UPSTREAM_UNAVAILABLE', 'fake upstream unreachable after guest');
    const markerAfter = await lstat(join(protectedRoot, 'marker'));
    if (!markerAfter.isFile() || markerAfter.dev !== markerEntry.dev || markerAfter.ino !== markerEntry.ino ||
        !marker.equals(await readFile(join(protectedRoot, 'marker')))) {
      throw fault('PROTECTED_MARKER_CHANGED', 'host-only protected marker changed');
    }
    let guest;
    try { guest = JSON.parse(executed.output); }
    catch { guest = { kind: 'guest_output_invalid' }; }
    const execution = { code: executed.code, signal: executed.signal ?? null,
      timedOut: executed.timedOut === true, overflow: executed.overflow === true,
      stopProof: executed.stopProof,
      guestKind: guest?.kind ?? null, guestCode: guest?.code ?? null };
    if (executed.code !== 0 || executed.timedOut || executed.overflow ||
        executed.stopProof?.kind !== 'confirmed' || guest.kind !== 'guest_relay_observed') {
      throw Object.assign(fault('GUEST_FAILED', 'guest fixture or exact stop failed'), { execution });
    }
    if (guest.kind !== 'guest_relay_observed' || upstream.seen.length !== 2 ||
        upstream.seen.some(item => !item.correctBearer || !item.dummyAbsent) ||
        broker.evidence.accepted !== 2) throw fault('RELAY_EVIDENCE_INVALID', 'relay evidence did not match fixture');
    result = { kind: 'synthetic_relay_observed', guest, broker: broker.evidence,
      upstream: upstream.seen, hostUpstream: { before: hostBefore.kind, after: hostAfter.kind },
      stopProof: 'fixture_processes_confirmed', stop: executed.stopProof };
    if (JSON.stringify(result).includes(bearer) || JSON.stringify(result).includes(marker.toString())) {
      throw fault('EVIDENCE_DISCLOSURE', 'synthetic secret entered retained evidence');
    }
  } catch (error) {
    result = { kind: 'synthetic_relay_error', stage: stageName, code: error.code ?? error.name,
      ...(error.execution ? { execution: error.execution } : {}),
      ...(broker ? { broker: broker.evidence } : {}),
      ...(upstream ? { upstream: upstream.seen } : {}),
      stopProof: 'descendants_unverified' };
  } finally {
    try { if (broker) await broker.close(); } catch { result.brokerClose = 'uncertain'; }
    try { if (upstream) await upstream.close(); } catch { result.upstreamClose = 'uncertain'; }
  }
  result.hostStarted = hostStarted;
  if (result.kind === 'synthetic_relay_observed' && !result.brokerClose && !result.upstreamClose) {
    const socket = join(root, 'socket', 'relay.sock');
    if (await lstat(socket).then(entry => entry.isSocket(), () => false)) {
      result.retainedFixtures = [root, runtimeRoot];
      result.socketStop = 'socket_path_still_present';
    } else {
      await rm(root, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      result.socketStop = 'observed_absent';
    }
  } else result.retainedFixtures = [root, runtimeRoot].filter(Boolean);
  return result;
}

async function executeGuest(prepared, config, expectedNode) {
  const separator = prepared.args.indexOf('--');
  if (separator < 0) throw fault('BWRAP_STATUS_INVALID', 'missing command delimiter');
  const args = [...prepared.args.slice(0, separator), '--json-status-fd', '3', ...prepared.args.slice(separator)];
  const child = spawn(prepared.executable, args, { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let output = '';
  let stderrBytes = 0;
  let overflow = false;
  let timedOut = false;
  let statusClosed = false;
  let statusCloseResolve;
  const statusDone = new Promise(resolveValue => { statusCloseResolve = resolveValue; });
  const statusLines = [];
  let statusBuffer = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveValue, reject) => { readyResolve = resolveValue; readyReject = reject; });
  ready.catch(() => undefined);
  const closed = new Promise(resolveValue => child.once('close', (code, signal) => resolveValue({ code, signal })));
  closed.then(() => readyReject(fault('GUEST_EXIT_EARLY', 'guest exited before ready')));
  child.once('error', error => readyReject(error));
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch { /* retain uncertainty */ }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGKILL'); } catch { /* retain uncertainty */ }
    }, 1_000).unref();
  };
  const timer = setTimeout(() => { timedOut = true; readyReject(fault('GUEST_DEADLINE', 'guest fixture timed out')); stop(); }, RUN_MS);
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
      overflow = true; readyReject(fault('GUEST_OUTPUT_LIMIT', 'guest output exceeded bound')); stop(); return;
    }
    const line = output.split('\n')[0];
    if (output.includes('\n')) {
      try { readyResolve(JSON.parse(line)); } catch { readyReject(fault('GUEST_OUTPUT_INVALID', 'guest output invalid')); }
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length;
    if (stderrBytes > OUTPUT_LIMIT) { overflow = true; readyReject(fault('GUEST_OUTPUT_LIMIT', 'guest stderr exceeded bound')); stop(); }
  });
  child.stdio[3].on('data', chunk => {
    statusBuffer += chunk.toString();
    if (Buffer.byteLength(statusBuffer) > OUTPUT_LIMIT) { overflow = true; stop(); return; }
    while (statusBuffer.includes('\n')) {
      const index = statusBuffer.indexOf('\n');
      statusLines.push(statusBuffer.slice(0, index));
      statusBuffer = statusBuffer.slice(index + 1);
    }
  });
  child.stdio[3].once('close', () => { statusClosed = true; statusCloseResolve(); });
  child.stdin.write(`${JSON.stringify(config)}\n`);
  let capture;
  let stopProof;
  try {
    const guest = await ready;
    if (guest.kind !== 'guest_relay_observed') throw fault('GUEST_FAILED', 'guest relay did not observe expected result');
    const deadline = Date.now() + 2_000;
    let status;
    do {
      status = parseBubblewrapStatus(statusLines);
      if (status.child !== null) break;
      await new Promise(resolveValue => setTimeout(resolveValue, 10));
    } while (Date.now() < deadline);
    if (status.child === null) throw fault('BWRAP_STATUS_INVALID', 'guest child PID not reported');
    capture = await captureFixtureProcesses(child.pid, status.child, expectedNode);
    child.stdin.end('release\n');
    const exit = await settleWithin(closed, 5_000, 'GUEST_STOP_DEADLINE');
    await settleWithin(statusDone, 1_000, 'STATUS_CLOSE_DEADLINE');
    status = parseBubblewrapStatus(statusLines);
    stopProof = await verifyFixtureStop(capture, status, { ...exit, statusClosed, timedOut, overflow });
    return { ...exit, output: output.trim(), timedOut, overflow, stopProof };
  } catch (error) {
    stop();
    const exit = await settleWithin(closed, 3_000, 'GUEST_STOP_DEADLINE')
      .catch(() => ({ code: null, signal: null }));
    return { ...exit, output: output.trim(), timedOut, overflow,
      stopProof: { kind: 'unverified', code: error.code ?? error.name,
        ...(error.observation ? { observation: error.observation } : {}) } };
  } finally {
    clearTimeout(timer);
    if (capture) await capture.fd.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--guest') {
    try {
      const lines = createInterface({ input: process.stdin });
      const iterator = lines[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || Buffer.byteLength(first.value) > OUTPUT_LIMIT) throw fault('GUEST_INPUT_LIMIT', 'guest config missing or too large');
      process.stdout.write(`${JSON.stringify(await guestFixture(JSON.parse(first.value)))}\n`);
      const release = await iterator.next();
      if (release.done || release.value !== 'release') throw fault('GUEST_RELEASE_INVALID', 'guest release was not exact');
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ kind: 'guest_relay_error', code: error.code ?? error.name })}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stdout.write(`${JSON.stringify(await qualify())}\n`);
  }
}
