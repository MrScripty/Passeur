#!/usr/bin/env node
// Disposable experiment boundary. This is an outer host wrapper, never an adapter fallback.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const ROOTS = ['/usr', '/bin', '/lib', '/lib64'];
const RESERVED = new Set(['/workspace', '/proc', '/dev', '/tmp']);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function sourceDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('SOURCE_INVALID', `${label} must be absolute`);
  try {
    const resolved = realpathSync(value);
    if (!lstatSync(resolved).isDirectory()) fail('SOURCE_INVALID', `${label} must be a directory`);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SOURCE_INVALID:')) throw error;
    fail('SOURCE_UNAVAILABLE', `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function guestPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value === '/') {
    fail('TARGET_INVALID', `${label} must be a normalized absolute path`);
  }
  if (RESERVED.has(value) || ROOTS.some((root) => value === root || value.startsWith(`${root}/`))) {
    fail('TARGET_RESERVED', `${label} overlaps a sandbox system mount`);
  }
  if (!value.startsWith('/mounts/')) fail('TARGET_INVALID', `${label} must be under /mounts`);
  return value;
}

function overlaps(a, b) {
  return a === b || a === '/' || b === '/' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function prepareSandbox(config, command) {
  if (!config || typeof config !== 'object') fail('CONFIG_INVALID', 'configuration object required');
  if (!Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== 'string')) {
    fail('COMMAND_INVALID', 'nonempty command array required');
  }
  const workspace = sourceDirectory(config.workspace, 'workspace');
  if (workspace === '/') fail('SOURCE_INVALID', 'workspace must not be the host root');
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  if (!Array.isArray(config.denied) || config.denied.length === 0) {
    fail('DENY_SET_REQUIRED', 'denied must list protected host directories');
  }
  const denied = config.denied.map((item, index) => sourceDirectory(item, `denied ${index}`));
  const assertNotDenied = (source, label) => {
    if (denied.some((protectedPath) => overlaps(source, protectedPath))) {
      fail('SOURCE_DENIED', `${label} overlaps a protected host directory`);
    }
  };
  assertNotDenied(workspace, 'workspace');
  const seenGuests = ['/workspace'];
  const writable = [workspace];
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv'];
  for (const root of ROOTS) if (existsSync(root)) {
    assertNotDenied(sourceDirectory(root, `system ${root}`), `system ${root}`);
    args.push('--ro-bind', root, root);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/mounts', '--bind', workspace, '/workspace');
  for (const [index, mount] of mounts.entries()) {
    if (!mount || !['ro', 'rw'].includes(mount.mode)) fail('MOUNT_INVALID', `mount ${index} needs mode ro or rw`);
    const source = sourceDirectory(mount.source, `mount ${index} source`);
    if (source === '/') fail('SOURCE_INVALID', `mount ${index} source must not be the host root`);
    assertNotDenied(source, `mount ${index} source`);
    const target = guestPath(mount.target, `mount ${index} target`);
    if (seenGuests.some((previous) => overlaps(previous, target))) fail('TARGET_OVERLAP', `mount ${index} target overlaps another guest mount`);
    if (mount.mode === 'rw' && writable.some((previous) => overlaps(previous, source))) {
      fail('WRITE_OVERLAP', `mount ${index} source overlaps another writable source`);
    }
    seenGuests.push(target);
    if (mount.mode === 'rw') writable.push(source);
    args.push('--dir', target, mount.mode === 'rw' ? '--bind' : '--ro-bind', source, target);
  }
  const env = config.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env) || env === null) fail('ENV_INVALID', 'env must be an object');
  const baseEnv = { HOME: '/workspace', TMPDIR: '/tmp', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const [key, value] of Object.entries({ ...baseEnv, ...env })) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || key.includes('\0') || value.includes('\0')) {
      fail('ENV_INVALID', `invalid environment entry ${key}`);
    }
    args.push('--setenv', key, value);
  }
  args.push('--chdir', '/workspace', '--', ...command);
  return { executable: 'bwrap', args, workspace, writable };
}

export function probeBubblewrap() {
  const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) fail('BWRAP_UNAVAILABLE', version.error?.message ?? version.stderr.trim());
  const probeArgs = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--clearenv'];
  for (const root of ROOTS) if (existsSync(root)) probeArgs.push('--ro-bind', root, root);
  probeArgs.push('--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true');
  const probe = spawnSync('bwrap', probeArgs, { encoding: 'utf8' });
  if (probe.status !== 0) fail('BWRAP_NAMESPACE_UNAVAILABLE', probe.error?.message ?? probe.stderr.trim());
  return version.stdout.trim();
}

export async function runSandbox(config, command) {
  const prepared = prepareSandbox(config, command);
  probeBubblewrap();
  return await new Promise((resolveResult, reject) => {
    const child = spawn(prepared.executable, prepared.args, { stdio: 'inherit', env: {} });
    const forward = (signal) => { if (child.exitCode === null) child.kill(signal); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const detach = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    child.once('error', (error) => { detach(); reject(error); });
    child.once('exit', (code, signal) => {
      detach();
      resolveResult(signal ? 128 + (osConstants.signals[signal] ?? 1) : code ?? 1);
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1 || separator !== 3) {
    console.error('usage: node scripts/experiment-worker-sandbox.mjs CONFIG.json -- COMMAND [ARGS...]');
    process.exitCode = 2;
  } else {
    try {
      const { readFileSync } = await import('node:fs');
      const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      process.exitCode = await runSandbox(config, process.argv.slice(separator + 1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
