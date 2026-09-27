import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, runManagedProcess, settleGroup } from '../../scripts/qualify-muse-native-shell.mjs';

test('fake provider serves the catalog and only one model-issued bash call', async () => {
  const fixture = await startFixture('printf sentinel > disposable-canary');
  try {
    const catalog = await fetch(`${fixture.url}/muse-code/models`, {
      headers: { authorization: 'Bearer fixture-key-never-real' },
    });
    assert.equal(catalog.status, 200);
    const models = await catalog.json();
    assert.equal(models.object, 'list');
    assert.equal(models.data[0].id, 'fixture-native-shell');
    assert.equal(models.data[0].metadata['muse-code'].is_hidden, false);

    const post = (body) => fetch(`${fixture.url}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const first = await post({ model: 'fixture-native-shell', input: 'NATIVE_SHELL_PROBE' });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type'), /text\/event-stream/);
    const firstEvents = (await first.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(firstEvents.map(event => event.type), [
      'response.created', 'response.function_call_arguments.done', 'response.completed',
    ]);
    assert.equal(firstEvents[1].name, 'bash');
    assert.deepEqual(JSON.parse(firstEvents[1].arguments), {
      command: 'printf sentinel > disposable-canary', description: 'Disposable native shell qualification',
    });

    const second = await post({ model: 'fixture-native-shell', input: 'NATIVE_SHELL_PROBE' });
    assert.equal(second.status, 200);
    assert.doesNotMatch(await second.text(), /response.function_call_arguments.done/);
    const unsupported = await fetch(`${fixture.url}/unknown`);
    assert.equal(unsupported.status, 501);
    assert.equal(fixture.requests.length, 4);
    assert.ok(fixture.requests.every(request => !JSON.stringify(request).includes('fixture-key-never-real')));
  } finally {
    await fixture.close();
  }
});

test('closed parent pipes do not abandon a SIGTERM-ignoring child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-stop-test-'));
  const pidFile = join(root, 'pids.json');
  const grandchild = [
    'process.on("SIGTERM", () => {});',
    'process.send("ready");',
    'setInterval(() => {}, 1000);',
  ].join('');
  const parent = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],`,
    "{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
    'const { writeFileSync } = require("node:fs");',
    `child.once("message", () => { writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ group: process.pid, child: child.pid })); process.exit(0); });`,
  ].join('');
  try {
    const result = await runManagedProcess(process.execPath, ['-e', parent], { cwd: root, env: process.env });
    assert.equal(result.code, 0);
    const { child: pid } = JSON.parse(await readFile(pidFile, 'utf8'));
    let state;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.ok(state === undefined || state === 'Z' || state === 'X', `descendant remained active: ${state}`);
  } finally {
    try {
      const { group, child } = JSON.parse(await readFile(pidFile, 'utf8'));
      const stat = await readFile(`/proc/${child}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) process.kill(-group, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('stop-verification errors retain the uncertain-stop classification and cause', async () => {
  const cause = Object.assign(new Error('proc unavailable'), { code: 'EACCES' });
  await assert.rejects(settleGroup(123456, async () => { throw cause; }), error => {
    assert.equal(error.code, 'GROUP_NOT_STOPPED');
    assert.equal(error.groupId, 123456);
    assert.equal(error.cause, cause);
    return true;
  });
});
