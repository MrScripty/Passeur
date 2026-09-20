import { describe, expect, it } from "vitest";
import { MuseSdkAdapter, type ClientStarter } from "../../src/muse/adapter.js";
import type { Assignment, ExecutionPolicy } from "../../src/contracts/agents.js";
import type { MuseOptions } from "../../src/muse/config.js";
const request: Assignment = { schema_version: 3, agent_id: "muse", request_key: "cancel", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const options: MuseOptions = { muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
const policy: ExecutionPolicy = { implementation: { enabled: false }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, max_workers: 2, max_queued_tasks: 8 };
const input = (adapter: MuseSdkAdapter, controller: AbortController, selectedPolicy = policy) => adapter.run({ request, policy: selectedPolicy, workspace: "/work", prompt: "prompt", task_id: "task", signal: controller.signal, approve: async () => ({ choice_id: "deny" }), onEvent: async () => {} });
const starts = (client: unknown): ClientStarter => () => ({ ready: Promise.resolve(client as never), close: async () => {} });
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
    expect(await running).toMatchObject({ status: "cancelled", worker_stop: "confirmed" }); expect(closes).toBe(1);
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
    const turn = { completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }), items: async function* () { begun(); await closed; if (rejectIterator) throw new Error("closed"); } };
    const session = { opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => turn };
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
  approve: async () => { throw new Error("No approval before startup"); }, onEvent: async () => {},
});
