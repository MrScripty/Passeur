import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchService, servicePaths } from '../../.passeur-core/src/service/bootstrap.js';
import { diagnosticInfo } from '../../.passeur-core/src/core/errors.js';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'passeur-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'service.mjs'), marker = join(root, 'ready');
  await writeFile(cli, source);
  const binding = { storeRoot: root, stateRoot: root, project: marker, repositoryId: 'test-repository' };
  return { binding, cli, marker, paths: servicePaths(binding) };
}

async function exitCode(child) {
  return child.exitCode !== null || child.signalCode !== null ? child.exitCode : (await once(child, 'exit'))[0];
}

test('launch reservation preserves the election loser, guard inode, and unrelated endpoint', async t => {
  const f = await fixture(t, `import {writeFile} from 'node:fs/promises';
await writeFile(process.argv[process.argv.indexOf('--project')+1], 'ready');
setInterval(()=>{},1000);`);
  await writeFile(f.paths.endpoint, 'unrelated');
  const winner = await launchService(f.binding, f.cli);
  t.after(() => { winner.released(); if (winner.child.exitCode === null) winner.child.kill(); });
  const deadline = AbortSignal.timeout(5000);
  while (true) {
    try { if (await readFile(f.marker, 'utf8') === 'ready') break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10, undefined, { signal: deadline });
  }
  const inode = (await stat(f.paths.guard)).ino;
  assert.equal(winner.child.exitCode, null);
  const loser = await launchService(f.binding, f.cli);
  let loserFailed = false;
  void loser.failure.catch(() => { loserFailed = true; });
  assert.equal(await exitCode(loser.child), 75);
  await Promise.resolve();
  assert.equal(loserFailed, false);
  loser.released();
  assert.equal((await stat(f.paths.guard)).ino, inode);
  assert.equal(await readFile(f.paths.endpoint, 'utf8'), 'unrelated');
  winner.released(); winner.child.kill();
  assert.equal(await exitCode(winner.child), null);
  await assert.rejects(winner.failure, { code: 'SERVICE_START_FAILED' });
  assert.equal((await stat(f.paths.guard)).ino, inode);
});

test('an elected launcher exiting before attachment reports its exact exit code', async t => {
  const f = await fixture(t, 'process.exit(7);');
  const launch = await launchService(f.binding, f.cli);
  t.after(() => launch.released());
  assert.equal(await exitCode(launch.child), 7);
  await assert.rejects(launch.failure, error => {
    assert.equal(error.code, 'SERVICE_START_FAILED');
    assert.match(error.message, /code 7/);
    return true;
  });
});

test('an elected launcher exiting with flock contention code remains a startup failure when the child owns the guard', async t => {
  const f = await fixture(t, 'process.exit(1);');
  const launch = await launchService(f.binding, f.cli);
  t.after(() => launch.released());
  assert.equal(await exitCode(launch.child), 1);
  await assert.rejects(launch.failure, error => {
    assert.equal(error.code, 'SERVICE_START_FAILED');
    assert.match(error.message, /code 1/);
    return true;
  });
});

test('missing flock reports an explicit unsupported platform mechanism', async t => {
  const f = await fixture(t, 'process.exit(0);');
  const moduleUrl = pathToFileURL(join(process.cwd(), '.passeur-core/src/service/bootstrap.js')).href;
  const script = `const {launchService}=await import(process.argv[1]);
const binding=JSON.parse(process.argv[2]);
const launch=await launchService(binding,process.argv[3]);
try { await launch.failure; process.exitCode=1; }
catch(error) { if(error.code!=='SERVICE_PLATFORM_UNSUPPORTED'||error.context.native_code!=='ENOENT')process.exitCode=1; }
finally { launch.released(); }`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, moduleUrl, JSON.stringify(f.binding), f.cli],
    { env: { ...process.env, PATH: join(f.binding.storeRoot, 'missing-bin') } });
});

test('guarded startup preserves only the bounded redacted CLI diagnostic', async t => {
  const diagnostic = { code: 'PERMISSION_DENIED', message: 'token=private-value secret=hidden-value',
    stage: 'state.prepare', path: '/fixture/state', native_code: 'EACCES', next_action: 'Check access; password=hidden-value' };
  const f = await fixture(t, `process.stderr.write(${JSON.stringify('arbitrary secret output\n')});
process.stderr.write(${JSON.stringify(JSON.stringify(diagnostic) + '\n')});process.exitCode=1;`);
  const launch = await launchService(f.binding, f.cli); t.after(() => launch.released());
  await assert.rejects(launch.failure, error => {
    assert.equal(error.code, diagnostic.code); assert.equal(error.context.stage, diagnostic.stage);
    assert.equal(error.context.path, diagnostic.path); assert.equal(error.context.native_code, diagnostic.native_code);
    assert.equal(error.message, 'token=[redacted] secret=[redacted]');
    assert.equal(error.context.next_action, 'Check access; password=[redacted]');
    assert.ok(!JSON.stringify(error).includes('hidden-value')); return true;
  });
});

test('guarded startup accepts the bounded UTF-8 failure contract above 8 KiB', async t => {
  const diagnostic = { code: 'SERVICE_PROFILE_CONFLICT', message: '猫'.repeat(2048), stage: 'service.profile',
    path: `/${'r'.repeat(4000)}`, requested_profile_path: `/${'q'.repeat(4000)}`,
    service_profile_path: `/${'s'.repeat(4000)}`, native_code: 'EIO', next_action: 'Inspect the elected profile' };
  const encoded = JSON.stringify(diagnostic);
  assert.ok(Buffer.byteLength(encoded) > 8192 && Buffer.byteLength(encoded) < 65_536);
  const f = await fixture(t, `process.stderr.write(${JSON.stringify(encoded + '\n')});process.exitCode=1;`);
  const launch = await launchService(f.binding, f.cli); t.after(() => launch.released());
  await assert.rejects(launch.failure, error => {
    assert.deepEqual(diagnosticInfo(error), diagnostic); return true;
  });
});

test('startup rejects unstructured, excessive, and unknown-field diagnostics with an actionable fallback', async t => {
  for (const output of ['token=arbitrary-secret\n', JSON.stringify({ code: 'BAD', message: 'x'.repeat(2049) }) + '\n',
    JSON.stringify({ code: 'BAD', message: 'arbitrary-secret', token: 'hidden' }) + '\n',
    'x'.repeat(8193) + '\n', 'x'.repeat(65536) + '\n' + JSON.stringify({ code: 'TOO_LATE', message: 'outside capture budget' }) + '\n']) {
    const f = await fixture(t, `process.stderr.write(${JSON.stringify(output)},()=>{process.exitCode=9});`);
    const launch = await launchService(f.binding, f.cli); t.after(() => launch.released());
    await assert.rejects(launch.failure, error => {
      assert.equal(error.code, 'SERVICE_START_FAILED'); assert.match(error.message, /code 9/);
      assert.equal(error.context.stage, 'service.launch'); assert.equal(error.context.path, f.cli);
      assert.ok(error.context.next_action); assert.ok(error.message.length < 2048);
      assert.ok(!JSON.stringify(error).includes('arbitrary-secret')); return true;
    });
  }
});

test('structured child startup diagnosis reaches frontend status and the real MCP SDK projection', async t => {
  const [{ PasseurFrontend }, { createMcpServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../../.passeur-core/src/service/client.js'), import('../../.passeur-core/src/mcp/server.js'),
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const raw = { code: 'PERMISSION_DENIED', message: 'token=hidden-secret', stage: 'state.prepare',
    path: '/fixture/state', native_code: 'EACCES', next_action: 'Inspect exact path permissions' };
  const f = await fixture(t, `console.error(${JSON.stringify(JSON.stringify(raw))});process.exitCode=1;`);
  const identity = { package_version: 'fixture', build_id: 'fixture', mode: 'development', node_version: process.version,
    node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const frontend = new PasseurFrontend({ project: f.binding.storeRoot, stateRoot: join(f.binding.storeRoot, 'state') }, identity, f.cli);
  const server = createMcpServer(frontend), client = new Client({ name: 'bootstrap-projection-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.shutdown(); await server.mcp.close(); });
  await server.mcp.connect(st); await client.connect(ct);
  const failed = await client.callTool({ name: 'passeur_prepare', arguments: {} });
  assert.equal(failed.isError, true);
  const body = JSON.parse(failed.content[0].text);
  assert.deepEqual(body.error, { ...raw, message: 'token=[redacted]' });
  const status = await client.callTool({ name: 'passeur_status', arguments: {} });
  assert.deepEqual(JSON.parse(status.content[0].text).service, { state: 'unavailable', ...body.error });
});

test('stderr observation does not keep the releasing frontend alive with the service', async t => {
  const f = await fixture(t, `import {writeFile} from 'node:fs/promises';
await writeFile(process.argv[process.argv.indexOf('--project')+1],String(process.pid));
setInterval(()=>{},1000);`);
  let servicePid;
  t.after(() => { if (servicePid) { try { process.kill(servicePid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } });
  const moduleUrl = pathToFileURL(join(process.cwd(), '.passeur-core/src/service/bootstrap.js')).href;
  const script = `import {readFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
const {launchService}=await import(process.argv[1]);const binding=JSON.parse(process.argv[2]);
const launch=await launchService(binding,process.argv[3]);
while(true){try{console.log(await readFile(binding.project,'utf8'));break}catch(e){if(e.code!=='ENOENT')throw e;await delay(10)}}
launch.released();`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, moduleUrl, JSON.stringify(f.binding), f.cli], { timeout: 3000 });
    servicePid = Number(stdout.trim()); assert.ok(servicePid > 0); process.kill(servicePid, 0);
  } finally {
    if (!servicePid) { try { servicePid = Number(await readFile(f.marker, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
});
