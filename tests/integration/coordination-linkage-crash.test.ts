import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, onTestFinished } from "vitest";
// @ts-expect-error The shared real-Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { RepositoryRuntime, resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { TaskStore } from "../../src/store/task-store.js";
import { operatorToken } from "../../src/service/operator-token.js";
import { CoordinationService } from "../../src/service/coordination.js";
import { TaskControls, initialControl } from "../../src/core/task-control.js";
import { canonicalHash } from "../../src/core/async.js";
import { coordinatedMaterialIdentity } from "../../src/contracts/tasks.js";

const identity = () => ({ package_version: "fixture", build_id: "fixture", mode: "development" as const,
  node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() });
const assignment = (base: string, requestKey = randomUUID()) => ({ schema_version: 3 as const, agent_id: "fixture",
  request_key: requestKey, mode: "implement" as const, objective: "Edit one scoped declaration",
  context: "Crash frontier integration", acceptance_criteria: ["Retain one exact task"],
  allowed_paths: ["source.ts"], base_commit: base, target_ref: "refs/heads/main" });
const profile = (worktreeRoot: string, maxQueued = 2) => ({ schema_version: 3 as const,
  execution: { stop_grace_ms: 1000, max_workers: 1, max_queued_tasks: maxQueued,
    max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
    implementation: { enabled: true, worktree_root: worktreeRoot } },
  agents: [{ agent_id: "fixture", adapter_id: "fixture", description: "", enabled: true, options: {} }] });
async function setup(name: string, store?: TaskStore) {
  const f = await serviceFixture({ name, after: onTestFinished });
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  assert.ok(token);
  const actor = { owner_id: createHash("sha256").update(token).digest("hex"), client_id: randomUUID() };
  return { f, intent, binding, actor, store: store ?? new TaskStore(binding.storeRoot), signal: new AbortController().signal };
}
function runtimeFor(context: Awaited<ReturnType<typeof setup>>, store: TaskStore, run: () => Promise<void>) {
  const runtime = new RepositoryRuntime(context.intent, identity(), { profile: async () => profile(join(context.f.temp, "worktrees")),
    store: () => store, definitions: { fixture: { configure: () => ({ modes: ["implement"], contract: "controlled-turn/1",
      configuration: {}, worker: { run: async input => { await run(); const turn_id = randomUUID();
        await input.onEvent({ kind: "turn_started", turn_id });
        await input.onEvent({ kind: "turn_settled", turn_id, terminal: "completed" });
        return { status: "completed", worker_stop: "confirmed",
        worker_assessment: "met", summary: "fixture complete", blockers: [], questions: [], checks: [] }; } } }) } } });
  context.f.sessions.push({ close: () => runtime.shutdown() });
  return runtime;
}
async function until(read: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected durable state did not settle");
}

test("disabled board and failed task publication leave no executable admission", async () => {
  const c = await setup("coordination publication failure");
  class FailingCreate extends TaskStore {
    fail = true;
    override async create(...args: Parameters<TaskStore["create"]>) {
      if (this.fail) { this.fail = false; throw new Error("injected before task publication"); }
      return super.create(...args);
    }
  }
  const store = new FailingCreate(c.binding.storeRoot);
  let starts = 0;
  const runtime = runtimeFor(c, store, async () => { starts++; });
  const request = { schema_version: 2 as const, kind: "inline" as const, assignment: assignment(c.f.base) };
  await assert.rejects(runtime.submitCoordinated(request, c.actor, c.f.root, c.signal), { code: "COORDINATION_NOT_ENABLED" });
  assert.equal((await store.list()).length, 0);
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: c.f.limits }, c.actor, c.f.root);
  await assert.rejects(runtime.submitCoordinated(request, c.actor, c.f.root, c.signal), /injected before task publication/);
  assert.equal((await store.list()).length, 0);
  assert.equal(starts, 0);
  // The failed publication has an explicit released disposition. A fresh intent uses a fresh key.
  const accepted = await runtime.submitCoordinated({ ...request, assignment: assignment(c.f.base) }, c.actor, c.f.root, c.signal);
  assert.equal((await store.durableRequest(accepted.task_id)).schema_version, 5);
  await until(async () => (await store.readResult(accepted.task_id))?.execution_status === "completed");
  assert.equal(starts, 1);
});

test("lost task-publication acknowledgment retries the same durable task and starts once after settlement", async () => {
  const c = await setup("coordination lost admission receipt");
  class LostReceipt extends TaskStore {
    lose = true;
    override async create(...args: Parameters<TaskStore["create"]>) {
      await super.create(...args);
      if (this.lose) { this.lose = false; throw new Error("injected lost task admission receipt"); }
    }
  }
  const store = new LostReceipt(c.binding.storeRoot);
  let starts = 0;
  const runtime = runtimeFor(c, store, async () => { starts++; });
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: c.f.limits }, c.actor, c.f.root);
  const request = { schema_version: 2 as const, kind: "inline" as const, assignment: assignment(c.f.base) };
  await assert.rejects(runtime.submitCoordinated(request, c.actor, c.f.root, c.signal), /injected lost task admission receipt/);
  const [record] = await store.list();
  assert.ok(record && "schema_version" in record && record.schema_version === 5);
  assert.equal(await store.readCoordinatedLink(record.task_id), undefined);
  assert.equal((await store.readControl(record.task_id)).native.state, "not_started");
  assert.equal(starts, 0);
  const accepted = await runtime.submitCoordinated(request, c.actor, c.f.root, c.signal);
  assert.equal(accepted.task_id, record.task_id);
  assert.equal((await store.readCoordinatedLink(record.task_id))?.state, "settled");
  await until(async () => (await store.readResult(record.task_id))?.execution_status === "completed");
  assert.equal(starts, 1);
  assert.equal((await runtime.submitCoordinated(request, c.actor, c.f.root, c.signal)).task_id, record.task_id);
  assert.equal(starts, 1);
});

test("an announcement payload whose publication receipt is lost is recovered by its exact operation key", async () => {
  const c = await setup("coordination lost announcement receipt");
  class LostPayloadReceipt extends TaskStore {
    lose = true;
    override async publishAnnouncement(...args: Parameters<TaskStore["publishAnnouncement"]>) {
      const payload = await super.publishAnnouncement(...args);
      if (this.lose) { this.lose = false; throw new Error("injected lost announcement payload receipt"); }
      return payload;
    }
  }
  const store = new LostPayloadReceipt(c.binding.storeRoot);
  let starts = 0;
  const runtime = runtimeFor(c, store, async () => { starts++; });
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: c.f.limits }, c.actor, c.f.root);
  const announcement = { schema_version: 1 as const, operation_key: randomUUID(),
    assignment: assignment(c.f.base), readers: [] };
  await assert.rejects(runtime.announce(announcement, c.actor, c.f.root, c.signal),
    /injected lost announcement payload receipt/);
  const recovered = await runtime.announce(announcement, c.actor, c.f.root, c.signal);
  assert.equal(recovered.record.state, "unresolved");
  assert.deepEqual((await store.readAnnouncement(recovered.record.id))?.payload.assignment, announcement.assignment);
  const reference = { schema_version: 2 as const, kind: "reference" as const,
    announcement: { id: recovered.record.id, revision: recovered.record.revision } };
  const accepted = await runtime.submitCoordinated(reference, c.actor, c.f.root, c.signal);
  assert.equal((await store.durableRequest(accepted.task_id)).schema_version, 5);
  await until(async () => (await store.readResult(accepted.task_id))?.execution_status === "completed");
  assert.equal(starts, 1);
  assert.equal((await runtime.announcement(recovered.record.id, c.actor, c.f.root, c.signal)).record.state, "linked");
});

test("restart settles an exact canceled admission before native startup with no execution profile", async () => {
  const c = await setup("coordination canceled pending link restart");
  const bootstrap = new RepositoryRuntime(c.intent, identity());
  c.f.sessions.push({ close: () => bootstrap.shutdown() });
  await bootstrap.coordinate({ schema_version: 1, kind: "initialize", limits: c.f.limits }, c.actor, c.f.root);
  await bootstrap.shutdown();

  const taskId = randomUUID(), item = assignment(c.f.base);
  const intentHash = canonicalHash(coordinatedMaterialIdentity({ schema_version: 2,
    source_view: c.f.root, assignment: item }));
  const metadata = new CoordinationService({ store_root: c.binding.storeRoot, repository_id: c.binding.repositoryId }, {
    assertOwned() {}, async authorizeInitialization() {},
    externalWorkspaces: { async assertExternalRegistration() {} },
  }, { ordinary_requests: 16, control_requests: 4, max_source_operations: 4, max_worktrees: 64 });
  const connection = { owner_id: c.actor.owner_id, source_view: c.f.root };
  const bound = await metadata.bindSubmission(connection, { operation_key: `passeur-internal:bind:${item.request_key}`,
    task_id: taskId, request_key: item.request_key, source_view: c.f.root, input_oid: c.f.base,
    intent_hash: intentHash, areas: [{ kind: "subtree", path: "source.ts" }] });
  assert.equal(bound.state, "bound");
  await metadata.close();

  const store = c.store;
  const link = { schema_version: 1 as const, task_id: taskId, request_key: item.request_key,
    owner_id: c.actor.owner_id, intent_hash: intentHash,
    decision_identity: bound.decision_identity, link_hash: bound.link_hash };
  await store.create({ schema_version: 5, task_id: taskId, project_id: c.binding.repositoryId,
    canonical_hash: intentHash, accepted_at: new Date().toISOString(), source_view: c.f.root,
    initial_owner: c.actor.owner_id, request: item,
    execution: { schema_version: 2, agent_id: "fixture", adapter_id: "fixture", adapter_contract: "controlled-turn/1",
      configuration: {}, configuration_fingerprint: canonicalHash({}), policy: profile(join(c.f.temp, "worktrees")).execution },
    linkage: link }, initialControl(taskId, c.actor.owner_id));
  const control = await store.readControl(taskId);
  await new TaskControls(store, 128, 512).cancel(taskId, c.actor, control.control_generation, randomUUID(), "Stop before start");
  assert.equal(await store.readCoordinatedLink(taskId), undefined);
  assert.equal((await store.readControl(taskId)).native.state, "not_started");

  const reopened = new RepositoryRuntime(c.intent, identity());
  c.f.sessions.push({ close: () => reopened.shutdown() });
  await reopened.prepare(c.signal);
  await until(async () => (await store.readControl(taskId)).phase === "terminal");
  assert.equal((await store.readCoordinatedLink(taskId))?.state, "settled");
  assert.equal((await store.readControl(taskId)).native.state, "not_started");
  assert.equal((await store.readResult(taskId))?.execution_status, "cancelled");
  assert.equal(reopened.status().execution.profile, "not_checked");
});
