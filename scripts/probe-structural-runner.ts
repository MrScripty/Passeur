import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_REPLY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 65_000;

/**
 * This file is copied into the fixture mount. It imports only Node builtins and
 * the MCP SDK from the installed candidate. Every installed child is spawned by
 * this one long-lived process, so CLI, service, and MCP share its PID namespace.
 */
const isolatedPayload = String.raw`
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;
let service;
let serviceError = '';
let mcp;
let transport;
let closing = false;
const running = new Set();

function boundedText(chunks, size) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (length > size) throw new Error('Isolated child output exceeded limit');
  return Buffer.concat(chunks, length).toString('utf8');
}

async function childExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function execNode(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Invalid Node arguments');
  const child = spawn('/node', args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  const stdout = [], stderr = [];
  let stdoutBytes = 0, stderrBytes = 0, exceeded = false;
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT) { exceeded = true; child.kill('SIGKILL'); }
    else stdout.push(chunk);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_ERROR) { exceeded = true; child.kill('SIGKILL'); }
    else stderr.push(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated Node command timed out')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal }); });
  }).finally(() => running.delete(child));
  if (exceeded) throw new Error('Isolated child output exceeded limit');
  const error = boundedText(stderr, MAX_ERROR);
  if (code.exitCode !== 0) throw new Error('Isolated Node command exited ' + String(code.exitCode ?? code.signal) + ': ' + error.slice(-8192));
  return boundedText(stdout, MAX_OUTPUT).trim();
}

async function startService({ guard, cli, project, state, profile }) {
  if (service) throw new Error('Installed service already started');
  serviceError = '';
  service = spawn('/usr/bin/flock', ['--nonblock', '--no-fork', guard, '/node', cli, 'service-run',
    '--project', project, '--state-root', state, '--profile', profile],
  { cwd: project, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  service.stdout.on('data', chunk => { serviceError = (serviceError + String(chunk)).slice(-8192); });
  service.stderr.on('data', chunk => { serviceError = (serviceError + String(chunk)).slice(-8192); });
  await new Promise((resolve, reject) => {
    service.once('spawn', resolve);
    service.once('error', reject);
  });
  return { pid: service.pid };
}

async function stopService() {
  if (!service) return;
  const child = service;
  service = undefined;
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await childExit(child, 5_000);
}

async function mcpConnect({ cli, project, state, profile }) {
  if (mcp) throw new Error('Installed MCP already connected');
  const installedRoot = dirname(dirname(dirname(cli)));
  const sdk = join(installedRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(join(sdk, 'client', 'index.js')).href),
    import(pathToFileURL(join(sdk, 'client', 'stdio.js')).href),
  ]);
  mcp = new Client({ name: 'installed-structural-probe', version: '1' }, { capabilities: {} });
  transport = new StdioClientTransport({ command: '/node', args: [cli, 'serve',
    '--project', project, '--state-root', state, '--profile', profile],
    cwd: project, env: process.env, stderr: 'pipe' });
  try { await mcp.connect(transport, { timeout: 10_000 }); }
  catch (error) { await mcpClose(); throw error; }
}

async function mcpCallTool(name, args) {
  if (!mcp) throw new Error('Installed MCP is not connected');
  if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Invalid MCP request');
  return mcp.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
}

async function mcpClose() {
  const client = mcp;
  const currentTransport = transport;
  mcp = undefined;
  transport = undefined;
  if (client) await client.close();
  else if (currentTransport) await currentTransport.close();
}

async function close() {
  if (closing) return;
  closing = true;
  try { await mcpClose(); } finally { await stopService(); }
  for (const child of running) child.kill('SIGKILL');
}

async function dispatch(op, params) {
  switch (op) {
    case 'ready': return { pid: process.pid };
    case 'execNode': return execNode(params.args);
    case 'startService': return startService(params);
    case 'serviceState': return { exited: service ? service.exitCode !== null || service.signalCode !== null : true,
      exitCode: service?.exitCode ?? null, signal: service?.signalCode ?? null, error: serviceError };
    case 'stopService': return stopService();
    case 'mcpConnect': return mcpConnect(params);
    case 'mcpCallTool': return mcpCallTool(params.name, params.args);
    case 'mcpClose': return mcpClose();
    case 'selfCheck': {
      if (!Number.isSafeInteger(params.hostPid) || params.hostPid <= 0) throw new Error('Invalid host PID');
      const forbidden = ['/bin/sh', '/usr/bin/npm', '/usr/bin/npx', '/usr/bin/node', '/usr/bin/cc',
        '/usr/bin/gcc', '/usr/bin/g++', '/usr/bin/make', '/usr/bin/cmake', '/usr/bin/curl',
        '/usr/bin/wget'];
      const attempts = forbidden.map(path => {
        const result = spawnSync(path, ['--version'], { cwd: process.cwd(), env: process.env,
          input: '', encoding: 'utf8', timeout: 2_000, maxBuffer: 4096 });
        return { path, error: result.error?.code ?? null, status: result.status, signal: result.signal };
      });
      const unexpected = attempts.filter(attempt => attempt.error !== 'ENOENT');
      if (unexpected.length > 0) throw new Error('Forbidden absolute executable attempt did not return ENOENT: ' + JSON.stringify(unexpected));
      const hostPidRootVisible = existsSync('/proc/' + String(params.hostPid) + '/root');
      if (hostPidRootVisible) throw new Error('Host PID root is visible in isolated namespace');
      const allowedExecutables = ['/node', '/usr/bin/git', '/usr/bin/flock'];
      if (allowedExecutables.some(path => !existsSync(path))) throw new Error('An installed runtime executable is unavailable');
      return { pidNamespace: readlinkSync('/proc/self/ns/pid'),
        hostPidVisible: existsSync('/proc/' + String(params.hostPid)), hostPidRootVisible,
        netNamespace: readlinkSync('/proc/self/ns/net'), forbiddenVisible: forbidden.filter(path => existsSync(path)),
        absoluteAttempts: attempts, allowedExecutables };
    }
    case 'close': await close(); return null;
    default: throw new Error('Unknown isolated runner operation');
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let id;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Runner request exceeded limit');
    const request = JSON.parse(line);
    id = request.id;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid runner request ID');
    const value = await dispatch(request.op, request.params ?? {});
    const response = JSON.stringify({ id, value });
    if (Buffer.byteLength(response) > 5 * 1024 * 1024) throw new Error('Runner response exceeded limit');
    process.stdout.write(response + '\n');
    if (request.op === 'close') process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 16384) }) + '\n');
  }
});
input.on('close', () => { void close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
`;

export type StructuralRunner = Readonly<{
  execNode(args: string[]): Promise<string>;
  startService(options: { guard: string; cli: string; project: string; state: string; profile: string }): Promise<void>;
  serviceState(): Promise<{ exited: boolean; exitCode: number | null; signal: NodeJS.Signals | null; error: string }>;
  stopService(): Promise<void>;
  mcpConnect(options: { cli: string; project: string; state: string; profile: string }): Promise<void>;
  mcpCallTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: unknown[]; structuredContent?: unknown }>;
  mcpClose(): Promise<void>;
  selfCheck(hostPid: number): Promise<{ pidNamespace: string; hostPidVisible: boolean; hostPidRootVisible: boolean;
    netNamespace: string; forbiddenVisible: string[]; absoluteAttempts: { path: string; error: string | null;
      status: number | null; signal: NodeJS.Signals | null }[]; allowedExecutables: string[] }>;
  close(): Promise<void>;
}>;

export async function startStructuralRunner(options: {
  isolatedArgs: string[];
  project: string;
  environment: NodeJS.ProcessEnv;
  runnerFile?: string;
}): Promise<StructuralRunner> {
  const runnerFile = options.runnerFile ?? join(dirname(options.project), "isolated-runner.mjs");
  await mkdir(dirname(runnerFile), { recursive: true });
  await writeFile(runnerFile, isolatedPayload, { mode: 0o600 });
  const child: ChildProcessWithoutNullStreams = spawn("bwrap", ["--unshare-pid", ...options.isolatedArgs,
    "--chdir", options.project, "--", "/node", runnerFile],
  { cwd: options.project, env: options.environment, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let pendingLine = "";
  let nextId = 0;
  let closed = false;
  const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const failAll = (error: Error): void => {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); }
    requests.clear();
  };
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  child.stdout.on("data", chunk => {
    pendingLine += String(chunk);
    if (Buffer.byteLength(pendingLine) > MAX_REPLY_BYTES) {
      failAll(new Error("Isolated runner response exceeded limit"));
      child.kill("SIGKILL");
      return;
    }
    for (;;) {
      const newline = pendingLine.indexOf("\n");
      if (newline < 0) break;
      const line = pendingLine.slice(0, newline);
      pendingLine = pendingLine.slice(newline + 1);
      try {
        const reply = JSON.parse(line) as { id: number; value?: unknown; error?: string };
        const request = requests.get(reply.id);
        if (!request) throw new Error("Unexpected isolated runner response");
        requests.delete(reply.id);
        clearTimeout(request.timer);
        if (reply.error) request.reject(new Error(reply.error));
        else request.resolve(reply.value);
      } catch (error) {
        failAll(error instanceof Error ? error : new Error(String(error)));
        child.kill("SIGKILL");
      }
    }
  });
  child.on("error", error => failAll(error));
  child.on("exit", (code, signal) => {
    closed = true;
    failAll(new Error(`Isolated runner exited ${String(code ?? signal)}: ${stderr}`));
  });
  const request = async <T>(op: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> => {
    if (closed) throw new Error(`Isolated runner is closed: ${stderr}`);
    const id = ++nextId;
    const line = JSON.stringify({ id, op, params });
    assert.ok(Buffer.byteLength(line) < 1024 * 1024, "Isolated runner request exceeded limit");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`Isolated runner ${op} timed out: ${stderr}`));
        child.kill("SIGKILL");
      }, timeoutMs);
      requests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${line}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        requests.delete(id);
        reject(error);
      });
    });
  };
  try { await request("ready", {}, 10_000); }
  catch (error) { child.kill("SIGKILL"); throw error; }
  return {
    execNode: args => request<string>("execNode", { args }),
    startService: async service => { await request("startService", service, 15_000); },
    serviceState: () => request("serviceState"),
    stopService: async () => { await request("stopService", {}, 10_000); },
    mcpConnect: async connection => { await request("mcpConnect", connection, 15_000); },
    mcpCallTool: (name, args) => request("mcpCallTool", { name, args }),
    mcpClose: async () => { await request("mcpClose", {}, 10_000); },
    selfCheck: hostPid => request("selfCheck", { hostPid }),
    close: async () => {
      if (closed) return;
      try { await request("close", {}, 10_000); }
      finally {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}
