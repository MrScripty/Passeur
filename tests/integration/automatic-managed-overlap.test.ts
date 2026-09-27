import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, onTestFinished } from "vitest";
// @ts-expect-error Shared real Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import type { WorkerInput } from "../../src/agents/types.js";

test.each(["different owners", "same owner"])("actual overlapping managed edits establish a selected case without a parent claim: %s", async ownership => {
  const moduleAt = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken }] = await Promise.all([
    moduleAt("core/repository-runtime.js"), moduleAt("store/task-store.js"), moduleAt("service/operator-token.js"),
  ]);
  const f = await serviceFixture({ name: "automatic managed overlap", after: onTestFinished });
  await f.service.close();
  const intent = { project: f.root, stateRoot: f.state, profilePath: join(f.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  assert.ok(token);
  const actors = [
    { owner_id: createHash("sha256").update(token).digest("hex"), client_id: randomUUID() },
    { owner_id: ownership === "same owner" ? createHash("sha256").update(token).digest("hex") : "b".repeat(64), client_id: randomUUID() },
  ];
  const store = new TaskStore(binding.storeRoot);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new RepositoryRuntime(intent,
    { package_version: "fixture", build_id: "fixture", mode: "development", node_version: process.version,
      node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, {
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 2,
        max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512,
        implementation: { enabled: true, worktree_root: join(f.temp, "managed-worktrees") } },
        agents: [{ agent_id: "fixture", adapter_id: "fixture", description: "", enabled: true, options: {} }] }),
      definitions: { fixture: { configure: () => ({ modes: ["implement"], contract: "controlled-turn/1", configuration: {},
        worker: { run: async (input: WorkerInput) => {
          await writeFile(join(input.workspace, "source.ts"), `export function run() { return ${input.request.objective.includes("left") ? 1 : 2}; }\n`);
          await held;
          const turn_id = randomUUID();
          await input.onEvent({ kind: "turn_started", turn_id });
          await input.onEvent({ kind: "turn_settled", turn_id, terminal: "completed" });
          return { status: "completed", worker_stop: "confirmed", worker_assessment: "met",
            summary: "fixture edit", blockers: [], questions: [], checks: [] };
        } } }) } },
    });
  f.sessions.push({ close: async () => { finish(); await runtime.shutdown(); } });
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: f.limits }, actors[0], f.root);
  const submit = (index: number) => runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment: {
    schema_version: 3, agent_id: "fixture", request_key: randomUUID(), mode: "implement",
    objective: index === 0 ? "left change" : "right change", context: "Controlled overlapping source edits",
    acceptance_criteria: ["Edit source.ts"], allowed_paths: ["source.ts"], base_commit: f.base,
    target_ref: "refs/heads/main",
  } }, actors[index], f.root, new AbortController().signal);
  const [left, right] = await Promise.all([submit(0), submit(1)]);
  const ids = [left.task_id, right.task_id];
  for (const id of ids) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const resource = await store.readResource(id);
      if (resource?.worktree_path && (await readFile(join(resource.worktree_path, "source.ts"), "utf8").catch(() => "")) !== "export function run() {}\n") break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const works = await Promise.all(ids.map(id => f.get("work", id, actors[0]).catch(() => undefined)));
    if (works.every(Boolean)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const refreshed: unknown[] = [];
  for (const [index, id] of ids.entries()) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { refreshed.push(await runtime.structuralRefresh(id, actors[index])); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
  }
  let established;
  for (let attempt = 0; attempt < 100; attempt++) {
    const inventory = await runtime.coordinate({ schema_version: 1, kind: "recovery_read", selector: { kind: "inventory" },
      offset: 0, limit: 8192, expected_hash: null }, actors[0], f.root);
    assert.equal(inventory.kind, "page");
    const candidates = JSON.parse(inventory.content).cases as Array<{ id: string }>;
    for (const candidate of candidates) {
      const reply = await runtime.coordinate({ schema_version: 1, kind: "read", selector: { kind: "case", id: candidate.id },
        offset: 0, limit: 8192, expected_hash: null }, actors[0], f.root);
      if (reply.kind !== "page") continue;
      const item = JSON.parse(reply.content) as { inputs: Array<{ work_id: string }> };
      if (ids.every(id => item.inputs.some(input => input.work_id === id))) established = item;
    }
    if (established) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(established, `source observations must create and select the overlap case automatically: ${JSON.stringify({ refreshed })}`);
  for (const [index, id] of ids.entries()) {
    const reply = await runtime.coordinate({ schema_version: 1, kind: "read", selector: { kind: "work", id },
      offset: 0, limit: 8192, expected_hash: null }, actors[index], f.root);
    assert.equal(reply.kind, "page");
    assert.deepEqual(JSON.parse(reply.content).source_grants ?? [], [], "automatic case selection cannot create parent-wide source grants");
  }
  finish();
}, 120_000);
