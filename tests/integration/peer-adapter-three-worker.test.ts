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
import type { WorkerInput } from "../../src/agents/types.js";

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
  }, 1000);
  const selected = settled.control.cases.find(item => item.id === joined.id);
  assert.ok(selected);
  assert.deepEqual(selected.delivery_pending, []);
  assert.equal(selected.delivery_observed.length, 3);
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
