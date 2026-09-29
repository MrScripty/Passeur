import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, readdir, stat, link, rename } from 'node:fs/promises';
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { assertProtectedHomePolicy, captureProtectedStartup, protectedLaunch, realProtectedPolicy,
  protectedSeedAdmissionRefused, settleProtectedStop } from '../../dist/src/agents/codex/protected-runtime.js';
import { initializeAfterProtectedCapture } from '../../dist/src/agents/codex/adapter.js';
import { credentialHoldback, nativeAuthPresent, PROTECTED_START_PERMIT, protectedProxyControlAuthority, runProtectedHost, snapshotCheckedSeed, startAfterProtectedProxyControl, syntheticAccessTokenFresh } from '../../dist/src/agents/codex/protected-host.js';
import { CodexStdio } from '../../dist/src/agents/codex/transport.js';
import { captureProtectedNamespace, verifyProtectedNamespaceStop } from '../../dist/src/core/protected-namespace.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'passeur-codex-protected-test-'));
  const workspace = join(root, 'workspace'), canonical = join(root, 'canonical.git');
  const control = join(root, 'control'), privateDir = join(control, 'private-git');
  const home = join(root, 'home'), native = join(root, 'native'), host = join(root, 'host.js');
  for (const path of [workspace, canonical, join(privateDir, 'worktrees', 'task'), home]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, '.git'), `gitdir: ${canonical}/worktrees/task\n`);
  await writeFile(join(privateDir, 'worktrees', 'task', 'commondir'), '../..\n');
  await writeFile(native, 'fixture executable'); await writeFile(host, 'fixture host');
  const config = `default_permissions = "passeur-boundary"\n` +
    `[permissions."passeur-boundary".workspace_roots]\n${JSON.stringify(workspace)} = true\n${JSON.stringify(canonical)} = true\n` +
    `[permissions."passeur-boundary".filesystem]\n":root" = "deny"\n":minimal" = "read"\n` +
    `":slash_tmp" = "deny"\n":tmpdir" = "deny"\n${JSON.stringify(native)} = "read"\n` +
    `${JSON.stringify(join(canonical, 'worktrees', 'task'))} = "write"\n` +
    `[permissions."passeur-boundary".filesystem.":workspace_roots"]\n"." = "write"\n` +
    `[permissions."passeur-boundary".network]\nenabled = false\n`;
  await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
  const input = { workspace, request: { mode: 'implement' }, private_git: { schema_version: 1,
    mount_kind: 'canonical_common_dir', view: { private_common_dir: privateDir,
      canonical_common_dir: canonical, admin_relative: 'worktrees/task' } } };
  return { root, workspace, canonical, privateDir, home, native, host, input, config,
    close: () => rm(root, { recursive: true, force: true }) };
}

test('protected launch places only the private Git common dir at the canonical guest path', async () => {
  const f = await fixture();
  try {
    const launch = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']);
    assert.ok(f.config.includes('[permissions."passeur-boundary".network]\nenabled = false\n'));
    assert.equal(launch.guestStartPermit, false);
    const spec = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8'));
    const args = spec.args;
    const at = args.indexOf('--bind', args.indexOf(f.workspace));
    assert.ok(args.includes('--unshare-pid') && args.includes('--unshare-net') && args.includes('--die-with-parent'));
    assert.equal(args.includes('/etc/resolv.conf'), false);
    assert.equal(args.includes('/etc/ssl/certs/ca-certificates.crt'), false);
    assert.equal(args.includes('--disable-userns'), false);
    assert.deepEqual(args.slice(at, at + 5), ['--bind', f.privateDir, f.canonical, '--ro-bind', f.native]);
    assert.ok(args.some((value, index) => value === '--ro-bind' &&
      args[index + 1]?.startsWith(`${join(f.root, 'control', 'codex-profile-')}`) &&
      args[index + 2] === '/mounts/home/config.toml'));
    assert.ok(args.indexOf('--tmpfs') < args.indexOf(f.workspace));
    assert.equal(args.filter(value => value === '--dir' && args[args.indexOf(value) + 1] === '/tmp').length, 0);
    assert.equal(args.at(-2), f.native);
    assert.equal(args.at(-1), 'app-server');
    assert.equal(spec.statusFile.startsWith(`${join(f.root, 'control')}/`), true);
    assert.deepEqual(launch.env, {});
  } finally { await f.close(); }
});

test('validated profile snapshot stays exact after the home source is replaced', async () => {
  const f = await fixture();
  try {
    const launch = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']);
    const args = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8')).args;
    const mount = args.findIndex((value, index) => value === '--ro-bind' && args[index + 2] === '/mounts/home/config.toml');
    assert.ok(mount >= 0);
    const snapshot = args[mount + 1];
    await writeFile(join(f.home, 'config.toml'), f.config.replace('enabled = false', 'enabled = true'));
    assert.equal(await readFile(snapshot, 'utf8'), f.config);
    assert.notEqual(await readFile(join(f.home, 'config.toml'), 'utf8'), await readFile(snapshot, 'utf8'));
  } finally { await f.close(); }
});

test('real caller home uses a generated task policy and inherited host network', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, 'config.toml'), 'model_provider = "untrusted"\n');
    const auth = join(f.home, 'auth.json');
    await writeFile(auth, 'dummy-login-before', { mode: 0o600 });
    await mkdir(join(f.home, 'skills'));
    await writeFile(join(f.home, 'AGENTS.md'), 'caller instructions');
    await writeFile(join(f.home, 'history.jsonl'), 'caller history');
    const launch = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
      undefined, undefined, false, true);
    const spec = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8'));
    const args = spec.args;
    assert.equal(args.includes('--unshare-net'), false);
    const dns = args.lastIndexOf('/etc/resolv.conf'), ca = args.lastIndexOf('/etc/ssl/certs/ca-certificates.crt');
    assert.deepEqual(args.slice(dns - 2, dns + 1), ['--ro-bind', realpathSync('/etc/resolv.conf'), '/etc/resolv.conf']);
    assert.deepEqual(args.slice(ca - 2, ca + 1), ['--ro-bind', realpathSync('/etc/ssl/certs/ca-certificates.crt'), '/etc/ssl/certs/ca-certificates.crt']);
    assert.ok(args.includes('/etc') && args.includes('/etc/ssl') && args.includes('/etc/ssl/certs'));
    assert.equal(args.some((value, index) => value === '--ro-bind' && args[index + 1] === '/etc'), false);
    assert.equal(args.some((value, index) => value === '--bind' && args[index + 1] === f.home), false);
    assert.ok(args.some((value, index) => value === '--bind-fd' && args[index + 1] === '4' &&
      args[index + 2] === '/mounts/home/auth.json'));
    assert.equal(args.includes(auth), false);
    assert.equal(spec.callerAuthFile, auth);
    assert.ok(args.some((value, index) => value === '--tmpfs' && args[index + 1] === '/mounts/home'));
    const index = args.findIndex((value, position) => value === '--ro-bind' && args[position + 2] === '/mounts/home/config.toml');
    assert.ok(index >= 0);
    const generated = realProtectedPolicy(f.workspace, f.canonical,
      join(f.canonical, 'worktrees', 'task'), f.native).toString();
    assert.ok(generated.includes('[permissions."passeur-boundary".network]\nenabled = true\n'));
    assert.equal(await readFile(args[index + 1], 'utf8'), generated);
    assert.equal((await readFile(args[index + 1], 'utf8')).includes('untrusted'), false);
    assert.equal(spec.seedFile, undefined);
    const inode = (await stat(auth)).ino;
    const authFd = openSync(auth, 0o10000000 | 0o400000);
    let mounted;
    try {
      mounted = spawnSync('bwrap', [...args.slice(0, args.indexOf('--')), '--', '/bin/sh', '-c',
        'test -f /mounts/home/auth.json && test -f /mounts/home/config.toml && ' +
        'test ! -e /proc/self/fd/4 && ' +
        'test ! -e /mounts/home/skills && test ! -e /mounts/home/AGENTS.md && ' +
        'test ! -e /mounts/home/history.jsonl && printf dummy-login-after > /mounts/home/auth.json'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ignore', authFd] });
    } finally { closeSync(authFd); }
    assert.equal(mounted.status, 0, mounted.stderr?.toString());
    assert.equal((await stat(auth)).ino, inode);
    assert.equal(await readFile(auth, 'utf8'), 'dummy-login-after');
    assert.equal(await readFile(join(f.home, 'AGENTS.md'), 'utf8'), 'caller instructions');
    await rename(auth, join(f.home, 'moved-auth'));
    await symlink(join(f.home, 'moved-auth'), auth);
    await assert.rejects(runProtectedHost(spec), /CODEX_PROTECTED_AUTH_INVALID/);
    for (const changed of [
      { ...spec, args: [...spec.args.slice(0, args.indexOf('--')), '--bind-fd', '4', '/mounts/other-auth', ...spec.args.slice(args.indexOf('--'))] },
      { ...spec, args: args.map(value => value === '/mounts/home/auth.json' ? '/mounts/other-auth' : value) },
      { ...spec, seedFile: join(f.root, 'seed-auth.json') },
    ]) await assert.rejects(runProtectedHost(changed), /CODEX_PROTECTED_HOST_CONFIG_INVALID/);
    assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
      { socketPath: '/tmp/nonexistent', port: 1 }, undefined, false, true),
      { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('real caller auth admission rejects absent, public, linked and symlinked files', async () => {
  const f = await fixture();
  const auth = join(f.home, 'auth.json');
  const launch = () => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
    undefined, undefined, false, true);
  try {
    assert.throws(launch, { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    await writeFile(auth, 'dummy', { mode: 0o644 });
    assert.throws(launch, { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    await chmod(auth, 0o600);
    const sibling = join(f.root, 'same-inode');
    await link(auth, sibling);
    assert.throws(launch, { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    await rm(sibling);
    await rm(auth);
    await symlink(join(f.root, 'other-auth'), auth);
    await writeFile(join(f.root, 'other-auth'), 'dummy', { mode: 0o600 });
    assert.throws(launch, { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('seeded launch copies a host-opened descriptor into a private guest home', async () => {
  const f = await fixture();
  try {
    const seed = join(f.root, 'seed-auth.json');
    await writeFile(seed, '{"synthetic":"secret"}', { mode: 0o600 });
    await writeFile(join(f.home, 'config.toml'), `chatgpt_base_url = "http://127.0.0.1:39173"\n${f.config}` +
      `[model_providers.passeur_fixture_loopback]\nname = "Passeur fixture"\n` +
      `base_url = "http://127.0.0.1:39173/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
    const relayDir = join(f.root, 'relay'); await mkdir(relayDir, { mode: 0o700 });
    const socket = join(relayDir, 'provider.sock');
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise(resolve => server.listen(socket, resolve));
    try {
      const launch = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
        { socketPath: socket, port: 39173 }, seed);
      assert.equal(launch.guestStartPermit, true);
      const spec = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8'));
      assert.equal(spec.seedFile, seed);
      assert.deepEqual(spec.args.slice(spec.args.indexOf('--file') - 2, spec.args.indexOf('--file') + 3),
        ['--perms', '0600', '--file', '4', '/mounts/home/auth.json']);
      assert.ok(spec.args.includes('--tmpfs'));
      assert.equal(spec.args.includes(seed), false);
      assert.equal(spec.args.some((value, index) => value === '--ro-bind' &&
        spec.args[index + 1]?.endsWith('/protected-egress.js')), false);
      assert.equal(JSON.stringify(launch).includes('secret'), false);
      await writeFile(join(f.home, 'config.toml'), (await readFile(join(f.home, 'config.toml'), 'utf8'))
        .replace('chatgpt_base_url = "http://127.0.0.1:39173"', 'chatgpt_base_url = "https://example.invalid"'));
      assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
        { socketPath: socket, port: 39173 }, seed), { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
      await chmod(seed, 0o644);
      await assert.rejects(runProtectedHost(spec), /CODEX_PROTECTED_SEED_INVALID/);
      await rm(seed);
      await symlink(f.native, seed);
      await assert.rejects(runProtectedHost(spec), /CODEX_PROTECTED_SEED_INVALID/);
      await rm(seed);
      execFileSync('/usr/bin/mkfifo', [seed]);
      await chmod(seed, 0o600);
      await assert.rejects(runProtectedHost(spec), /CODEX_PROTECTED_SEED_INVALID/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await f.close(); }
});

test('TLS seeded launch mounts only public CA and sets exact guest proxy environment', async () => {
  const f = await fixture();
  const seed = join(f.root, 'seed-auth.json'), ca = join(f.root, 'ca.pem');
  const relayDir = join(f.root, 'relay'); await mkdir(relayDir, { mode: 0o700 });
  const socket = join(relayDir, 'broker.sock');
  const { createServer } = await import('node:net');
  const server = createServer(); await new Promise(resolve => server.listen(socket, resolve));
  try {
    await writeFile(seed, '{"synthetic":"secret"}', { mode: 0o600 });
    await writeFile(ca, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    await writeFile(join(f.home, 'config.toml'),
      `chatgpt_base_url = "https://accounts.fixture.invalid"\n${f.config}` +
      `[model_providers.passeur_fixture_tls]\nname = "Passeur fixture"\n` +
      `base_url = "https://inference.fixture.invalid/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n` +
      `[analytics]\nenabled = false\n`);
    const relay = { socketPath: socket, port: 39173,
      tlsProxy: { caFile: ca, accountHost: 'accounts.fixture.invalid', inferenceHost: 'inference.fixture.invalid' } };
    const launch = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'], relay, seed);
    const spec = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8'));
    assert.equal(spec.tlsSeedAdmission, true);
    const args = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8')).args;
    assert.ok(args.includes('--unshare-net'));
    assert.ok(args.some((value, index) => value === '--ro-bind' &&
      args[index + 1]?.endsWith('/protected-egress.js')));
    assert.ok(args.some((value, index) => value === '--ro-bind' && args[index + 1] === ca &&
      args[index + 2] === '/mounts/ca.pem'));
    assert.ok(args.some((value, index) => value === '--setenv' && args[index + 1] === 'HTTPS_PROXY' &&
      args[index + 2] === 'http://127.0.0.1:39173'));
    assert.ok(args.some((value, index) => value === '--setenv' && args[index + 1] === 'CODEX_CA_CERTIFICATE' &&
      args[index + 2] === '/mounts/ca.pem'));
    for (const forbidden of ['NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'OPENAI_API_KEY']) assert.equal(args.includes(forbidden), false);
    assert.equal(args.includes('PRIVATE KEY'), false);
    assert.equal(args.includes(seed), false);
    const direct = protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'],
      { ...relay, tlsProxy: { ...relay.tlsProxy, directNoProxy: true } }, seed);
    const directArgs = JSON.parse(Buffer.from(direct.args[1], 'base64url').toString('utf8')).args;
    assert.equal(directArgs.includes('HTTPS_PROXY'), false);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
    const payload = exp => Buffer.from(JSON.stringify({ email: 'passeur-synthetic@example.invalid', exp,
      'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
    assert.equal(syntheticAccessTokenFresh(`${header}.${payload(now + 300)}.synthetic`, now), false);
    assert.equal(syntheticAccessTokenFresh(`${header}.${payload(now + 301)}.synthetic`, now), true);
    assert.equal(syntheticAccessTokenFresh(`${header}.${payload(now - 1)}.synthetic`, now), false);
    assert.equal(syntheticAccessTokenFresh(`${header}.${Buffer.from('{"email":"passeur-synthetic@example.invalid"}').toString('base64url')}.synthetic`, now), false);
    assert.equal(syntheticAccessTokenFresh(`${header}.invalid.synthetic`, now), false);
    const staleJwt = `${header}.${payload(now + 45)}.synthetic`;
    const staleBytes = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: staleJwt, access_token: staleJwt, refresh_token: 'synthetic-refresh',
        account_id: 'synthetic-account' } });
    await writeFile(seed, staleBytes);
    await assert.rejects(runProtectedHost(spec), /CODEX_PROTECTED_AUTH_STALE/);
    assert.equal(protectedSeedAdmissionRefused(spec.statusFile), true);
    assert.equal(await readFile(seed, 'utf8'), staleBytes);
    const policyPath = join(f.home, 'config.toml');
    const policy = await readFile(policyPath, 'utf8');
    for (const altered of [policy.replace('[analytics]\nenabled = false\n', '[analytics]\nenabled = true\n'),
      policy.replace('[analytics]\nenabled = false\n', '')]) {
      await writeFile(policyPath, altered);
      assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'], relay, seed),
        { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('first-party sealed home admits built-in openai and rejects origin or provider overrides', async () => {
  const f = await fixture();
  const seed = join(f.root, 'seed-auth.json'), ca = join(f.root, 'ca.pem');
  const relayDir = join(f.root, 'relay'); await mkdir(relayDir, { mode: 0o700 });
  const socket = join(relayDir, 'broker.sock');
  const server = createServer(); await new Promise(resolve => server.listen(socket, resolve));
  const firstParty = { socketPath: socket, port: 39173,
    tlsProxy: { caFile: ca, accountHost: 'chatgpt.com', inferenceHost: 'chatgpt.com', firstParty: true } };
  const profile = `model_provider = "openai"\n${f.config}[analytics]\nenabled = false\n`;
  try {
    await writeFile(seed, '{"synthetic":"secret"}', { mode: 0o600 });
    await writeFile(ca, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    await writeFile(join(f.home, 'config.toml'), profile, { mode: 0o600 });
    assert.equal(assertProtectedHomePolicy(f.home, f.workspace, f.canonical,
      join(f.canonical, 'worktrees', 'task'), f.native, undefined, firstParty.tlsProxy).toString(), profile);
    assert.equal(protectedProxyControlAuthority(Buffer.from(profile)), 'chatgpt.com:443');
    assert.equal(protectedLaunch(f.input, f.native, f.home, f.host, ['app-server'], firstParty, seed).guestStartPermit, true);
    for (const altered of [`chatgpt_base_url = "https://fixture.invalid"\n${profile}`,
      `${profile}[model_providers.openai]\nbase_url = "https://fixture.invalid"\n`]) {
      await writeFile(join(f.home, 'config.toml'), altered);
      assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host,
        ['app-server'], firstParty, seed), { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('guest proxy control selects only the two sealed local TLS variants', () => {
  const custom = Buffer.from('chatgpt_base_url = "https://accounts.fixture.invalid"\n' +
    'model_provider = "passeur_fixture_tls"\n[model_providers.passeur_fixture_tls]\n' +
    '[analytics]\nenabled = false\n');
  const firstParty = Buffer.from('model_provider = "openai"\n[analytics]\nenabled = false\n');
  assert.equal(protectedProxyControlAuthority(custom), 'accounts.fixture.invalid:443');
  assert.equal(protectedProxyControlAuthority(firstParty), 'chatgpt.com:443');
  for (const altered of [
    Buffer.from('model_provider = "openai"\nchatgpt_base_url = "https://accounts.fixture.invalid"\n' +
      '[model_providers.passeur_fixture_tls]\n[analytics]\nenabled = false\n'),
    Buffer.from('model_provider = "openai"\n[analytics]\nenabled = true\n'),
    Buffer.from('model_provider = "openai"\nmodel_provider = "other"\n[analytics]\nenabled = false\n'),
    Buffer.alloc(65_537, 120),
  ]) assert.throws(() => protectedProxyControlAuthority(altered), /CODEX_PROTECTED_GUEST_PROXY_CONTROL_INVALID/);
});

test('guest control requires HTTP 200 before native spawn for either sealed variant', async () => {
  const seen = [];
  let status = 200;
  const server = createHttpServer();
  server.on('connect', (request, socket) => {
    seen.push({ authority: request.url, host: request.headers.host });
    socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let spawned = 0;
  try {
    for (const authority of ['accounts.fixture.invalid:443', 'chatgpt.com:443']) {
      assert.equal(await startAfterProtectedProxyControl(port, authority, () => {}, () => ++spawned), spawned);
      assert.deepEqual(seen.at(-1), { authority, host: authority });
    }
    assert.equal(spawned, 2);
    status = 403;
    await assert.rejects(startAfterProtectedProxyControl(port, 'chatgpt.com:443', () => {}, () => ++spawned),
      /CODEX_PROTECTED_GUEST_PROXY_CONTROL_FAILED/);
    assert.equal(spawned, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('checked seed snapshot stays byte exact after its named source changes', async () => {
  const f = await fixture();
  const seed = join(f.root, 'seed-auth.json');
  let fd;
  try {
    await writeFile(seed, 'checked-seed', { mode: 0o600 });
    fd = snapshotCheckedSeed(await readFile(seed), f.root);
    await writeFile(seed, 'changed-source');
    const inheritedRead = Buffer.alloc(Buffer.byteLength('checked-seed'));
    assert.equal(readSync(fd, inheritedRead, 0, inheritedRead.length, null), inheritedRead.length);
    assert.equal(inheritedRead.toString('utf8'), 'checked-seed');
    assert.equal(readFileSync(`/proc/self/fd/${fd}`, 'utf8'), 'checked-seed');
    assert.equal((await readdir(f.root)).some(name => name.startsWith('.seed-snapshot-')), false);
  } finally { if (fd !== undefined) closeSync(fd); await f.close(); }
});

test('same-name permissive profile is rejected before protected launch', async () => {
  const f = await fixture();
  try {
    for (const replacement of [
      f.config.replace('":root" = "deny"', '":root" = "read"'),
      f.config.replace('enabled = false', 'enabled = true'),
      f.config.replace(`${JSON.stringify(f.canonical)} = true\n`, ''),
      f.config.replace(`${JSON.stringify(join(f.canonical, 'worktrees', 'task'))} = "write"\n`, ''),
      f.config.replace('"." = "write"', '"." = "write"\n".." = "write"'),
    ]) {
      await writeFile(join(f.home, 'config.toml'), replacement);
      assert.throws(() => assertProtectedHomePolicy(f.home, f.workspace, f.canonical,
        join(f.canonical, 'worktrees', 'task'), f.native),
        { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
      assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']),
        { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    }
  } finally { await f.close(); }
});

test('protected launch refuses a changed worktree pointer before spawning', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, '.git'), `gitdir: ${f.privateDir}/worktrees/task\n`);
    assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']),
      { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('protected launch refuses a symlinked worktree pointer', async () => {
  const f = await fixture();
  try {
    await rm(join(f.workspace, '.git'));
    await writeFile(join(f.root, 'pointer'), `gitdir: ${f.canonical}/worktrees/task\n`);
    const { symlink } = await import('node:fs/promises');
    await symlink(join(f.root, 'pointer'), join(f.workspace, '.git'));
    assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']),
      { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('protected launch refuses absent private authority and a symlinked canonical common dir', async () => {
  const f = await fixture();
  try {
    assert.throws(() => protectedLaunch({ ...f.input, private_git: undefined }, f.native, f.home, f.host,
      ['app-server']), { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
    const { symlink } = await import('node:fs/promises');
    await rm(f.canonical, { recursive: true });
    await symlink(f.privateDir, f.canonical);
    assert.throws(() => protectedLaunch(f.input, f.native, f.home, f.host, ['app-server']),
      { code: 'CODEX_PROTECTED_LAUNCH_INVALID' });
  } finally { await f.close(); }
});

test('host wrapper refuses a missing or ambiguous sandbox separator before spawning', async () => {
  await assert.rejects(runProtectedHost({ args: ['--unshare-pid'], statusFile: '/tmp/unused' }),
    /CODEX_PROTECTED_HOST_CONFIG_INVALID/);
  await assert.rejects(runProtectedHost({ args: ['--', '/bin/true', '--', '/bin/false'], statusFile: '/tmp/unused' }),
    /CODEX_PROTECTED_HOST_CONFIG_INVALID/);
});

test('guest relay projects native auth presence without forwarding values', () => {
  assert.equal(nativeAuthPresent({ accept: 'text/event-stream' }), false);
  assert.equal(nativeAuthPresent({ authorization: 'Bearer forbidden' }), true);
  assert.equal(nativeAuthPresent({ 'proxy-authorization': 'forbidden' }), true);
  assert.equal(nativeAuthPresent({ 'x-api-key': 'forbidden' }), true);
});

test('credential holdback blocks split stderr token and ignored stdout notification', async () => {
  const secrets = [Buffer.from('jwt.synthetic'), Buffer.from('synthetic-refresh')];
  for (const chunks of [
    ['benign stderr\nsynthetic-', 'refresh\n'],
    ['{"method":"ignored","value":"jwt.', 'synthetic"}\n'],
  ]) {
    let exposed = 0; const forwarded = [];
    const guard = credentialHoldback(secrets, () => { exposed++; });
    guard.on('data', chunk => forwarded.push(chunk));
    for (const chunk of chunks) guard.write(Buffer.from(chunk));
    guard.end();
    await new Promise(resolve => guard.once('finish', resolve));
    assert.equal(exposed, 1);
    assert.equal(containsAny(Buffer.concat(forwarded), secrets), false);
  }
  function containsAny(bytes, values) { return values.some(value => bytes.includes(value)); }
});

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startGuest(port, nativeArgs, options = {}) {
  const spec = { native: process.execPath, nativeArgs,
    socketPath: '/mounts/relay/fixture.sock', port };
  const child = spawn(process.execPath,
    [...(options.preload ? ['--require', options.preload] : []),
      join(process.cwd(), 'dist/src/agents/codex/protected-host.js'), 'guest',
      Buffer.from(JSON.stringify(spec)).toString('base64url')],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const close = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  if (options.permit !== false) child.stdin.write(PROTECTED_START_PERMIT);
  return { child, close };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error(`fixture did not start: ${path}`);
}

test('guest EOF and repeated SIGTERM stop only native and retire the relay', async () => {
  const f = await fixture();
  const port = await unusedPort();
  const started = join(f.root, 'started'), stopped = join(f.root, 'stopped');
  const native = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));` +
    `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});` +
    `process.stdin.resume();`;
  const { child, close } = startGuest(port, ['-e', native]);
  try {
    await waitForFile(started);
    const active = connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => { active.once('connect', resolve); active.once('error', reject); });
    const activeClosed = new Promise(resolve => active.once('close', resolve));
    child.stdin.end();
    child.kill('SIGTERM'); child.kill('SIGTERM');
    assert.deepEqual(await close, { code: 0, signal: null });
    assert.equal(await readFile(stopped, 'utf8'), 'stopped');
    await activeClosed;
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    }), { code: 'ECONNREFUSED' });
  } finally { child.kill('SIGKILL'); await f.close(); }
});

test('guest leaves a stubborn native unresolved until it actually closes', async () => {
  const f = await fixture();
  const started = join(f.root, 'started');
  const native = `require('node:fs').writeFileSync(${JSON.stringify(started)},'started');` +
    `process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(7),180);`;
  const port = await unusedPort();
  const { child, close } = startGuest(port, ['-e', native]);
  try {
    await waitForFile(started);
    child.stdin.end();
    assert.equal(await Promise.race([close.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 40))]), 'pending');
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    }), { code: 'ECONNREFUSED' });
    assert.deepEqual(await close, { code: 7, signal: null });
  } finally { child.kill('SIGKILL'); await f.close(); }
});

test('outer stop budget reports false while a stubborn direct native remains alive', async () => {
  const f = await fixture();
  const started = join(f.root, 'started');
  const port = await unusedPort();
  const spec = { native: process.execPath,
    nativeArgs: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));` +
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],
    socketPath: '/mounts/relay/fixture.sock', port };
  const transport = new CodexStdio({ command: process.execPath,
    args: [join(process.cwd(), 'dist/src/agents/codex/protected-host.js'), 'guest',
      Buffer.from(JSON.stringify(spec)).toString('base64url')], cwd: process.cwd(), env: process.env,
    request: async () => ({}), notification: () => {} });
  let nativePid;
  try {
    await transport.startProtectedGuest(new AbortController().signal);
    nativePid = Number(await waitForFile(started));
    assert.equal(await transport.close(80, 20), false);
    assert.equal(transport.exitEvidence, undefined);
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    }), { code: 'ECONNREFUSED' });
  } finally {
    if (nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch { /* Fixture may have exited. */ } }
    if (transport.pid) { try { process.kill(transport.pid, 'SIGKILL'); } catch { /* Fixture may have exited. */ } }
    await f.close();
  }
});

test('guest EOF before asynchronous startup prevents native spawn', async () => {
  const f = await fixture();
  const count = join(f.root, 'spawn-count'), preload = join(f.root, 'preload.cjs');
  await writeFile(preload, `const cp=require('node:child_process'),fs=require('node:fs');` +
    `const sync=require('node:module').syncBuiltinESMExports;fs.writeFileSync(${JSON.stringify(count)},'0');` +
    `const original=cp.spawn;cp.spawn=(...args)=>{fs.writeFileSync(${JSON.stringify(count)},'1');return original(...args)};sync();`);
  const { child, close } = startGuest(await unusedPort(), ['-e', 'process.exit(0)'],
    { permit: false, preload });
  try {
    child.stdin.end();
    assert.deepEqual(await close, { code: 143, signal: null });
    assert.equal(await readFile(count, 'utf8'), '0');
  } finally { child.kill('SIGKILL'); await f.close(); }
});

test('malformed protected start permit cannot spawn native', async () => {
  const f = await fixture();
  const count = join(f.root, 'spawn-count'), preload = join(f.root, 'preload.cjs');
  await writeFile(preload, `const cp=require('node:child_process'),fs=require('node:fs');` +
    `const sync=require('node:module').syncBuiltinESMExports;fs.writeFileSync(${JSON.stringify(count)},'0');` +
    `const original=cp.spawn;cp.spawn=(...args)=>{fs.writeFileSync(${JSON.stringify(count)},'1');return original(...args)};sync();`);
  const { child, close } = startGuest(await unusedPort(), ['-e', 'process.exit(0)'],
    { permit: false, preload });
  try {
    child.stdin.end('PASSEUR_PROTECTED_START_V2\n');
    assert.deepEqual(await close, { code: 1, signal: null });
    assert.equal(await readFile(count, 'utf8'), '0');
  } finally { child.kill('SIGKILL'); await f.close(); }
});

test('protected start permit is consumed and the first native frame stays byte exact', async () => {
  const f = await fixture();
  const output = join(f.root, 'native-input');
  const native = `let bytes='';process.stdin.on('data',chunk=>{bytes+=chunk.toString();` +
    `if(bytes.includes('\\n')){require('node:fs').writeFileSync(${JSON.stringify(output)},bytes);process.exit(0)}});`;
  const { child, close } = startGuest(await unusedPort(), ['-e', native]);
  const frame = '{"id":"passeur:1","method":"initialize","params":{"x":1}}\n';
  try {
    child.stdin.write(frame);
    assert.deepEqual(await close, { code: 0, signal: null });
    assert.equal(await readFile(output, 'utf8'), frame);
  } finally { child.kill('SIGKILL'); await f.close(); }
});

test('direct protected capture sends native initialize with zero permit bytes', async () => {
  const f = await fixture();
  const output = join(f.root, 'direct-native-input');
  const native = `let bytes='';process.stdin.on('data',chunk=>{bytes+=chunk.toString();` +
    `if(bytes.includes('\\n')){require('node:fs').writeFileSync(${JSON.stringify(output)},bytes);` +
    `process.stdout.write(JSON.stringify({id:'passeur:1',result:{userAgent:'fixture'}})+'\\n')}});`;
  const transport = new CodexStdio({ command: process.execPath, args: ['-e', native],
    cwd: process.cwd(), env: process.env, request: async () => ({}), notification: () => {} });
  try {
    let retained = false;
    const result = await initializeAfterProtectedCapture(
      { statusFile: 'fixture', nativePath: process.execPath, guestStartPermit: false },
      () => { retained = true; },
      () => transport.request('initialize', { x: 1 }, new AbortController().signal),
      new AbortController().signal, undefined, async () => ({ nativePid: transport.pid }),
      async () => { throw new Error('direct native received a guest permit'); });
    assert.equal(retained, true);
    assert.deepEqual(result, { userAgent: 'fixture' });
    assert.equal(await readFile(output, 'utf8'), '{"id":"passeur:1","method":"initialize","params":{"x":1}}\n');
  } finally { await transport.close(200); await f.close(); }
});

test('guest SIGTERM during native work waits for direct child close', async () => {
  const f = await fixture();
  const started = join(f.root, 'started'), stopped = join(f.root, 'stopped');
  const native = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');` +
    `process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(stopped)},'closed');process.exit(0)},30));` +
    `process.stdin.resume();`;
  const { child, close } = startGuest(await unusedPort(), ['-e', native]);
  try {
    await waitForFile(started);
    child.kill('SIGTERM');
    assert.deepEqual(await close, { code: 0, signal: null });
    assert.equal(await readFile(stopped, 'utf8'), 'closed');
  } finally { child.kill('SIGKILL'); await f.close(); }
});

function observer() {
  const state = { stopped: false, closed: false, status: [
    { kind: 'wrapper', pid: 41 }, { 'child-pid': 42 },
  ] };
  const process = pid => ({ pid, parent: pid === 42 ? 41 : 0,
    start: `${pid}`, pidns: pid === 42 ? 'pid:[2]' : 'pid:[1]',
    netns: pid === 42 ? 'net:[2]' : 'net:[1]', nspid: pid === 42 ? [42, 1] : [41], exe: pid === 42 ? '/bin/codex' : '/usr/bin/bwrap' });
  const io = { status: async () => state.status.map(value => JSON.stringify(value)).join('\n') + '\n',
    boot: async () => 'boot', identity: async pid => { if (state.stopped) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return process(pid); },
    members: async () => state.stopped ? [] : [process(42)],
    openNamespace: async () => ({ fd: 7, close: async () => { state.closed = true; } }),
    heldNamespace: async () => 'pid:[2]', executable: async () => ({ dev: 1, ino: 2 }) };
  return { state, io };
}

test('shared observer requires exact native identity and whole-namespace retirement', async () => {
  const f = observer();
  const captured = await captureProtectedNamespace('status', '/bin/codex', '/bin/codex', f.io);
  f.state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await verifyProtectedNamespaceStop(captured, 'status', f.io), false);
  assert.equal(f.state.closed, true);
  const next = observer();
  const captured2 = await captureProtectedNamespace('status', '/bin/codex', '/bin/codex', next.io);
  next.state.stopped = true;
  next.state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await verifyProtectedNamespaceStop(captured2, 'status', next.io), true);
});

test('startup capture waits for native association before initialize and retains one handle through normal stop', async () => {
  const f = observer();
  const members = f.io.members;
  let scans = 0, closes = 0;
  f.io.members = async namespace => ++scans === 1 ? [] : members(namespace);
  f.io.openNamespace = async () => ({ fd: 7, close: async () => { closes++; } });
  const captured = await captureProtectedStartup('status', '/bin/codex', f.io);
  assert.equal(scans, 2);
  assert.equal(closes, 1, 'failed association releases its attempted descriptor');
  assert.equal(captured.nativePid, 42);
  // Native initialize is permitted only after capture has returned its owned descriptor.
  const initialized = captured.namespaceFd.fd === 7;
  assert.equal(initialized, true);
  f.state.stopped = true;
  f.state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await settleProtectedStop(captured, 'status', true, f.io), 'confirmed');
  assert.equal(closes, 2);
});

test('pre-initialize terminal abort retains capture for a confirmed stop audit', async () => {
  const f = observer();
  const terminal = new AbortController();
  const captured = await captureProtectedStartup('status', '/bin/codex', f.io);
  terminal.abort(new Error('fixture TLS refusal'));
  assert.equal(terminal.signal.aborted, true);
  assert.equal(f.state.closed, false, 'abort does not release the sole namespace handle');
  f.state.stopped = true;
  f.state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await settleProtectedStop(captured, 'status', true, f.io), 'confirmed');
  assert.equal(f.state.closed, true);
});

test('failed transport close still audits and releases the captured namespace once', async () => {
  const f = observer();
  const captured = await captureProtectedNamespace('status', '/bin/codex', '/bin/codex', f.io);
  assert.equal(await settleProtectedStop(captured, 'status', false, f.io), 'unconfirmed');
  assert.equal(f.state.closed, true);
});

test('namespace handle close failure retains unconfirmed stop', async () => {
  const f = observer();
  f.io.openNamespace = async () => ({ fd: 7, close: async () => { throw new Error('close failed'); } });
  const captured = await captureProtectedNamespace('status', '/bin/codex', '/bin/codex', f.io);
  f.state.stopped = true;
  f.state.status.push({ 'exit-code': 0 }, { kind: 'wrapper-exit', code: 0, signal: null });
  assert.equal(await settleProtectedStop(captured, 'status', true, f.io), 'unconfirmed');
});
