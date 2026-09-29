import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { CASES, classifyTransport, transportPrepublicationAccepted, tlsProfile, transportMarkersValid, transportProbeCommand,
  runTransport, noInheritedHostSocketFds, toolDescendants, scanLiveToolSocketFds,
  accountRequestBodyless, settingsRequestValid, tlsIdentityDiagnostic, tlsRequestRoute,
  tunnelCountsBounded, deniedPathStructure,
  TRANSPORT_LABELS } from '../../scripts/qualify-codex-subscription-transport.mjs';
import { SEED_DENIAL_MARKERS } from '../../scripts/qualify-codex-protected-worker.mjs';
import { nativePresentedFixedCommand } from '../../scripts/qualify-codex-protected-worker.mjs';

test('sealed TLS profile uses separate authenticated HTTP fixture provider and origins', () => {
  const config = tlsProfile('/tmp/task/workspace', '/tmp/private.git',
    '/tmp/private.git/worktrees/task',
    '/home/jeremy/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');
  assert.match(config, /^chatgpt_base_url = "https:\/\/accounts\.fixture\.invalid"/);
  assert.match(config, /model_provider = "passeur_fixture_tls"/);
  assert.match(config, /base_url = "https:\/\/inference\.fixture\.invalid\/v1"/);
  assert.match(config, /requires_openai_auth = true/);
  assert.match(config, /\[analytics\]\nenabled = false\n/);
  assert.equal(config.includes('passeur_fixture_loopback'), false);
  assert.deepEqual(TRANSPORT_LABELS, { providerLabel: 'passeur_fixture_tls',
    credentialLabel: 'synthetic_chatgpt_fixture' });
});

test('account check rejects any declared request body', () => {
  assert.equal(accountRequestBodyless({ host: 'accounts.fixture.invalid' }), true);
  assert.equal(accountRequestBodyless({ 'content-length': '0' }), false);
  assert.equal(accountRequestBodyless({ 'content-length': '9' }), false);
  assert.equal(accountRequestBodyless({ 'transfer-encoding': 'chunked' }), false);
  assert.equal(settingsRequestValid({ 'cache-control': 'no-cache, no-store' }), true);
  for (const headers of [{}, { 'cache-control': 'max-age=0' },
    { 'cache-control': 'no-cache, no-store', 'content-length': '0' },
    { 'cache-control': 'no-cache, no-store', 'transfer-encoding': 'chunked' }]) {
    assert.equal(settingsRequestValid(headers), false);
  }
});

test('TLS identity diagnostics retain only finite classes', () => {
  const token = 'synthetic-diagnostic-token';
  const diagnostic = tlsIdentityDiagnostic({ method: 'GET', url: '/unexpected?secret=synthetic-diagnostic-token',
    headers: { host: 'unknown.example', authorization: `Bearer ${token}` } }, token);
  assert.deepEqual(diagnostic, { method: 'get', path: 'other', host: 'other', authorization: 'expected' });
  assert.equal(JSON.stringify(diagnostic).includes(token), false);
  assert.equal(tlsIdentityDiagnostic({ method: 'POST', url: '/v1/responses',
    headers: { host: 'inference.fixture.invalid' } }, token).authorization, 'absent');
  assert.equal(tlsIdentityDiagnostic({ method: 'GET', url: '/v1/models?client_version=0.157.1',
    headers: { host: 'inference.fixture.invalid', authorization: `Bearer ${token}` } }, token).path, 'models');
  assert.equal(tlsIdentityDiagnostic({ method: 'GET', url: '/v1/models?client_version=0.157.1&other=1',
    headers: { host: 'inference.fixture.invalid', authorization: `Bearer ${token}` } }, token).path, 'other');
  assert.equal(tlsRequestRoute('GET', '/v1/models?client_version=0.157.1'), 'catalog');
  assert.equal(tlsRequestRoute('GET', '/api/codex/settings/user'), 'settings');
  assert.equal(tlsIdentityDiagnostic({ method: 'GET', url: '/api/codex/settings/user',
    headers: { host: 'accounts.fixture.invalid', authorization: `Bearer ${token}` } }, token).path, 'user_settings');
  for (const path of ['/api/codex/settings', '/api/codex/settings/user/',
    '/api/codex/settings/user?x=1', '/wham/settings/user']) {
    assert.equal(tlsRequestRoute('GET', path), 'unknown');
  }
  assert.equal(tlsRequestRoute('POST', '/api/codex/settings/user'), 'unknown');
  for (const path of ['/v1/models', '/v1/models?client_version=0.157.2',
    '/v1/models?client_version=0.157.1&other=1']) assert.equal(tlsRequestRoute('GET', path), 'unknown');
  assert.equal(tlsRequestRoute('POST', '/v1/models?client_version=0.157.1'), 'unknown');
  for (const [path, kind] of [
    ['/api/codex/tasks', 'task_create'], ['/wham/accounts/send_add_credits_nudge_email', 'credits_nudge'],
    ['/api/codex/usage/thread_usage/query', 'thread_usage'], ['/v1/traces', 'otel_traces'],
    ['/codex/analytics-events/events', 'analytics_events'],
  ]) {
    const observed = tlsIdentityDiagnostic({ method: 'POST', url: path,
      headers: { host: 'accounts.fixture.invalid', authorization: `Bearer ${token}` } }, token);
    assert.equal(observed.path, kind);
    assert.equal(tlsRequestRoute('POST', path), 'unknown');
  }
  assert.equal(tlsIdentityDiagnostic({ method: 'POST', url: '/api/codex/tasks?token=synthetic-diagnostic-token',
    headers: { host: 'accounts.fixture.invalid' } }, token).path, 'other');
  const structure = deniedPathStructure('/api/codex/threads/synthetic-diagnostic-token/turns?account_id=private&unknown=secret');
  assert.deepEqual(structure, { shape: 'path', segments: ['api', 'codex', 'threads', 'opaque', 'turns'],
    extraSegments: false, query: ['account_id', 'other'] });
  assert.equal(JSON.stringify(structure).includes('synthetic-diagnostic-token'), false);
  assert.equal(JSON.stringify(structure).includes('private'), false);
  assert.deepEqual(deniedPathStructure('/codex/analytics-events/events'),
    { shape: 'path', segments: ['codex', 'analytics-events', 'events'], extraSegments: false, query: 'none' });
  assert.equal(deniedPathStructure('https://unknown.invalid/api/codex/tasks').shape, 'invalid');
});

test('tool command probes guest proxy and broker aliases before commit', () => {
  const command = transportProbeCommand('/tmp/task/workspace', '/tmp/protected/canary',
    '/tmp/sibling/canary', 39173, '/mounts/relay/broker.sock');
  assert.ok(command.indexOf('PROXY_DIRECT_DENIED') < command.indexOf('exact protected Codex commit bytes'));
  for (const marker of ['BROKER_CONNECT_DENIED', 'BROKER_SYMLINK_DENIED', 'BROKER_PROC_DENIED',
    'BROKER_FD_DENIED']) assert.ok(command.includes(marker));
  assert.throws(() => transportProbeCommand('/tmp/task/workspace', '/tmp/protected/canary',
    '/tmp/sibling/canary', 39173, '/mounts/relay/../../bad'));
  assert.equal(transportMarkersValid('no output'), false);
  const output = `Process exited with code 0\nOutput:\n${[
    'PROXY_DIRECT_DENIED', 'BROKER_CONNECT_DENIED', 'BROKER_SYMLINK_DENIED',
    'BROKER_PROC_DENIED', 'BROKER_FD_DENIED', ...SEED_DENIAL_MARKERS, 'commit output',
  ].join('\n')}\n`;
  assert.equal(transportMarkersValid(output), true);
  assert.equal(transportMarkersValid(output.replace('BROKER_FD_DENIED\n', '')), false);
  const root = '/tmp/passeur-codex-protected-worker-abcdef';
  const shaped = transportProbeCommand(`${root}/worktrees/12345678-1234-1234-1234-123456789abc`,
    `${root}/protected/auth-canary`, `${root}/sibling/sibling-canary`, 39173, '/mounts/relay/provider.sock');
  assert.ok(Buffer.byteLength(nativePresentedFixedCommand(shaped)) <= 4096);
});

test('transport oracle rejects missing broker retirement, refresh attempt and publication gaps', () => {
  const report = { status: 'accepted_synthetic_seeded_home', hostCanariesIntact: true,
    nativeOutputClean: true, retainedArtifactsClean: true, homeCanaryIntact: true,
    deliveryStatus: 'committed', transportPrepublicationValid: true,
    provider: TRANSPORT_LABELS.providerLabel, credential: TRANSPORT_LABELS.credentialLabel };
  const evidence = { brokerRetired: true, active: 0, unknown: 0, unapprovedDirect: 0,
    account: 1, settings: 1, catalog: 1, accountTunnels: 6, inference: 2, inferenceTunnels: 4,
    accepted: 10, oauth: 0, latchedDenied: 0, authLatched: false, terminalReason: null,
    account401Responses: 0, model401Selected: 0, model401WriteCompleted: 0,
    model401NativeReceipt: 'unobserved', account401ResponsesAtLatch: null,
    model401SelectedAtLatch: null, applicationsAfterLatch: 0,
    transportMarkersValid: true, fdInheritanceClean: true, toolFdObserved: true,
    retainedCleanBeforePublication: true };
  assert.equal(classifyTransport('positive', report, evidence), 'accepted_synthetic_tls_private_commit');
  assert.equal(tunnelCountsBounded(evidence), true);
  for (const invalid of [{ brokerRetired: false }, { active: 1 }, { unknown: 1 },
    { unapprovedDirect: 1 }, { oauth: 1 }, { accountTunnels: 1 }, { accountTunnels: 17 },
    { catalog: 0 }, { settings: 0 }, { settings: 2 }, { inferenceTunnels: 17 }, { fdInheritanceClean: false },
    { toolFdObserved: false },
    { transportMarkersValid: false }]) {
    assert.equal(classifyTransport('positive', report, { ...evidence, ...invalid }), 'incomplete');
  }
  assert.equal(classifyTransport('positive', { ...report, transportPrepublicationValid: false }, evidence), 'incomplete');
  assert.equal(classifyTransport('positive', { ...report, provider: 'passeur_fixture_loopback' }, evidence), 'incomplete');
  assert.equal(classifyTransport('positive', { ...report, credential: 'anonymous_fixed_synthetic' }, evidence), 'incomplete');
  const failed = { ...report, status: 'incomplete', executionStatus: 'failed',
    deliveryStatus: 'incomplete', privateResourceState: 'prepared', workerStop: 'confirmed',
    privateBefore: 'base', privateAfter: 'base', canonicalAfter: 'base', mainAfter: 'base',
    hookRan: false, bytesExact: false, nativeCommandCorrelated: false, providerOutput: null,
    transportPrepublicationValid: false, providerSequenceComplete: false,
    nativeResultCode: 'CODEX_PROTECTED_REFRESH_DENIED' };
  const accountFailed = { ...failed, accountChecks: 2, providerRequests: 0 };
  const accountFailure = { ...evidence, account: 2, settings: 0, catalog: 0, oauth: 1,
    inference: 0, inferenceTunnels: 0, accountTunnels: 3, accepted: 4, authLatched: true,
    terminalReason: 'refresh_denied',
    account401Responses: 2, account401ResponsesAtLatch: 2,
    fdInheritanceClean: false, toolFdObserved: false, transportMarkersValid: false };
  assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure, oauth: 0 }), 'incomplete');
  assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure, account: 1 }), 'incomplete');
  assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure, inference: 1 }), 'incomplete');
  assert.equal(classifyTransport('account-401', accountFailed, accountFailure),
    'accepted_synthetic_account_401_refresh_denial_confirmed_stop');
  for (const invalid of [{ account401Responses: 1 }, { account401ResponsesAtLatch: 1 },
    { applicationsAfterLatch: 1 }, { account: 3 }, { toolFdObserved: true },
    { transportMarkersValid: true }]) {
    assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure, ...invalid }), 'incomplete');
  }
  for (const invalid of [{ privateAfter: 'changed' }, { hookRan: true }, { bytesExact: true },
    { nativeCommandCorrelated: true }, { providerOutput: 'tool output' },
    { transportPrepublicationValid: true }]) {
    assert.equal(classifyTransport('account-401', { ...accountFailed, ...invalid }, accountFailure), 'incomplete');
  }
  assert.equal(classifyTransport('account-401', { ...accountFailed, nativeResultCode: null }, accountFailure), 'incomplete');
  assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure, authLatched: false }), 'incomplete');
  assert.equal(classifyTransport('account-401', accountFailed, { ...accountFailure,
    catalog: 1, inferenceTunnels: 1, accepted: 5 }),
  'accepted_synthetic_account_401_refresh_denial_confirmed_stop');
  assert.equal(classifyTransport('account-401', { ...accountFailed, deliveryStatus: 'committed' },
    accountFailure), 'incomplete');
  const modelFailed = { ...failed, accountChecks: 1, providerRequests: 1,
    nativeResultCode: 'CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED' };
  const modelFailure = { ...evidence, settings: 0, catalog: 0, oauth: 0, inference: 1, inferenceTunnels: 1,
    accountTunnels: 2, accepted: 3, authLatched: true, terminalReason: 'upstream_unauthorized',
    model401Selected: 1, model401SelectedAtLatch: 1,
    fdInheritanceClean: false, toolFdObserved: false,
    transportMarkersValid: false };
  assert.equal(classifyTransport('model-401', modelFailed, { ...modelFailure, inference: 0 }), 'incomplete');
  assert.equal(classifyTransport('model-401', modelFailed, modelFailure),
    'accepted_synthetic_model_401_upstream_unauthorized_confirmed_stop');
  assert.equal(classifyTransport('model-401', { ...modelFailed, hookRan: true }, modelFailure), 'incomplete');
  assert.equal(classifyTransport('model-401', { ...modelFailed, providerSequenceComplete: true }, modelFailure), 'incomplete');
  assert.equal(classifyTransport('model-401', modelFailed, { ...modelFailure,
    catalog: 1, inferenceTunnels: 2, accepted: 4 }),
  'accepted_synthetic_model_401_upstream_unauthorized_confirmed_stop');
  assert.equal(classifyTransport('model-401', modelFailed, { ...modelFailure,
    catalog: 1, settings: 1, accountTunnels: 3, inferenceTunnels: 2, accepted: 5 }),
  'accepted_synthetic_model_401_upstream_unauthorized_confirmed_stop');
  assert.equal(classifyTransport('model-401', modelFailed, { ...modelFailure,
    catalog: 2, inferenceTunnels: 2, accepted: 4 }), 'incomplete');
  for (const invalid of [{ model401Selected: 0 }, { model401SelectedAtLatch: 0 },
    { model401WriteCompleted: 2 }, { inference: 2 }, { oauth: 1 },
    { terminalReason: 'refresh_denied' }, { applicationsAfterLatch: 17 }]) {
    assert.equal(classifyTransport('model-401', modelFailed, { ...modelFailure, ...invalid }), 'incomplete');
  }
  assert.equal(classifyTransport('model-401', modelFailed,
    { ...modelFailure, applicationsAfterLatch: 1 }),
  'accepted_synthetic_model_401_upstream_unauthorized_confirmed_stop');
  assert.equal(classifyTransport('near-expiry', failed, { ...accountFailure, account: 0, accountTunnels: 1, accepted: 2 }), 'incomplete');
  const stale = { ...failed, nativeResultCode: 'CODEX_PROTECTED_AUTH_STALE', workerStop: 'not_started',
    privateAfter: 'base', hookRan: false, bytesExact: false, providerRequests: 0, accountChecks: 0,
    catalogChecks: 0, nativeCommandCorrelated: false, providerOutput: null,
    transportPrepublicationValid: false };
  const noTraffic = { ...evidence, account: 0, settings: 0, catalog: 0, inference: 0,
    accountTunnels: 0, inferenceTunnels: 0, accepted: 0, toolFdObserved: false };
  assert.equal(classifyTransport('near-expiry', stale, noTraffic),
    'accepted_synthetic_near_expiry_host_refusal_not_started');
  assert.equal(classifyTransport('near-expiry', { ...stale, providerRequests: 1 }, noTraffic), 'incomplete');
  assert.equal(classifyTransport('near-expiry', stale, { ...noTraffic, oauth: 1, accepted: 1 }), 'incomplete');
  const redirect = { ...evidence, settings: 0, catalog: 1, account: 6, accountTunnels: 7,
    inference: 0, inferenceTunnels: 1, oauth: 0, unknown: 6, accepted: 14,
    toolFdObserved: false, transportMarkersValid: false };
  const redirectFailed = { ...failed, accountChecks: 6, catalogChecks: 1, providerRequests: 0 };
  assert.equal(classifyTransport('redirect', redirectFailed, redirect),
    'accepted_synthetic_tls_redirect_refusal_confirmed_stop');
  for (const count of [1, 2, 3, 4, 5]) {
    assert.equal(classifyTransport('redirect', { ...redirectFailed, accountChecks: count }, {
      ...redirect, account: count, accountTunnels: count + 1, unknown: count, accepted: 2 * count + 2,
    }), 'accepted_synthetic_tls_redirect_refusal_confirmed_stop');
  }
  for (const invalid of [
    { unknown: 5, accepted: 13 }, { unknown: 7, accepted: 15 },
    { catalog: 0, inferenceTunnels: 0, accepted: 13 },
    { accountTunnels: 8, accepted: 15 }, { inferenceTunnels: 2, accepted: 15 },
    { inference: 1, inferenceTunnels: 2, accepted: 15 },
    { toolFdObserved: true }, { transportMarkersValid: true },
  ]) assert.equal(classifyTransport('redirect', redirectFailed, { ...redirect, ...invalid }), 'incomplete');
  assert.equal(classifyTransport('redirect', { ...redirectFailed, accountChecks: 7 }, {
    ...redirect, account: 7, accountTunnels: 8, unknown: 7, accepted: 16,
  }), 'incomplete');
  for (const invalid of [
    { deliveryStatus: 'committed' }, { hookRan: true }, { bytesExact: true },
    { privateAfter: 'changed' }, { providerOutput: 'tool output' },
    { transportPrepublicationValid: true }, { providerSequenceComplete: true },
  ]) assert.equal(classifyTransport('redirect', { ...redirectFailed, ...invalid }, redirect), 'incomplete');
  const wrongHost = { ...evidence, settings: 0, catalog: 0, account: 0, inference: 0,
    accountTunnels: 1, inferenceTunnels: 1, latchedDenied: 4, accepted: 6, authLatched: true,
    terminalReason: 'tls_refused', tlsSessions: 2, tlsNoRequestCloses: 1, tlsNoRequestAtLatch: 1,
    toolFdObserved: false, transportMarkersValid: false };
  const wrongHostFailed = { ...failed, accountChecks: 0, catalogChecks: 0, providerRequests: 0,
    nativeResultCode: 'CODEX_PROTECTED_TLS_REFUSED' };
  assert.equal(classifyTransport('wrong-host', wrongHostFailed, wrongHost),
    'accepted_synthetic_tls_wrong_host_refusal_confirmed_stop');
  assert.equal(classifyTransport('wrong-host', wrongHostFailed,
    { ...wrongHost, catalog: 1 }), 'incomplete');
  for (const invalid of [{ terminalReason: null }, { tlsNoRequestAtLatch: 0 },
    { tlsSessions: 0 }, { tlsSessions: 3 }, { applicationsAfterLatch: 1 },
    { account: 1 }, { settings: 1 }, { inference: 1 },
    { latchedDenied: 9, accepted: 11 },
    { tlsNoRequestCloses: 3 }])
    assert.equal(classifyTransport('wrong-host', wrongHostFailed, { ...wrongHost, ...invalid }), 'incomplete');
  assert.equal(classifyTransport('wrong-host', wrongHostFailed,
    { ...wrongHost, inferenceTunnels: 0, tlsSessions: 1, accepted: 5 }), 'incomplete');
  assert.equal(classifyTransport('wrong-host', wrongHostFailed,
    { ...wrongHost, inferenceTunnels: 4, accepted: 9 }),
  'accepted_synthetic_tls_wrong_host_refusal_confirmed_stop');
  assert.equal(classifyTransport('wrong-host', wrongHostFailed,
    { ...wrongHost, inferenceTunnels: 5, accepted: 10 }), 'incomplete');
  assert.equal(classifyTransport('wrong-host', { ...wrongHostFailed, workerStop: 'unconfirmed' }, wrongHost), 'incomplete');
  assert.equal(classifyTransport('wrong-host', { ...wrongHostFailed, nativeResultCode: 'CODEX_PROTECTED_REFRESH_DENIED' }, wrongHost), 'incomplete');
  for (const invalid of [{ hookRan: true }, { privateAfter: 'changed' }, { providerRequests: 1 },
    { providerOutput: 'tool output' }, { deliveryStatus: 'committed' },
    { transportPrepublicationValid: true }, { executionStatus: 'completed' }])
    assert.equal(classifyTransport('wrong-host', { ...wrongHostFailed, ...invalid }, wrongHost), 'incomplete');
  const untrustedCa = { ...evidence, settings: 0, catalog: 0, account: 0, inference: 0,
    accountTunnels: 2, inferenceTunnels: 1, latchedDenied: 3, accepted: 6, authLatched: true,
    terminalReason: 'tls_refused', tlsSessions: 3, tlsNoRequestCloses: 1, tlsNoRequestAtLatch: 1,
    toolFdObserved: false, transportMarkersValid: false };
  const untrustedFailed = { ...failed, accountChecks: 0, catalogChecks: 0, providerRequests: 0,
    nativeResultCode: 'CODEX_PROTECTED_TLS_REFUSED' };
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed, untrustedCa),
    'accepted_synthetic_tls_untrusted_ca_refusal_confirmed_stop');
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed,
    { ...untrustedCa, settings: 1 }), 'incomplete');
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed,
    { ...untrustedCa, catalog: 1 }), 'incomplete');
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed,
    { ...untrustedCa, inferenceTunnels: 2, accepted: 7 }), 'incomplete');
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed,
    { ...untrustedCa, tlsNoRequestAtLatch: 0 }), 'incomplete');
  assert.equal(classifyTransport('untrusted-ca', untrustedFailed,
    { ...untrustedCa, accountTunnels: 0, accepted: 4 }), 'incomplete');
  assert.equal(classifyTransport('untrusted-ca', { ...untrustedFailed, workerStop: 'unconfirmed' },
    untrustedCa), 'incomplete');
  const cancelled = { ...failed, executionStatus: 'cancelled', providerSequenceComplete: true,
    accountChecks: 1, catalogChecks: 1, providerRequests: 1 };
  const cancelledTunnel = { ...evidence, account: 1, settings: 1, catalog: 1, inference: 1,
    accountTunnels: 3, inferenceTunnels: 2, accepted: 5, toolFdObserved: false,
    transportMarkersValid: false };
  assert.equal(classifyTransport('cancel-tunnel', cancelled, cancelledTunnel),
    'accepted_synthetic_tls_tunnel_cancellation_confirmed_stop');
  for (const invalid of [{ privateAfter: 'changed' }, { hookRan: true },
    { nativeCommandCorrelated: true }, { providerOutput: { kind: 'unexpected' } },
    { transportPrepublicationValid: true }, { bytesExact: true },
    { deliveryStatus: 'committed' }, { providerSequenceComplete: false },
    { workerStop: 'unconfirmed' }])
    assert.equal(classifyTransport('cancel-tunnel', { ...cancelled, ...invalid }, cancelledTunnel),
      'incomplete');
  for (const invalid of [{ toolFdObserved: true }, { transportMarkersValid: true },
    { account: 0 }, { inference: 0 }, { model401Selected: 1 },
    { applicationsAfterLatch: 1 }])
    assert.equal(classifyTransport('cancel-tunnel', cancelled, { ...cancelledTunnel, ...invalid }),
      'incomplete');
  assert.equal(classifyTransport('cancel-tunnel', cancelled,
    { ...cancelledTunnel, unknown: 1, accepted: 6 }), 'incomplete');
});

test('all negative cases refuse publication before Coordinator even with positive-shaped native completion', () => {
  const report = { providerSequenceComplete: true, nativeOutputClean: true,
    homeCanaryIntactBeforePublication: true, providerFailure: null };
  const result = { status: 'completed', worker_stop: 'confirmed' };
  const evidence = { fdInheritanceClean: true, toolFdObserved: true, retainedCleanBeforePublication: true,
    brokerRetired: true, active: 0, unapprovedDirect: 0, account: 1, settings: 1,
    catalog: 1, inference: 2, accountTunnels: 3, inferenceTunnels: 3,
    accepted: 6, oauth: 0, unknown: 0, latchedDenied: 0, authLatched: false, terminalReason: null,
    account401Responses: 0, model401Selected: 0, applicationsAfterLatch: 0,
    transportMarkersValid: true };
  assert.equal(transportPrepublicationAccepted('positive', report, result, evidence, true, true), true);
  for (const caseName of CASES.filter(value => value !== 'positive')) {
    assert.equal(transportPrepublicationAccepted(caseName, report, result, evidence, true, true), false,
      `negative case ${caseName} must be downgraded before publication`);
  }
  assert.equal(transportPrepublicationAccepted('positive', report, result, evidence, false, true), false);
});

test('host socket descriptor scanner rejects an intentionally inherited socket', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const inherited = spawn('/usr/bin/sleep', ['10'],
    { stdio: ['ignore', 'ignore', 'ignore', server._handle.fd] });
  try {
    await new Promise((resolve, reject) => { inherited.once('spawn', resolve); inherited.once('error', reject); });
    assert.equal(await noInheritedHostSocketFds(inherited.pid), false);
    assert.deepEqual(await scanLiveToolSocketFds(process.pid, async (pid, status) => {
      if (pid !== inherited.pid || status !== 'inherited') return;
      const exited = new Promise(resolve => inherited.once('exit', resolve));
      inherited.kill('SIGTERM'); await exited;
    }), { clean: false, observed: false });
  } finally {
    if (inherited.exitCode === null && inherited.signalCode === null) {
      const exited = new Promise(resolve => inherited.once('exit', resolve));
      inherited.kill('SIGTERM'); await exited;
    }
    await new Promise(resolve => server.close(resolve));
  }
});

test('FD EACCES is skipped only after independent process identity proves exit', async () => {
  const child = spawn('/usr/bin/sleep', ['10'], { stdio: 'ignore' });
  const denied = () => Object.assign(new Error('synthetic proc access denied'), { code: 'EACCES' });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await assert.rejects(scanLiveToolSocketFds(process.pid, async () => {}, async pid => {
      if (pid === child.pid) throw denied();
      return 'clean';
    }), { code: 'EACCES' });
    const observed = await scanLiveToolSocketFds(process.pid, async () => {}, async pid => {
      if (pid !== child.pid) return 'clean';
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
      throw denied();
    });
    assert.equal(observed.clean, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
  }
});

test('tool descendant scan includes children spawned by a non-main thread', async () => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    parentPort.postMessage(child.pid);
    parentPort.once('message', () => { child.kill('SIGTERM'); parentPort.postMessage('stopped'); });
  `, { eval: true });
  try {
    const childPid = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    const mainChildren = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
    assert.equal(mainChildren.trim().split(/\s+/).includes(String(childPid)), false);
    assert.ok((await toolDescendants(process.pid)).includes(childPid));
  } finally {
    const stopped = new Promise(resolve => worker.once('message', resolve));
    worker.postMessage('stop');
    await stopped;
    await worker.terminate();
  }
});

test('installed synthetic TLS cases remain separate from focused tests',
  { skip: process.env.PASSEUR_CODEX_INSTALLED_TLS_GATE !== '1' }, async () => {
    for (const caseName of CASES) {
      const report = await runTransport(caseName);
      assert.notEqual(report.transportStatus, 'incomplete');
      assert.equal(report.transport.brokerRetired, true);
    }
  });
