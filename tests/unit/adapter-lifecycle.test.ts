import { describe, expect, it } from "vitest";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import type { DelegateRequest, Profile } from "../../src/contracts/index.js";

const request: DelegateRequest = { schema_version: 1, request_key: "cancel", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "restricted" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed" } };

describe("MuseSdkAdapter lifecycle", () => {
  const input = (adapter: MuseSdkAdapter, controller: AbortController) => adapter.run({ request, profile, workspace: "/work", prompt: "prompt", signal: controller.signal, approve: async () => ({ choice_id: "deny" }), onEvent: async () => {} });
  it("does not spawn for an already-cancelled assignment", async () => {
    let spawns = 0; const adapter = new MuseSdkAdapter(async () => { spawns++; throw new Error("must not spawn"); }); const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const result = await input(adapter, controller);
    expect(result.status).toBe("cancelled"); expect(spawns).toBe(0); expect(result.worker_stop).toBe("not_started");
  });
  it("cancels blocked session startup and closes the host", async () => {
    let closeCalls = 0; let spawned!: () => void; const didSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const client = { startSession: async () => new Promise<never>(() => {}), close: async () => { closeCalls++; } };
    const adapter = new MuseSdkAdapter(async () => { spawned(); return client as never; }); const controller = new AbortController(); const running = input(adapter, controller); await didSpawn; controller.abort(new Error("cancelled"));
    const result = await Promise.race([running, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))]);
    expect(result).not.toBe("timeout"); expect(result).toMatchObject({ status: "cancelled" }); expect(closeCalls).toBe(1);
  });
  it("cancels blocked output draining after the terminal outcome", async () => {
    let closeCalls = 0; let release!: () => void; const closed = new Promise<void>((resolve) => { release = resolve; });
    const turn = { turnId: "turn", observedStart: true, completed: Promise.resolve({ kind: "completed", observedStart: true, params: { terminal: "completed" } }), items: async function* () { await closed; }, deltas: async function* () {} };
    const session = { opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => turn };
    const client = { startSession: async () => session, close: async () => { closeCalls++; release(); } };
    const adapter = new MuseSdkAdapter(async () => client as never); const controller = new AbortController(); const running = input(adapter, controller); await new Promise((resolve) => setImmediate(resolve)); controller.abort(new Error("cancelled"));
    const result = await Promise.race([running, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))]);
    expect(result).not.toBe("timeout"); expect(result).toMatchObject({ status: "cancelled" }); expect(closeCalls).toBe(1);
  });
  it("settles a rejecting item iterator after cancellation without an unhandled rejection", async () => {
    let close!: () => void; const closed = new Promise<void>((resolve) => { close = resolve; });
    const turn = { turnId: "turn", observedStart: true, completed: new Promise<never>(() => {}), items: async function* () { await closed; throw new Error("iterator closed"); }, deltas: async function* () {} };
    let markStarted!: () => void; const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const session = { opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => { markStarted(); return turn; } };
    const client = { startSession: async () => session, close: async () => { close(); } };
    const adapter = new MuseSdkAdapter(async () => client as never); const controller = new AbortController();
    const unhandled: unknown[] = []; const handler = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", handler);
    try {
      const running = input(adapter, controller);
      await started; controller.abort(new Error("cancelled")); const result = await running; await new Promise((resolve) => setImmediate(resolve));
      expect(result.status).toBe("cancelled"); expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", handler); }
  });
});
