import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertUnchanged, classifyCommand, classifySandboxSetup, loadManifest, qualifyFixtureApps, runBoundedProcess,
  installedRustEnvironment, sandboxArguments, snapshotProtected, waitedChildCpuMilliseconds } from
  '../../scripts/qualify-fixture-apps.mjs';
import { selectPeerOverlapEvidence } from '../../.passeur-core/src/observation/overlap.js';
import { createHash } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { spawnSync } from 'node:child_process';

async function qualificationCase(id, source, build) {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-fixture-command-'));
  const apps = join(directory, 'apps'), oracles = join(directory, 'oracles');
  await mkdir(join(apps, 'case'), { recursive: true });
  await mkdir(oracles);
  await writeFile(join(apps, 'case', 'build.mjs'), source);
  await writeFile(join(oracles, `${id}.json`), JSON.stringify({ id,
    functional: [{ id: 'normal', argv: ['normal'], stdout: 'normal\n' }] }));
  const row = { id, root: 'case', toolchain: id === 'L02' ? 'TypeScript 5.9.3; Node.js 24.12.0' :
    'Node.js 24.12.0', entrypoint: 'build.mjs',
    sources: [{ path: 'build.mjs',
    sha256: createHash('sha256').update(source).digest('hex') }], build,
    runs: [{ case_id: 'normal', argv: ['node', 'build.mjs', 'normal'], input_argv: ['normal'] }] };
  const manifestPath = join(directory, 'manifest.json');
  const save = () => writeFile(manifestPath, JSON.stringify({ schema_version: 1, rows: [row] }));
  await save();
  return { directory, apps, oracles, row, manifestPath, save,
    qualify: () => qualifyFixtureApps({ manifestPath, appRoot: apps, oracleRoot: oracles }) };
}

test('authored two-edit overlap selects a stable quote body and excludes an unrelated symbol', async () => {
  const oracle = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../oracles/fixture-apps/L02.json', import.meta.url), 'utf8'));
  const entry = oracle.syntax[0];
  const file = (id, text) => ({ status: 'present', text, mode: '100644',
    byte_length: Buffer.byteLength(text), content_sha256: createHash('sha256').update(text).digest('hex'),
    consistency: 'sampled_file_not_atomic', source: { kind: 'working_capture',
      repository_id: 'fixture-oracle', object_format: 'sha1', workspace_id: id,
      workspace_generation: 1, capture_id: id, capture_sequence: 1,
      head_anchor: 'a'.repeat(40), path: entry.path } });
  const declaration = (text, digest) => ({ key: 'quote', kind: 'function_declaration', name: 'quote',
    enclosing: [], range: { start_byte: 0, end_byte: Buffer.byteLength(text.trimEnd()) },
    signature: 'export function quote(cents: number): number', parameters: ['cents: number'],
    result: { state: 'declared', syntax: ': number' }, header_complete: true,
    body_digest: digest, default_digests: [] });
  const input = file('input', entry.source);
  const base = { input, dialect: 'typescript', parser_identity: 'tree-sitter-typescript@1',
    extractor_identity: 'native-declarations@1', subject_id: 'quote',
    declaration: declaration(entry.source, 'authored-input-body') };
  const observation = (id, text) => ({ observation_id: id, observed: file(id, text),
    change: { kind: 'modified', declaration_changed: false, body_changed: true, default_changed: false,
      input: base.declaration, observed: declaration(text, `authored-${id}-body`) } });
  const forward = selectPeerOverlapEvidence({ ...base,
    observations: [observation('left', entry.left), observation('right', entry.right)] });
  const reverse = selectPeerOverlapEvidence({ ...base,
    observations: [observation('right', entry.right), observation('left', entry.left)] });
  assert.deepEqual(forward, reverse);
  assert.equal(forward.changes.length, 2);
  assert.ok(forward.changes.every(change => change.reasons.includes('body_changed')));
  assert.equal(JSON.stringify(forward).includes('unrelated'), false);
});

test('missing integrator manifest is failed artifact evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-absent-manifest-'));
  try {
    const result = await qualifyFixtureApps({ manifestPath: join(directory, 'absent.json') });
    assert.equal(result.status, 'failed');
    assert.equal(result.rows.length, 13);
    assert.ok(result.rows.every(row => row.status === 'failed' && row.reason === 'manifest_missing'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('protected app and oracle trees detect modifications and additions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-protection-oracle-'));
  const apps = join(directory, 'apps'), oracles = join(directory, 'oracles');
  try {
    await mkdir(apps); await mkdir(oracles);
    await writeFile(join(apps, 'quote.ts'), 'original');
    await writeFile(join(oracles, 'L01.json'), '{}');
    const before = await snapshotProtected({ apps, oracles });
    await writeFile(join(apps, 'quote.ts'), 'changed');
    const changed = await snapshotProtected({ apps, oracles });
    assert.throws(() => assertUnchanged(before, changed),
      { code: 'PROTECTED_MUTATION' });
    await writeFile(join(apps, 'quote.ts'), 'original');
    await writeFile(join(oracles, 'added.json'), '{}');
    const added = await snapshotProtected({ apps, oracles });
    assert.throws(() => assertUnchanged(before, added),
      { code: 'PROTECTED_MUTATION' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manifest rejects an undeclared or escaping local command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-command-contract-'));
  const manifestPath = join(directory, 'manifest.json');
  try {
    const row = { id: 'L01', root: 'rust', toolchain: 'Node.js 24.12.0', entrypoint: 'main.rs',
      sources: [{ path: 'main.rs', sha256: 'a'.repeat(64) }],
      build: { argv: ['node', 'build.mjs'] }, runs: [{ case_id: 'normal', argv: ['node', 'run.mjs', 'normal'], input_argv: ['normal'] }] };
    await writeFile(manifestPath, JSON.stringify({ schema_version: 1, rows: [row] }));
    assert.equal((await loadManifest(manifestPath)).rows.length, 1);
    row.build.argv = ['curl', 'https://example.com'];
    await writeFile(manifestPath, JSON.stringify({ schema_version: 1, rows: [row] }));
    await assert.rejects(loadManifest(manifestPath), { code: 'MANIFEST_COMMAND' });
    row.build.argv = ['node', 'build.mjs']; row.root = '../outside';
    await writeFile(manifestPath, JSON.stringify({ schema_version: 1, rows: [row] }));
    await assert.rejects(loadManifest(manifestPath), { code: 'MANIFEST_SCHEMA' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manifest requires bounded toolchain and entrypoint identities', async () => {
  const fixture = await qualificationCase('L01', 'console.log("normal");\n',
    { argv: ['node', 'build.mjs'] });
  try {
    assert.equal((await loadManifest(fixture.manifestPath)).rows[0].toolchain, 'Node.js 24.12.0');
    for (const field of ['toolchain', 'entrypoint']) {
      const original = fixture.row[field];
      fixture.row[field] = 'x'.repeat(256);
      await fixture.save();
      assert.equal((await loadManifest(fixture.manifestPath)).rows[0][field].length, 256);
      for (const invalid of [undefined, null, '', ' ', ' leading', 'trailing ',
        'x'.repeat(257), 'line\nbreak', {}, []]) {
        if (invalid === undefined) delete fixture.row[field];
        else fixture.row[field] = invalid;
        await fixture.save();
        await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_SCHEMA' });
      }
      fixture.row[field] = original;
    }
    await fixture.save();
    assert.equal((await loadManifest(fixture.manifestPath)).rows.length, 1);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('one exact declared build exit is blocked; a different exit fails', async () => {
  const fixture = await qualificationCase('L01', 'if (process.argv[2] !== "normal") process.exit(42); console.log("normal");\n',
    { argv: ['node', 'build.mjs'], blocked_exit_code: 42 });
  try {
    const blocked = (await fixture.qualify()).rows.find(row => row.id === 'L01');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'declared_build_blocked_exit');
    assert.equal(blocked.actual.code, 42);
    fixture.row.build.blocked_exit_code = 43;
    await fixture.save();
    const failed = (await fixture.qualify()).rows.find(row => row.id === 'L01');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'build_failed');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('blocked build metadata is bounded and forbidden on runs', async () => {
  const fixture = await qualificationCase('L01', 'process.exit(0);\n', { argv: ['node', 'build.mjs'] });
  try {
    for (const invalid of [0, -1, 256, 1.5, '42', null, true, [], {}]) {
      fixture.row.build.blocked_exit_code = invalid;
      await fixture.save();
      await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' });
    }
    fixture.row.build.blocked_exit_code = 42;
    fixture.row.runs = [{ case_id: 'normal', argv: ['node', 'build.mjs', 'normal'], input_argv: ['normal'], blocked_exit_code: 42 }];
    await fixture.save();
    await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('sandbox binds only the copied cwd for writing and isolates networking', () => {
  const args = sandboxArguments('/tmp/copy', '/tmp/copy/work', ['node', 'build.mjs']);
  assert.ok(args.includes('--unshare-pid'));
  assert.ok(args.includes('--unshare-net'));
  assert.ok(args.includes('--unshare-ipc'));
  assert.deepEqual(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2), ['--tmpfs', '/']);
  assert.equal(args.some((part, index) => part === '--ro-bind' && args[index + 1] === '/'), false);
  assert.ok(args.includes('/tmp/.dotnet'));
  assert.ok(args.includes('/usr'));
  assert.equal(args.some((part, index) => part === '--ro-bind' &&
    args[index + 2] === '/tmp/copy/node_modules'), false);
  assert.deepEqual(args.slice(-7), ['--chdir', '/tmp/copy/work', '--die-with-parent',
    '--new-session', '--', 'node', 'build.mjs']);
});

test('native toolchain root is mounted read-only and must be disposable', async () => {
  const args = sandboxArguments('/tmp/copy', '/tmp/copy', ['lua', 'test.lua'],
    { nativeToolRoot: '/tmp/native-tools' });
  assert.ok(args.some((part, index) => part === '--ro-bind' &&
    args[index + 1] === '/tmp/native-tools' && args[index + 2] === '/tmp/native-tools'));
  await assert.rejects(qualifyFixtureApps({ offlineNativeRoot: '/usr' }),
    { code: 'TOOLCHAIN_ROOT' });
});

test('installed bare package and bin resolve from the copied app', async () => {
  const source = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import ts from 'typescript';
assert.ok(ts.version);
assert.equal(process.env.PATH.split(':')[0], join(process.cwd(), 'node_modules/.bin'));
if (process.argv[2] === 'normal') console.log('normal');
`;
  const fixture = await qualificationCase('L02', source, { argv: ['tsc', '--version'] });
  try {
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L02');
    assert.equal(row.status, 'passed', JSON.stringify(row));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('offline compiler provisioning requires the fixture declared version', async () => {
  const fixture = await qualificationCase('L02', 'console.log("normal");\n',
    { argv: ['tsc', '--version'] });
  try {
    fixture.row.toolchain = 'TypeScript 0.0.0; Node.js 24.12.0';
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L02');
    assert.equal(row.status, 'blocked');
    assert.equal(row.reason, 'toolchain_unavailable');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('offline frontend provisioning rejects a lock that differs from declared packages', async () => {
  const fixture = await qualificationCase('L12', 'console.log("normal");\n',
    { argv: ['node', 'build.mjs'] });
  try {
    const packageBytes = '{"dependencies":{"svelte":"5.19.8"}}\n';
    await writeFile(join(fixture.apps, 'case', 'package.json'), packageBytes);
    fixture.row.sources.push({ path: 'package.json',
      sha256: createHash('sha256').update(packageBytes).digest('hex') });
    await fixture.save();
    const dependencyRoot = join(fixture.directory, 'dependencies');
    await mkdir(join(dependencyRoot, 'svelte5'), { recursive: true });
    await mkdir(join(dependencyRoot, 'npm-cache'));
    await writeFile(join(dependencyRoot, 'svelte5', 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: {} } } }));
    await assert.rejects(qualifyFixtureApps({ manifestPath: fixture.manifestPath,
      appRoot: fixture.apps, oracleRoot: fixture.oracles, offlineDependencyRoot: dependencyRoot }),
    { code: 'DEPENDENCY_LOCK' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('copied TypeScript package and Vite cache are writable only in the disposable app', async () => {
  const source = `import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const cache = join(process.cwd(), 'node_modules/.vite-temp/config.mjs');
await writeFile(cache, 'copy-local');
assert.equal(await readFile(cache, 'utf8'), 'copy-local');
await writeFile(join(process.cwd(), 'node_modules/typescript/package.json'), 'copy-local');
if (process.argv[2] === 'normal') console.log('normal');
`;
  const fixture = await qualificationCase('L02', source, { argv: ['node', 'build.mjs'] });
  try {
    const installed = await readFile(new URL('../../node_modules/typescript/package.json', import.meta.url), 'utf8');
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L02');
    assert.equal(row.status, 'passed', JSON.stringify(row));
    assert.equal(await readFile(new URL('../../node_modules/typescript/package.json', import.meta.url), 'utf8'), installed);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('installed Rust toolchain is readable and Cargo state stays in the copy', async () => {
  const source = `import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.argv[2] === 'normal') {
  assert.equal(process.env.CARGO_HOME, join(process.cwd(), '.cargo-home'));
  assert.equal(process.env.RUSTUP_HOME, join(process.cwd(), '.rustup-home'));
  await access(process.env.RUSTC);
  await writeFile(join(process.env.CARGO_HOME, 'config.toml'), 'copy-only');
  console.log('normal');
}
`;
  const fixture = await qualificationCase('L01', source, { argv: ['cargo', '--version'] });
  try {
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'passed', JSON.stringify(row));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('system cargo/rustc fallback does not require rustup state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-system-rust-'));
  try {
    const installed = await installedRustEnvironment(directory);
    assert.ok(installed, 'a Rust toolchain is required for this protection observation');
    const bin = join(directory, 'system-bin');
    await mkdir(bin);
    for (const program of ['cargo', 'rustc'])
      await symlink(join(installed.toolchain, 'bin', program), join(bin, program));
    const fallback = await installedRustEnvironment(directory,
      { rustupHome: join(directory, 'absent-rustup'), systemDirectories: [bin] });
    assert.equal(fallback?.toolchain, installed.toolchain);
    assert.equal(fallback.env.CARGO_HOME, join(directory, '.cargo-home'));
    assert.equal(fallback.env.RUSTC, join(installed.toolchain, 'bin', 'rustc'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Cargo compiles inside the copied cwd using the validated absolute rustc', async () => {
  const fixture = await qualificationCase('L01', 'unused fixture script\n',
    { argv: ['cargo', 'test', '--offline', '--quiet', '--manifest-path', 'Cargo.toml', '--target-dir', '.build'] });
  try {
    const cargoManifest = '[package]\nname = "passeur_qualifier_rust"\nversion = "0.1.0"\nedition = "2021"\n';
    const main = 'fn main() { println!("normal"); }\n';
    await mkdir(join(fixture.apps, 'case', 'src'));
    for (const [path, content] of [['Cargo.toml', cargoManifest], ['src/main.rs', main]]) {
      await writeFile(join(fixture.apps, 'case', path), content);
      fixture.row.sources.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
    }
    fixture.row.entrypoint = 'src/main.rs';
    fixture.row.runs[0].argv = ['cargo', 'run', '--offline', '--quiet', '--manifest-path',
      'Cargo.toml', '--target-dir', '.build', '--', 'normal'];
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'passed', JSON.stringify(row));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('.NET runtime state writes into the copied directory through its fixed /tmp path', async () => {
  const marker = `passeur-${Date.now()}-${process.pid}`;
  const source = `import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.argv[2] === 'normal') {
  const shm = '/tmp/.dotnet/shm';
  await mkdir(shm, { recursive: true });
  await writeFile(join(shm, ${JSON.stringify(marker)}), 'copy-only');
  assert.equal(await readFile(join(process.cwd(), '.dotnet-runtime/shm', ${JSON.stringify(marker)}), 'utf8'), 'copy-only');
  console.log('normal');
}
`;
  const fixture = await qualificationCase('L08', source, { argv: ['dotnet', '--version'] });
  try {
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L08');
    assert.equal(row.status, 'passed', JSON.stringify(row));
    await assert.rejects(readFile(join('/tmp/.dotnet/shm', marker)), { code: 'ENOENT' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('package-free .NET project builds and runs within the sandbox bound', async () => {
  const fixture = await qualificationCase('L08', 'unused fixture script\n',
    { argv: ['dotnet', 'build', 'Probe.csproj', '--configuration', 'Release', '--output', '.build',
      '--property:BaseIntermediateOutputPath=.obj/', '--property:MSBuildProjectExtensionsPath=.obj/',
      '--verbosity', 'normal'], timeout_ms: 20_000 });
  try {
    const files = {
      'Probe.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs': 'System.Console.WriteLine("normal");\n',
      'NuGet.Config': '<?xml version="1.0"?><configuration><packageSources><clear /></packageSources></configuration>\n'
    };
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(fixture.apps, 'case', path), content);
      fixture.row.sources.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
    }
    fixture.row.entrypoint = 'Program.cs';
    fixture.row.runs[0].argv = ['dotnet', '.build/Probe.dll', 'normal'];
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L08');
    assert.equal(row.status, 'passed', JSON.stringify(row));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('sandbox setup errors, signals, and timeouts remain blocked evidence', () => {
  assert.deepEqual(classifySandboxSetup({ code: 0 }), { status: 'passed' });
  for (const result of [{ error: 'ENOENT' }, { code: 1, stderr: 'bwrap: setup failed' },
    { code: null, signal: 'SIGKILL', timed_out: true }, { code: 0, overflow: true }]) {
    assert.deepEqual(classifySandboxSetup(result),
      { status: 'blocked', reason: 'sandbox_setup_unavailable', actual: result });
  }
  for (const resource_exceeded of ['cpu_time', 'rss'])
    assert.deepEqual(classifySandboxSetup({ code: null, signal: 'SIGKILL', resource_exceeded }),
      { status: 'failed', reason: 'resource_budget_exceeded',
        actual: { code: null, signal: 'SIGKILL', resource_exceeded } });
  assert.equal(classifySandboxSetup({ resource_accounting_error: 'procfs unavailable' }).status, 'failed');
  assert.equal(classifyCommand({ code: 0, stdout: 'normal\n', stderr: '',
    resource_exceeded: 'cpu_time' }, { stdout: 'normal\n' }).reason, 'resource_budget_exceeded');
});

test('resource or accounting failure in sandbox preflight stops before the build', async () => {
  const fixture = await qualificationCase('L01',
    `import { writeFileSync } from 'node:fs'; writeFileSync('build-ran', 'yes');\n`,
    { argv: ['node', 'build.mjs'] });
  try {
    for (const [observation, reason] of [
      [{ resource_exceeded: 'cpu_time', signal: 'SIGKILL' }, 'resource_budget_exceeded'],
      [{ resource_accounting_error: 'procfs unavailable' }, 'resource_accounting_failed'],
      [{ error: 'ENOENT' }, 'sandbox_setup_unavailable']
    ]) {
      const result = await qualifyFixtureApps({ manifestPath: fixture.manifestPath,
        appRoot: fixture.apps, oracleRoot: fixture.oracles,
        runPreflight: async () => observation });
      const row = result.rows.find(item => item.id === 'L01');
      assert.equal(row.reason, reason);
      assert.equal(row.status, reason === 'sandbox_setup_unavailable' ? 'blocked' : 'failed');
      assert.deepEqual(row.actual, observation);
      await assert.rejects(readFile(join(fixture.apps, 'case', 'build-ran')), { code: 'ENOENT' });
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('post-setup command output resembling bwrap is failed command evidence', async () => {
  const fixture = await qualificationCase('L01',
    'process.stderr.write("bwrap: command failed\\n"); process.exit(1);\n',
    { argv: ['node', 'build.mjs'] });
  try {
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.equal(row.reason, 'build_failed');
    assert.equal(row.actual.stderr, 'bwrap: command failed\n');
    assert.deepEqual(classifyCommand({ code: 1, stderr: 'bwrap: command failed\n', stdout: '' },
      { stdout: 'normal\n' }), { status: 'failed', reason: 'exact_output_mismatch',
      actual: { code: 1, stderr: 'bwrap: command failed\n', stdout: '' } });
    const runOnly = 'if (process.argv[2] === "normal") { process.stderr.write("bwrap: run failed\\n"); process.exit(1); }\n';
    await writeFile(join(fixture.apps, 'case', 'build.mjs'), runOnly);
    fixture.row.sources[0].sha256 = createHash('sha256').update(runOnly).digest('hex');
    await fixture.save();
    const runRow = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(runRow.status, 'failed', JSON.stringify(runRow));
    assert.equal(runRow.runs[0].reason, 'exact_output_mismatch');
    assert.equal(runRow.runs[0].actual.stderr, 'bwrap: run failed\n');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('sandbox hides host paths, pathname sockets, and host PIDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-host-secret-'));
  const socketPath = join(directory, 'host.sock');
  const secretPath = join(directory, 'secret');
  let accepted = 0;
  const server = createServer(socket => { accepted += 1; socket.end(); });
  await writeFile(secretPath, 'host-secret');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  let fixture;
  try {
    const source = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
if (process.argv[2] === 'normal') console.log('normal');
else {
  await assert.rejects(readFile(${JSON.stringify(secretPath)}), { code: 'ENOENT' });
  await assert.rejects(readFile('/proc/${process.pid}/status'), { code: 'ENOENT' });
  await new Promise((resolve, reject) => {
    const socket = connect(${JSON.stringify(socketPath)});
    socket.once('connect', () => reject(new Error('host socket reached')));
    socket.once('error', error => error.code === 'ENOENT' ? resolve() : reject(error));
  });
}
`;
    fixture = await qualificationCase('L01', source, { argv: ['node', 'build.mjs'] });
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'passed', JSON.stringify(row));
    assert.equal(accepted, 0);
    assert.equal(await readFile(secretPath, 'utf8'), 'host-secret');
  } finally {
    if (fixture) await rm(fixture.directory, { recursive: true, force: true });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('sandboxed build cannot write to the protected source tree', async () => {
  const fixture = await qualificationCase('L01', 'console.log("normal");\n',
    { argv: ['node', 'build.mjs'] });
  try {
    const protectedPath = join(fixture.apps, 'case', 'build.mjs');
    const source = `import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'normal') console.log('normal');
else {
  try { writeFileSync(${JSON.stringify(protectedPath)}, 'breach'); }
  catch (error) { if (!['EROFS', 'EACCES', 'ENOENT'].includes(error.code)) throw error; }
}
`;
    await writeFile(protectedPath, source);
    fixture.row.sources[0].sha256 = createHash('sha256').update(source).digest('hex');
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'passed', JSON.stringify(row));
    assert.equal(await readFile(protectedPath, 'utf8'), source);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('sandboxed build cannot reach a live host loopback listener or write protected sources',
  { timeout: 10_000 }, async () => {
    let accepted = 0;
    const server = createServer(socket => { accepted += 1; socket.end(); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    let fixture;
    try {
      const port = server.address().port;
      await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.setTimeout(300);
        socket.once('connect', () => { socket.end(); resolve(); });
        socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(new Error('host listener unreachable')); });
      });
      assert.equal(accepted, 1);
      fixture = await qualificationCase('L01', 'console.log("normal");\n',
        { argv: ['node', 'build.mjs'], timeout_ms: 1_500 });
      const protectedPath = join(fixture.apps, 'case', 'build.mjs');
      const source = `import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
if (process.argv[2] === 'normal') console.log('normal');
else {
  try { writeFileSync(${JSON.stringify(protectedPath)}, 'breach'); }
  catch (error) { if (!['EROFS', 'EACCES', 'ENOENT'].includes(error.code)) throw error; }
  await new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port: ${port} });
    socket.setTimeout(300);
    socket.once('connect', () => {
      console.log('unexpected_network_access');
      process.exitCode = 1;
      socket.destroy();
      resolve();
    });
    socket.once('error', () => resolve());
    socket.once('timeout', () => { socket.destroy(); resolve(); });
  });
}
`;
      await writeFile(protectedPath, source);
      fixture.row.sources[0].sha256 = createHash('sha256').update(source).digest('hex');
      await fixture.save();
      const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
      assert.equal(row.status, 'passed', JSON.stringify(row));
      assert.equal(accepted, 1, 'sandbox reached the host loopback listener');
      assert.equal(await readFile(protectedPath, 'utf8'), source);
    } finally {
      if (fixture) await rm(fixture.directory, { recursive: true, force: true });
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

test('build commands receive temporary .NET state and offline environment', async () => {
  const source = `import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
assert.equal(process.env.DOTNET_CLI_HOME, join(process.cwd(), '.dotnet-home'));
assert.equal(process.env.NUGET_PACKAGES, join(process.cwd(), '.nuget-packages'));
assert.equal(process.env.DOTNET_GENERATE_ASPNET_CERTIFICATE, 'false');
assert.equal(process.env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE, '1');
assert.equal(process.env.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
assert.equal(process.env.DOTNET_NOLOGO, '1');
assert.equal(process.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR, join(process.cwd(), '.dotnet-bundle'));
assert.equal(process.env.DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE, 'true');
assert.equal(process.env.DOTNET_SDK_VULNERABILITY_CHECK_DISABLE, 'true');
assert.equal(process.env.DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER, '1');
assert.equal(process.env.DOTNET_CLI_USE_MSBUILD_SERVER, '0');
assert.equal(process.env.MSBUILDDISABLENODEREUSE, '1');
assert.equal(process.env.UseSharedCompilation, 'false');
assert.equal(process.env.CARGO_NET_OFFLINE, 'true');
assert.equal(process.env.npm_config_offline, 'true');
assert.equal(process.env.PIP_NO_INDEX, '1');
assert.ok(process.env.PATH.split(delimiter)[0].endsWith('node_modules/.bin'));
assert.equal(process.env.HOME, process.cwd());
assert.equal(process.env.TMPDIR, process.cwd());
assert.equal(process.env.NODE_OPTIONS, undefined);
if (process.argv[2] === 'normal') console.log('normal');
`;
  const fixture = await qualificationCase('L01', source, { argv: ['node', 'build.mjs'] });
  try {
    const result = (await fixture.qualify()).rows.find(row => row.id === 'L01');
    assert.equal(result.status, 'passed', JSON.stringify(result));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('missing row, oracle, and app are failed artifacts before sandbox startup', async () => {
  const fixture = await qualificationCase('L01', 'console.log("normal");\n', { argv: ['node', 'build.mjs'] });
  try {
    const baseline = await fixture.qualify();
    assert.equal(baseline.rows.find(row => row.id === 'L02').reason, 'manifest_row_missing');
    await rm(join(fixture.oracles, 'L01.json'));
    assert.deepEqual((await fixture.qualify()).rows.find(row => row.id === 'L01'),
      { id: 'L01', status: 'failed', reason: 'oracle_missing' });
    await writeFile(join(fixture.oracles, 'L01.json'), JSON.stringify({ id: 'L01',
      functional: [{ id: 'normal', argv: ['normal'], stdout: 'normal\n' }] }));
    await rm(join(fixture.apps, 'case'), { recursive: true });
    assert.deepEqual((await fixture.qualify()).rows.find(row => row.id === 'L01'),
      { id: 'L01', status: 'failed', reason: 'app_missing' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('missing build cwd fails while a missing build program is blocked', async () => {
  const fixture = await qualificationCase('L01', 'console.log("normal");\n', { argv: ['node', 'build.mjs'], cwd: 'missing' });
  try {
    let row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'failed');
    assert.equal(row.reason, 'build_cwd_missing');
    fixture.row.build = { argv: ['zig', 'version'] };
    await fixture.save();
    row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'blocked');
    assert.equal(row.reason, 'toolchain_unavailable');
    assert.deepEqual(row.command, ['zig', 'version']);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('missing run executable is failed command evidence', () => {
  assert.deepEqual(classifyCommand({ error: 'ENOENT', argv: ['./quote-c', 'normal'] },
    { stdout: 'normal\n' }), { status: 'failed', reason: 'run_executable_missing',
    actual: { error: 'ENOENT', argv: ['./quote-c', 'normal'] } });
});

test('missing built run executable fails after a successful sandboxed build', async () => {
  const fixture = await qualificationCase('L09', 'process.exit(0);\n', { argv: ['node', 'build.mjs'] });
  try {
    fixture.row.runs[0].argv = ['./quote-c', 'normal'];
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L09');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.equal(row.runs[0].reason, 'run_executable_missing');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('missing run cwd is failed command evidence after a successful build', async () => {
  const fixture = await qualificationCase('L01', 'if (process.argv[2]) console.log("normal");\n',
    { argv: ['node', 'build.mjs'] });
  try {
    fixture.row.runs[0].cwd = 'missing';
    await fixture.save();
    const row = (await fixture.qualify()).rows.find(item => item.id === 'L01');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.equal(row.runs[0].reason, 'run_cwd_missing');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('an installed dependency throwing during build is failed, while explicit 127 is blocked', async () => {
  const source = `try { await import('./dependency.mjs'); } catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') process.exit(127);
  throw error;
}\n`;
  const fixture = await qualificationCase('L12', source,
    { argv: ['node', 'build.mjs'], blocked_exit_code: 127 });
  try {
    const absent = (await fixture.qualify()).rows.find(row => row.id === 'L12');
    assert.equal(absent.reason, 'declared_build_blocked_exit');
    const dependency = 'throw new Error("broken installed dependency");\n';
    await writeFile(join(fixture.apps, 'case', 'dependency.mjs'), dependency);
    fixture.row.sources.push({ path: 'dependency.mjs',
      sha256: createHash('sha256').update(dependency).digest('hex') });
    await fixture.save();
    const broken = (await fixture.qualify()).rows.find(row => row.id === 'L12');
    assert.equal(broken.status, 'failed', JSON.stringify(broken));
    assert.equal(broken.reason, 'build_failed');
    assert.notEqual(broken.actual.code, 127);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('functional cases and runs need nonempty matching input argv', async () => {
  const fixture = await qualificationCase('L01', 'console.log("normal");\n', { argv: ['node', 'build.mjs'] });
  const oraclePath = join(fixture.oracles, 'L01.json');
  try {
    fixture.row.runs = [];
    await fixture.save();
    await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_SCHEMA' });
    fixture.row.runs = [{ case_id: 'normal', argv: ['node', 'build.mjs', 'normal'], input_argv: [] }];
    await fixture.save();
    await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_SCHEMA' });
    fixture.row.runs[0].input_argv = ['other'];
    await fixture.save();
    assert.equal((await fixture.qualify()).rows.find(row => row.id === 'L01').reason,
      'functional_input_or_case_mismatch');
    fixture.row.runs[0].input_argv = ['normal'];
    await fixture.save();
    await writeFile(oraclePath, JSON.stringify({ id: 'L01', functional: [] }));
    await assert.rejects(fixture.qualify(), { code: 'ORACLE_SCHEMA' });
    await writeFile(oraclePath, JSON.stringify({ id: 'L01', functional: [
      { id: 'normal', argv: ['normal'], stdout: 'normal\n' },
      { id: 'normal', argv: ['normal'], stdout: 'normal\n' }] }));
    await assert.rejects(fixture.qualify(), { code: 'ORACLE_SCHEMA' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('inline dependency probes cannot declare a blocked exit', async () => {
  const fixture = await qualificationCase('L12', 'process.exit(0);\n',
    { argv: ['node', '-e', 'process.exit(127)'], blocked_exit_code: 127 });
  try { await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' }); }
  finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('process group termination closes descendants on timeout and output overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'passeur-process-group-'));
  try {
    for (const [mode, expected] of [['timeout', 'timed_out'], ['overflow', 'overflow']]) {
      const marker = join(directory, `${mode}.marker`);
      const childSource = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 400)';
      const source = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(childSource)},${JSON.stringify(marker)}],{stdio:'inherit'});
${mode === 'overflow' ? 'process.stdout.write("x".repeat(70000));' : 'setInterval(() => {}, 1000);'}
`;
      const result = await runBoundedProcess(process.execPath, ['-e', source],
        { cwd: directory, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          timeout_ms: mode === 'overflow' ? 2_000 : 150 });
      assert.equal(result[expected], true, JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 500));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sandbox rejects aggregate CPU and RSS over-budget descendant trees and terminates their children',
  { timeout: 12_000 }, async () => {
    const copy = await mkdtemp(join(tmpdir(), 'passeur-resource-budget-'));
    try {
      await mkdir(join(copy, '.dotnet-runtime', 'shm'), { recursive: true });
      await mkdir(join(copy, '.vite-temp'));
      for (const mode of ['cpu_time', 'rss']) {
        const marker = join(copy, `${mode}.survived`);
        const sentinel = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`;
        const worker = mode === 'cpu_time' ?
          'const start=process.cpuUsage(); while (true) { const used=process.cpuUsage(start); if (used.user+used.system >= 180000) break; } setInterval(()=>{},1000);' :
          'const pages=[]; for(let i=0;i<64;i++) pages.push(Buffer.alloc(1024*1024,1)); setInterval(()=>{},1000);';
        const source = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'}).unref();
spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'}).unref();
spawn(process.execPath,['-e',${JSON.stringify(sentinel)}],{detached:true,stdio:'ignore'}).unref();
setInterval(()=>{},1000);`;
        const result = await runBoundedProcess('/usr/bin/bwrap',
          sandboxArguments(copy, copy, ['node', '-e', source]),
          { cwd: copy, env: { PATH: [dirname(process.execPath), '/usr/bin'].join(':') },
            timeout_ms: 3_000, max_cpu_ms: mode === 'cpu_time' ? 250 : 60_000,
            max_rss_bytes: mode === 'rss' ? 180 * 1024 * 1024 : 2 * 1024 * 1024 * 1024 });
        assert.equal(result.resource_exceeded, mode, JSON.stringify(result));
        assert.equal(classifyCommand(result, { stdout: '' }).reason, 'resource_budget_exceeded');
        await new Promise(resolve => setTimeout(resolve, 1400));
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
      }
    } finally { await rm(copy, { recursive: true, force: true }); }
  });

test('CPU budget includes descendants forked by a worker thread and leaves none running',
  { timeout: 5_000 }, async () => {
    const copy = await mkdtemp(join(tmpdir(), 'passeur-thread-resource-'));
    const marker = join(copy, 'survived');
    try {
      await mkdir(join(copy, '.dotnet-runtime', 'shm'), { recursive: true });
      await mkdir(join(copy, '.vite-temp'));
      const burner = 'const end=Date.now()+900; while(Date.now()<end) {}';
      const sentinel = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000)`;
      const worker = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(burner)}],{detached:true,stdio:'ignore'}).unref();
spawn(process.execPath,['-e',${JSON.stringify(sentinel)}],{detached:true,stdio:'ignore'}).unref();
setInterval(()=>{},1000);`;
      const source = `const {Worker}=require('node:worker_threads');
new Worker(${JSON.stringify(worker)},{eval:true});
setInterval(()=>{},1000);`;
      const result = await runBoundedProcess('/usr/bin/bwrap',
        sandboxArguments(copy, copy, ['node', '-e', source]),
        { cwd: copy, env: { PATH: [dirname(process.execPath), '/usr/bin'].join(':') },
          timeout_ms: 2_000, max_cpu_ms: 250 });
      assert.equal(result.resource_exceeded, 'cpu_time', JSON.stringify(result));
      assert.equal(result.timed_out, false, JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 1100));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally { await rm(copy, { recursive: true, force: true }); }
  });

test('CPU budget includes a short-lived reaped child after it exits', { timeout: 5_000 }, async () => {
  const copy = await mkdtemp(join(tmpdir(), 'passeur-reaped-cpu-'));
  try {
    await mkdir(join(copy, '.dotnet-runtime', 'shm'), { recursive: true });
    await mkdir(join(copy, '.vite-temp'));
    const reaped = join(copy, 'child-reaped');
    const burner = `const start=process.cpuUsage(); while (true) {
  const used=process.cpuUsage(start); if (used.user+used.system >= 55000) break;
}`;
    const source = `const {spawnSync}=require('node:child_process');
for(let i=0;i<3;i++) {
  const result=spawnSync(process.execPath,['-e',${JSON.stringify(burner)}]);
  if(result.status!==0) process.exit(2);
  if(i===0) require('node:fs').writeFileSync(${JSON.stringify(reaped)}, 'yes');
}
setInterval(()=>{},1000);`;
    const result = await runBoundedProcess('/usr/bin/bwrap',
      sandboxArguments(copy, copy, ['node', '-e', source]),
      { cwd: copy, env: { PATH: [dirname(process.execPath), '/usr/bin'].join(':') },
        timeout_ms: 2_000, max_cpu_ms: 100, resource_sample_ms: 500 });
    assert.equal(result.resource_exceeded, 'cpu_time', JSON.stringify(result));
    assert.equal(result.timed_out, false, JSON.stringify(result));
    assert.equal(await readFile(reaped, 'utf8'), 'yes');
  } finally { await rm(copy, { recursive: true, force: true }); }
});

test('short-lived root CPU cannot escape a requested slow sample interval and cleans up its group',
  { timeout: 3_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'passeur-root-cpu-'));
    const marker = join(directory, 'survived');
    try {
      const sentinel = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 450)`;
      const source = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(sentinel)}],{stdio:'ignore'});
const start=process.cpuUsage();
while (true) { const used=process.cpuUsage(start); if (used.user+used.system >= 240000) break; }`;
      const result = await runBoundedProcess(process.execPath, ['-e', source],
        { cwd: directory, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          timeout_ms: 1_500, max_cpu_ms: 100, resource_sample_ms: 500 });
      assert.equal(result.resource_exceeded, 'cpu_time', JSON.stringify(result));
      assert.equal(result.timed_out, false, JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 500));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('terminal child accounting catches CPU consumed before the observer can sample',
  { timeout: 3_000 }, async () => {
    const source = `const start=process.cpuUsage();
while (true) { const used=process.cpuUsage(start); if (used.user+used.system >= 240000) break; }`;
    const originalSetInterval = globalThis.setInterval;
    let requestedInterval;
    try {
      // Simulate an observer whose timer is delayed until the short-lived root
      // is reaped. The production interval remains capped; this forces the
      // terminal accounting path instead of testing timer scheduling luck.
      globalThis.setInterval = (handler, delay, ...args) => {
        requestedInterval = delay;
        return originalSetInterval(handler, 1_000, ...args);
      };
      const result = await runBoundedProcess(process.execPath, ['-e', source],
        { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          timeout_ms: 2_000, max_cpu_ms: 100, resource_sample_ms: 500 });
      assert.ok(requestedInterval <= 5, `unexpected sampling interval ${requestedInterval}`);
      assert.equal(result.resource_exceeded, 'cpu_time', JSON.stringify(result));
      assert.equal(result.timed_out, false, JSON.stringify(result));
    } finally { globalThis.setInterval = originalSetInterval; }
  });

test('terminal accounting retains CPU after a child has been reaped', { timeout: 3_000 }, () => {
  const before = waitedChildCpuMilliseconds();
  const burner = `const start=process.cpuUsage();
while (true) { const used=process.cpuUsage(start); if (used.user+used.system >= 240000) break; }`;
  const finished = spawnSync(process.execPath, ['-e', burner], { timeout: 2_000 });
  assert.equal(finished.status, 0, String(finished.stderr));
  assert.ok(waitedChildCpuMilliseconds() - before > 100,
    'waited-child CPU must remain available after the child proc entry disappears');
});

test('concurrent bounded calls do not charge one command for another command CPU',
  { timeout: 6_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'passeur-concurrent-cpu-'));
    const marker = join(directory, 'heavy-started');
    try {
      const heavySource = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');
const start=process.cpuUsage();
while (true) { const used=process.cpuUsage(start); if (used.user+used.system >= 420000) break; }`;
      const lightSource = `setTimeout(() => process.stdout.write('light\\n'), 750)`;
      const options = { cwd: directory, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeout_ms: 3_000 };
      const heavy = runBoundedProcess(process.execPath, ['-e', heavySource],
        { ...options, max_cpu_ms: 1_000 });
      let started = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { started = await readFile(marker, 'utf8') === 'ready'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (started) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(started, true, 'heavy command did not start');
      const light = runBoundedProcess(process.execPath, ['-e', lightSource],
        { ...options, max_cpu_ms: 200 });
      const [heavyResult, lightResult] = await Promise.all([heavy, light]);
      assert.equal(heavyResult.code, 0, JSON.stringify(heavyResult));
      assert.equal(heavyResult.resource_exceeded, undefined, JSON.stringify(heavyResult));
      assert.equal(lightResult.code, 0, JSON.stringify(lightResult));
      assert.equal(lightResult.stdout, 'light\n');
      assert.equal(lightResult.resource_exceeded, undefined, JSON.stringify(lightResult));
      assert.equal(lightResult.resource_accounting_error, undefined, JSON.stringify(lightResult));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('PID namespace terminates a separate-session descendant holding output pipes',
  { timeout: 6_000 }, async () => {
    const copy = await mkdtemp(join(tmpdir(), 'passeur-pid-namespace-'));
    const marker = join(copy, 'survived');
    try {
      await mkdir(join(copy, '.dotnet-runtime', 'shm'), { recursive: true });
      await mkdir(join(copy, '.vite-temp'));
      const childSource = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`;
      const source = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'inherit'}).unref();
console.log('ready');
setInterval(() => {}, 1000);
`;
      const result = await runBoundedProcess('/usr/bin/bwrap',
        sandboxArguments(copy, copy, ['node', '-e', source]),
        { cwd: copy, env: { PATH: [dirname(process.execPath), '/usr/bin'].join(':') }, timeout_ms: 500 });
      assert.equal(result.timed_out, true, JSON.stringify(result));
      assert.equal(result.stdout, 'ready\n', JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 1400));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally { await rm(copy, { recursive: true, force: true }); }
  });

test('C and C++ rows admit one local executable basename without executing a shell fixture', async () => {
  const fixture = await qualificationCase('L09', 'process.exit(0);\n', { argv: ['node', 'build.mjs'] });
  try {
    fixture.row.runs = [{ case_id: 'normal', argv: ['./quote', 'normal'], input_argv: ['normal'] }];
    await fixture.save();
    assert.equal((await loadManifest(fixture.manifestPath)).rows.length, 1);
    fixture.row.id = 'L10';
    await fixture.save();
    assert.equal((await loadManifest(fixture.manifestPath)).rows.length, 1);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('local executable admission rejects traversal, separators, and other rows', async () => {
  const fixture = await qualificationCase('L09', 'process.exit(0);\n', { argv: ['node', 'build.mjs'] });
  try {
    fixture.row.runs = [{ case_id: 'normal', argv: ['./quote', 'normal'], input_argv: ['normal'] }];
    await fixture.save();
    assert.equal((await loadManifest(fixture.manifestPath)).rows.length, 1);
    for (const program of ['./', './.', './..', './../quote', './sub/quote',
      '.\\quote', '.\\sub\\quote', '../quote', '/tmp/quote', './quote/other']) {
      fixture.row.runs[0].argv = [program, 'normal'];
      await fixture.save();
      await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' });
    }
    fixture.row.runs[0].argv = ['./quote', 'normal'];
    fixture.row.id = 'L01';
    await fixture.save();
    await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' });
    fixture.row.id = 'L09';
    fixture.row.build.argv = ['./quote'];
    await fixture.save();
    await assert.rejects(loadManifest(fixture.manifestPath), { code: 'MANIFEST_COMMAND' });
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
