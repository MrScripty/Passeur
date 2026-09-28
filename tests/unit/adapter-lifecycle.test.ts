import { describe, expect, it } from "vitest";
import { MuseSdkAdapter, type ClientStarter } from "../../src/muse/adapter.js";
import type { Assignment } from "../../src/contracts/agents.js";
import type { LifecyclePolicy } from "../../src/contracts/tasks.js";
import type { MuseOptions } from "../../src/muse/config.js";
const request: Assignment = { schema_version: 3, agent_id: "muse", request_key: "cancel", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const options: MuseOptions = { muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
const policy: LifecyclePolicy = { implementation: { enabled: false }, stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512 };
const input = (adapter: MuseSdkAdapter, controller: AbortController, selectedPolicy = policy) => adapter.run({ request, policy: selectedPolicy, workspace: "/work", prompt: "prompt", task_id: "task", signal: controller.signal, approve: async () => ({ choice_id: "deny" }), input: async () => { throw new Error("Unexpected clarification in this fixture"); }, onEvent: async () => {} });
const starts = (client: unknown): ClientStarter => () => ({ ready: Promise.resolve(client as never), close: async () => {} });
it("requires independent stop evidence even when the SDK closes cleanly", async () => {
  const session = { sessionId: "native-session", fold: { current: true,
    items: { list: () => [], isTerminalUnknown: () => false } },
    opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {},
    sendUserTurn: async () => ({ turnId: "native-turn",
      completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }),
      items: async function* () { yield { kind: "agentMessage", text:
        'PASSEUR_MESSAGE {"schema_version":2,"kind":"final","summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[]}' }; } }),
  };
  for (const { proved, closeFails } of [{ proved: false, closeFails: false },
    { proved: true, closeFails: false }, { proved: true, closeFails: true }]) {
    let closes = 0, proofs = 0;
    const adapter = new MuseSdkAdapter(options, () => ({
      ready: Promise.resolve({ startSession: async () => session, close: async () => {
        closes++; if (closeFails) throw Error("SDK close failed"); } } as never),
      close: async () => { closes++; }, stopProof: async () => { proofs++; return proved; },
    }));
    const result = await input(adapter, new AbortController());
    expect(closes).toBe(1);
    expect(proofs).toBe(1);
    expect(result).toMatchObject({ status: "completed", worker_stop: proved && !closeFails ? "confirmed" : "unconfirmed" });
  }
});
describe("owned Muse startup and cancellation", () => {
  it("uses a Muse-compatible machine identifier", async () => {
    let clientName: string | undefined;
    const starter: ClientStarter = (options) => {
      clientName = options.clientInfo.name;
      return { ready: Promise.reject(new Error("stop after capture")), close: async () => {} };
    };
    const result = await input(new MuseSdkAdapter(options, starter), new AbortController());
    expect(result.status).toBe("failed");
    expect(clientName).toMatch(/^[a-z0-9_]+$/);
    expect(clientName).toBe("muse_bridge");
  });
  it("does not start an already-cancelled assignment", async () => {
    let spawns = 0; const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const result = await input(new MuseSdkAdapter(options, () => { spawns++; throw new Error("must not spawn"); }), controller);
    expect(spawns).toBe(0); expect(result.worker_stop).toBe("not_started");
  });
  it("closes pending host initialization on cancellation", async () => {
    let closes = 0; const controller = new AbortController();
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<never>((_resolve, reject) => { rejectReady = reject; });
    const adapter = new MuseSdkAdapter(options, () => ({ ready, close: async () => { closes++; rejectReady(new Error("closed")); } }));
    const running = input(adapter, controller); controller.abort(new Error("cancelled"));
    expect(await running).toMatchObject({ status: "cancelled", worker_stop: "unconfirmed" }); expect(closes).toBe(1);
  });
  it("bounds an unresponsive startup close and preserves uncertainty", async () => {
    const controller = new AbortController();
    const adapter = new MuseSdkAdapter(options, () => ({ ready: new Promise<never>(() => {}), close: async () => new Promise<never>(() => {}) }));
    const running = input(adapter, controller, { ...policy, stop_grace_ms: 10 }); controller.abort(new Error("cancelled"));
    expect(await running).toMatchObject({ status: "cancelled", worker_stop: "unconfirmed" });
  });
  it("cancels a blocked session start and closes its client", async () => {
    let closes = 0; let begun!: () => void; const started = new Promise<void>((resolve) => { begun = resolve; });
    const client = { startSession: async () => { begun(); return new Promise<never>(() => {}); }, close: async () => { closes++; } };
    const controller = new AbortController(); const running = input(new MuseSdkAdapter(options, starts(client)), controller);
    await started; controller.abort(new Error("cancelled"));
    expect((await running).status).toBe("cancelled"); expect(closes).toBe(1);
  });
  for (const rejectIterator of [false, true]) it(`settles output draining after cancellation (reject=${rejectIterator})`, async () => {
    let close!: () => void; const closed = new Promise<void>((resolve) => { close = resolve; });
    let begun!: () => void; const started = new Promise<void>((resolve) => { begun = resolve; });
    const turn = { turnId: "native-turn", completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }), items: async function* () { begun(); await closed; if (rejectIterator) throw new Error("closed"); } };
    const session = { sessionId: "native-session", fold: {current:true,items:{list:()=>[],isTerminalUnknown:()=>false}}, opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => turn };
    const controller = new AbortController(); const adapter = new MuseSdkAdapter(options, starts({ startSession: async () => session, close: async () => { close(); } }));
    const unhandled: unknown[] = []; const handler = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", handler);
    try {
      const running = input(adapter, controller); await started; controller.abort(new Error("cancelled"));
      expect((await running).status).toBe("cancelled"); await new Promise((resolve) => setImmediate(resolve)); expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", handler); }
  });
});

import { cancellationConformance } from "../fixtures/adapter-conformance.js";
cancellationConformance("Muse", () => new MuseSdkAdapter(options, () => { throw new Error("Pre-cancelled work must not start"); }), {
  request, policy, workspace: "/unavailable/pre-cancelled-workspace", prompt: "not submitted", task_id: "pre-cancelled",
  approve: async () => { throw new Error("No approval before startup"); }, input: async () => { throw new Error("Unexpected clarification in this fixture"); }, onEvent: async () => {},
});

// Native peer substitution proves the adapter, not the installed Muse SDK/runtime.
it("observes native host death while awaiting an explicit continuation", async () => {
  let die!: (error: Error) => void, entered!: () => void;
  const failure = new Promise<never>((_resolve,reject)=>{die=reject;}); failure.catch(()=>undefined);
  const waiting = new Promise<void>(resolve=>{entered=resolve;});
  const session = { sessionId: "native-session", fold: {current:true,items:{list:()=>[],isTerminalUnknown:()=>false}},
    opening:{result:{session:{modelId:"model"}}},onApproval(){},onApprovalError(){},
    sendUserTurn:async()=>({turnId:"native-turn",completed:Promise.resolve({kind:"completed",params:{terminal:"completed"}}),items:async function*(){yield {kind:"agentMessage",text:'PASSEUR_MESSAGE {"schema_version":2,"kind":"input_required","question":"Which output?"}'};}}) };
  const client={startSession:async()=>session,close:async()=>{}};
  const adapter=new MuseSdkAdapter(options,()=>({ready:Promise.resolve(client as never),failure,close:async()=>{}}));
  const result=adapter.run({request,policy,workspace:"/work",prompt:"fixture",task_id:"fixture",signal:new AbortController().signal,
    approve:async()=>({choice_id:"deny"}),onEvent:async()=>{},input:async(_q,_a,_id,_choices,signal)=>{
      entered();return new Promise<string>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true}));
    }});
  await waiting;die(new Error("observed host exit"));
  expect(await result).toMatchObject({status:"failed",worker_stop:"unconfirmed"});
});
it("waits for an explicitly in-progress native item instead of timing it out", async () => {
  let released=false, observed!:()=>void;const started=new Promise<void>(resolve=>{observed=resolve;});
  const item={itemId:"background",kind:"userShell",status:"inProgress"};
  const session={sessionId:"native-session",fold:{current:true,items:{list:()=>[item],isTerminalUnknown:()=>false}},opening:{result:{session:{modelId:"model"}}},onApproval(){},onApprovalError(){},
    sendUserTurn:async()=>({turnId:"native-turn",completed:Promise.resolve({kind:"completed",params:{terminal:"completed"}}),items:async function*(){yield {kind:"agentMessage",text:'PASSEUR_MESSAGE {"schema_version":2,"kind":"final","summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[]}'};}})};
  const adapter=new MuseSdkAdapter(options,starts({startSession:async()=>session,close:async()=>{expect(released).toBe(true);}}));
  let settled=false;
  const running=adapter.run({request,policy,workspace:"/work",prompt:"fixture",task_id:"fixture",signal:new AbortController().signal,
    approve:async()=>({choice_id:"deny"}),input:async()=>{throw Error("Not an input wait");},onEvent:async(event)=>{if(event.kind==="operation_started")observed();}}).then(result=>{settled=true;return result;});
  await started;await Promise.resolve();expect(settled).toBe(false);released=true;item.status="completed";
  expect(await running).toMatchObject({status:"completed",worker_stop:"unconfirmed"});
});

it("does not present an early approval when durable native correlation fails", async () => {
  let approval!: (request: unknown) => Promise<unknown>, presentations = 0;
  const native = { sessionId: "native-session", fold: { current: true,
    items: { list: () => [], isTerminalUnknown: () => false } },
    opening: { result: { session: { modelId: "model" } } },
    onApproval(callback: typeof approval) { approval = callback; }, onApprovalError() {},
    sendUserTurn: async () => {
      const decided = approval({ approvalId: "approval", sessionId: "native-session", turnId: "native-turn",
        toolCallId: "call", itemId: "item", taskId: "task", viewCursor: "cursor",
        currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
        toolName: "bash", rawArgs: "{}", subject: { kind: "shell" },
        availableChoices: [{ choiceId: "deny", label: "Deny", decision: "denied", scope: "once" }] });
      return { turnId: "native-turn", completed: decided.then(() => ({ kind: "completed", params: { terminal: "completed" } })),
        items: async function* () {} };
    } };
  const adapter = new MuseSdkAdapter(options, starts({ startSession: async () => native, close: async () => {} }));
  const result = await adapter.run({ request, policy, workspace: "/work", prompt: "fixture", task_id: "fixture",
    signal: new AbortController().signal,
    approve: async () => { presentations++; return { choice_id: "deny" }; },
    input: async () => { throw Error("unexpected clarification"); },
    onEvent: async event => { if (event.kind === "turn_correlated") throw Error("durable write failed"); } });
  expect(result).toMatchObject({ status: "failed", error: { code: "MUSE_NATIVE_CORRELATION_FAILED" } });
  expect(presentations).toBe(0);
});

for (const failureKind of ["submitFailed", "handlerThrew"] as const)
  it(`does not report success when SDK ${failureKind} arrives after the terminal event`, async () => {
    let approval!: (request: unknown) => Promise<unknown>;
    let failed!: (failure: { kind: typeof failureKind; approvalId: string; error: Error }) => void;
    const native = { sessionId: "native-session", fold: { current: true,
      items: { list: () => [], isTerminalUnknown: () => false } },
      opening: { result: { session: { modelId: "model" } } },
      onApproval(callback: typeof approval) { approval = callback; }, onApprovalError(callback: typeof failed) { failed = callback; },
      sendUserTurn: async () => ({ turnId: "native-turn", completed: approval({
        approvalId: "approval", sessionId: "native-session", turnId: "native-turn", toolCallId: "call",
        itemId: "item", taskId: "task", viewCursor: "cursor",
        currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
        toolName: "bash", rawArgs: "{}", subject: { kind: "shell" },
        availableChoices: [{ choiceId: "deny", label: "Deny", decision: "denied", scope: "once" }],
      }).then(() => ({ kind: "completed", params: { terminal: "completed" } })),
      items: async function* () { yield { kind: "agentMessage", text: 'PASSEUR_MESSAGE {"schema_version":2,"kind":"final","summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[]}' }; } }),
    };
    const adapter = new MuseSdkAdapter(options, starts({ startSession: async () => native, close: async () => {} }));
    const result = await adapter.run({ request, policy, workspace: "/work", prompt: "fixture", task_id: "fixture",
      signal: new AbortController().signal,
      approve: async () => ({ choice_id: "deny" }), input: async () => { throw Error("unexpected input"); },
      onEvent: async event => { if (event.kind === "turn_settled") queueMicrotask(() =>
        failed({ kind: failureKind, approvalId: "approval", error: Error("late SDK failure") })); } });
    expect(result).toMatchObject({ status: "failed", worker_stop: "unconfirmed",
      error: { code: failureKind === "submitFailed" ? "MUSE_APPROVAL_DISPATCH_UNKNOWN" : "MUSE_APPROVAL_HANDLER_FAILED" } });
  });

for (const changed of ["toolCallId", "itemId", "taskId"] as const)
  it(`rejects a changed native approval ${changed} on the next requirement`, async () => {
    let approval!: (request: unknown) => Promise<unknown>, presentations = 0;
    const base = { approvalId: "approval", sessionId: "native-session", turnId: "native-turn",
      toolCallId: "call", itemId: "item", taskId: "task", viewCursor: "cursor",
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
      toolName: "bash", rawArgs: "{}", subject: { kind: "shell" },
      availableChoices: [{ choiceId: "deny", label: "Deny", decision: "denied", scope: "once" }] };
    const native = { sessionId: "native-session", fold: { current: true,
      items: { list: () => [], isTerminalUnknown: () => false } },
      opening: { result: { session: { modelId: "model" } } },
      onApproval(callback: typeof approval) { approval = callback; }, onApprovalError() {},
      sendUserTurn: async () => ({ turnId: "native-turn", completed: (async () => {
        await approval(base);
        await approval({ ...base, currentRequirementId: { approvalId: "approval", sourceIndex: 1 },
          [changed]: "foreign" });
        return { kind: "completed", params: { terminal: "completed" } };
      })(), items: async function* () {} }) };
    const adapter = new MuseSdkAdapter(options, starts({ startSession: async () => native, close: async () => {} }));
    const result = await adapter.run({ request, policy, workspace: "/work", prompt: "fixture", task_id: "fixture",
      signal: new AbortController().signal, approve: async () => { presentations++; return { choice_id: "deny" }; },
      input: async () => { throw Error("unexpected input"); }, onEvent: async () => {} });
    expect(result).toMatchObject({ status: "failed", error: { code: "MUSE_APPROVAL_IDENTITY_CHANGED" } });
    expect(presentations).toBe(1);
  });
