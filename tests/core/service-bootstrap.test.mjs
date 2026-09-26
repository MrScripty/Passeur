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
