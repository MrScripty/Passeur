import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished, test } from "vitest";
import { AgentRegistry } from "../../src/agents/registry.js";
import { Coordinator } from "../../src/core/coordinator.js";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import type { MuseOptions } from "../../src/muse/config.js";
import { TaskStore } from "../../src/store/task-store.js";

const exec = promisify(execFile);
const options: MuseOptions = { muse_bin: "controlled", model: "controlled",
  review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
  implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
const actor = { owner_id: "a".repeat(64), client_id: randomUUID() };
const final = `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "final", summary: "Controlled native turn",
  assessment: "met", blockers: [], questions: [], checks: [] })}`;
const pause = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`${label} was not observed`);
}
async function controlledCoordinator(adapter: MuseSdkAdapter) {
  const root = await mkdtemp(join(tmpdir(), "passeur-muse-identity-"));
  const project = join(root, "project"), state = join(root, "state"), worktrees = join(root, "worktrees");
  await mkdir(project); await mkdir(worktrees);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Passeur Identity Fixture"], ["config", "commit.gpgsign", "false"]])
    await exec("git", ["-C", project, ...args]);
  await writeFile(join(project, "source.txt"), "controlled input\n");
  await exec("git", ["-C", project, "add", "source.txt"]);
  await exec("git", ["-C", project, "commit", "-qm", "test: base"]);
  const policy = { implementation: { enabled: true, worktree_root: worktrees }, stop_grace_ms: 1_000,
    max_workers: 1, max_queued_tasks: 2, max_clients: 8, max_waiters: 16,
    max_pending_inputs: 8, max_control_receipts: 32 };
  const profile = { schema_version: 3 as const, execution: policy,
    agents: [{ agent_id: "muse", adapter_id: "muse", description: "Controlled Muse", enabled: true, options: {} }] };
  const registry = new AgentRegistry(profile, { muse: { configure: () => ({ worker: adapter,
    modes: ["review" as const], contract: "muse-sdk/controlled-identity", requested_model: "controlled", configuration: {} }) } });
  const store = new TaskStore(state); await store.initialize();
  const coordinator = new Coordinator(project, "identity-fixture", policy, store, registry);
  onTestFinished(async () => {
    for (const record of await store.list()) if (coordinator.isActive(record.task_id)) {
      const control = await store.readControl(record.task_id);
      await coordinator.cancel(record.task_id, actor, control.control_generation, randomUUID(), "Dispose controlled native identity fixture");
    }
    await coordinator.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const receipt = await coordinator.submit({ schema_version: 1, source_view: project, assignment: {
    schema_version: 3, agent_id: "muse", request_key: randomUUID(), mode: "review",
    objective: "Observe native identity", context: "", acceptance_criteria: ["Observe one turn"] } },
  actor, new AbortController().signal);
  return { coordinator, store, taskId: receipt.task_id };
}

const approval = (stage: number) => ({ approvalId: "approval-1", sessionId: "native-session",
  turnId: "native-turn", toolCallId: "native-call", itemId: "native-item", taskId: "native-task",
  viewCursor: `cursor-${stage}`, currentRequirementId: { approvalId: "approval-1", sourceIndex: stage },
  toolName: "bash", rawArgs: '{"command":"true"}', subject: { kind: "shell", command: "true" },
  availableChoices: [{ choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" }] });

test("early native approval waits for durable Coordinator correlation before InputBroker presentation", async () => {
  const send = pause();
  let callback!: (request: unknown) => Promise<{ choiceId: string }>;
  let decided!: Promise<{ choiceId: string }>;
  const session = { sessionId: "native-session", opening: { result: { session: { modelId: "controlled" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval(handler: typeof callback) { callback = handler; }, onApprovalError() {},
    sendUserTurn: async () => {
      decided = callback(approval(0));
      await send.promise;
      return { turnId: "native-turn", completed: decided.then(() => ({ kind: "completed", params: { terminal: "completed" } })),
        items: async function* () { yield { kind: "agentMessage", text: final }; } };
    } };
  const adapter = new MuseSdkAdapter(options, () => ({ ready: Promise.resolve({ startSession: async () => session,
    close: async () => {} } as never), close: async () => {} }));
  const { coordinator, store, taskId } = await controlledCoordinator(adapter);
  await eventually(async () => (await store.readControl(taskId)).native.turn_id ? true : undefined, "provisional turn");
  assert.equal((await store.readControl(taskId)).inputs.length, 0);
  send.release();
  const pending = await eventually(async () => (await store.readControl(taskId)).inputs.find(value => value.state === "pending"), "correlated approval");
  const control = await store.readControl(taskId);
  assert.equal(control.native.native_session_id, "native-session");
  assert.equal(control.native.turn_id, "native-turn");
  assert.equal(pending.turn_id, "native-turn");
  assert.deepEqual((pending.data.kind === "permission" ? pending.data.approval.subject.native : null), {
    session_id: "native-session", turn_id: "native-turn", approval_id: "approval-1",
    tool_call_id: "native-call", item_id: "native-item", task_id: "native-task",
    view_cursor: "cursor-0", current_requirement_id: { approvalId: "approval-1", sourceIndex: 0 } });
  const claim = await coordinator.inputs.claim(taskId, pending.input_id, actor, control.control_generation);
  await coordinator.inputs.answer(taskId, pending.input_id, actor, control.control_generation,
    claim.claim!.id, randomUUID(), "allow-once");
  assert.deepEqual(await decided, { choiceId: "allow-once" });
  const result = await eventually(() => store.readResult(taskId), "completed task");
  assert.equal(result.execution_status, "completed");
  assert.equal((await store.readControl(taskId)).native.coverage, "turn_scoped");
});

test.each(["submitFailed", "handlerThrew"] as const)("changed native requirement creates a new input; SDK %s remains failed", async failureKind => {
  let callback!: (request: unknown) => Promise<{ choiceId: string }>;
  let failed!: (failure: { kind: "submitFailed" | "handlerThrew"; approvalId: string; error: Error }) => void;
  const first = pause();
  const session = { sessionId: "native-session", opening: { result: { session: { modelId: "controlled" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval(handler: typeof callback) { callback = handler; }, onApprovalError(handler: typeof failed) { failed = handler; },
    sendUserTurn: async () => ({ turnId: "native-turn", completed: (async () => {
      const initial = await callback(approval(0)); assert.equal(initial.choiceId, "allow-once");
      first.release();
      const next = await callback(approval(1)); assert.equal(next.choiceId, "deny");
      failed({ kind: failureKind, approvalId: "approval-1", error: Error("ambiguous SDK transport") });
      return new Promise<never>(() => {});
    })(), items: async function* () {} }),
  };
  const adapter = new MuseSdkAdapter(options, () => ({ ready: Promise.resolve({ startSession: async () => session,
    close: async () => {} } as never), close: async () => {} }));
  const { coordinator, store, taskId } = await controlledCoordinator(adapter);
  const answer = async (expectedIndex: number, choice: string) => {
    const pending = await eventually(async () => (await store.readControl(taskId)).inputs.find(value => value.state === "pending" &&
      value.data.kind === "permission" && (value.data.approval.subject.native as { current_requirement_id: { sourceIndex: number } })
        .current_requirement_id.sourceIndex === expectedIndex), `approval stage ${expectedIndex}`);
    const control = await store.readControl(taskId);
    const claim = await coordinator.inputs.claim(taskId, pending.input_id, actor, control.control_generation);
    await coordinator.inputs.answer(taskId, pending.input_id, actor, control.control_generation,
      claim.claim!.id, randomUUID(), choice);
    return pending;
  };
  const firstInput = await answer(0, "allow-once");
  await first.promise;
  const secondInput = await answer(1, "deny");
  assert.notEqual(firstInput.native_id, secondInput.native_id);
  assert.notEqual(firstInput.input_id, secondInput.input_id);
  const result = await eventually(() => store.readResult(taskId), "failed task");
  assert.equal(result.execution_status, "failed");
  assert.equal(result.error?.code, failureKind === "submitFailed" ? "MUSE_APPROVAL_DISPATCH_UNKNOWN" : "MUSE_APPROVAL_HANDLER_FAILED");
  assert.notEqual((await store.readControl(taskId)).inputs.find(value => value.input_id === secondInput.input_id)?.state, "settled");
});

test.each([
  ["session", { sessionId: "foreign-session" }],
  ["turn", { turnId: "foreign-turn" }],
  ["requirement", { currentRequirementId: { approvalId: "foreign-approval", sourceIndex: 0 } }],
] as const)("foreign native approval %s fails before InputBroker presentation", async (_name, changed) => {
  let callback!: (request: unknown) => Promise<{ choiceId: string }>;
  const session = { sessionId: "native-session", opening: { result: { session: { modelId: "controlled" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval(handler: typeof callback) { callback = handler; }, onApprovalError() {},
    sendUserTurn: async () => ({ turnId: "native-turn", completed: callback({ ...approval(0), ...changed })
      .then(() => ({ kind: "completed", params: { terminal: "completed" } })),
    items: async function* () {} }) };
  const adapter = new MuseSdkAdapter(options, () => ({ ready: Promise.resolve({ startSession: async () => session,
    close: async () => {} } as never), close: async () => {} }));
  const { store, taskId } = await controlledCoordinator(adapter);
  const result = await eventually(() => store.readResult(taskId), "foreign approval failure");
  assert.equal(result.execution_status, "failed");
  assert.equal(result.error?.code, "MUSE_APPROVAL_UNCORRELATED");
  assert.equal((await store.readControl(taskId)).inputs.length, 0);
});

test("a concurrent requirement withdraws the older input and cannot return its stale answer to the SDK", async () => {
  let callback!: (request: unknown) => Promise<{ choiceId: string }>;
  let firstDecision!: Promise<{ choiceId: string }>, secondDecision!: Promise<{ choiceId: string }>;
  const session = { sessionId: "native-session", opening: { result: { session: { modelId: "controlled" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval(handler: typeof callback) { callback = handler; }, onApprovalError() {},
    sendUserTurn: async () => {
      firstDecision = callback(approval(0));
      firstDecision.catch(() => undefined);
      return { turnId: "native-turn", completed: new Promise<never>(() => {}), items: async function* () {} };
    } };
  const adapter = new MuseSdkAdapter(options, () => ({ ready: Promise.resolve({ startSession: async () => session,
    close: async () => {} } as never), close: async () => {} }));
  const { coordinator, store, taskId } = await controlledCoordinator(adapter);
  const firstInput = await eventually(async () => (await store.readControl(taskId)).inputs.find(value => value.state === "pending"), "first approval stage");
  const control = await store.readControl(taskId);
  const claim = await coordinator.inputs.claim(taskId, firstInput.input_id, actor, control.control_generation);
  secondDecision = callback(approval(1));
  secondDecision.catch(() => undefined);
  const racedAnswer = await Promise.allSettled([coordinator.inputs.answer(taskId, firstInput.input_id, actor, control.control_generation,
    claim.claim!.id, randomUUID(), "allow-once")]);
  await assert.rejects(firstDecision);
  await assert.rejects(secondDecision);
  const result = await eventually(() => store.readResult(taskId), "superseded task failure");
  assert.equal(result.execution_status, "failed");
  assert.equal(result.error?.code, "MUSE_APPROVAL_STAGE_SUPERSEDED");
  const staleState = (await store.readControl(taskId)).inputs.find(value => value.input_id === firstInput.input_id)?.state;
  assert.ok(staleState === "withdrawn" || staleState === "answer_intent");
  if (racedAnswer[0]?.status === "rejected") assert.equal(staleState, "withdrawn");
});

test.each(["submitFailed", "handlerThrew"] as const)("SDK %s during close vetoes a completed task result", async failureKind => {
  let callback!: (request: unknown) => Promise<{ choiceId: string }>;
  let failed!: (failure: { kind: "submitFailed" | "handlerThrew"; approvalId: string; error: Error }) => void;
  const session = { sessionId: "native-session", opening: { result: { session: { modelId: "controlled" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval(handler: typeof callback) { callback = handler; }, onApprovalError(handler: typeof failed) { failed = handler; },
    sendUserTurn: async () => ({ turnId: "native-turn", completed: callback(approval(0)).then(() =>
      ({ kind: "completed", params: { terminal: "completed" } })),
    items: async function* () { yield { kind: "agentMessage", text: final }; } }) };
  let closes = 0;
  const close = async () => { closes++;
    failed({ kind: failureKind, approvalId: "approval-1", error: Error("late native dispatch failure") }); };
  const adapter = new MuseSdkAdapter(options, () => ({ ready: Promise.resolve({ startSession: async () => session, close } as never), close }));
  const { coordinator, store, taskId } = await controlledCoordinator(adapter);
  const pending = await eventually(async () => (await store.readControl(taskId)).inputs.find(value => value.state === "pending"), "approval before close");
  const control = await store.readControl(taskId);
  const claim = await coordinator.inputs.claim(taskId, pending.input_id, actor, control.control_generation);
  await coordinator.inputs.answer(taskId, pending.input_id, actor, control.control_generation,
    claim.claim!.id, randomUUID(), "allow-once");
  const result = await eventually(() => store.readResult(taskId), "late SDK failure");
  assert.equal(result.execution_status, "failed");
  assert.equal(result.error?.code, failureKind === "submitFailed" ? "MUSE_APPROVAL_DISPATCH_UNKNOWN" : "MUSE_APPROVAL_HANDLER_FAILED");
  assert.equal(closes, 1);
});
