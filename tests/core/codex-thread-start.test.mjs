import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assertFixtureMethod, classify, closeTransport, finalizeFixture, nativeArgs, parseLive,
  pinnedIdentity, PIN, preflightAndStart, safeReport, settleFixture, threadParams,
  verifyPinnedNative } from '../../scripts/qualify-codex-thread-start.mjs';

test('explicit launch gate and pinned binary identities', () => {
  for (const args of [[], ['--live'], ['--live', '--native', 'relative'],
    ['--live', '--native', '/bin/codex', 'extra']]) assert.throws(() => parseLive(args));
  assert.equal(parseLive(['--live', '--native', '/absolute/codex']), '/absolute/codex');
  assert.equal(PIN.version, 'codex-cli 0.157.1');
  assert.equal(PIN.binary, '3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970');
  assert.equal(PIN.companion, '67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0');
  assert.equal(pinnedIdentity(PIN.binary, PIN.companion, PIN.version), true);
  for (const changed of [[`0${PIN.binary.slice(1)}`, PIN.companion, PIN.version],
    [PIN.binary, `0${PIN.companion.slice(1)}`, PIN.version],
    [PIN.binary, PIN.companion, 'codex-cli 0.157.2']]) {
    assert.equal(pinnedIdentity(...changed), false);
  }
  const args = nativeArgs();
  assert.deepEqual(args, ['-c', 'forced_login_method="chatgpt"', '-c',
    'default_permissions="passeur-boundary"', '-c', 'model_provider="openai"', '-c',
    'mcp_servers={}', '-c', 'features.multi_agent=false', '-c', 'features.apps=false',
    '-c', 'features.plugins=false', '-c', 'features.image_generation=false', '-c',
    'web_search="disabled"', 'app-server']);
});

test('the admitted RPC has no prompt and methods exclude turns and input', () => {
  const request = threadParams('/tmp/fixture/workspace');
  assert.deepEqual(request, { model: 'gpt-6-astra', modelProvider: 'openai',
    cwd: '/tmp/fixture/workspace', permissions: 'passeur-boundary', ephemeral: true,
    allowProviderModelFallback: false });
  for (const method of ['turn/start', 'turn/interrupt', 'item/tool/requestUserInput',
    'item/commandExecution/requestApproval', 'command/exec']) {
    assert.throws(() => assertFixtureMethod(method), /outside allowlist/);
  }
  for (const method of ['initialize', 'account/read', 'config/read',
    'permissionProfile/list', 'skills/list', 'thread/start']) assert.doesNotThrow(() => assertFixtureMethod(method));
});

test('preflight fails closed at account before config or thread start', async () => {
  const calls = [];
  const transport = { request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'initialize') return { userAgent: 'test' };
    if (method === 'account/read') return { requiresOpenaiAuth: false, account: null };
    throw Error('Unexpected request');
  }, notify: async method => { calls.push([method]); } };
  await assert.rejects(preflightAndStart(transport, new AbortController().signal,
    { workspace: '/tmp/workspace', canonical: '/tmp/project', admin: '/tmp/project/admin',
      native: '/tmp/native' }));
  assert.deepEqual(calls.map(([method]) => method), ['initialize', 'initialized', 'account/read']);
});

function controlledNativeResponses(identity) {
  const { workspace, canonical, admin, native } = identity;
  const profile = { workspace_roots: { [workspace]: true, [canonical]: true },
    filesystem: { ':root': 'deny', ':minimal': 'read', ':slash_tmp': 'deny',
      ':tmpdir': 'deny', [native]: 'read',
      [`${native.slice(0, native.lastIndexOf('/'))}/codex-code-mode-host`]: 'read',
      [admin]: 'write', ':workspace_roots': { '.': 'write' } }, network: { enabled: true } };
  const settings = { cli_auth_credentials_store: 'file',
    skills: { include_instructions: false, bundled: { enabled: false } },
    memories: { use_memories: false, generate_memories: false } };
  const effectivePermissions = { 'passeur-boundary': { ...profile, description: null,
    extends: null, filesystem: { ...profile.filesystem, glob_scan_max_depth: null },
    network: { enabled: true, proxy_url: null, enable_socks5: null, socks_url: null,
      enable_socks5_udp: null, allow_upstream_proxy: null,
      dangerously_allow_non_loopback_proxy: null, dangerously_allow_all_unix_sockets: null,
      mode: null, domains: null, unix_sockets: null, allow_local_binding: null,
      mitm: null } } };
  const memoryOptions = ['version', 'dual_write', 'disable_on_external_context',
    'dedicated_tools', 'max_raw_memories_for_consolidation', 'max_unused_days',
    'max_rollout_age_days', 'max_rollouts_per_startup', 'min_rollout_idle_hours',
    'min_rate_limit_remaining_percent', 'extract_model', 'consolidation_model'];
  const memories = { ...settings.memories,
    ...Object.fromEntries(memoryOptions.map(key => [key, null])) };
  return {
    initialize: { userAgent: 'controlled-native' },
    'account/read': { requiresOpenaiAuth: true, account: { type: 'chatgpt' } },
    'config/read': { config: { model_provider: 'openai', default_permissions: 'passeur-boundary',
      forced_login_method: 'chatgpt', mcp_servers: {}, web_search: 'disabled',
      features: { multi_agent: false, apps: false, plugins: false, image_generation: false },
      permissions: effectivePermissions, chatgpt_base_url: 'https://chatgpt.com/backend-api/',
      cli_auth_credentials_store: 'file', skills: settings.skills, memories },
      origins: { default_permissions: { name: { type: 'sessionFlags' } } },
      layers: [{ name: { type: 'user', file: '/mounts/home/config.toml', profile: null },
        config: { ...settings, permissions: { 'passeur-boundary': profile } } },
      { name: { type: 'sessionFlags' }, config: { default_permissions: 'passeur-boundary',
        model_provider: 'openai', forced_login_method: 'chatgpt', mcp_servers: {},
        features: { multi_agent: false, apps: false, plugins: false, image_generation: false },
        web_search: 'disabled' } }] },
    'permissionProfile/list': { data: [{ id: 'passeur-boundary', allowed: true }], nextCursor: null },
    'skills/list': { data: [{ cwd: workspace, skills: [], errors: [] }] },
    'thread/start': { thread: { id: 'controlled-thread' }, cwd: workspace,
      model: 'gpt-6-astra', modelProvider: 'openai',
      activePermissionProfile: { id: 'passeur-boundary' } },
  };
}

test('complete preflight sends exact ordered methods and validates thread identity', async () => {
  const identity = { workspace: '/tmp/fixture/workspace', canonical: '/tmp/fixture/project',
    admin: '/tmp/fixture/project/worktrees/thread-start-fixture',
    native: '/tmp/fixture/bin/codex' };
  const responses = controlledNativeResponses(identity), calls = [], progress = [];
  const transport = { request: async (method, params) => {
    calls.push([method, params]); return responses[method];
  }, notify: async (method, params) => { calls.push([method, params]); } };
  assert.equal(await preflightAndStart(transport, new AbortController().signal, identity,
    method => progress.push(method)), true);
  assert.deepEqual(calls.map(([method]) => method), ['initialize', 'initialized', 'account/read',
    'config/read', 'permissionProfile/list', 'skills/list', 'thread/start']);
  assert.deepEqual(progress, ['initialize', 'account/read', 'config/read',
    'permissionProfile/list', 'skills/list', 'thread/start']);
  assert.deepEqual(calls.at(-1)[1], threadParams(identity.workspace));
  responses['thread/start'] = { ...responses['thread/start'],
    activePermissionProfile: { id: 'wrong-profile' } };
  await assert.rejects(preflightAndStart(transport, new AbortController().signal, identity),
    { code: 'CODEX_CONFIGURATION_MISMATCH' });
});

test('only confirmed namespace stop permits pass and cleanup', () => {
  const report = { stage: 'thread/start', thread: 'matched', namespace_stop: 'confirmed',
    transport_closed: true, protocol_clean: true, unexpected_native: false,
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: PIN.version,
    native_path: 'canonical_pinned', caller_home: 'canonical_caller',
    workspace: 'disposable_private_git' };
  assert.equal(classify(report), 'thread_start_passed');
  for (const change of [{ namespace_stop: 'unconfirmed' }, { transport_closed: false },
    { protocol_clean: false }, { native_sha256: null }, { companion_sha256: null },
    { native_version: 'mismatch' }, { native_path: 'canonical_candidate' },
    { unexpected_native: true }, { thread: 'not_started' }, { stage: 'skills/list' }]) {
    assert.equal(classify({ ...report, ...change }), 'incomplete');
  }
});

test('durable projection discards native errors, paths and response objects', () => {
  const privateText = 'secret-native-error-with-path-/home/person/auth.json';
  const projected = safeReport({ root: '/tmp/owned-fixture', status: 'incomplete', stage: privateText,
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: privateText,
    caller_home: privateText, native_path: privateText,
    workspace: privateText, thread: privateText, unexpected_native: false,
    transport_closed: false, namespace_stop: 'unconfirmed', root_removed: false,
    error: new Error(privateText), response: { auth: privateText } });
  assert.equal(projected.stage, 'setup');
  assert.equal(projected.native_version, 'mismatch');
  assert.equal(JSON.stringify(projected).includes(privateText), false);
  assert.equal(projected.caller_home, 'unverified');
  assert.equal(projected.native_path, 'unverified');
  assert.equal(Object.hasOwn(projected, 'error'), false);
  assert.equal(Object.hasOwn(projected, 'response'), false);
});

test('cleanup only follows full success; failed cleanup retains bounded report', async () => {
  const accepted = { root: '/tmp/fixture', stage: 'thread/start', thread: 'matched',
    namespace_stop: 'confirmed', transport_closed: true, protocol_clean: true,
    unexpected_native: false,
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: PIN.version,
    caller_home: 'canonical_caller', native_path: 'canonical_pinned',
    workspace: 'disposable_private_git', root_removed: false };
  const calls = [];
  const io = { rm: async () => { calls.push('rm'); },
    writeFile: async () => { calls.push('write'); } };
  assert.equal((await finalizeFixture({ ...accepted }, io)).status, 'thread_start_passed');
  assert.deepEqual(calls, ['rm']);
  calls.length = 0;
  assert.equal((await finalizeFixture({ ...accepted, namespace_stop: 'unconfirmed' }, io)).status, 'incomplete');
  assert.deepEqual(calls, ['write']);
  calls.length = 0;
  const failing = { rm: async () => { calls.push('rm'); throw Error('cleanup failed'); },
    writeFile: async () => { calls.push('write'); } };
  const retained = await finalizeFixture({ ...accepted }, failing);
  assert.equal(retained.status, 'incomplete');
  assert.equal(retained.root_removed, false);
  assert.deepEqual(calls, ['rm', 'write']);
});

test('wrong binary or companion never reaches the native version executable', async () => {
  const native = '/tmp/fixture/codex';
  const binary = Buffer.from('synthetic binary');
  const companion = Buffer.from('synthetic companion');
  const exact = { binary: createHash('sha256').update(binary).digest('hex'),
    companion: createHash('sha256').update(companion).digest('hex'), version: PIN.version };
  let executions = 0;
  const io = { lstat: async () => ({ isFile: () => true, mode: 0o100755 }),
    realpath: async path => path,
    readFile: async path => path === native ? binary : companion,
    execFileSync: () => { executions++; return PIN.version; } };
  await assert.rejects(verifyPinnedNative(native, '/tmp/fixture', io,
    { ...exact, binary: PIN.binary }));
  await assert.rejects(verifyPinnedNative(native, '/tmp/fixture', io,
    { ...exact, companion: PIN.companion }));
  assert.equal(executions, 0);
  assert.deepEqual(await verifyPinnedNative(native, '/tmp/fixture', io, exact),
    { binaryHash: exact.binary, companionHash: exact.companion, version: exact.version });
  assert.equal(executions, 1);
});

test('native version stderr is suppressed and raw rejection never enters report', async () => {
  const native = '/tmp/fixture/codex', secret = 'private-auth-stderr-/home/person/auth.json';
  const binary = Buffer.from('binary'), companion = Buffer.from('companion');
  const expected = { binary: createHash('sha256').update(binary).digest('hex'),
    companion: createHash('sha256').update(companion).digest('hex'), version: PIN.version };
  let options;
  const io = { lstat: async () => ({ isFile: () => true, mode: 0o100755 }),
    realpath: async path => path,
    readFile: async path => path === native ? binary : companion,
    execFileSync: (_path, _args, received) => { options = received; throw Error(secret); } };
  await assert.rejects(verifyPinnedNative(native, '/tmp/fixture', io, expected));
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(options.maxBuffer, 4096);
  const report = safeReport({ root: '/tmp/fixture', status: 'incomplete', stage: 'setup',
    native_sha256: null, companion_sha256: null, native_version: null,
    caller_home: 'canonical_caller', native_path: 'canonical_candidate',
    workspace: 'disposable_private_git', thread: 'not_started', unexpected_native: false,
    transport_closed: false, protocol_clean: false, namespace_stop: 'unconfirmed',
    root_removed: false, error: Error(secret) });
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('a malformed frame after matched thread response invalidates success before cleanup', async () => {
  const report = { stage: 'thread/start', thread: 'matched', namespace_stop: 'confirmed',
    transport_closed: false, protocol_clean: false, unexpected_native: false,
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: PIN.version,
    native_path: 'canonical_pinned', caller_home: 'canonical_caller',
    workspace: 'disposable_private_git' };
  const transport = { operationFailure: undefined, close: async () => {
    transport.operationFailure = Error('malformed native frame with private contents');
    return true;
  } };
  await closeTransport(report, transport);
  assert.equal(report.transport_closed, true);
  assert.equal(report.protocol_clean, false);
  assert.equal(classify(report), 'incomplete');
  assert.equal(JSON.stringify(safeReport({ ...report, root: '/tmp/fixture' })).includes('private contents'), false);
});

test('composed close, namespace audit and finalization remove only a clean fixture', async () => {
  const report = { root: '/tmp/fixture', stage: 'thread/start', thread: 'matched',
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: PIN.version,
    native_path: 'canonical_pinned', caller_home: 'canonical_caller',
    workspace: 'disposable_private_git', unexpected_native: false,
    transport_closed: false, protocol_clean: false, namespace_stop: 'unconfirmed',
    root_removed: false };
  const sequence = [], capture = { kind: 'controlled-capture' };
  const transport = { operationFailure: undefined, close: async () => {
    sequence.push('close'); return true;
  } };
  const io = { settleProtectedStop: async (seen, statusFile, closed) => {
    sequence.push('audit');
    assert.equal(seen, capture);
    assert.equal(statusFile, '/tmp/fixture/status');
    assert.equal(closed, true);
    return 'confirmed';
  }, finalizeFixture: final => finalizeFixture(final, {
    rm: async () => { sequence.push('remove'); },
    writeFile: async () => { sequence.push('retain'); } }) };
  const outcome = await settleFixture(report, transport,
    { statusFile: '/tmp/fixture/status' }, capture, io);
  assert.deepEqual(sequence, ['close', 'audit', 'remove']);
  assert.equal(outcome.status, 'thread_start_passed');
  assert.equal(outcome.root_removed, true);
});

test('late protocol failure retains root even after confirmed namespace stop', async () => {
  const report = { root: '/tmp/fixture', stage: 'thread/start', thread: 'matched',
    native_sha256: PIN.binary, companion_sha256: PIN.companion, native_version: PIN.version,
    native_path: 'canonical_pinned', caller_home: 'canonical_caller',
    workspace: 'disposable_private_git', unexpected_native: false,
    transport_closed: false, protocol_clean: false, namespace_stop: 'unconfirmed',
    root_removed: false };
  const sequence = [], privateText = 'raw-malformed-frame-with-auth-secret';
  const transport = { operationFailure: undefined, close: async () => {
    sequence.push('close'); transport.operationFailure = Error(privateText); return true;
  } };
  const io = { settleProtectedStop: async () => { sequence.push('audit'); return 'confirmed'; },
    finalizeFixture: final => finalizeFixture(final, {
      rm: async () => { sequence.push('remove'); },
      writeFile: async (_path, bytes) => {
        sequence.push('retain'); assert.equal(bytes.includes(privateText), false);
      } }) };
  const outcome = await settleFixture(report, transport,
    { statusFile: '/tmp/fixture/status' }, {}, io);
  assert.deepEqual(sequence, ['close', 'audit', 'retain']);
  assert.equal(outcome.status, 'incomplete');
  assert.equal(outcome.root_removed, false);
});

test('source has one thread request and no turn request', async () => {
  const source = await readFile(new URL('../../scripts/qualify-codex-thread-start.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/request\('thread\/start', threadParams\(workspace\)\)/g) ?? []).length, 1);
  assert.equal(source.includes("request('turn/start'"), false);
  assert.equal(source.includes("request('turn/interrupt'"), false);
  assert.equal(createHash('sha256').update(source).digest('hex').length, 64);
});
