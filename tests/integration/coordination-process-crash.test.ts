import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, onTestFinished } from "vitest";
// @ts-expect-error The shared real-Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { RepositoryRuntime, resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { TaskStore } from "../../src/store/task-store.js";
import { operatorToken } from "../../src/service/operator-token.js";

type Frontier = "payload" | "announcement" | "binding" | "admission" | "settlement" | "receipt" | "native-intent";
type Signal = { frontier: Frontier; task_id?: string; announcement_id?: string };

const identity = () => ({ package_version: "fixture", build_id: "fixture", mode: "development" as const,
  node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() });
const policy = (root: string) => ({ schema_version: 3 as const, execution: { stop_grace_ms: 1000, max_workers: 1,
  max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
  implementation: { enabled: true, worktree_root: root } },
  agents: [{ agent_id: "fixture", adapter_id: "fixture", description: "", enabled: true, options: {} }] });

// This script runs in a separate Node process with the compiled production modules. Each barrier
// acknowledges a completed durable write and then suspends before its caller can advance.
const childScript = String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleAt = path => import(pathToFileURL(join(process.cwd(), 'dist/src', path)).href);
const [{RepositoryRuntime, resolveRepositoryBinding}, {TaskStore}, {CoordinationService}, {operatorToken}] = await Promise.all([
  moduleAt('core/repository-runtime.js'), moduleAt('store/task-store.js'),
  moduleAt('service/coordination.js'), moduleAt('service/operator-token.js')]);
const config = JSON.parse(process.env.PASSEUR_CRASH_CONFIG);
const {frontier, intent, assignment, operationKey, startLog} = config;
const pause = details => {
  process.stdout.write('FRONTIER ' + JSON.stringify({frontier, ...details}) + '\n');
  setInterval(() => {}, 1000);
  return new Promise(() => {});
};
const wrap = (prototype, name, after) => {
  const original = prototype[name];
  prototype[name] = async function(...args) {
    const value = await original.apply(this, args);
    if (frontier === after) await pause({task_id: value?.task_id ?? args[0]?.task_id,
      announcement_id: value?.id});
    return value;
  };
};
wrap(TaskStore.prototype, 'publishAnnouncement', 'payload');
wrap(CoordinationService.prototype, 'announce', 'announcement');
wrap(CoordinationService.prototype, 'bindSubmission', 'binding');
wrap(TaskStore.prototype, 'create', 'admission');
wrap(CoordinationService.prototype, 'settleSubmission', 'settlement');
if (frontier === 'native-intent') {
  const original = TaskStore.prototype.writeState;
  TaskStore.prototype.writeState = async function(id, state) {
    await original.call(this, id, state);
    if (state.native?.state === 'unknown') await pause({task_id: id});
  };
}
const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
const token = await operatorToken(binding, true);
const actor = {owner_id: createHash('sha256').update(token).digest('hex'), client_id: randomUUID()};
const runtime = new RepositoryRuntime(intent, {package_version:'fixture',build_id:'fixture',mode:'development',
  node_version:process.version,node_executable:process.execPath,pid:process.pid,started_at:new Date().toISOString()}, {
  profile: async () => ({schema_version:3,execution:{stop_grace_ms:1000,max_workers:1,max_queued_tasks:2,
    max_clients:32,max_waiters:128,max_pending_inputs:16,max_control_receipts:512,
    implementation:{enabled:true,worktree_root:join(config.temp,'worktrees')}},
    agents:[{agent_id:'fixture',adapter_id:'fixture',description:'',enabled:true,options:{}}]}),
  definitions:{fixture:{configure:()=>({modes:['implement'],contract:'controlled-turn/1',configuration:{},
    worker:{run:async input=>{await appendFile(startLog, input.task_id+'\n');
      const turn_id=randomUUID();await input.onEvent({kind:'turn_started',turn_id});
      await input.onEvent({kind:'turn_settled',turn_id,terminal:'completed'});
      return {status:'completed',worker_stop:'confirmed',worker_assessment:'met',summary:'fixture complete',
        blockers:[],questions:[],checks:[]};}}})}}});
const request = {schema_version:2,kind:'inline',assignment};
if (frontier === 'native-intent') setInterval(() => {}, 1000);
if (frontier === 'payload' || frontier === 'announcement') {
  await runtime.announce({schema_version:1,operation_key:operationKey,assignment,readers:[]},actor,intent.project,new AbortController().signal);
} else {
  const result = await runtime.submitCoordinated(request,actor,intent.project,new AbortController().signal);
  if (frontier === 'receipt') await pause({task_id:result.task_id});
}
`;

async function killedAt(frontier: Frontier, config: Record<string, unknown>): Promise<Signal> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: process.cwd(), env: { ...process.env, PASSEUR_CRASH_CONFIG: JSON.stringify({ ...config, frontier }) }, stdio: "pipe",
  });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", value => { errors += value; });
  const reached = new Promise<Signal>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out before ${frontier}: stdout=${output} stderr=${errors}`)), 20_000);
    child.stdout.on("data", (value: string) => {
      output += value;
      const line = output.split("\n").find(item => item.startsWith("FRONTIER "));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(9)) as Signal); }
    });
    child.on("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Child exited before ${frontier}: ${code}/${signal}: ${errors}`)); });
  });
  try {
    const signal = await reached;
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
    return signal;
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

async function waitUntil(read: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Retained coordinated state did not settle");
}

test.each<Frontier>(["payload", "announcement", "binding", "admission", "settlement", "receipt", "native-intent"])(
  "fresh process dies after %s publication and exact request reopens", async frontier => {
    const fixture = await serviceFixture({ name: `coordinated process ${frontier}`, after: onTestFinished });
    await fixture.service.close();
    const intent = { project: fixture.root, stateRoot: fixture.state, profilePath: join(fixture.temp, "missing-profile.json") };
    const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
    const token = await operatorToken(binding, true);
    assert.ok(token);
    const actor = { owner_id: createHash("sha256").update(token).digest("hex"), client_id: randomUUID() };
    const bootstrap = new RepositoryRuntime(intent, identity());
    await bootstrap.coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits }, actor, fixture.root);
    await bootstrap.shutdown();
    const assignment = { schema_version: 3 as const, agent_id: "fixture", request_key: randomUUID(),
      mode: "implement" as const, objective: "Edit one scoped declaration", context: "Process crash frontier",
      acceptance_criteria: ["Retain exact task"], allowed_paths: ["source.ts"], base_commit: fixture.base, target_ref: "refs/heads/main" };
    const startLog = join(fixture.temp, "starts.log");
    const operationKey = randomUUID();
    const checkpoint = await killedAt(frontier, { intent, assignment, operationKey, temp: fixture.temp, startLog });
    assert.equal(checkpoint.frontier, frontier);
    const store = new TaskStore(binding.storeRoot);
    const retained = await store.list();
    const preAdmission = frontier === "payload" || frontier === "announcement" || frontier === "binding";
    assert.equal(retained.length, preAdmission ? 0 : 1);
    if (!preAdmission) {
      const record = retained[0]!;
      assert.ok("schema_version" in record && record.schema_version === 5);
      assert.equal(record.request.request_key, assignment.request_key);
      assert.equal(record.task_id, checkpoint.task_id);
      assert.equal((await store.readControl(record.task_id)).native.state, frontier === "native-intent" ? "unknown" : "not_started");
      assert.equal((await store.readCoordinatedLink(record.task_id))?.state, frontier === "receipt" || frontier === "native-intent" ? "settled" : undefined);
    }
    if (frontier === "payload") assert.equal((await store.readAnnouncement(checkpoint.announcement_id!))?.control.state, "unresolved");
    if (frontier === "announcement") assert.equal((await store.readAnnouncement(checkpoint.announcement_id!))?.control.state, "unresolved");
    const startsBefore = await readFile(startLog, "utf8").catch(() => "");
    assert.equal(startsBefore.trim().split("\n").filter(Boolean).length, 0);
    // The killed process cannot release its proper-lockfile lease. Let the production stale
    // interval elapse; deleting the lock would bypass the actual restart contract.
    await new Promise(resolve => setTimeout(resolve, 31_000));
    const reopened = new RepositoryRuntime(intent, identity(), { profile: async () => policy(join(fixture.temp, "worktrees")),
      definitions: { fixture: { configure: () => ({ modes: ["implement"], contract: "controlled-turn/1", configuration: {},
        worker: { run: async input => { const { appendFile } = await import("node:fs/promises");
          await appendFile(startLog, `${input.task_id}\n`); const turn_id = randomUUID();
          await input.onEvent({ kind: "turn_started", turn_id }); await input.onEvent({ kind: "turn_settled", turn_id, terminal: "completed" });
          return { status: "completed", worker_stop: "confirmed", worker_assessment: "met", summary: "fixture complete",
            blockers: [], questions: [], checks: [] }; } } }) } } });
    fixture.sessions.push({ close: () => reopened.shutdown() });
    if (frontier === "native-intent") {
      await assert.rejects(reopened.prepare(new AbortController().signal), { code: "PROJECT_NEEDS_RECONCILIATION" });
      assert.equal((await store.durableRequest(retained[0]!.task_id)).task_id, retained[0]!.task_id);
      assert.equal((await store.readControl(retained[0]!.task_id)).native.state, "unknown");
      assert.equal((await readFile(startLog, "utf8").catch(() => "")).trim(), "");
      return;
    }
    await reopened.prepare(new AbortController().signal);
    if (frontier === "admission" || frontier === "settlement") {
      await waitUntil(async () => (await store.readCoordinatedLink(retained[0]!.task_id))?.state === "settled");
    }
    if (frontier === "payload" || frontier === "announcement") {
      const announcement = await reopened.announce({ schema_version: 1, operation_key: operationKey, assignment, readers: [] }, actor,
        fixture.root, new AbortController().signal);
      assert.equal(announcement.record.id, checkpoint.announcement_id);
    }
    const request = { schema_version: 2 as const, kind: "inline" as const, assignment };
    let observed: Awaited<ReturnType<RepositoryRuntime["submitCoordinated"]>> | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { observed = await reopened.submitCoordinated(request, actor, fixture.root, new AbortController().signal); break; }
      catch (error) {
        if ((error as { code?: string }).code !== "COORDINATION_LINK_RECONCILIATION_PENDING") throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.ok(observed, "Exact retry remained blocked after startup reconciliation");
    if (!preAdmission) assert.equal(observed.task_id, retained[0]!.task_id);
    const acceptedBeforeCrash = frontier === "admission" || frontier === "settlement" || frontier === "receipt";
    if (!acceptedBeforeCrash) await waitUntil(async () => (await store.readControl(observed.task_id)).phase === "terminal");
    assert.equal((await store.list()).length, 1);
    const starts = (await readFile(startLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    if (acceptedBeforeCrash) {
      assert.deepEqual(starts, []);
      assert.equal((await store.readControl(observed.task_id)).native.state, "not_started");
      assert.equal((await store.readCoordinatedLink(observed.task_id))?.state, "settled");
    } else assert.deepEqual(starts, [observed.task_id]);
  }, 90_000);
