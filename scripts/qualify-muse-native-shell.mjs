#!/usr/bin/env node
// Disposable, no-account probe of the installed Muse model-issued shell path.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const MODEL = 'fixture-native-shell';
const LIMIT_BYTES = 1_000_000;
const RUN_MS = 20_000;

function uncertainGroupStop(groupId, cause) {
  const error = new Error(`GROUP_NOT_STOPPED: process group ${groupId} could not be verified stopped`, { cause });
  error.code = 'GROUP_NOT_STOPPED';
  error.groupId = groupId;
  return error;
}

async function activeGroupMembers(groupId) {
  try { process.kill(-groupId, 0); }
  catch (error) { if (error.code === 'ESRCH') return []; throw error; }
  const entries = await readdir('/proc');
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === groupId && !['Z', 'X'].includes(fields[0])) members.push(Number(entry));
  }
  return members;
}

export async function settleGroup(groupId, inspectGroup = activeGroupMembers) {
  try {
    const signal = (name) => {
      try { process.kill(-groupId, name); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const waitUntilEmpty = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await inspectGroup(groupId)).length === 0) return true;
        await delay(100);
      }
      return false;
    };
    if ((await inspectGroup(groupId)).length === 0) return;
    signal('SIGTERM');
    if (await waitUntilEmpty()) return;
    signal('SIGKILL');
    if (await waitUntilEmpty()) return;
    throw new Error('live group members remain after SIGKILL');
  } catch (cause) {
    throw uncertainGroupStop(groupId, cause);
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function startFixture(command) {
  const requests = [];
  let scripted = false;
  const server = createServer(async (request, response) => {
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > LIMIT_BYTES) throw new Error('request too large');
      }
    } catch {
      json(response, 413, { error: { message: 'fixture request too large' } });
      return;
    }
    // Never retain the Authorization header or dummy API key.
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    requests.push({ method: request.method, path: request.url, bytes: body.length,
      model: parsed?.model, toolNames: parsed?.tools?.map(tool => tool.name ?? tool.function?.name) });
    if (request.method === 'GET' && request.url === '/muse-code/models') {
      json(response, 200, { object: 'list', data: [{ id: MODEL, object: 'model', metadata: {
        'muse-code': { release_date: '2026-01-01', is_hidden: false, limit: { context: 1_000_000, output: 1024 } },
      } }] });
    } else if (request.method === 'POST' && request.url === '/responses') {
      const doTool = !scripted && body.includes('NATIVE_SHELL_PROBE');
      const id = doTool ? 'resp_fixture_tool' : 'resp_fixture_text';
      const frame = (status) => ({ id, object: 'response', model: MODEL, status, output: [] });
      const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
      const events = [sse({ type: 'response.created', sequence_number: 1, response: frame('in_progress') })];
      if (doTool) {
        events.push(sse({ type: 'response.function_call_arguments.done', sequence_number: 2,
          output_index: 0, item_id: 'fc_fixture', name: 'bash', call_id: 'call_fixture',
          arguments: JSON.stringify({ command, description: 'Disposable native shell qualification' }) }));
      } else {
        events.push(sse({ type: 'response.output_text.delta', sequence_number: 2, output_index: 0,
          item_id: 'msg_fixture_done', content_index: 0, delta: 'Fixture complete.' }));
      }
      events.push(sse({ type: 'response.completed', sequence_number: 3,
        response: { ...frame('completed'), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.join(''));
      if (doTool) scripted = true;
    } else {
      json(response, 501, { error: { message: 'fixture has no response contract for this request' } });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

function run(command, args, options, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let capped = false;
    let timedOut = false;
    let hardStop;
    const stop = () => {
      if (!child.pid || hardStop) return;
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') { reject(uncertainGroupStop(child.pid, error)); return; } }
      hardStop = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') reject(uncertainGroupStop(child.pid, error)); }
      }, 2_000);
    };
    const collect = (field, chunk) => {
      const next = (field === 'stdout' ? stdout : stderr) + chunk;
      if (field === 'stdout') stdout = next.slice(0, LIMIT_BYTES);
      else stderr = next.slice(0, LIMIT_BYTES);
      if (next.length > LIMIT_BYTES) { capped = true; stop(); }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk.toString()));
    child.stderr.on('data', chunk => collect('stderr', chunk.toString()));
    child.once('error', error => { clearTimeout(timeout); clearTimeout(hardStop); reject(error); });
    const timeout = setTimeout(() => { timedOut = true; stop(); }, RUN_MS);
    child.once('close', async (code, signal) => {
      clearTimeout(timeout);
      try { if (child.pid) await settleGroup(child.pid); }
      catch (error) { clearTimeout(hardStop); reject(error); return; }
      clearTimeout(hardStop);
      const events = stdout.split('\n').flatMap(line => {
        try {
          const item = JSON.parse(line);
          if (!item.payload_type) return [];
          return [{ type: item.payload_type, event: item.payload?.event?.kind,
            task_kind: item.payload?.event?.task_kind,
            message: item.payload?.event?.message?.slice(0, 300),
            detail: ['tool.result', 'task.lifecycle.output'].includes(item.payload_type)
              ? JSON.stringify(item.payload).slice(0, 2_000) : undefined }];
        } catch { return []; }
      });
      resolve({ code, signal, timedOut, stdout: stdout.slice(-2_000), events: events.slice(-100), stderr: stderr.slice(-4_000), capped });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export { run as runManagedProcess };

export async function qualify({ muse = '/home/jeremy/.local/bin/muse', scenario = 'git' } = {}) {
  const commands = {
    git: 'printf forbidden > .git/probe',
    inside: 'printf shell-ran > shell-canary',
    outside: 'printf forbidden > ../outside-canary',
    commit: 'printf shell-ran > shell-canary && git add shell-canary && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture-shell',
  };
  if (!(scenario in commands)) throw new Error('scenario must be git, inside, outside, or commit');
  const root = await mkdtemp(join(tmpdir(), 'passeur-muse-native-shell-'));
  let fixture;
  let retainOnUncertainStop = false;
  try {
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(home);
    await mkdir(workspace);
    const env = {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: root, PATH: process.env.PATH ?? '/usr/bin:/bin',
      MUSE_NO_AUTO_UPDATE: '1', LANG: 'C.UTF-8',
    };
    const version = await run(muse, ['--version'], { env, cwd: root });
    if (version.code !== 0 || !version.stdout.includes('1.4.0-R4302.1')) {
      throw new Error(`installed Muse version mismatch: ${version.stdout.trim() || version.stderr.trim()}`);
    }
    const init = await run('git', ['init', '-q', workspace], { env, cwd: root });
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
    await writeFile(join(workspace, 'README.md'), 'disposable fixture\n');
    const add = await run('git', ['-C', workspace, 'add', 'README.md'], { env, cwd: root });
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const commit = await run('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { env, cwd: root });
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    await writeFile(join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf hook-ran > hook-canary\n');
    await chmod(join(workspace, '.git', 'hooks', 'pre-commit'), 0o755);
    fixture = await startFixture(commands[scenario]);
    const prompt = `NATIVE_SHELL_PROBE: Use your native bash workspace tool to run the requested disposable ${scenario} scenario. Report the actual tool result. Do not use userShell.`;
    const result = await run(muse, [
      'exec', '--json', '--provider', 'meta', '--base-url', fixture.url,
      '--api-key-stdin', '--model', MODEL, '--workspace', workspace,
      '--no-session-log', '--no-foreign-personal-context', '--disable-web-tools',
      '--approval-mode', scenario === 'inside' ? 'on-request' : 'never', '--max-model-steps', '4', prompt,
    ], { env, cwd: workspace }, 'fixture-key-never-real\n');
    const files = {};
    for (const name of ['shell-canary', 'hook-canary', '.git/probe', '../outside-canary']) {
      try { files[name] = await readFile(join(workspace, name), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') files[name] = null; else throw error; }
    }
    const head = await run('git', ['-C', workspace, 'log', '-1', '--format=%H %s'], { env, cwd: root });
    const status = await run('git', ['-C', workspace, 'status', '--short'], { env, cwd: root });
    return { fixture: 'no-account-loopback', scope: 'offline diagnostic only', scenario,
      nativeApprovalMode: scenario === 'inside' ? 'on-request' : 'never',
      nativeSandboxInvocation: 'no sandbox override flag passed; enforcement unverified',
      observationWindowMs: RUN_MS,
      muse, version: version.stdout.trim(), requests: fixture.requests, result, files,
      git: { head: head.stdout.trim(), status: status.stdout.trim() } };
  } catch (error) {
    if (error.code === 'GROUP_NOT_STOPPED') {
      retainOnUncertainStop = true;
      error.message += `; disposable fixture retained at ${root}`;
    }
    throw error;
  } finally {
    if (fixture) await fixture.close();
    if (!retainOnUncertainStop) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(await qualify({ scenario: process.argv[2] ?? 'git' }), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
