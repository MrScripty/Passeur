#!/usr/bin/env node
/** Disposable synthetic ChatGPT credential and local TLS transport qualification. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { writeFile, readFile, readlink, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startProtectedEgress } from '../dist/src/agents/codex/protected-egress.js';
import { ACCOUNT_CHECK_RESPONSE, ELF, MODEL, SEED_DENIAL_MARKERS, fixedCommand,
  finalSse, fixedOutputDiagnostic, homeProbeOutputValid, nativePresentedFixedCommand, protectedProfileToml,
  retainedArtifactsClean, run } from './qualify-codex-protected-worker.mjs';
import { execSchema, sseCall, outputForCall } from './qualify-codex-model-exec.mjs';

const ACCOUNT = 'accounts.fixture.invalid';
const INFERENCE = 'inference.fixture.invalid';
const MODEL_CATALOG_PATH = '/v1/models?client_version=0.157.1';
export const TRANSPORT_LABELS = Object.freeze({ providerLabel: 'passeur_fixture_tls',
  credentialLabel: 'synthetic_chatgpt_fixture' });
const MAX_BODY = 262_144;
const sha = value => createHash('sha256').update(value).digest('hex');

async function socketLinks(pid) {
  const path = `/proc/${pid}/fd`;
  const names = await readdir(path);
  const links = await Promise.all(names.map(name => readlink(join(path, name)).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  })));
  return new Set(links.filter(value => /^socket:\[[0-9]+\]$/.test(value ?? '')));
}

async function parentPid(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const parent = Number(fields[1]);
  if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) throw Error('invalid process parent');
  return parent;
}

function processVanished(error) { return error?.code === 'ENOENT' || error?.code === 'ESRCH'; }

async function liveProcessIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
    if (processVanished(error)) return null;
    throw error;
  });
  if (stat === null) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields.length < 20 || !/^[0-9]+$/.test(fields[19])) throw Error('invalid process identity');
  return ['Z', 'X', 'x'].includes(fields[0]) ? null : `${pid}:${fields[19]}`;
}

async function socketInheritanceStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'inconclusive';
  try {
    const own = await socketLinks(pid);
    let ancestor = await parentPid(pid);
    let sawSidecar = false;
    for (let depth = 0; depth < 16; depth++) {
      const sockets = await socketLinks(ancestor);
      if (sockets.size) sawSidecar = true;
      if ([...own].some(link => sockets.has(link))) return 'inherited';
      if (ancestor === process.pid || ancestor === 1) return sawSidecar ? 'clean' : 'inconclusive';
      ancestor = await parentPid(ancestor);
    }
    return 'inconclusive';
  } catch (error) { if (processVanished(error)) return 'inconclusive'; throw error; }
}

export async function noInheritedHostSocketFds(pid) {
  try { return await socketInheritanceStatus(pid) === 'clean'; }
  catch { return false; }
}

export async function toolDescendants(pid) {
  const observed = new Set();
  const pending = [pid];
  while (pending.length) {
    const current = pending.pop();
    const tids = await readdir(`/proc/${current}/task`).catch(error => {
      if (processVanished(error)) return [];
      throw error;
    });
    for (const tid of tids) {
      const children = (await readFile(`/proc/${current}/task/${tid}/children`, 'utf8').catch(error => {
        if (processVanished(error)) return '';
        throw error;
      })).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const child of children) {
        if (!Number.isSafeInteger(child) || child < 1) throw Error('invalid child process identity');
        if (!observed.has(child)) { observed.add(child); pending.push(child); }
        if (observed.size > 32) throw Error('too many tool descendants');
      }
    }
  }
  return [...observed];
}

export async function scanLiveToolSocketFds(pid, afterSocketScan = async () => {},
  scanSocketStatus = socketInheritanceStatus) {
  let observed = false;
  for (const child of await toolDescendants(pid)) {
    const identity = await liveProcessIdentity(child);
    if (identity === null) continue;
    const comm = (await readFile(`/proc/${child}/comm`, 'utf8').catch(error => {
      if (processVanished(error)) return '';
      throw error;
    })).trim();
    if (!['bash', 'sleep'].includes(comm)) continue;
    let status;
    try { status = await scanSocketStatus(child); }
    catch (error) {
      if (error?.code === 'EACCES' && await liveProcessIdentity(child) !== identity) continue;
      throw error;
    }
    await afterSocketScan(child, status);
    if (status === 'inherited') return { clean: false, observed };
    if (await liveProcessIdentity(child) !== identity) continue;
    if (status !== 'clean') return { clean: false, observed };
    observed = true;
  }
  return { clean: true, observed };
}
export const CASES = ['positive', 'near-expiry', 'account-401', 'model-401', 'redirect',
  'wrong-host', 'untrusted-ca', 'direct-no-proxy', 'cancel-tunnel'];

export function accountRequestBodyless(headers) {
  return headers && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined;
}

export function settingsRequestValid(headers) {
  return accountRequestBodyless(headers) && headers['cache-control'] === 'no-cache, no-store';
}

export function tlsRequestRoute(method, path) {
  if (method === 'GET' && path === '/api/codex/accounts/check') return 'account';
  if (method === 'GET' && path === '/api/codex/settings/user') return 'settings';
  if (method === 'GET' && path === MODEL_CATALOG_PATH) return 'catalog';
  if (method === 'POST' && path === '/v1/responses') return 'responses';
  return 'unknown';
}

export function deniedPathStructure(path) {
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/')) return { shape: 'invalid' };
  let url;
  try { url = new URL(path, `https://${ACCOUNT}`); }
  catch { return { shape: 'invalid' }; }
  if (url.origin !== `https://${ACCOUNT}` || url.hash) return { shape: 'invalid' };
  const known = new Set(['api', 'codex', 'wham', 'backend-api', 'v1', 'v2', 'accounts', 'auth',
    'config', 'models', 'responses', 'tasks', 'task', 'threads', 'thread', 'turns', 'turn',
    'usage', 'thread_usage', 'thread-estimates', 'query', 'events', 'event', 'analytics', 'analytics-events',
    'telemetry', 'logs', 'metrics', 'traces', 'feedback', 'sessions', 'session',
    'rate-limit-reset-credits', 'consume', 'profiles', 'settings', 'workspaces', 'workspace',
    'agents', 'agent', 'rollouts', 'rollout', 'uploads', 'upload', 'batch', 'batches']);
  const parts = url.pathname.split('/').filter(Boolean);
  const segment = value => known.has(value) ? value :
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) ? 'uuid' :
    /^[0-9]+$/.test(value) ? 'number' : value.length > 32 ? 'opaque_long' : 'opaque';
  const queryKeys = new Set(['client_version', 'limit', 'cursor', 'account_id', 'thread_id',
    'task_id', 'model', 'source', 'type']);
  const keys = [...url.searchParams.keys()];
  return { shape: 'path', segments: parts.slice(0, 8).map(segment),
    extraSegments: parts.length > 8, query: keys.length === 0 ? 'none' :
      keys.length > 8 ? 'many' : keys.map(key => queryKeys.has(key) ? key : 'other') };
}

export function tunnelCountsBounded(evidence) {
  return ['accountTunnels', 'inferenceTunnels', 'accepted', 'settings'].every(key => Number.isSafeInteger(evidence[key])) &&
    evidence.accountTunnels >= evidence.account + evidence.settings + 1 && evidence.accountTunnels <= 16 &&
    evidence.inferenceTunnels >= evidence.inference + evidence.catalog &&
    evidence.inferenceTunnels <= 16 && evidence.accepted <= 32 &&
    Number.isSafeInteger(evidence.latchedDenied) && evidence.latchedDenied >= 0 &&
    evidence.accepted === evidence.accountTunnels + evidence.inferenceTunnels + evidence.oauth +
      evidence.unknown + evidence.latchedDenied;
}

export function tlsIdentityDiagnostic(request, token) {
  const postPath = request.method === 'POST' ? {
    '/api/codex/tasks': 'task_create', '/wham/tasks': 'task_create',
    '/api/codex/accounts/send_add_credits_nudge_email': 'credits_nudge',
    '/wham/accounts/send_add_credits_nudge_email': 'credits_nudge',
    '/api/codex/usage/thread_usage/query': 'thread_usage',
    '/api/codex/usage/thread-estimates/query': 'thread_estimate',
    '/wham/usage/thread_usage/query': 'thread_usage',
    '/wham/usage/thread-estimates/query': 'thread_estimate',
    '/api/codex/responses': 'backend_responses', '/wham/responses': 'backend_responses',
    '/v1/traces': 'otel_traces', '/v1/logs': 'otel_logs', '/v1/metrics': 'otel_metrics',
    '/codex/analytics-events/events': 'analytics_events',
  }[request.url] : undefined;
  return {
    method: request.method === 'GET' ? 'get' : request.method === 'POST' ? 'post' : 'other',
    path: request.url === '/api/codex/accounts/check' ? 'account_check' :
      request.url === '/api/codex/settings/user' ? 'user_settings' :
      request.url === '/v1/responses' ? 'responses' :
      request.url === MODEL_CATALOG_PATH ? 'models' : postPath ?? 'other',
    host: request.headers.host === ACCOUNT ? 'account' :
      request.headers.host === INFERENCE ? 'inference' : 'other',
    authorization: request.headers.authorization === undefined ? 'absent' :
      request.headers.authorization === `Bearer ${token}` ? 'expected' : 'mismatch',
  };
}

export function tlsProfile(workspace, canonical, admin, native) {
  if (native !== ELF) throw Error('fixture native mismatch');
  return protectedProfileToml(workspace, canonical, admin, 39173, true)
    .replace('chatgpt_base_url = "http://127.0.0.1:39173"', `chatgpt_base_url = "https://${ACCOUNT}"`)
    .replaceAll('passeur_fixture_loopback', 'passeur_fixture_tls')
    .replace('base_url = "http://127.0.0.1:39173/v1"', `base_url = "https://${INFERENCE}/v1"`) +
    '\n[analytics]\nenabled = false\n';
}

export function generateCertificate(root, commonName = ACCOUNT) {
  const caKey = join(root, 'ca.key'), ca = join(root, 'ca.pem');
  const key = join(root, 'peer.key'), csr = join(root, 'peer.csr'), cert = join(root, 'peer.pem');
  const ext = join(root, 'peer.ext');
  const openssl = (...args) => execFileSync('/usr/bin/openssl', args, { cwd: root, stdio: 'ignore', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' } });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Passeur Fixture CA',
    '-keyout', caKey, '-out', ca);
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${commonName}`, '-keyout', key, '-out', csr);
  return { ca, key, cert, csr, ext, caKey, openssl };
}

export function transportProbeCommand(workspace, protectedPath, siblingPath, proxyPort, brokerGuestPath) {
  const base = fixedCommand(workspace, protectedPath, siblingPath, '/mounts/home/auth.json', true);
  if (!/^\/mounts\/relay\/[A-Za-z0-9._-]+$/.test(brokerGuestPath)) throw Error('unsafe broker path');
  const alias = join(workspace, 'broker-link');
  const connectFunction = `broker_connect() { /usr/bin/python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(1); s.connect(sys.argv[1]); s.sendall(b"CONNECT accounts.fixture.invalid:443 HTTP/1.1\\r\\nHost: accounts.fixture.invalid:443\\r\\n\\r\\n"); sys.exit(0 if s.recv(64).startswith(b"HTTP/1.1 200") else 1)' "$1"; };`;
  const deniedConnect = (path, marker) =>
    `! broker_connect ${path} >/dev/null 2>&1 && printf '${marker}\\n'`;
  const probes = [
    `/usr/bin/python3 -c 'print(1)' >/dev/null 2>&1`,
    `/usr/bin/sleep 1`,
    `! /usr/bin/curl -q --noproxy '*' --max-time 1 -sS http://127.0.0.1:${proxyPort}/probe >/dev/null 2>&1 && printf 'PROXY_DIRECT_DENIED\\n'`,
    deniedConnect(brokerGuestPath, 'BROKER_CONNECT_DENIED'),
    deniedConnect(alias, 'BROKER_SYMLINK_DENIED'),
    deniedConnect(`/proc/self/root${brokerGuestPath}`, 'BROKER_PROC_DENIED'),
    `! (for pid in $$ $PPID 1; do for n in 3 4 5 6 7 8 9; do /usr/bin/timeout 0.1 /usr/bin/head -c 64 "/proc/$pid/fd/$n" 2>/dev/null; done; done | /usr/bin/grep -F 'HTTP/1.1 200') >/dev/null 2>&1 && printf 'BROKER_FD_DENIED\\n'`,
    `rm -- ${alias}`,
  ];
  return `${connectFunction} ${probes.join(' && ')} && ${base}`;
}

export function transportMarkersValid(output) {
  if (typeof output !== 'string') return false;
  const at = output.indexOf('\nOutput:\n');
  if (at < 0) return false;
  const markers = ['PROXY_DIRECT_DENIED', 'BROKER_CONNECT_DENIED', 'BROKER_SYMLINK_DENIED',
    'BROKER_PROC_DENIED', 'BROKER_FD_DENIED', ...SEED_DENIAL_MARKERS];
  return output.slice(at + '\nOutput:\n'.length).startsWith(`${markers.join('\n')}\n`) &&
    homeProbeOutputValid(output.slice(0, at + '\nOutput:\n'.length) +
      output.slice(at + '\nOutput:\n'.length + markers.slice(0, 5).join('\n').length + 1), true);
}

/** This gate runs inside worker.run, before Coordinator can publish the private resource. */
export function transportPrepublicationAccepted(caseName, report, result, evidence,
  sourceIntact, canariesIntact) {
  return caseName === 'positive' && result.status === 'completed' && result.worker_stop === 'confirmed' &&
    report.providerSequenceComplete === true && report.nativeOutputClean === true &&
    report.homeCanaryIntactBeforePublication === true && !report.providerFailure &&
    evidence.fdInheritanceClean && evidence.toolFdObserved && evidence.retainedCleanBeforePublication &&
    sourceIntact && canariesIntact && evidence.brokerRetired && evidence.active === 0 &&
    evidence.unapprovedDirect === 0 && evidence.account === 1 && evidence.settings === 1 &&
    evidence.catalog === 1 && evidence.inference === 2 && tunnelCountsBounded(evidence) &&
    evidence.oauth === 0 && evidence.unknown === 0 && evidence.latchedDenied === 0 &&
    evidence.authLatched === false && evidence.terminalReason === null &&
    evidence.account401Responses === 0 && evidence.model401Selected === 0 &&
    evidence.applicationsAfterLatch === 0 &&
    evidence.transportMarkersValid === true;
}

export function classifyTransport(caseName, report, evidence) {
  if (caseName === 'near-expiry') return report?.nativeResultCode === 'CODEX_PROTECTED_AUTH_STALE' &&
      report.executionStatus === 'failed' && report.workerStop === 'not_started' &&
      report.deliveryStatus === 'incomplete' && report.privateResourceState === 'prepared' &&
      report.providerRequests === 0 && report.accountChecks === 0 && report.catalogChecks === 0 &&
      report.nativeCommandCorrelated !== true && report.providerOutput == null && !report.providerFailure &&
      report.transportPrepublicationValid === false &&
      report.privateAfter === report.privateBefore && report.canonicalAfter === report.privateBefore &&
      report.mainAfter === report.privateBefore && report.hookRan === false && report.bytesExact === false &&
      report.hostCanariesIntact === true && report.homeCanaryIntact === true &&
      report.nativeOutputClean === true && report.retainedArtifactsClean === true &&
      evidence?.retainedCleanBeforePublication === true && evidence.brokerRetired === true &&
      evidence.active === 0 && evidence.accepted === 0 && evidence.account === 0 && evidence.settings === 0 &&
      evidence.catalog === 0 && evidence.inference === 0 && evidence.oauth === 0 &&
      evidence.unknown === 0 && evidence.latchedDenied === 0 && evidence.authLatched === false &&
      evidence.terminalReason === null && evidence.account401Responses === 0 && evidence.model401Selected === 0 &&
      evidence.applicationsAfterLatch === 0 ?
      'accepted_synthetic_near_expiry_host_refusal_not_started' : 'incomplete';
  if (!CASES.includes(caseName) || !report?.hostCanariesIntact || !report?.nativeOutputClean ||
      !report?.retainedArtifactsClean || !evidence?.brokerRetired || evidence.active !== 0 ||
      evidence.unapprovedDirect !== 0 ||
      (evidence.toolFdObserved === true && evidence.fdInheritanceClean !== true) ||
      evidence.retainedCleanBeforePublication !== true || report.homeCanaryIntact !== true ||
      report.providerFailure || !tunnelCountsBounded(evidence) ||
      ![0, 1].includes(evidence.catalog) || ![0, 1].includes(evidence.settings)) return 'incomplete';
  if (caseName === 'positive') return report.status === 'accepted_synthetic_seeded_home' &&
      report.transportPrepublicationValid === true && evidence.fdInheritanceClean === true &&
      evidence.toolFdObserved === true &&
      report.provider === TRANSPORT_LABELS.providerLabel &&
      report.credential === TRANSPORT_LABELS.credentialLabel &&
      evidence.account === 1 && evidence.settings === 1 && evidence.catalog === 1 && evidence.inference === 2 &&
      evidence.oauth === 0 && evidence.unknown === 0 && evidence.latchedDenied === 0 &&
      evidence.authLatched === false && evidence.terminalReason === null &&
      evidence.account401Responses === 0 && evidence.model401Selected === 0 &&
      evidence.applicationsAfterLatch === 0 &&
      evidence.transportMarkersValid ?
      'accepted_synthetic_tls_private_commit' : 'incomplete';
  if (report.privateResourceState !== 'prepared' ||
      report.deliveryStatus !== 'incomplete' ||
      report.canonicalAfter !== report.privateBefore || report.mainAfter !== report.privateBefore ||
      !['confirmed', 'unconfirmed'].includes(report.workerStop)) return 'incomplete';
  const status = report.workerStop === 'confirmed' ? 'accepted' : 'observed';
  const suffix = report.workerStop === 'confirmed' ? 'confirmed_stop' : 'unconfirmed_stop';
  if (caseName === 'account-401' || caseName === 'model-401') {
    const account401 = caseName === 'account-401';
    const transactions = account401 ?
      evidence.account === 2 && evidence.account401Responses === 2 &&
      evidence.account401ResponsesAtLatch === 2 && evidence.model401Selected === 0 &&
      evidence.inference === 0 && report.accountChecks === 2 && report.providerRequests === 0 :
      evidence.account === 1 && evidence.account401Responses === 0 &&
      evidence.inference === 1 && evidence.model401Selected === 1 &&
      evidence.model401SelectedAtLatch === 1 && [0, 1].includes(evidence.model401WriteCompleted) &&
      evidence.model401NativeReceipt === 'unobserved' &&
      report.accountChecks === 1 && report.providerRequests === 1;
    const denial = account401 ? evidence.oauth === 1 && evidence.terminalReason === 'refresh_denied' &&
      evidence.applicationsAfterLatch === 0 && report.nativeResultCode === 'CODEX_PROTECTED_REFRESH_DENIED' :
      evidence.oauth === 0 && evidence.terminalReason === 'upstream_unauthorized' &&
      Number.isSafeInteger(evidence.applicationsAfterLatch) &&
      evidence.applicationsAfterLatch >= 0 && evidence.applicationsAfterLatch <= 16 &&
      report.nativeResultCode === 'CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED';
    return transactions && denial && evidence.authLatched === true && evidence.unknown === 0 &&
      evidence.toolFdObserved === false && evidence.transportMarkersValid === false &&
      report.privateAfter === report.privateBefore && report.hookRan === false &&
      report.bytesExact === false && report.nativeCommandCorrelated === false &&
      report.providerOutput == null && report.transportPrepublicationValid === false &&
      report.providerSequenceComplete === false && report.executionStatus !== 'completed' &&
      !report.providerFailure ?
      `${status}_synthetic_${caseName.replace('-', '_')}_${account401 ? 'refresh_denial' : 'upstream_unauthorized'}_${suffix}` : 'incomplete';
  }
  if (caseName === 'wrong-host' || caseName === 'untrusted-ca') {
    // tlsNoRequestCloses is incremented only for this case's expected SNI after peer socket close.
    const route = caseName === 'wrong-host' ?
      evidence.accountTunnels >= 1 && evidence.accountTunnels <= 4 &&
      evidence.inferenceTunnels >= 1 && evidence.inferenceTunnels <= 4 :
      evidence.accountTunnels >= 1 && evidence.accountTunnels <= 4 &&
      evidence.inferenceTunnels >= 0 && evidence.inferenceTunnels <= 1;
    return report.workerStop === 'confirmed' && report.executionStatus === 'failed' &&
      report.nativeResultCode === 'CODEX_PROTECTED_TLS_REFUSED' && route &&
      evidence.terminalReason === 'tls_refused' && evidence.authLatched === true &&
      evidence.tlsSessions >= 1 && evidence.tlsSessions <=
        evidence.accountTunnels + evidence.inferenceTunnels &&
      evidence.tlsNoRequestAtLatch === 1 && evidence.tlsNoRequestCloses >= 1 &&
      evidence.tlsNoRequestCloses <= evidence.tlsSessions && evidence.applicationsAfterLatch === 0 &&
      evidence.account === 0 && evidence.settings === 0 && evidence.catalog === 0 &&
      evidence.inference === 0 && evidence.latchedDenied <= 8 &&
      evidence.oauth === 0 && evidence.unknown === 0 && evidence.toolFdObserved === false &&
      evidence.transportMarkersValid === false && report.accountChecks === evidence.account &&
      report.catalogChecks === evidence.catalog && report.providerRequests === 0 &&
      report.privateAfter === report.privateBefore && report.hookRan === false &&
      report.bytesExact === false && report.nativeCommandCorrelated === false &&
      report.providerOutput == null && report.transportPrepublicationValid === false &&
      report.providerSequenceComplete === false && evidence.account401Responses === 0 &&
      evidence.model401Selected === 0 ?
      `accepted_synthetic_tls_${caseName.replaceAll('-', '_')}_refusal_confirmed_stop` : 'incomplete';
  }
  if (evidence.authLatched || evidence.oauth !== 0 || evidence.latchedDenied !== 0) return 'incomplete';
  if (caseName === 'cancel-tunnel') return report.workerStop === 'confirmed' &&
      report.executionStatus === 'cancelled' && report.providerSequenceComplete === true &&
      report.privateAfter === report.privateBefore && report.hookRan === false &&
      report.bytesExact === false && report.nativeCommandCorrelated === false &&
      report.providerOutput == null && report.transportPrepublicationValid === false &&
      report.accountChecks === 1 && report.catalogChecks === 1 && report.providerRequests === 1 &&
      evidence.account === 1 && evidence.settings === 1 && evidence.catalog === 1 &&
      evidence.inference === 1 && evidence.accountTunnels >= 3 && evidence.accountTunnels <= 16 &&
      evidence.inferenceTunnels >= 2 && evidence.inferenceTunnels <= 16 &&
      evidence.unknown === 0 &&
      evidence.toolFdObserved === false && evidence.transportMarkersValid === false &&
      evidence.terminalReason === null && evidence.account401Responses === 0 &&
      evidence.model401Selected === 0 && evidence.applicationsAfterLatch === 0 ?
      'accepted_synthetic_tls_tunnel_cancellation_confirmed_stop' : 'incomplete';
  if (report.executionStatus === 'completed' || report.providerSequenceComplete !== false ||
      report.privateAfter !== report.privateBefore || report.hookRan !== false ||
      report.bytesExact !== false || report.nativeCommandCorrelated !== false ||
      report.providerOutput != null || report.transportPrepublicationValid !== false ||
      report.accountChecks !== evidence.account || report.catalogChecks !== evidence.catalog ||
      report.providerRequests !== 0 || evidence.toolFdObserved !== false ||
      evidence.transportMarkersValid !== false || evidence.terminalReason !== null ||
      evidence.account401Responses !== 0 || evidence.model401Selected !== 0 ||
      evidence.applicationsAfterLatch !== 0) return 'incomplete';
  const valid = caseName === 'redirect' ? Number.isSafeInteger(evidence.account) &&
    evidence.account >= 1 && evidence.account <= 6 && evidence.settings === 0 &&
    evidence.catalog === 1 && evidence.unknown === evidence.account &&
    evidence.accountTunnels === evidence.account + 1 && evidence.inferenceTunnels === 1 &&
    evidence.inference === 0 :
    evidence.account === 0 && evidence.accountTunnels === 1 && evidence.inference === 0 &&
      evidence.inferenceTunnels === 0 && evidence.accepted === 1 && evidence.unknown === 0;
  return valid ? `${status}_synthetic_tls_${caseName.replaceAll('-', '_')}_refusal_${suffix}` : 'incomplete';
}

export async function runTransport(caseName = 'positive') {
  if (!CASES.includes(caseName)) throw Error('unsupported transport case');
  const evidence = { account: 0, settings: 0, catalog: 0, inference: 0, oauth: 0, unknown: 0,
    latchedDenied: 0, authLatched: false, terminalReason: null,
    tlsSessions: 0, tlsNoRequestCloses: 0, tlsNoRequestAtLatch: null,
    account401Responses: 0, model401Selected: 0, model401WriteCompleted: 0,
    model401NativeReceipt: 'unobserved', account401ResponsesAtLatch: null,
    model401SelectedAtLatch: null, applicationsAfterLatch: 0,
    accountTunnels: 0, inferenceTunnels: 0, accepted: 0,
    active: null, brokerRetired: false, unapprovedDirect: 0, transportMarkersValid: false,
    fdInheritanceClean: false, toolFdObserved: false, retainedCleanBeforePublication: false };
  const mode = caseName === 'cancel-tunnel' ? 'seeded-cancel' : 'seeded-home';
  const transport = {
    ...TRANSPORT_LABELS,
    ...(caseName === 'near-expiry' ? { accessExpiry: Math.floor(Date.now() / 1000) + 45 } : {}),
    async prepare(context) {
      const certificate = generateCertificate(context.root);
      await writeFile(certificate.ext, `subjectAltName=DNS:${ACCOUNT}${caseName === 'wrong-host' ? '' : `,DNS:${INFERENCE}`}\nextendedKeyUsage=serverAuth\n`);
      certificate.openssl('x509', '-req', '-in', certificate.csr, '-CA', certificate.ca,
        '-CAkey', certificate.caKey, '-CAcreateserial', '-days', '1', '-extfile', certificate.ext,
        '-out', certificate.cert);
      const caFile = caseName === 'untrusted-ca' ? join(context.root, 'untrusted.pem') : certificate.ca;
      if (caseName === 'untrusted-ca') {
        certificate.openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
          '-subj', '/CN=Untrusted Fixture CA', '-keyout', join(context.root, 'untrusted.key'), '-out', caFile);
      }
      const auth = JSON.parse(context.seedBytes.toString('utf8'));
      const token = auth.tokens.access_token;
      const forbidden = [...context.secretValues, context.state.protectedCanary, context.state.siblingCanary];
      const cleanBytes = bytes => !forbidden.some(value => bytes.includes(Buffer.from(value)));
      const brokerGuestPath = `/mounts/relay/${context.socketPath.slice(context.relayDir.length + 1)}`;
      const command = transportProbeCommand(context.workspace, context.protectedPath,
        context.siblingPath, context.relayPort, brokerGuestPath);
      if (Buffer.byteLength(nativePresentedFixedCommand(command)) > 4096) throw Error('fixture command projection exceeds retained bound');
      context.state.fixedCommand = command;
      await symlink(brokerGuestPath, join(context.workspace, 'broker-link'));
      const probe = { cmd: command, workspace: context.workspace };
      let tls, broker, first = true, monitorStop = false, monitorPromise;
      const applicationSockets = new WeakSet();
      const observedTlsSockets = new WeakSet();
      const terminalAuth = new AbortController();
      const provider = {
        async listen() {
          tls = createHttpsServer({ key: await readFile(certificate.key), cert: await readFile(certificate.cert) },
            (request, response) => {
              applicationSockets.add(request.socket);
              if (broker?.authDenied()) {
                evidence.applicationsAfterLatch++;
                if (caseName !== 'model-401') context.state.failure ??= 'tls_request_after_refresh_latch';
                response.writeHead(403).end(); return;
              }
              const projectedHeaders = { ...request.headers }; delete projectedHeaders.authorization;
              if (!cleanBytes(Buffer.from(JSON.stringify(projectedHeaders)))) {
                context.state.failure ??= 'tls_header_secret_exposed'; response.writeHead(403).end(); return;
              }
              const route = tlsRequestRoute(request.method, request.url);
              const accountRoute = route === 'account' || route === 'settings';
              const catalogRoute = route === 'catalog';
              if (request.headers.authorization !== `Bearer ${token}` ||
                  request.headers.host !== (accountRoute ? ACCOUNT : INFERENCE)) {
                context.state.identityDiagnostic ??= tlsIdentityDiagnostic(request, token);
                if (context.state.identityDiagnostic.path === 'other') {
                  context.state.identityDiagnostic.structure = deniedPathStructure(request.url);
                }
                context.state.failure ??= 'tls_request_identity_invalid'; response.writeHead(403).end(); return;
              }
              if (accountRoute || catalogRoute) {
                if (!accountRequestBodyless(request.headers)) {
                  context.state.failure ??= 'tls_get_body_invalid'; response.writeHead(403).end(); return;
                }
                if (route === 'settings') {
                  if (!settingsRequestValid(request.headers)) {
                    context.state.failure ??= 'tls_settings_request_invalid'; response.writeHead(403).end(); return;
                  }
                  evidence.settings++;
                  if (evidence.settings > 1) {
                    context.state.failure ??= 'tls_settings_repeated'; response.writeHead(403).end(); return;
                  }
                  response.writeHead(200, { 'content-type': 'application/json' })
                    .end('{"commit_attribution_enabled":false}'); return;
                }
                if (catalogRoute) {
                  context.state.catalogChecks = (context.state.catalogChecks ?? 0) + 1;
                  evidence.catalog++;
                  if (evidence.catalog > 1) {
                    context.state.failure ??= 'tls_catalog_repeated'; response.writeHead(403).end(); return;
                  }
                  response.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}'); return;
                }
                context.state.accountChecks++; evidence.account++;
                if (caseName === 'account-401') {
                  if (evidence.account401Responses >= 2) {
                    context.state.failure ??= 'tls_account_401_repeated'; response.writeHead(403).end(); return;
                  }
                  evidence.account401Responses++; response.writeHead(401).end(); return;
                }
                if (caseName === 'redirect') { response.writeHead(302, { location: 'https://unknown.fixture.invalid/' }).end(); return; }
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ACCOUNT_CHECK_RESPONSE)); return;
              }
              if (request.method !== 'POST' || request.url !== '/v1/responses') {
                context.state.failure ??= 'tls_route_invalid'; response.writeHead(403).end(); return;
              }
              context.state.requests++; evidence.inference++;
              let size = 0; const chunks = [];
              request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) request.destroy(); else chunks.push(chunk); });
              request.on('end', () => {
                if (broker?.authDenied()) {
                  evidence.applicationsAfterLatch++;
                  if (caseName !== 'model-401') context.state.failure ??= 'tls_request_after_refresh_latch';
                  response.writeHead(403).end(); return;
                }
                const raw = Buffer.concat(chunks);
                if (!cleanBytes(raw)) {
                  context.state.failure ??= 'tls_body_secret_exposed'; response.writeHead(403).end(); return;
                }
                let body; try { body = JSON.parse(raw.toString('utf8')); }
                catch { context.state.failure ??= 'tls_json_invalid'; response.writeHead(400).end(); return; }
                if (body.model !== MODEL || execSchema(body) !== 'accepted') {
                  context.state.failure ??= 'tls_schema_invalid'; response.writeHead(400).end(); return;
                }
                if (caseName === 'model-401') {
                  if (evidence.model401Selected >= 1) {
                    context.state.failure ??= 'tls_model_401_repeated'; response.writeHead(403).end(); return;
                  }
                  evidence.model401Selected++;
                  response.once('finish', () => evidence.model401WriteCompleted++);
                  broker.denyUnauthorizedUpstream();
                  try { response.writeHead(401).end(); } catch { /* The terminal latch may retire this tunnel first. */ }
                  return;
                }
                if (first) {
                  first = false; context.state.first = true;
                  if (caseName === 'cancel-tunnel') return;
                  response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseCall(0, probe)); return;
                }
                const output = outputForCall(body, 0, probe, [probe]);
                if (!cleanBytes(Buffer.from(output.text ?? ''))) {
                  context.state.failure ??= 'tls_tool_secret_exposed'; response.writeHead(400).end(); return;
                }
                context.state.outputDiagnostic = fixedOutputDiagnostic(output,
                  context.state.protectedCanary, context.state.siblingCanary, token);
                evidence.transportMarkersValid = transportMarkersValid(output.text);
                context.state.homeProbeMarkersValid = evidence.transportMarkersValid;
                if (output.status !== 'accepted' || !evidence.transportMarkersValid ||
                    !output.text.includes('Process exited with code 0')) {
                  context.state.failure ??= 'tls_tool_output_invalid'; response.writeHead(400).end(); return;
                }
                context.state.second = true; context.state.toolOutputSha256 = sha(output.text);
                context.state.toolOutputBytes = Buffer.byteLength(output.text);
                response.writeHead(200, { 'content-type': 'text/event-stream' }).end(finalSse());
              });
            });
          const observeTlsSocket = socket => {
            if (observedTlsSockets.has(socket)) return;
            observedTlsSockets.add(socket);
            evidence.tlsSessions++;
            const expected = caseName === 'wrong-host' ? INFERENCE :
              caseName === 'untrusted-ca' ? ACCOUNT : null;
            const closed = () => {
              if (expected === null || socket.servername !== expected || applicationSockets.has(socket) ||
                  monitorStop || !broker) return;
              evidence.tlsNoRequestCloses++;
              broker.denyTlsRefusal();
            };
            if (socket.destroyed) closed(); else socket.once('close', closed);
          };
          tls.on('secureConnection', observeTlsSocket);
          tls.on('tlsClientError', (_error, socket) => observeTlsSocket(socket));
          await new Promise((resolve, reject) => { tls.once('error', reject); tls.listen(0, '127.0.0.1', resolve); });
          broker = await startProtectedEgress({ socketPath: context.socketPath,
            accountHost: ACCOUNT, inferenceHost: INFERENCE,
            accountPort: tls.address().port, inferencePort: tls.address().port,
            onTerminalDenial: reason => {
              evidence.account401ResponsesAtLatch = evidence.account401Responses;
              evidence.model401SelectedAtLatch = evidence.model401Selected;
              evidence.tlsNoRequestAtLatch = evidence.tlsNoRequestCloses;
              terminalAuth.abort(new Error(reason === 'upstream_unauthorized' ?
                'CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED' : reason === 'tls_refused' ?
                  'CODEX_PROTECTED_TLS_REFUSED' : 'CODEX_PROTECTED_REFRESH_DENIED'));
            } });
        },
        async close() {
          monitorStop = true; if (monitorPromise) await monitorPromise;
          if (broker) {
            await broker.close(); evidence.active = broker.active(); evidence.brokerRetired = true;
            evidence.oauth = broker.counts.oauth_denied; evidence.unknown = broker.counts.unknown_denied;
            evidence.latchedDenied = broker.counts.latched_denied;
            evidence.authLatched = broker.authDenied();
            evidence.terminalReason = broker.latchReason();
            evidence.accountTunnels = broker.counts.account;
            evidence.inferenceTunnels = broker.counts.inference;
            evidence.accepted = broker.accepted();
            evidence.unapprovedDirect = broker.accepted() - Object.values(broker.counts).reduce((a, b) => a + b, 0);
          }
          if (tls) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
        },
      };
      return { provider, syntheticProvider: 'passeur_fixture_tls', terminalAuthSignal: terminalAuth.signal,
        observeProcess: async pid => {
          evidence.fdInheritanceClean = await noInheritedHostSocketFds(pid);
          if (!evidence.fdInheritanceClean) context.state.failure ??= 'tls_inherited_socket_fd';
          monitorPromise = (async () => {
            while (!monitorStop) {
              try {
                const scan = await scanLiveToolSocketFds(pid);
                evidence.toolFdObserved ||= scan.observed;
                if (!scan.clean) {
                  evidence.fdInheritanceClean = false;
                  context.state.failure ??= 'tls_tool_inherited_socket_fd';
                }
              } catch {
                evidence.fdInheritanceClean = false;
                context.state.failure ??= 'tls_tool_fd_scan_invalid';
              }
              await delay(20);
            }
          })();
        },
        beforeReturn: async ({ report, result, root, seedPath, secretValues }) => {
          evidence.retainedCleanBeforePublication = await retainedArtifactsClean(root, seedPath, secretValues);
          const sourceIntact = (await readFile(seedPath).catch(() => null))?.equals(context.seedBytes) === true;
          const canariesIntact = (await readFile(context.protectedPath, 'utf8').catch(() => null)) === context.state.protectedCanary &&
            (await readFile(context.siblingPath, 'utf8').catch(() => null)) === context.state.siblingCanary;
          return transportPrepublicationAccepted(caseName, report, result, evidence,
            sourceIntact, canariesIntact);
        },
        relay: { socketPath: context.socketPath, port: context.relayPort,
        tlsProxy: { caFile, accountHost: ACCOUNT, inferenceHost: INFERENCE,
          ...(caseName === 'direct-no-proxy' ? { directNoProxy: true } : {}) } },
      config: tlsProfile(context.workspace, context.canonical, context.admin, ELF) };
    },
  };
  const report = await run(mode, transport);
  report.transport = evidence;
  report.transportStatus = classifyTransport(caseName, report, evidence);
  await writeFile(join(report.root, 'bounded-transport-report.json'), `${JSON.stringify({ caseName,
    status: report.transportStatus, evidence, workerStop: report.workerStop,
    deliveryStatus: report.deliveryStatus, taskId: report.taskId }, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1]?.endsWith('/qualify-codex-subscription-transport.mjs')) {
  const caseName = process.argv[2]?.replace(/^--/, '') ?? 'positive';
  const report = await runTransport(caseName);
  process.stdout.write(`${JSON.stringify({ root: report.root, status: report.transportStatus,
    workerStop: report.workerStop, taskId: report.taskId })}\n`);
  process.exitCode = report.transportStatus.startsWith('accepted_') ? 0 : 1;
}
