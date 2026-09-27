import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, test } from "vitest";
// @ts-expect-error The disposable Git fixture is shared with the core suite.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import type { MuseOptions } from "../../src/muse/config.js";
import type { WorkerInput, WorkerPeerOperationRequest } from "../../src/agents/types.js";
import { parseWorkerMessage } from "../../src/agents/report.js";

const source = (value: number) => `export function run() { return ${value}; }\n`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (value: Record<string, unknown>) => `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, ...value })}`;
const final = (summary: string, extra: Record<string, unknown> = {}) => message({ kind: "final", summary,
  assessment: "met", blockers: [], questions: [], checks: [], ...extra });

type NativePeer = { prompts: string[]; operations: string[]; errors: string[]; portErrors: string[];
  release: () => void; edited: Promise<void>; proposalNote: () => string | undefined;
  observedOutcome: () => unknown };

/** The scripted native peer sees only its assigned prompt, delivered turn, and operation replies. */
function controlledMuse(index: number): { adapter: MuseSdkAdapter; peer: NativePeer } {
  const prompts: string[] = [], operations: string[] = [], errors: string[] = [], portErrors: string[] = [];
  let release!: () => void, didEdit!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edited = new Promise<void>(resolve => { didEdit = resolve; });
  let workspace = "", selfTask = "", caseId = "", deliveryKey = "";
  let current: any, lastAwait: Record<string, unknown> | undefined, operationNumber = 0;
  let combinedValue: number | undefined;
  let agreedProposalDigest: string | undefined, agreedProposalNoteId: string | undefined;
  let appliedDigest: string | undefined;
  let observedOutcome: unknown;
  const op = (kind: string, fields: Record<string, unknown> = {}) => {
    operations.push(kind);
    return message({ kind: "peer_operation", operation: { schema_version: 1,
      operation_key: `${kind}-${index}-${++operationNumber}`, case_id: caseId, kind, ...fields } });
  };
  const wait = () => {
    assert.ok(current, "a worker needs a current result before waiting");
    lastAwait = { schema_version: 1, operation_key: `wait-${index}-${++operationNumber}`,
      case_id: caseId, kind: "await_change", after_case_revision: current.case_revision,
      after_case_generation: current.case_generation, after_negotiation_cursor: current.negotiation_cursor };
    operations.push("await_change");
    return message({ kind: "peer_operation", operation: lastAwait });
  };
  const proposal = (action: "propose" | "counter_propose") => {
    assert.ok(current, "proposal context must come from inspect or await_change");
    const prior = current.proposal;
    const context = action === "propose" ? current.first_proposal : prior;
    assert.ok(context, "worker must receive canonical proposal context");
    const value = action === "propose" ? index + 1 : combinedValue;
    assert.ok(value !== undefined, "a counter needs both source-grounded values");
    const summary = action === "propose"
      ? `Keep the ${index === 0 ? "tax" : "delivery"} task's value ${value}`
      : `Combine the two overlapping values: return ${value}`;
    const next = { ...context, proposal_revision: action === "propose" ? 1 : prior.proposal_revision + 1,
      action, predecessor_digest: action === "propose" ? null : prior.resolution_digest,
      scope: [{ kind: "file", path: "source.ts" }], summary,
      changes: [{ path: "source.ts", before_sha256: digest(source(index + 1)),
        after_base64: Buffer.from(source(value)).toString("base64") }] };
    delete (next as { resolution_digest?: string }).resolution_digest;
    return op(action, { proposal: next });
  };
  const choose = (): string => {
    assert.ok(current);
    if (current.application_outcome) {
      const outcome = current.application_outcome;
      assert.equal(outcome.status, "applied", "each worker must observe a durable applied outcome");
      assert.equal(outcome.proposal_digest, agreedProposalDigest);
      assert.equal(outcome.proposal_note_id, agreedProposalNoteId);
      if (index === 1) assert.equal(outcome.application_digest, appliedDigest);
      observedOutcome = outcome;
      return final("Observed the durable combined peer resolution after consent");
    }
    const p = current.proposal;
    if (!p) return index === 0 ? proposal("propose") : wait();
    if (p.action === "propose") return index === 1 ? proposal("counter_propose") : wait();
    agreedProposalDigest = p.resolution_digest;
    agreedProposalNoteId = current.proposal_note_id;
    const acknowledged = current.acknowledged_task_ids as string[];
    if (!acknowledged.includes(selfTask)) {
      if (index === 0 || acknowledged.length > 0) return op("acknowledge", { note_id: current.proposal_note_id });
      return wait();
    }
    if (index === 1 && acknowledged.length === current.participant_task_ids.length) {
      return op("apply", { note_id: current.proposal_note_id, expected_case_revision: current.case_revision,
        expected_case_generation: current.case_generation, proposal_digest: p.resolution_digest });
    }
    return wait();
  };
  const nextMessage = (prompt: string, displayText: string): string => {
    if (!selfTask) {
      const match = /^Passeur task ([a-f0-9-]{36})$/.exec(displayText);
      assert.ok(match, "native task identity must arrive through the normal turn");
      selfTask = match[1]!;
      return final(`Edited source.ts for task ${index}`);
    }
    if (prompt.startsWith("Passeur delivered peer evidence")) {
      const metadata = /^Peer metadata: (.+)$/m.exec(prompt);
      const content = /^Peer content: (.+)$/m.exec(prompt);
      assert.ok(metadata && content, "native peer receives the actual delivery turn");
      const envelope = JSON.parse(metadata[1]!);
      const evidence = JSON.parse(JSON.parse(content[1]!));
      deliveryKey = envelope.idempotency_key;
      caseId = envelope.case_id;
      assert.equal(evidence.kind, "peer_overlap_evidence");
      assert.equal(evidence.schema_version, 2);
      const text = JSON.stringify(evidence.selected_evidence);
      const values = new Set([...text.matchAll(/return (\d+)/g)].map(match => Number(match[1])));
      assert.deepEqual(values, new Set([1, 2]), "delivered changed spans must ground both values");
      combinedValue = [...values].reduce((sum, value) => sum + value, 0);
      return message({ kind: "peer_operation", peer_observed: deliveryKey,
        operation: { schema_version: 1, operation_key: `inspect-${index}-1`, case_id: caseId, kind: "inspect" } });
    }
    const line = /^(?:Peer operation result|Peer application outcome): (.+)$/m.exec(prompt);
    assert.ok(line, "worker continuation must contain a concrete operation response");
    const result = JSON.parse(line[1]!);
    if (result.kind === "pending") {
      assert.ok(lastAwait);
      operations.push("await_change");
      return message({ kind: "peer_operation", operation: lastAwait });
    }
    if (result.kind === "application") {
      assert.equal(result.status, "applied");
      appliedDigest = result.application_digest;
      return op("inspect");
    }
    if (result.kind === "receipt") {
      if (result.operation === "propose" || result.operation === "counter_propose") return wait();
      if (result.operation === "acknowledge") return op("inspect");
    }
    assert.equal(result.kind, "current");
    current = result;
    return choose();
  };
  const options: MuseOptions = { muse_bin: "controlled", model: "controlled",
    review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
    implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
  const adapter = new MuseSdkAdapter(options, ({ cwd }) => {
    workspace = cwd!;
    const session = { sessionId: `controlled-peer-${index}`, opening: { result: { session: { modelId: "controlled" } } },
      fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
      onApproval() {}, onApprovalError() {},
      sendUserTurn: async ({ input, displayText }: { input: Array<{ text: string }>; displayText: string }) => {
        const prompt = input[0]!.text;
        prompts.push(prompt);
        if (!selfTask) {
          await writeFile(join(workspace, "source.ts"), source(index + 1));
          didEdit();
        }
        let reply: string;
        try { reply = nextMessage(prompt, displayText); }
        catch (error) { errors.push(String(error)); throw error; }
        return { turnId: randomUUID(), completed: (async () => {
          if (prompts.length === 1) await gate;
          return { kind: "completed", params: { terminal: "completed" } };
        })(), items: async function* () { yield { kind: "agentMessage", text: reply }; } };
      } };
    return { ready: Promise.resolve({ startSession: async () => session, close: async () => {} } as never),
      close: async () => {} };
  });
  return { adapter, peer: { prompts, operations, errors, portErrors, release, edited,
    proposalNote: () => agreedProposalNoteId, observedOutcome: () => observedOutcome } };
}

async function composeControlledPeers(sameParent: boolean, probeIdentity = false): Promise<void> {
  const fromBuild = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken }] = await Promise.all([
    fromBuild("core/repository-runtime.js"), fromBuild("store/task-store.js"), fromBuild("service/operator-token.js"),
  ]);
  const fixture = await serviceFixture({ name: sameParent ? "sibling worker-only peer composition" : "worker-only peer composition",
    after: onTestFinished });
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  assert.ok(token);
  const actors = [
    { owner_id: digest(token), client_id: randomUUID() },
    { owner_id: sameParent ? digest(token) : "b".repeat(64), client_id: randomUUID() },
  ];
  const store = new TaskStore(binding.storeRoot);
  const peers = [controlledMuse(0), controlledMuse(1)];
  let taskIds: string[] = [];
  let impersonationProbe: { bound_task_id: string; claimed_task_id: string; invalid_rejected: boolean } | undefined;
  const runtime = new RepositoryRuntime(intent,
    { package_version: "fixture", build_id: "fixture", mode: "development", node_version: process.version,
      node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, {
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 2,
        max_queued_tasks: 2, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
        max_control_receipts: 512, implementation: { enabled: true,
          worktree_root: join(fixture.temp, "managed-worktrees") } },
        agents: peers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
          description: "", enabled: true, options: {} })) }),
      definitions: Object.fromEntries(peers.map(({ adapter, peer }, index) => [`peer${index}`, {
        configure: () => ({ modes: ["implement"], contract: "muse-sdk/controlled", configuration: {}, worker: {
          run: async (input: WorkerInput) => {
            assert.ok(input.peer);
            let first = true;
            return adapter.run({ ...input, peer: { ...input.peer,
              operation: async request => {
                try {
                  if (probeIdentity && index === 0 && request.kind === "inspect" && !impersonationProbe) {
                    // Independent harness probe: these task facts never enter the scripted peer's decisions.
                    const sibling = await store.readControl(taskIds[1]!);
                    const siblingAdmission = await store.durableRequest(taskIds[1]!);
                    const claimed = { ...request, operation_key: "claimed-sibling-inspect",
                      task_id: taskIds[1]!, run_id: sibling.native.run_id,
                      control_generation: sibling.control_generation, source_view: siblingAdmission.source_view };
                    const bound = await input.peer!.operation!(claimed as WorkerPeerOperationRequest);
                    assert.equal(bound.task_id, input.task_id,
                      "task-bound port must use the authenticated caller, not a claimed sibling identity");
                    if (bound.kind !== "current") assert.fail("identity probe must return a current inspection");
                    assert.deepEqual(bound.acknowledged_task_ids, [],
                      "the identity probe must not record consent for either sibling");
                    await assert.rejects(input.peer!.operation!({ ...claimed,
                      operation_key: "invalid-sibling-identity", owner_id: actors[1]!.owner_id,
                    } as WorkerPeerOperationRequest), { code: "PEER_OPERATION_INVALID" });
                    impersonationProbe = { bound_task_id: bound.task_id,
                      claimed_task_id: taskIds[1]!, invalid_rejected: true };
                  }
                  return await input.peer!.operation!(request);
                }
                catch (error) { peer.portErrors.push(`${request.kind}: ${error instanceof Error ? error.stack : String(error)}`); throw error; }
              },
              next: async () => {
              // Controlled delivery is held until the ordinary watcher produces a case.
              // This does not test a worker that has already finalized before late delivery.
              if (!first) return input.peer!.next();
              first = false;
              for (let attempt = 0; attempt < 2000; attempt++) {
                const delivered = await input.peer!.next();
                if (delivered) return delivered;
                await new Promise(resolve => setTimeout(resolve, 30));
              }
              throw new Error("The selected managed overlap produced no peer delivery");
            } } });
          },
        } }),
      }])),
    });
  fixture.sessions.push({ close: async () => {
    for (const peer of peers) peer.peer.release();
    await runtime.shutdown();
  } });
  const coordinate = (request: unknown, index = 0) => runtime.coordinate(request, actors[index]!, fixture.root);
  await coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits });
  const submit = (index: number) => runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment: {
    schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: "implement",
    objective: `Change source.ts for peer ${index}`, context: "Controlled overlapping managed edits",
    acceptance_criteria: ["Edit source.ts"], allowed_paths: ["source.ts"],
    base_commit: fixture.base, target_ref: "refs/heads/main",
  } }, actors[index]!, fixture.root, new AbortController().signal);
  const tasks = await Promise.all([submit(0), submit(1)]);
  const ids = tasks.map(task => task.task_id);
  taskIds = ids;
  await Promise.all(peers.map(peer => peer.peer.edited));
  let caseId: string | undefined;
  for (let attempt = 0; attempt < 500 && !caseId; attempt++) {
    const inventory = await coordinate({ schema_version: 1, kind: "recovery_read",
      selector: { kind: "inventory" }, offset: 0, limit: 8192, expected_hash: null });
    assert.equal(inventory.kind, "page");
    for (const candidate of JSON.parse(inventory.content).cases as Array<{ id: string }>) {
      const page = await coordinate({ schema_version: 1, kind: "read", selector: { kind: "case", id: candidate.id },
        offset: 0, limit: 8192, expected_hash: null });
      assert.equal(page.kind, "page");
      if (ids.every(id => JSON.parse(page.content).inputs.some((input: { work_id: string }) => input.work_id === id))) caseId = candidate.id;
    }
    if (!caseId) await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!caseId) {
    const inventory = await coordinate({ schema_version: 1, kind: "recovery_read",
      selector: { kind: "inventory" }, offset: 0, limit: 8192, expected_hash: null });
    const works = inventory.kind === "page" ? JSON.parse(inventory.content).works as Array<{ id: string; owner: string }> : [];
    const observationStates = await Promise.all(ids.map(async (id, index) => {
      const work = works.find(candidate => candidate.id === id);
      if (!work) return { state: "work_absent" };
      try { return await runtime.structuralObservationStatus(work.id, actors[index]!); }
      catch (error) { return { state: "status_error", error: String(error) }; }
    }));
    const resourcesAtFailure = await Promise.all(ids.map(id => store.readResource(id)));
    const controlsAtFailure = await Promise.all(ids.map(id => store.readControl(id)));
    assert.fail(`passive source observation must establish the selected case from real edits: ${JSON.stringify({
      works, observationStates, resources: resourcesAtFailure.map(resource => ({ state: resource?.state,
        worktree_path: resource?.worktree_path })), controls: controlsAtFailure.map(control => ({
        phase: control.phase, native: control.native.state, outcome: control.outcome })),
    })}`);
  }
  for (const peer of peers) peer.peer.release();
  for (let attempt = 0; attempt < 500; attempt++) {
    const controls = await Promise.all(ids.map(id => store.readControl(id)));
    if (controls.every(control => control.phase === "terminal")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const controls = await Promise.all(ids.map(id => store.readControl(id)));
  const results = await Promise.all(ids.map(id => store.readResult(id)));
  const resources = await Promise.all(ids.map(id => store.readResource(id)));
  assert.ok(resources[1]?.worktree_path);
  const actual = await readFile(join(resources[1].worktree_path, "source.ts"), "utf8");
  assert.ok(controls.every(control => control.phase === "terminal"), JSON.stringify({
    controls: controls.map(control => ({ phase: control.phase, outcome: control.outcome, native: control.native.state })),
    operations: peers.map(peer => peer.peer.operations), nativeErrors: peers.map(peer => peer.peer.errors),
    portErrors: peers.map(peer => peer.peer.portErrors),
    lastPrompts: peers.map(peer => peer.peer.prompts.at(-1)?.slice(0, 600)),
  }));
  assert.ok(results.every(result => result?.execution_status === "completed"), JSON.stringify({
    operations: peers.map(peer => peer.peer.operations), portErrors: peers.map(peer => peer.peer.portErrors),
    errors: results.map(result => result?.error), statuses: results.map(result => result?.execution_status),
    nativeErrors: peers.map(peer => peer.peer.errors),
    actual,
    lastPrompts: peers.map(peer => peer.peer.prompts.at(-1)?.slice(0, 800)),
  }));
  assert.ok(controls.every(control => control.peer_deliveries?.some((record: { state: string; envelope: { case_id: string } }) =>
    record.state === "observed" && record.envelope.case_id === caseId)), "both peers must consume delivered turns");
  assert.ok(peers[0]!.peer.operations.includes("propose"));
  assert.ok(peers[1]!.peer.operations.includes("counter_propose"));
  assert.ok(peers.every(peer => peer.peer.operations.includes("acknowledge")),
    JSON.stringify({ operations: peers.map(peer => peer.peer.operations), nativeErrors: peers.map(peer => peer.peer.errors),
      portErrors: peers.map(peer => peer.peer.portErrors),
      lastPrompts: peers.map(peer => peer.peer.prompts.at(-1)?.slice(0, 600)), outcomes: controls.map(control => control.outcome),
      errors: results.map(result => result?.error) }));
  assert.ok(peers[1]!.peer.operations.includes("apply"), JSON.stringify({
    operations: peers.map(peer => peer.peer.operations), nativeErrors: peers.map(peer => peer.peer.errors),
    portErrors: peers.map(peer => peer.peer.portErrors),
    errors: results.map(result => result?.error), outcomes: controls.map(control => control.outcome),
    lastPrompts: peers.map(peer => peer.peer.prompts.at(-1)?.slice(0, 800)),
  }));
  const outcomes = peers.map(peer => peer.peer.observedOutcome());
  assert.ok(outcomes.every(Boolean), "both workers must inspect the durable application outcome");
  assert.deepEqual(outcomes[0], outcomes[1], "both peers must observe the same retained application outcome");
  if (probeIdentity) assert.deepEqual(impersonationProbe,
    { bound_task_id: ids[0], claimed_task_id: ids[1], invalid_rejected: true },
    "a sibling identity claim must neither replace task-bound authority nor enter the worker operation contract");
  assert.equal(actual, source(3), JSON.stringify({
    operations: peers.map(peer => peer.peer.operations), portErrors: peers.map(peer => peer.peer.portErrors),
    errors: results.map(result => result?.error), statuses: results.map(result => result?.execution_status),
    lastPrompts: peers.map(peer => peer.peer.prompts.at(-1)?.slice(0, 800)),
  }));
  const combined = await import(`data:text/javascript;base64,${Buffer.from(actual).toString("base64")}`);
  assert.equal(combined.run(), 3, "independent executable oracle checks the applied result");
  assert.equal(await readFile(join(fixture.root, "source.ts"), "utf8"), "export function run() {}\n");
  if (probeIdentity) assert.throws(() => parseWorkerMessage(message({ kind: "peer_operation", operation: {
      schema_version: 1, operation_key: "impersonate-sibling", case_id: caseId,
      kind: "inspect", task_id: ids[1],
    } })), { code: "WORKER_MESSAGE_INVALID" },
    "worker text cannot smuggle a sibling task identity into the task-bound operation port");
  const proposalNote = peers[1]!.peer.proposalNote();
  assert.ok(proposalNote);
  await assert.rejects(coordinate({ schema_version: 1, kind: "command", command: {
    kind: "ack_note", operation_key: randomUUID(), note_id: proposalNote,
  } }), { code: "COORDINATION_FORBIDDEN" },
  "parent acknowledgment cannot substitute for a task principal's consent");
}

test("distinct-parent controlled Muse peers compose managed edits through worker operations", () =>
  composeControlledPeers(false), 120_000);
test("same-parent sibling Muse peers independently consent and apply their overlap", () =>
  composeControlledPeers(true), 120_000);
test("task-bound peer port refuses a sibling identity claim", () =>
  composeControlledPeers(false, true), 120_000);
