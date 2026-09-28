import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, test } from "vitest";
// @ts-expect-error The disposable Git fixture is shared with the core suite.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import { decodePeerResolutionText } from "../../src/coordination/peer-resolution.js";
import type { MuseOptions } from "../../src/muse/config.js";
import type { WorkerInput } from "../../src/agents/types.js";
import { BridgeError } from "../../src/core/errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const response = (fields: Record<string, unknown>) =>
  `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "final", summary: "Observed exact peer context",
    assessment: "met", blockers: [], questions: [], checks: [], ...fields })}`;

type ScriptedMuse = { adapter: MuseSdkAdapter; release: () => void; edited: Promise<void>;
  seen: Array<{ key: string; turnId: string; caseId: string; revision: number; sourceWorkId: string }>;
  sessionId: string; errors: string[] };
type CaseState = { id: string; revision: number; observed_origin?: string;
  inputs: Array<{ work_id: string }>; delivery_pending: string[]; delivery_observed: unknown[] };

function scriptedMuse(index: number): ScriptedMuse {
  let release!: () => void, didEdit!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edited = new Promise<void>(resolve => { didEdit = resolve; });
  const seen: ScriptedMuse["seen"] = [], errors: string[] = [];
  const sessionId = `three-peer-session-${index}`;
  let first = true;
  const options: MuseOptions = { muse_bin: "controlled", model: "controlled",
    review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
    implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
  const adapter = new MuseSdkAdapter(options, ({ cwd }) => {
    const session = { sessionId, opening: { result: { session: { modelId: "controlled" } } },
      fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
      onApproval() {}, onApprovalError() {},
      sendUserTurn: async ({ input }: { input: Array<{ text: string }> }) => {
        const prompt = input[0]!.text;
        const turnId = randomUUID();
        let text: string;
        try {
          if (first) {
            first = false;
            await writeFile(join(cwd!, "source.ts"), `export function run() { return ${index + 1}; }\n`);
            didEdit();
            text = response({ summary: `Edited source.ts for worker ${index}` });
          } else {
            const metadata = /^Peer metadata: (.+)$/m.exec(prompt);
            const content = /^Peer content: (.+)$/m.exec(prompt);
            assert.ok(metadata && content, "adapter must deliver a real peer turn to the SDK session");
            const envelope = JSON.parse(metadata[1]!);
            const evidence = JSON.parse(JSON.parse(content[1]!));
            assert.equal(evidence.kind, "peer_overlap_evidence");
            assert.ok(evidence.selected_evidence?.subject_id);
            seen.push({ key: envelope.idempotency_key, turnId, caseId: envelope.case_id,
              revision: envelope.case_revision, sourceWorkId: envelope.source_work_id });
            text = response({ peer_observed: envelope.idempotency_key });
          }
        } catch (error) { errors.push(String(error)); throw error; }
        const held = seen.length === 0 && !first;
        return { turnId, completed: (async () => {
          if (held) await gate;
          return { kind: "completed", params: { terminal: "completed" } };
        })(), items: async function* () { yield { kind: "agentMessage", text }; } };
      } };
    return { ready: Promise.resolve({ startSession: async () => session, close: async () => {} } as never),
      close: async () => {} };
  });
  return { adapter, release, edited, seen, sessionId, errors };
}

test("three controlled Muse SDK sessions consume a late observed case through real adapter peer ports", async () => {
  const fromBuild = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken }] = await Promise.all([
    fromBuild("core/repository-runtime.js"), fromBuild("store/task-store.js"), fromBuild("service/operator-token.js"),
  ]);
  const fixture = await serviceFixture({ name: "three controlled Muse SDK peer sessions", after: onTestFinished });
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [digest(token), "b".repeat(64), "c".repeat(64)]
    .map(owner_id => ({ owner_id, client_id: randomUUID() }));
  const store = new TaskStore(binding.storeRoot);
  const peers = [0, 1, 2].map(scriptedMuse);
  const admittedDirected = new Set<string>();
  let queueInterruptions = 0;
  let finalSettlementConflicts = 0;
  let revisedPublished = false;
  const settlements: Array<{ outcome: string; observed_delivery_ids: readonly string[]; at: number }> = [];
  let wakeSelectedCase: (() => Promise<void>) | undefined;
  const runtime = new RepositoryRuntime(intent,
    { package_version: "fixture", build_id: "fixture", mode: "development", node_version: process.version,
      node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, {
      enableObservedCaseExtensionForTest: true,
      onObservedCaseSettlement: (attempt: { outcome: string; observed_delivery_ids: readonly string[] }) => {
        settlements.push({ ...attempt, at: Date.now() });
      },
      beforeObservedCaseDeliverySettlementForTest: (attempt: { pending_count: number }) => {
        if (revisedPublished && attempt.pending_count === 1 && finalSettlementConflicts++ < 2)
          throw new BridgeError("PEER_DELIVERY_STALE", "Controlled optimistic metadata conflict");
      },
      onObservedCaseExtensionPublishedForTest: (_caseId: string, wake: () => Promise<void>) => {
        wakeSelectedCase = wake;
        revisedPublished = true;
      },
      beforeObservedCaseDeliveryQueueForTest: (edge: { recipient_task_id: string; source_work_id: string }) => {
        const key = `${edge.recipient_task_id}:${edge.source_work_id}`;
        if (!admittedDirected.has(key) && admittedDirected.size === 2 && queueInterruptions < 4) {
          queueInterruptions++;
          throw Error("controlled postpublication queue interruption");
        }
        admittedDirected.add(key);
      },
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 3,
        max_queued_tasks: 3, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
        max_control_receipts: 512, implementation: { enabled: true,
          worktree_root: join(fixture.temp, "managed-worktrees") } },
        agents: peers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
          description: "", enabled: true, options: {} })) }),
      definitions: Object.fromEntries(peers.map(({ adapter }, index) => [`peer${index}`, {
        configure: () => ({ modes: ["implement"], contract: "muse-sdk/controlled", configuration: {},
          worker: { run: (input: WorkerInput) => adapter.run(input) } }),
      }])),
    });
  fixture.sessions.push({ close: async () => {
    for (const peer of peers) peer.release();
    await runtime.shutdown();
  } });
  const state = async (): Promise<{ cases: CaseState[]; works: Array<{ id: string; owner: string }> }> =>
    JSON.parse(await readFile(join(binding.storeRoot, "coordination/control.json"), "utf8"));
  const waitFor = async <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, attempts = 500): Promise<T> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await read();
      if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`${label} did not become true`);
  };
  const submit = (index: number) => runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment: {
    schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: "implement",
    objective: `Change source.ts for peer ${index}`, context: "Controlled three-worker overlap",
    acceptance_criteria: ["Edit source.ts"], allowed_paths: ["source.ts"],
    base_commit: fixture.base, target_ref: "refs/heads/main",
  } }, actors[index]!, fixture.root, new AbortController().signal);
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits }, actors[0], fixture.root);
  const first = await Promise.all([submit(0), submit(1)]);
  const ids = first.map(item => item.task_id);
  await Promise.all(peers.slice(0, 2).map(peer => peer.edited));
  const pair = await waitFor("initial selected pair", async () => (await state()).cases.find(item =>
    item.observed_origin === "selected" && item.inputs.length === 2), Boolean);
  assert.ok(pair);
  const third = await submit(2);
  ids.push(third.task_id);
  await peers[2]!.edited;
  const joined = await waitFor("late three-work extension", async () => (await state()).cases.find(item =>
    item.id === pair.id && item.inputs.length === 3), Boolean);
  assert.ok(joined);
  assert.equal(joined.revision, pair.revision + 1);
  const queued = await waitFor("six directed revision-specific queues", async () =>
    Promise.all(ids.map(id => store.readPeerDeliveries(id))), records => records.every(items =>
      items.filter((record: any) => record.envelope.case_id === joined.id &&
        record.envelope.case_revision === joined.revision && record.state === "queued").length === 2));
  assert.equal(queued.flat().filter((record: any) => record.envelope.case_id === joined.id &&
    record.envelope.case_revision === joined.revision).length, 6);
  assert.equal(queueInterruptions, 4, "same-live retry must finish a two-of-six interrupted publication");
  assert.ok(wakeSelectedCase);
  await Promise.all([wakeSelectedCase(), wakeSelectedCase(), wakeSelectedCase()]);
  assert.equal((await Promise.all(ids.map(id => store.readPeerDeliveries(id)))).flat().filter((record: any) =>
    record.envelope.case_id === joined.id && record.envelope.case_revision === joined.revision).length, 6,
  "concurrent wakes retain one exact envelope per directed obligation");
  const queuedCase = (await state()).cases.find(item => item.id === joined.id);
  assert.ok(queuedCase);
  assert.equal(queuedCase.delivery_pending.length, 3);
  for (const peer of peers) peer.release();
  const settled = await waitFor("all current exact adapter receipts", async () => ({
    control: await state(), records: await Promise.all(ids.map(id => store.readPeerDeliveries(id))),
  }), snapshot => {
    const current = snapshot.control.cases.find((item: any) => item.id === joined.id);
    return current?.delivery_pending.length === 0 && snapshot.records.every((items: any[]) =>
      items.filter(record => record.envelope.case_id === joined.id &&
        record.envelope.case_revision === joined.revision && record.state === "observed").length === 2);
  }, 1500).catch(async error => {
    const [metadata, controls, results] = await Promise.all([state(), Promise.all(ids.map(id => store.readControl(id))),
      Promise.all(ids.map(id => store.readResult(id)))]);
    const selected = metadata.cases.find(item => item.id === joined.id);
    const pendingWork = metadata.works.find(work => work.id === selected?.delivery_pending[0]);
    const pendingActor = actors.find(actor => actor.owner_id === pendingWork?.owner);
    const observation = pendingWork && pendingActor
      ? await runtime.structuralObservationStatus(pendingWork.id, pendingActor) : undefined;
    error.message += `; delivery frontier=${JSON.stringify({
      case: selected && { revision: selected.revision, pending: selected.delivery_pending,
        observed: selected.delivery_observed.length }, runtime: runtime.status().coordination,
      tasks: controls.map((control, index) => ({ id: ids[index], phase: control.phase,
        outcome: control.outcome, result: results[index] && { execution_status: results[index]!.execution_status,
          worker_stop: results[index]!.worker_stop,
          native_state: results[index]!.schema_version === 4 ? results[index]!.native_evidence.state : undefined },
        native: { state: control.native.state, coverage: control.native.coverage, run_id: control.native.run_id },
        deliveries: control.peer_deliveries.map((record: any) => ({ state: record.state,
          revision: record.envelope.case_revision, source_work_id: record.envelope.source_work_id })) })),
      seen: peers.map(peer => peer.seen.map(item => ({ revision: item.revision, sourceWorkId: item.sourceWorkId }))),
      errors: peers.map(peer => peer.errors), settlementConflicts: finalSettlementConflicts,
      limitations: observation?.limitations,
      settlements: settlements.map(item => ({ outcome: item.outcome, count: item.observed_delivery_ids.length,
        at: item.at })),
    })}`;
    throw error;
  });
  const selected = settled.control.cases.find(item => item.id === joined.id);
  assert.ok(selected);
  assert.deepEqual(selected.delivery_pending, []);
  assert.equal(selected.delivery_observed.length, 3);
  assert.equal(finalSettlementConflicts, 3, "two quiet final metadata conflicts must be retried");
  assert.equal(settlements.filter(attempt => attempt.outcome === "failed" &&
    attempt.observed_delivery_ids.length === 2).length, 2);
  assert.equal(settlements.filter(attempt => attempt.outcome === "completed" &&
    attempt.observed_delivery_ids.length === 2).length, 3);
  const controls = await Promise.all(ids.map(id => store.readControl(id)));
  for (const [index, control] of controls.entries()) {
    const current = settled.records[index]!.filter((record: any) => record.envelope.case_id === joined.id &&
      record.envelope.case_revision === joined.revision && record.state === "observed");
    assert.equal(new Set(current.map((record: any) => record.envelope.source_work_id)).size, 2);
    assert.equal(peers[index]!.seen.filter(item => item.caseId === joined.id && item.revision === joined.revision).length, 2);
    for (const record of current) {
      const native = peers[index]!.seen.find(item => item.key === record.envelope.idempotency_key);
      assert.ok(native);
      assert.equal(record.envelope.recipient_run_id, control.native.run_id);
      assert.equal(record.native_session_id, peers[index]!.sessionId);
      assert.equal(record.native_turn_id, native.turnId);
    }
    const slots = control.peer_delivery_reservations.filter((slot: any) => slot.case_id === joined.id &&
      slot.case_revision === joined.revision);
    assert.equal(slots.length, 2);
    assert.ok(slots.every((slot: any) => slot.state === "consumed" && current.some((record: any) =>
      record.envelope.delivery_id === slot.delivery_id)));
    assert.deepEqual(peers[index]!.errors, []);
  }
  assert.ok(settled.records.slice(0, 2).every((items: any[]) => items.some(record =>
    record.envelope.case_id === joined.id && record.envelope.case_revision === pair.revision)),
  "original pair delivery history remains retained after the extension");
}, 180_000);

type NegotiatingMuse = ScriptedMuse & { operations: string[]; outcome: () => unknown;
  proposalNote: () => string | undefined; appliedDigest: () => string | undefined };

function negotiatingMuse(index: number): NegotiatingMuse {
  let release!: () => void, didEdit!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edited = new Promise<void>(resolve => { didEdit = resolve; });
  const seen: ScriptedMuse["seen"] = [], errors: string[] = [], operations: string[] = [];
  const values = new Set<number>();
  const sessionId = `three-negotiating-session-${index}`;
  let first = true, selfTask = "", caseId = "", operationNumber = 0;
  let current: any, lastAwait: Record<string, unknown> | undefined;
  let outcome: unknown, proposalNote: string | undefined, appliedDigest: string | undefined;
  const operation = (kind: string, fields: Record<string, unknown> = {}, peerObserved?: string) => {
    operations.push(kind);
    return `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "peer_operation",
      ...(peerObserved ? { peer_observed: peerObserved } : {}), operation: {
        schema_version: 1, operation_key: `${kind}-${index}-${++operationNumber}`, case_id: caseId,
        kind, ...fields } })}`;
  };
  const awaitChange = () => {
    assert.ok(current);
    lastAwait = { schema_version: 1, operation_key: `await-${index}-${++operationNumber}`,
      case_id: caseId, kind: "await_change", after_case_revision: current.case_revision,
      after_case_generation: current.case_generation, after_negotiation_cursor: current.negotiation_cursor };
    operations.push("await_change");
    return `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "peer_operation", operation: lastAwait })}`;
  };
  const proposal = (action: "propose" | "counter_propose", target: number) => {
    assert.deepEqual([...values].sort(), [1, 2, 3], "all three changes must be visible in exact delivered evidence");
    const context = action === "propose" ? current.first_proposal : current.proposal;
    assert.ok(context, "proposal context must come from a current worker inspection");
    const candidate = { ...context, proposal_revision: action === "propose" ? 1 : context.proposal_revision + 1,
      action, predecessor_digest: action === "propose" ? null : context.resolution_digest,
      scope: [{ kind: "file", path: "source.ts" }],
      summary: `Worker ${index} grounds ${action} in three changes and returns ${target}`,
      changes: [{ path: "source.ts", before_sha256: digest(`export function run() { return ${index + 1}; }\n`),
        after_base64: Buffer.from(`export function run() { return ${target}; }\n`).toString("base64") }] };
    delete (candidate as { resolution_digest?: string }).resolution_digest;
    return operation(action, { proposal: candidate });
  };
  const choose = (): string => {
    assert.ok(current);
    assert.equal(current.participant_task_ids.length, 3);
    if (current.application_outcome) {
      assert.equal(current.application_outcome.status, "applied");
      assert.equal(current.application_outcome.proposal_note_id, proposalNote);
      if (index === 2) assert.equal(current.application_outcome.application_digest, appliedDigest);
      outcome = current.application_outcome;
      return response({ summary: `Worker ${index} observed the durable three-party result` });
    }
    const prior = current.proposal;
    if (!prior) return index === 0 ? proposal("propose", 1) : awaitChange();
    if (prior.proposal_revision === 1) return index === 1 ? proposal("counter_propose", 3) : awaitChange();
    if (prior.proposal_revision === 2) return index === 2 ? proposal("counter_propose", 6) : awaitChange();
    assert.equal(prior.proposal_revision, 3);
    proposalNote = current.proposal_note_id;
    const acknowledged = current.acknowledged_task_ids as string[];
    if (!acknowledged.includes(selfTask)) return operation("acknowledge", { note_id: proposalNote });
    if (index === 2 && acknowledged.length === 3) {
      operations.push("apply_after_three");
      return operation("apply", { note_id: proposalNote, expected_case_revision: current.case_revision,
        expected_case_generation: current.case_generation, proposal_digest: prior.resolution_digest });
    }
    return awaitChange();
  };
  const nextMessage = (prompt: string, displayText: string, turnId: string): string => {
    if (!selfTask) {
      const match = /^Passeur task ([a-f0-9-]{36})$/.exec(displayText);
      assert.ok(match);
      selfTask = match[1]!;
      return response({ summary: `Edited source.ts for worker ${index}` });
    }
    if (prompt.startsWith("Passeur delivered peer evidence")) {
      const metadata = /^Peer metadata: (.+)$/m.exec(prompt);
      const content = /^Peer content: (.+)$/m.exec(prompt);
      assert.ok(metadata && content);
      const envelope = JSON.parse(metadata[1]!);
      const evidence = JSON.parse(JSON.parse(content[1]!));
      assert.equal(evidence.kind, "peer_overlap_evidence");
      assert.ok(evidence.selected_evidence?.subject_id);
      caseId = envelope.case_id;
      seen.push({ key: envelope.idempotency_key, turnId, caseId,
        revision: envelope.case_revision, sourceWorkId: envelope.source_work_id });
      for (const match of JSON.stringify(evidence.selected_evidence).matchAll(/return (\d+)/g))
        values.add(Number(match[1]));
      const currentCount = seen.filter(item => item.caseId === caseId && item.revision === envelope.case_revision).length;
      return currentCount === 2 ? operation("inspect", {}, envelope.idempotency_key)
        : response({ peer_observed: envelope.idempotency_key });
    }
    const line = /^(?:Peer operation result|Peer application outcome): (.+)$/m.exec(prompt);
    assert.ok(line, "SDK continuation must contain the exact operation response");
    const result = JSON.parse(line[1]!);
    if (result.kind === "pending") {
      assert.ok(lastAwait);
      operations.push("await_change");
      return `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "peer_operation", operation: lastAwait })}`;
    }
    if (result.kind === "application") {
      assert.equal(result.status, "applied");
      appliedDigest = result.application_digest;
      return operation("inspect");
    }
    if (result.kind === "receipt") {
      if (result.operation === "propose" || result.operation === "counter_propose") return awaitChange();
      if (result.operation === "acknowledge") return operation("inspect");
    }
    assert.equal(result.kind, "current");
    current = result;
    return choose();
  };
  const options: MuseOptions = { muse_bin: "controlled", model: "controlled",
    review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
    implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
  const adapter = new MuseSdkAdapter(options, ({ cwd }) => {
    const session = { sessionId, opening: { result: { session: { modelId: "controlled" } } },
      fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
      onApproval() {}, onApprovalError() {},
      sendUserTurn: async ({ input, displayText }: { input: Array<{ text: string }>; displayText: string }) => {
        const prompt = input[0]!.text, turnId = randomUUID();
        const initial = first;
        if (initial) {
          first = false;
          await writeFile(join(cwd!, "source.ts"), `export function run() { return ${index + 1}; }\n`);
          didEdit();
        }
        let text: string;
        try { text = nextMessage(prompt, displayText, turnId); }
        catch (error) { errors.push(String(error)); throw error; }
        return { turnId, completed: (async () => {
          if (initial) await gate;
          return { kind: "completed", params: { terminal: "completed" } };
        })(), items: async function* () { yield { kind: "agentMessage", text }; } };
      } };
    return { ready: Promise.resolve({ startSession: async () => session, close: async () => {} } as never),
      close: async () => {} };
  });
  return { adapter, release, edited, seen, sessionId, errors, operations,
    outcome: () => outcome, proposalNote: () => proposalNote, appliedDigest: () => appliedDigest };
}

test("three controlled Muse workers counter, consent, apply and verify one combined outcome", async () => {
  const fromBuild = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { TaskStore }, { operatorToken }] = await Promise.all([
    fromBuild("core/repository-runtime.js"), fromBuild("store/task-store.js"), fromBuild("service/operator-token.js"),
  ]);
  const fixture = await serviceFixture({ name: "three-party controlled Muse negotiation", after: onTestFinished });
  await fixture.service.close();
  const intent = { project: fixture.root, stateRoot: fixture.state,
    profilePath: join(fixture.temp, "missing-profile.json") };
  const binding = await resolveRepositoryBinding(intent, {}, new AbortController().signal);
  const token = await operatorToken(binding, true);
  const actors = [digest(token), "b".repeat(64), "c".repeat(64)]
    .map(owner_id => ({ owner_id, client_id: randomUUID() }));
  const store = new TaskStore(binding.storeRoot);
  const peers = [0, 1, 2].map(negotiatingMuse);
  const runtime = new RepositoryRuntime(intent,
    { package_version: "fixture", build_id: "fixture", mode: "development", node_version: process.version,
      node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() }, {
      enableObservedCaseExtensionForTest: true,
      store: () => store,
      profile: async () => ({ schema_version: 3, execution: { stop_grace_ms: 1000, max_workers: 3,
        max_queued_tasks: 3, max_clients: 32, max_waiters: 128, max_pending_inputs: 16,
        max_control_receipts: 512, implementation: { enabled: true,
          worktree_root: join(fixture.temp, "managed-worktrees") } },
        agents: peers.map((_, index) => ({ agent_id: `peer${index}`, adapter_id: `peer${index}`,
          description: "", enabled: true, options: {} })) }),
      definitions: Object.fromEntries(peers.map(({ adapter }, index) => [`peer${index}`, {
        configure: () => ({ modes: ["implement"], contract: "muse-sdk/controlled", configuration: {},
          worker: { run: (input: WorkerInput) => adapter.run(input) } }),
      }])),
    });
  fixture.sessions.push({ close: async () => {
    for (const peer of peers) peer.release();
    await runtime.shutdown();
  } });
  const state = async (): Promise<{ cases: CaseState[] }> =>
    JSON.parse(await readFile(join(binding.storeRoot, "coordination/control.json"), "utf8"));
  const waitFor = async <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, attempts = 1000): Promise<T> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await read();
      if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`${label} did not become true: ${JSON.stringify({ operations: peers.map(peer => peer.operations),
      errors: peers.map(peer => peer.errors) })}`);
  };
  const submit = (index: number) => runtime.submitCoordinated({ schema_version: 2, kind: "inline", assignment: {
    schema_version: 3, agent_id: `peer${index}`, request_key: randomUUID(), mode: "implement",
    objective: `Change source.ts for peer ${index}`, context: "Combine three independently managed edits",
    acceptance_criteria: ["Edit source.ts"], allowed_paths: ["source.ts"],
    base_commit: fixture.base, target_ref: "refs/heads/main",
  } }, actors[index]!, fixture.root, new AbortController().signal);
  await runtime.coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits }, actors[0], fixture.root);
  const first = await Promise.all([submit(0), submit(1)]);
  const ids = first.map(item => item.task_id);
  await Promise.all(peers.slice(0, 2).map(peer => peer.edited));
  const pair = await waitFor("initial selected pair", async () => (await state()).cases.find(item =>
    item.observed_origin === "selected" && item.inputs.length === 2), Boolean);
  assert.ok(pair);
  const third = await submit(2);
  ids.push(third.task_id);
  await peers[2]!.edited;
  const joined = await waitFor("late selected extension", async () => (await state()).cases.find(item =>
    item.id === pair.id && item.inputs.length === 3), Boolean);
  assert.ok(joined);
  await waitFor("six durable revised directed queues", async () => Promise.all(ids.map(id => store.readPeerDeliveries(id))),
    records => records.every(items => items.filter((record: any) => record.envelope.case_id === joined.id &&
      record.envelope.case_revision === joined.revision && record.state === "queued").length === 2));
  for (const peer of peers) peer.release();
  const releasedAt = Date.now();
  const milestones: Array<{ elapsed_ms: number; notes: number; acknowledgments: number; terminal: number }> = [];
  let samples = 0, lastSignature = "";
  const controls = await waitFor("three terminal negotiated workers", async () => {
    const values = await Promise.all(ids.map(id => store.readControl(id)));
    if (++samples % 10 === 0 || values.some(control => control.phase === "terminal")) {
      const metadata = await state() as unknown as { notes?: Array<{ kind: string; acknowledged: string[] }> };
      const marker = { elapsed_ms: Date.now() - releasedAt,
        notes: metadata.notes?.filter(note => note.kind === "agreement_proposal").length ?? 0,
        acknowledgments: metadata.notes?.reduce((sum, note) => sum + note.acknowledged.length, 0) ?? 0,
        terminal: values.filter(control => control.phase === "terminal").length };
      const signature = `${marker.notes}:${marker.acknowledgments}:${marker.terminal}`;
      if (signature !== lastSignature) { milestones.push(marker); lastSignature = signature; }
    }
    return values;
  }, values => values.every(control => control.phase === "terminal"), 3000).catch(async error => {
    const [metadata, current] = await Promise.all([state(), Promise.all(ids.map(id => store.readControl(id)))]);
    const selected = metadata.cases.find(item => item.id === joined.id);
    const retained = metadata as unknown as { notes?: Array<{ id: string; kind: string; author: string;
      acknowledged: string[] }>; receipts?: Array<{ action: string; item_id: string }> };
    error.message += `; negotiation frontier=${JSON.stringify({
      milestones, case: selected && { revision: selected.revision, pending: selected.delivery_pending,
        observed: selected.delivery_observed.length }, runtime: runtime.status().coordination,
      notes: retained.notes?.map(note => ({ id: note.id, kind: note.kind, author: note.author,
        acknowledgments: note.acknowledged.length })),
      receipts: retained.receipts?.map(receipt => ({ action: receipt.action, item_id: receipt.item_id })),
      tasks: current.map((control, index) => ({ id: ids[index], phase: control.phase,
        native: { state: control.native.state, coverage: control.native.coverage, run_id: control.native.run_id },
        deliveries: control.peer_deliveries.map((record: any) => ({ state: record.state,
          revision: record.envelope.case_revision, source_work_id: record.envelope.source_work_id })) })),
      seen: peers.map(peer => peer.seen.map(item => ({ revision: item.revision, sourceWorkId: item.sourceWorkId }))),
    })}`;
    throw error;
  });
  const results = await Promise.all(ids.map(id => store.readResult(id)));
  if (!results.every(result => result?.execution_status === "completed")) {
    const metadata = await state() as unknown as { notes?: Array<{ id: string; kind: string;
      acknowledged: string[] }>; receipts?: Array<{ action: string; item_id: string }> };
    const [retainedOperations, events] = await Promise.all([
      Promise.all(ids.map(id => store.listPeerOperations(id))),
      Promise.all(ids.map(id => readFile(join(store.taskDir(id), "events.ndjson"), "utf8")
        .then(text => text.trim().split("\n").slice(-30).map(line => {
          const entry = JSON.parse(line).event;
          return { kind: entry.kind, operation: entry.operation, operation_key: entry.operation_key,
            outcome: entry.outcome, code: entry.code, state: entry.state };
        })).catch(error => [{ kind: "event_read_error", code: error.code }]))),
    ]);
    assert.fail(JSON.stringify({
      results: results.map(result => ({ status: result?.execution_status, error: result?.error })),
      operations: peers.map(peer => peer.operations), errors: peers.map(peer => peer.errors), milestones,
      notes: metadata.notes?.map(note => ({ id: note.id, kind: note.kind, acknowledgments: note.acknowledged.length })),
      receipts: metadata.receipts?.map(receipt => ({ action: receipt.action, item_id: receipt.item_id })),
      retainedOperations: retainedOperations.map(records => records.map((record: any) => ({
        kind: record.request.kind, key: record.request.operation_key, disposition: record.disposition,
        result: record.result?.kind }))), events,
    }));
  }
  const finalCase = (await state()).cases.find(item => item.id === joined.id);
  assert.ok(finalCase);
  assert.deepEqual(finalCase.delivery_pending, []);
  assert.equal(finalCase.delivery_observed.length, 3);
  for (const [index, control] of controls.entries()) {
    const current = control.peer_deliveries.filter((record: any) => record.envelope.case_id === joined.id &&
      record.envelope.case_revision === joined.revision && record.state === "observed");
    assert.equal(current.length, 2);
    assert.equal(new Set(current.map((record: any) => record.envelope.source_work_id)).size, 2);
    const slots = control.peer_delivery_reservations.filter((slot: any) => slot.case_id === joined.id &&
      slot.case_revision === joined.revision);
    assert.equal(slots.length, 2);
    assert.ok(slots.every((slot: any) => slot.state === "consumed" && current.some((record: any) =>
      record.envelope.delivery_id === slot.delivery_id)));
    for (const record of current) {
      const native = peers[index]!.seen.find(item => item.key === record.envelope.idempotency_key);
      assert.ok(native);
      assert.equal(record.envelope.recipient_run_id, control.native.run_id);
      assert.equal(record.native_turn_id, native.turnId);
      assert.equal(record.native_session_id, peers[index]!.sessionId);
    }
    assert.deepEqual(peers[index]!.errors, []);
  }
  assert.ok(controls.slice(0, 2).every(control => control.peer_deliveries.some((record: any) =>
    record.envelope.case_id === joined.id && record.envelope.case_revision === pair.revision)));
  assert.ok(peers[0]!.operations.includes("propose"));
  assert.ok(peers[1]!.operations.includes("counter_propose"));
  assert.ok(peers[2]!.operations.includes("counter_propose"));
  assert.ok(peers.every(peer => peer.operations.includes("acknowledge")));
  assert.ok(peers[2]!.operations.includes("apply_after_three"));
  assert.equal(peers.filter(peer => peer.operations.includes("apply")).length, 1);
  const outcomes = peers.map(peer => peer.outcome());
  assert.ok(outcomes.every(Boolean));
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[1], outcomes[2]);
  const retained = JSON.parse(await readFile(join(binding.storeRoot, "coordination/control.json"), "utf8"));
  const proposals = retained.notes.flatMap((note: any) => {
    if (note.subject.kind !== "case" || note.subject.id !== joined.id || note.kind !== "agreement_proposal") return [];
    const record = decodePeerResolutionText(note.text);
    return record?.kind === "peer_resolution_proposal" ? [{ note, record }] : [];
  }).sort((left: any, right: any) => left.record.proposal_revision - right.record.proposal_revision);
  assert.equal(proposals.length, 3, "one exact three-step proposal lineage must be retained");
  assert.deepEqual(proposals.map((item: any) => item.record.proposal_revision), [1, 2, 3]);
  assert.deepEqual(proposals.map((item: any) => item.record.action), ["propose", "counter_propose", "counter_propose"]);
  assert.deepEqual(proposals.map((item: any) => item.note.author), actors.map(actor => actor.owner_id));
  assert.equal(proposals[0]!.record.predecessor_digest, null);
  for (let index = 1; index < proposals.length; index++) {
    assert.equal(proposals[index]!.record.predecessor_digest, proposals[index - 1]!.record.resolution_digest);
    assert.equal(proposals[index]!.record.evidence_id, proposals[0]!.record.evidence_id);
    assert.equal(proposals[index]!.record.sources.length, 3);
  }
  const finalProposal = proposals[2]!;
  assert.equal(finalProposal.note.acknowledged.length, 3);
  const operations = await Promise.all(ids.map(id => store.listPeerOperations(id)));
  for (const [index, records] of operations.entries()) {
    const authorPrefix = `worker-peer-v1:${ids[index]}:${controls[index]!.native.run_id}:`;
    const proposalReceipt = retained.receipts.filter((receipt: any) => receipt.action === "post_note" &&
      receipt.item_id === proposals[index]!.note.id && receipt.owner === actors[index]!.owner_id &&
      receipt.key.startsWith(authorPrefix));
    assert.equal(proposalReceipt.length, 1, `worker ${index} must author its own proposal revision`);
    const acknowledgments = retained.receipts.filter((receipt: any) => receipt.action === "ack_note" &&
      receipt.item_id === finalProposal.note.id && receipt.owner === actors[index]!.owner_id &&
      receipt.key.startsWith(authorPrefix));
    assert.equal(acknowledgments.length, 1, `worker ${index} must retain one task/run-bound consent`);
    const exact = records.filter((record: any) => record.request.kind === "acknowledge" &&
      record.request.note_id === finalProposal.note.id && record.disposition === "settled" &&
      record.result?.kind === "receipt" && record.result.operation === "acknowledge" &&
      record.result.note_id === finalProposal.note.id);
    assert.equal(exact.length, 1, `worker ${index} must settle one exact task-owned ACK intent`);
  }
  const applications = retained.notes.flatMap((note: any) => {
    if (note.subject.kind !== "case" || note.subject.id !== joined.id || note.kind !== "resolution_update") return [];
    const record = decodePeerResolutionText(note.text);
    return record?.kind === "peer_resolution_application" && record.status === "applied"
      ? [{ note, record }] : [];
  });
  assert.equal(applications.length, 1, "the final consensus must have one durable applied effect");
  assert.equal(applications[0]!.record.proposal_digest, finalProposal.record.resolution_digest);
  const outcome = outcomes[0] as { proposal_note_id: string; application_note_id: string;
    proposal_digest: string; application_digest: string };
  assert.equal(outcome.proposal_note_id, finalProposal.note.id);
  assert.equal(outcome.application_note_id, applications[0]!.note.id);
  assert.equal(outcome.proposal_digest, finalProposal.record.resolution_digest);
  assert.equal(outcome.application_digest, applications[0]!.record.application_digest);
  const applyingPrefix = `worker-peer-v1:${ids[2]}:${controls[2]!.native.run_id}:`;
  assert.equal(retained.receipts.filter((receipt: any) => receipt.action === "post_note" &&
    receipt.item_id === applications[0]!.note.id && receipt.key.startsWith(applyingPrefix)).length, 1);
  assert.equal(operations[2]!.filter((record: any) => record.request.kind === "apply" &&
    record.disposition === "settled" && record.result?.status === "applied").length, 1);
  assert.ok(operations.slice(0, 2).every(records => !records.some((record: any) => record.request.kind === "apply")));
  const resources = await Promise.all(ids.map(id => store.readResource(id)));
  assert.ok(resources.every(resource => resource?.worktree_path));
  const sources = await Promise.all(resources.map(resource => readFile(join(resource.worktree_path, "source.ts"), "utf8")));
  assert.deepEqual(sources.slice(0, 2), [
    "export function run() { return 1; }\n", "export function run() { return 2; }\n",
  ], "application must leave the first two managed worktrees unchanged");
  const actual = sources[2]!;
  assert.equal(actual, "export function run() { return 6; }\n");
  const combined = await import(`data:text/javascript;base64,${Buffer.from(actual).toString("base64")}`);
  assert.equal(combined.run(), 6);
  assert.equal(await readFile(join(fixture.root, "source.ts"), "utf8"), "export function run() {}\n");
}, 240_000);
