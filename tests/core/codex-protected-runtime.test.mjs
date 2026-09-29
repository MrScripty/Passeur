import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertProtectedHomePolicy, protectedLaunch, settleProtectedStop } from '../../dist/src/agents/codex/protected-runtime.js';
import { nativeAuthPresent, runProtectedHost } from '../../dist/src/agents/codex/protected-host.js';
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
    const spec = JSON.parse(Buffer.from(launch.args[1], 'base64url').toString('utf8'));
    const args = spec.args;
    const at = args.indexOf('--bind', args.indexOf(f.workspace));
    assert.ok(args.includes('--unshare-pid') && args.includes('--unshare-net') && args.includes('--die-with-parent'));
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
