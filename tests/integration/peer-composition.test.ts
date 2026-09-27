import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, test } from "vitest";
// @ts-expect-error The disposable Git fixture is shared with the core suite.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import type { WorkerInput } from "../../src/agents/types.js";
import type { PeerResolutionProposal } from "../../src/coordination/peer-resolution.js";

type PeerPort = NonNullable<NonNullable<WorkerInput["peer"]>["operation"]>;
type PeerRequest = Parameters<PeerPort>[0];
type PeerResult = Awaited<ReturnType<PeerPort>>;
type Job = { request: PeerRequest; resolve: (value: PeerResult) => void; reject: (reason: unknown) => void };

function peer() {
  const jobs: Job[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  return {
    send(request: PeerRequest): Promise<PeerResult> {
      return new Promise((resolve, reject) => { jobs.push({ request, resolve, reject }); wake?.(); });
    },
    stop() { stopped = true; wake?.(); },
    async run(input: WorkerInput) {
      assert.ok(input.peer?.operation);
      const turn_id = randomUUID();
      await input.onEvent({ kind: "turn_started", turn_id });
      await input.onEvent({ kind: "turn_settled", turn_id, terminal: "completed" });
      while (!stopped) {
        if (!jobs.length) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        for (const job of jobs.splice(0)) {
          try { job.resolve(await input.peer.operation(job.request)); }
          catch (error) { job.reject(error); }
        }
      }
      return { status: "completed" as const, worker_stop: "confirmed" as const,
        worker_assessment: "met" as const, summary: "Controlled peer finished",
        blockers: [], questions: [], checks: [] };
    },
  };
}

test("distinct-parent managed overlap delivers changed spans and reaches scoped v2 application", async () => {
  const fromBuild = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken },
    { peerResolutionDigest, PEER_RESOLUTION_ACTIONS }] = await Promise.all([
    fromBuild("core/repository-runtime.js"), fromBuild("store/task-store.js"),
    fromBuild("service/operator-token.js"), fromBuild("coordination/peer-resolution.js"),
  ]);
  const fixture = await serviceFixture({ name: "peer composition", after: onTestFinished });
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  assert.ok(token);
  const actors = [
    { owner_id: createHash("sha256").update(token).digest("hex"), client_id: randomUUID() },
    { owner_id: "b".repeat(64), client_id: randomUUID() },
  ];
  const store = new TaskStore(binding.storeRoot);
  const workers = [peer(), peer()];
  const runtime = new RepositoryRuntime(intent,
    { package_version: "fixture", build_id: "fixture", mode: "development", node_version: process.version,
      node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, {
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 2,
        max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
        max_control_receipts: 512, implementation: { enabled: true,
          worktree_root: join(fixture.temp, "managed-worktrees") } },
        agents: workers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
          description: "", enabled: true, options: {} })) }),
      definitions: Object.fromEntries(workers.map((worker, index) => [`peer${index}`, {
        configure: () => ({ modes: ["implement"], contract: "controlled-peer/1", configuration: {},
          worker: { run: async (input: WorkerInput) => {
            await writeFile(join(input.workspace, "source.ts"),
              `export function run() { return ${index + 1}; }\n`);
            return worker.run(input);
          } },
        }),
      }])),
    });
  fixture.sessions.push({ close: async () => {
    for (const worker of workers) worker.stop();
    await runtime.shutdown();
  } });
  const coordinate = (request: unknown, index = 0) => runtime.coordinate(request, actors[index]!, fixture.root);
  const read = async (kind: string, id: string, index = 0) => {
    const result = await coordinate({ schema_version: 1, kind: "read", selector: { kind, id },
      offset: 0, limit: 8192, expected_hash: null }, index);
    assert.equal(result.kind, "page");
    return JSON.parse(result.content);
  };
  await coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits });
  const submit = (index: number) => runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment: {
    schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: "implement",
    objective: `Change source.ts for peer ${index}`, context: "Controlled overlapping managed edits",
    acceptance_criteria: ["Edit source.ts"], allowed_paths: ["source.ts"],
    base_commit: fixture.base, target_ref: "refs/heads/main",
  } }, actors[index]!, fixture.root, new AbortController().signal);
  const tasks = await Promise.all([submit(0), submit(1)]);
  const ids = tasks.map(task => task.task_id);
  let selected: any;
  for (let attempt = 0; attempt < 100 && !selected; attempt++) {
    const resources = await Promise.all(ids.map(id => store.readResource(id)));
    if (resources.every(resource => resource?.worktree_path)) {
      for (const [index, id] of ids.entries()) await runtime.structuralRefresh(id, actors[index]!).catch(() => undefined);
      const inventory = await coordinate({ schema_version: 1, kind: "recovery_read",
        selector: { kind: "inventory" }, offset: 0, limit: 8192, expected_hash: null });
      assert.equal(inventory.kind, "page");
      for (const candidate of JSON.parse(inventory.content).cases as Array<{ id: string }>) {
        const item = await read("case", candidate.id);
        if (ids.every(id => item.inputs.some((input: { work_id: string }) => input.work_id === id))) selected = item;
      }
    }
    if (!selected) await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(selected, "actual managed edits must establish a selected overlap case");
  const waitForSettledPeers = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const before = await Promise.all(ids.map(id => store.readControl(id)));
      if (before.every(control => control.phase === "active" && control.native.state === "observed_live" &&
        control.native.coverage === "turn_scoped" && control.native.obligations.length === 0)) {
        await new Promise(resolve => setTimeout(resolve, 30));
        const after = await Promise.all(ids.map(id => store.readControl(id)));
        if (after.every((control, index) => control.revision === before[index]!.revision)) return;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const controls = await Promise.all(ids.map(id => store.readControl(id)));
    assert.fail(`controlled native peers did not settle: ${JSON.stringify(controls.map(control => ({
      phase: control.phase, revision: control.revision, native: control.native,
    })))}`);
  };
  await waitForSettledPeers();
  const delivered: any[] = [];
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt++) {
    delivered.length = 0;
    for (const id of ids) {
      const control = await store.readControl(id);
      const envelope = control.peer_deliveries?.find((record: { envelope: { case_id: string; content: string } }) =>
        record.envelope.case_id === selected.id)?.envelope;
      if (envelope) delivered.push(JSON.parse(envelope.content));
    }
    if (delivered.length < 2) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(delivered.length, 2, "each controlled peer must receive a selected case handoff");
  for (const evidence of delivered) {
    assert.equal(evidence.schema_version, 2);
    assert.equal(evidence.kind, "peer_overlap_evidence");
    assert.ok(evidence.selected_evidence?.changes?.length);
    const spans = evidence.selected_evidence.changes.flatMap((change: { spans: Array<{ text: string }> }) => change.spans);
    assert.ok(spans.some((span: { text: string }) => /return [12]/.test(span.text)),
      "handoff must include actual changed source bytes");
  }
  const resources = await Promise.all(ids.map(id => store.readResource(id)));
  for (const [index, resource] of resources.entries()) {
    assert.ok(resource?.worktree_path);
    assert.equal(await readFile(join(resource.worktree_path, "source.ts"), "utf8"),
      `export function run() { return ${index + 1}; }\n`);
  }
  const works = await Promise.all(ids.map((id, index) => read("work", id, index)));
  const inspect = async (index: number, key: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await workers[index]!.send({ schema_version: 1, kind: "inspect",
        operation_key: `${key}-${attempt}`, case_id: selected.id }); }
      catch (error) {
        if ((error as { code?: string }).code !== "PEER_OPERATION_STALE" || attempt === 3) throw error;
        await waitForSettledPeers();
      }
    }
    throw new Error("Bounded peer inspection retries exhausted");
  };
  const stage = async <T>(label: string, action: Promise<T>): Promise<T> => {
    try { return await action; }
    catch (cause) { throw new Error(`Peer composition ${label} failed`, { cause }); }
  };
  const first = await inspect(0, "initial-inspect");
  assert.equal(first.kind, "current");
  assert.equal(first.evidence_status, "current");
  assert.ok(first.evidence_id);
  assert.ok(first.evidence_revision);
  const sources = selected.inputs.map((input: { work_id: string; commit_oid: string }) => {
    const work = works.find(candidate => candidate.id === input.work_id);
    assert.ok(work);
    return { work_id: work.id, work_revision: work.revision, input_oid: work.input_oid,
      selected_commit_oid: input.commit_oid };
  });
  const base = { schema_version: 2 as const, kind: "peer_resolution_proposal" as const,
    case_id: selected.id, case_revision: selected.revision, case_generation: selected.generation,
    evidence_id: first.evidence_id, evidence_revision: first.evidence_revision,
    participants: actors.map(actor => actor.owner_id), sources, scope: [{ kind: "file" as const, path: "source.ts" }],
    permitted_actions: [...PEER_RESOLUTION_ACTIONS] };
  const original = await readFile(join(fixture.root, "source.ts"));
  const change = (before: Buffer | string, value: number) => [{ path: "source.ts",
    before_sha256: createHash("sha256").update(before).digest("hex"),
    after_base64: Buffer.from(`export function run() { return ${value}; }\n`).toString("base64") }];
  const firstSource = await readFile(join(resources[0]!.worktree_path!, "source.ts"));
  const secondSource = await readFile(join(resources[1]!.worktree_path!, "source.ts"));
  const proposal: PeerResolutionProposal = { ...base, proposal_revision: 1, action: "propose",
    summary: "Keep the first peer's value", changes: change(firstSource, 1),
    resolution_digest: peerResolutionDigest("Keep the first peer's value", change(firstSource, 1)), predecessor_digest: null };
  const posted = await stage("initial proposal", workers[0]!.send({ schema_version: 1, kind: "propose",
    operation_key: "initial-proposal", case_id: selected.id, proposal }));
  assert.equal(posted.kind, "receipt");
  const counter: PeerResolutionProposal = { ...base, proposal_revision: 2, action: "counter_propose",
    summary: "Combine both peers' values", changes: change(secondSource, 3),
    resolution_digest: peerResolutionDigest("Combine both peers' values", change(secondSource, 3)),
    predecessor_digest: proposal.resolution_digest };
  const countered = await stage("combined counter", workers[1]!.send({ schema_version: 1, kind: "counter_propose",
    operation_key: "combined-counter", case_id: selected.id, proposal: counter }));
  assert.equal(countered.kind, "receipt");
  const beforeConsent = await inspect(0, "before-consent");
  assert.equal(beforeConsent.kind, "current");
  assert.deepEqual(beforeConsent.acknowledged_task_ids, []);
  const applyRequest = { schema_version: 1 as const, kind: "apply" as const,
    case_id: selected.id, note_id: countered.note_id,
    expected_case_revision: selected.revision, expected_case_generation: selected.generation,
    proposal_digest: counter.resolution_digest };
  await assert.rejects(workers[1]!.send({ ...applyRequest, operation_key: "before-consent-apply" }),
    { code: "PEER_OPERATION_FORBIDDEN" });
  for (const index of [0, 1]) {
    const result: PeerResult = await stage(`acknowledgment ${index}`, workers[index]!.send({ schema_version: 1, kind: "acknowledge",
      operation_key: `ack-${index}`, case_id: selected.id, note_id: countered.note_id }));
    assert.equal(result.kind, "receipt");
  }
  const agreed = await inspect(1, "agreed");
  assert.equal(agreed.kind, "current");
  assert.equal(agreed.proposal_note_id, countered.note_id);
  assert.deepEqual(new Set(agreed.acknowledged_task_ids), new Set(ids));
  assert.deepEqual(agreed.proposal, counter);
  const proposedBytes = Buffer.from(counter.changes![0]!.after_base64!, "base64");
  const candidate = await import(`data:text/javascript;base64,${proposedBytes.toString("base64")}`);
  assert.equal(candidate.run(), 3, "independent oracle checks the combined proposed behavior");
  assert.equal(await readFile(join(fixture.root, "source.ts"), "utf8"), original.toString("utf8"),
    "agreement alone must not change the target checkout");
  const originalSettle = store.settlePeerOperationOutcome.bind(store);
  let interruptOutcome = true;
  store.settlePeerOperationOutcome = async (...args: Parameters<typeof store.settlePeerOperationOutcome>) => {
    const settled = await originalSettle(...args);
    if (interruptOutcome && (args[2] as { kind?: string }).kind === "application") {
      interruptOutcome = false;
      throw new Error("injected failure after task application result settlement");
    }
    return settled;
  };
  await assert.rejects(workers[1]!.send({ ...applyRequest, operation_key: "apply-combined" }),
    /injected failure after task application result settlement/);
  const retained = await store.readPeerOperation(ids[1]!, "apply-combined");
  assert.equal(retained?.disposition, "settled", "task outcome must be durable before the injected failure");
  const applied = await stage("scoped application outcome recovery",
    workers[1]!.send({ ...applyRequest, operation_key: "apply-combined" }));
  assert.equal(applied.kind, "application");
  assert.equal(applied.status, "applied");
  assert.match(applied.application_digest!, /^[a-f0-9]{64}$/);
  assert.deepEqual(applied.paths, ["source.ts"]);
  const actualBytes = await readFile(join(resources[1]!.worktree_path!, "source.ts"));
  assert.deepEqual(actualBytes, proposedBytes);
  const actualModule = await import(`data:text/javascript;base64,${actualBytes.toString("base64")}`);
  assert.equal(actualModule.run(), 3, "independent oracle checks the actual scoped application effect");
  const caseBeforeReplay = await read("case", selected.id);
  const replayed = await stage("same-key application replay after outcome recovery",
    workers[1]!.send({ ...applyRequest, operation_key: "apply-combined" }));
  assert.deepEqual(replayed, applied, "same-key replay must return the retained application result");
  assert.deepEqual(await readFile(join(resources[1]!.worktree_path!, "source.ts")), actualBytes,
    "same-key replay must not reapply a manifest whose preimage has changed");
  assert.deepEqual(await read("case", selected.id), caseBeforeReplay,
    "same-key replay must not publish a second case effect");
  await assert.rejects(workers[1]!.send({ ...applyRequest, operation_key: "different-application" }),
    { code: "COORDINATION_EXTERNAL_EFFECT_UNRESOLVED" });
  assert.deepEqual(await readFile(join(resources[1]!.worktree_path!, "source.ts")), actualBytes,
    "a different operation key must not repeat the file effect");
  assert.equal(await readFile(join(fixture.root, "source.ts"), "utf8"), original.toString("utf8"),
    "scoped application must leave the source checkout untouched");
}, 120_000);
