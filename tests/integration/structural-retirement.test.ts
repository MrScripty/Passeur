import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, onTestFinished } from "vitest";
// @ts-expect-error Shared real Git fixture is JavaScript.
import { serviceFixture, git } from "../fixtures/structural/service-fixture.mjs";
import type { RepositoryRuntime as RuntimeType } from "../../src/core/repository-runtime.js";
import type { TaskStore as TaskStoreType } from "../../src/store/task-store.js";
import type { WorkerInput } from "../../src/agents/types.js";

const identity = () => ({ package_version: "fixture", build_id: "fixture", mode: "development" as const,
  node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() });
const key = () => randomUUID();
const command = (value: Record<string, unknown>) => ({ schema_version: 1 as const, kind: "command" as const, command: value });
const read = (kind: "work" | "case", id: string) => ({ schema_version: 1 as const, kind: "read" as const,
  selector: { kind, id }, offset: 0, limit: 8192, expected_hash: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function until(ready: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected durable task state did not settle");
}

test("automatic managed result survives selection, observation, adoption and release-first Git retirement", async () => {
  const moduleAt = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken }] = await Promise.all([
    moduleAt("core/repository-runtime.js"), moduleAt("store/task-store.js"), moduleAt("service/operator-token.js"),
  ]);
  const f = await serviceFixture({ name: "structural retirement integration", after: onTestFinished });
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  assert.ok(token);
  const owner = { owner_id: createHash("sha256").update(token).digest("hex"), client_id: key() };
  const successor = { owner_id: "b".repeat(64), client_id: key() };
  const store = new TaskStore(binding.storeRoot), workerCommitted = gate(), finishWorker = gate();
  const runtime = new RepositoryRuntime(intent, identity(), {
    store: () => store,
    profile: async () => ({ schema_version: 3 as const, execution: { stop_grace_ms: 1000, max_workers: 1,
      max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
      implementation: { enabled: true, worktree_root: join(f.temp, "managed-worktrees") } },
      agents: [{ agent_id: "fixture", adapter_id: "fixture", description: "", enabled: true, options: {} }] }),
    definitions: { fixture: { configure: () => ({ modes: ["implement"], contract: "controlled-turn/1", configuration: {},
      worker: { run: async (input: WorkerInput) => {
        try {
          await writeFile(join(input.workspace, "source.ts"), "export function run(value: string): number { return value.length; }\n");
          await git(input.workspace, ["add", "--", "source.ts"]);
          await git(input.workspace, ["-c", "user.name=Retirement fixture", "-c", "user.email=fixture@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "-m", "test: completed managed declaration"]);
          workerCommitted.release();
          await finishWorker.promise;
          const turn_id = key();
          await input.onEvent({ kind: "turn_started", turn_id });
          await input.onEvent({ kind: "turn_settled", turn_id, terminal: "completed" });
          return { status: "completed" as const, worker_stop: "confirmed" as const, worker_assessment: "met" as const,
            summary: "fixture committed one declaration", blockers: [], questions: [], checks: [] };
        } finally { workerCommitted.release(); }
      } } }) } },
  });
  f.sessions.push({ close: async () => { finishWorker.release(); await runtime.shutdown(); } });
  const signal = new AbortController().signal;
  const coordinate = (request: Parameters<RuntimeType["coordinate"]>[0]) => runtime.coordinate(request, owner, f.root);
  const item = async (kind: "work" | "case", id: string) => {
    const reply = await coordinate(read(kind, id));
    assert.equal(reply.kind, "page");
    return JSON.parse(reply.content);
  };
  await coordinate({ schema_version: 1, kind: "initialize", limits: f.limits });
  const assignment = { schema_version: 3 as const, agent_id: "fixture", request_key: key(), mode: "implement" as const,
    objective: "Change one declaration", context: "Real Git and durable retirement acceptance",
    acceptance_criteria: ["Keep exact source commit"], allowed_paths: ["source.ts"],
    base_commit: f.base, target_ref: "refs/heads/main" };
  const admitted = await runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment }, owner, f.root, signal);
  await workerCommitted.promise;
  const taskId = admitted.task_id;
  const admission = await store.durableRequest(taskId);
  assert.equal(admission.schema_version, 5);
  const resource = await store.readResource(taskId);
  assert.ok(resource?.worktree_path && resource.branch_ref);
  const workspace = resource.worktree_path, branch = resource.branch_ref;
  const head = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  assert.notEqual(head, f.base);
  assert.equal((await git(f.root, ["rev-parse", branch])).trim(), head);
  assert.equal((await item("work", taskId)).managed.task_id, taskId, "prepared workspace enrolls without parent-authored task metadata");

  // Source capture and a watcher traverse the actual managed workspace while native work owns it.
  const work = await item("work", taskId);
  await coordinate(command({ kind: "watch_source", operation_key: key(), work_id: taskId,
    expected_revision: work.revision, watchers: [{ recipient: owner.owner_id, regions: [{ kind: "file", path: "source.ts" }] }] }));
  const report = await runtime.structuralReport(taskId, owner, f.root);
  assert.equal(report.reports.length, 1);
  assert.match(report.reports[0]!.text, /value: string/);
  await runtime.structuralRefresh(taskId, owner);
  assert.ok((await runtime.structuralNoticePull(owner, 0)).notices.length > 0);

  finishWorker.release();
  await until(async () => (await store.readControl(taskId)).phase === "terminal" && !!await store.readResult(taskId));
  const result = await store.readResult(taskId);
  assert.equal(result?.worker_stop, "confirmed");
  const claimed = await coordinate(command({ kind: "claim_target", operation_key: key(), target: "refs/heads/main", members: [] }));
  assert.equal(claimed.kind, "receipt");
  const caseId = claimed.receipt.item_id;
  let selected = await item("case", caseId);
  await coordinate(command({ kind: "select_inputs", operation_key: key(), case_id: caseId,
    expected_revision: selected.revision, generation: selected.generation,
    target_oid: f.base, inputs: [{ work_id: taskId, commit_oid: head }] }));
  const archive = { task_id: taskId, operation_key: key(), disposition: "archived" as const,
    expected_head: head, expected_branch_ref: branch, cleanup_authorized: true, archive_authorized: true,
    reason: "Exact test-owned result protected by archive ref" };
  const [refused] = await runtime.finalize([archive]);
  assert.equal(refused?.error?.code, "COORDINATION_RESULT_SELECTED");
  await access(workspace);
  assert.equal((await git(f.root, ["rev-parse", branch])).trim(), head);
  assert.equal((await git(f.root, ["rev-parse", "refs/heads/main"])).trim(), f.base);
  const [retained] = await runtime.finalize([{ ...archive, operation_key: key(), disposition: "retained",
    owner: "fixture owner", reason: "case still selects this result", next_action: "release the case" }]);
  assert.equal(retained?.receipt?.resource.state, "retained");
  await access(workspace);

  // Task control adoption and metadata ownership are separate authorities. Selection remains in force.
  await runtime.attachTask({ task_id: taskId }, successor, key());
  assert.equal((await store.readControl(taskId)).owner_id, successor.owner_id);
  assert.equal((await item("work", taskId)).owner, owner.owner_id);
  const [afterAdoption] = await runtime.finalize([{ ...archive, operation_key: key() }]);
  assert.equal(afterAdoption?.error?.code, "COORDINATION_RESULT_SELECTED");

  selected = await item("case", caseId);
  await coordinate(command({ kind: "release_case", operation_key: key(), case_id: caseId,
    expected_revision: selected.revision, generation: selected.generation }));
  const secondClaim = await coordinate(command({ kind: "claim_target", operation_key: key(),
    target: "refs/heads/main", members: [] }));
  assert.equal(secondClaim.kind, "receipt");
  const secondCase = await item("case", secondClaim.receipt.item_id);
  const retirementIntent = gate(), resumeRetirement = gate();
  const writeOperation = store.writeOperation.bind(store);
  let pauseIntent = true;
  store.writeOperation = async (id: Parameters<TaskStoreType["writeOperation"]>[0],
    record: Parameters<TaskStoreType["writeOperation"]>[1]) => {
    await writeOperation(id, record);
    if (id === taskId && record.state === "intent" && pauseIntent) {
      pauseIntent = false;
      retirementIntent.release();
      await resumeRetirement.promise;
    }
  };
  const retirement = runtime.finalize([{ ...archive, operation_key: key() }]);
  try {
    await retirementIntent.promise;
    await assert.rejects(coordinate(command({ kind: "select_inputs", operation_key: key(),
      case_id: secondCase.id, expected_revision: secondCase.revision, generation: secondCase.generation,
      target_oid: f.base, inputs: [{ work_id: taskId, commit_oid: head }] })),
    { code: "COORDINATION_RETIREMENT_ACTIVE" });
    await assert.rejects(runtime.attachTask({ task_id: taskId }, owner, key()), { code: "COORDINATION_TASK_BUSY" });
    // The source reader can complete against the pinned checkout or return a typed unavailable
    // outcome. It must never silently read another path or change native task control.
    try {
      const during = await runtime.structuralReport(taskId, owner, f.root);
      assert.equal(during.reports[0]?.path, "source.ts");
    } catch (error) {
      assert.ok(["STRUCTURAL_SOURCE_FORBIDDEN", "COORDINATION_TASK_RESOURCE_UNAVAILABLE", "STRUCTURAL_SOURCE_CHANGED",
        "COORDINATION_WORKSPACE_UNAVAILABLE"].includes((error as { code?: string }).code ?? ""), String(error));
    }
  } finally { resumeRetirement.release(); }
  const [retired] = await retirement;
  assert.equal(retired?.receipt?.resource.state, "retired", JSON.stringify(retired));
  await assert.rejects(access(workspace), { code: "ENOENT" });
  assert.equal((await git(f.root, ["rev-parse", `refs/passeur/archive/${taskId}`])).trim(), head);
  assert.equal((await git(f.root, ["for-each-ref", "--format=%(refname)", branch])).trim(), "");
  assert.equal((await git(f.root, ["rev-parse", "refs/heads/main"])).trim(), f.base);
  assert.equal((await store.readResource(taskId))?.state, "retired");
  const retainedResult = await store.readResult(taskId);
  assert.ok(retainedResult && "delivery" in retainedResult);
  assert.equal(retainedResult.delivery.head_commit, head);

  // A registered external linked worktree is outside DispositionManager ownership.
  const external = await f.linked("external-source");
  const externalHead = (await git(external, ["rev-parse", "HEAD"])).trim();
  const externalWork = await runtime.coordinate(command({ kind: "register_external_work", operation_key: key(),
    input_oid: f.base, intent: "Retain external workspace", areas: [{ kind: "file", path: "source.ts" }], readers: [] }), owner, external);
  assert.equal(externalWork.kind, "receipt");
  assert.ok(externalWork.receipt.item_id);
  const [notManaged] = await runtime.finalize([{ ...archive, task_id: externalWork.receipt.item_id,
    operation_key: key(), expected_head: externalHead, expected_branch_ref: "refs/heads/external-source" }]);
  assert.equal(notManaged?.error?.code, "STORE_INCOMPLETE");
  await access(external);
  assert.equal((await git(external, ["rev-parse", "HEAD"])).trim(), externalHead);
}, 120_000);
