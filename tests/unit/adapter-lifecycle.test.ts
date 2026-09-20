import { describe, expect, it } from "vitest";
import { MuseSdkAdapter, type ClientStarter } from "../../src/muse/adapter.js";
import type { DelegateRequest, Profile } from "../../src/contracts/types.js";
const request: DelegateRequest = { schema_version: 2, request_key: "cancel", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "restricted" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed" } };
const input = (adapter: MuseSdkAdapter, controller: AbortController, selectedProfile = profile) => adapter.run({ request, profile: selectedProfile, workspace: "/work", prompt: "prompt", task_id: "task", signal: controller.signal, approve: async () => ({ choice_id: "deny" }), onEvent: async () => {} });
const starts = (client: unknown): ClientStarter => () => ({ ready: Promise.resolve(client as never), close: async () => {} });
describe("owned Muse startup and cancellation", () => {
  it("uses a Muse-compatible machine identifier", async () => {
    let clientName: string | undefined;
    const starter: ClientStarter = (options) => {
      clientName = options.clientInfo.name;
      return { ready: Promise.reject(new Error("stop after capture")), close: async () => {} };
    };
    const result = await input(new MuseSdkAdapter(starter), new AbortController());
    expect(result.status).toBe("failed");
    expect(clientName).toMatch(/^[a-z0-9_]+$/);
    expect(clientName).toBe("muse_bridge");
  });
  it("does not start an already-cancelled assignment", async () => {
    let spawns = 0; const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const result = await input(new MuseSdkAdapter(() => { spawns++; throw new Error("must not spawn"); }), controller);
    expect(spawns).toBe(0); expect(result.worker_stop).toBe("not_started");
  });
  it("closes pending host initialization on cancellation", async () => {
    let closes = 0; const controller = new AbortController();
    const adapter = new MuseSdkAdapter(() => ({ ready: new Promise<never>(() => {}), close: async () => { closes++; } }));
    const running = input(adapter, controller); controller.abort(new Error("cancelled"));
    expect(await running).toMatchObject({ status: "cancelled", worker_stop: "confirmed" }); expect(closes).toBe(1);
  });
  it("bounds an unresponsive startup close and preserves uncertainty", async () => {
    const controller = new AbortController();
    const adapter = new MuseSdkAdapter(() => ({ ready: new Promise<never>(() => {}), close: async () => new Promise<never>(() => {}) }));
    const running = input(adapter, controller, { ...profile, stop_grace_ms: 10 }); controller.abort(new Error("cancelled"));
    expect(await running).toMatchObject({ status: "cancelled", worker_stop: "unconfirmed" });
  });
  it("cancels a blocked session start and closes its client", async () => {
    let closes = 0; let begun!: () => void; const started = new Promise<void>((resolve) => { begun = resolve; });
    const client = { startSession: async () => { begun(); return new Promise<never>(() => {}); }, close: async () => { closes++; } };
    const controller = new AbortController(); const running = input(new MuseSdkAdapter(starts(client)), controller);
    await started; controller.abort(new Error("cancelled"));
    expect((await running).status).toBe("cancelled"); expect(closes).toBe(1);
  });
  for (const rejectIterator of [false, true]) it(`settles output draining after cancellation (reject=${rejectIterator})`, async () => {
    let close!: () => void; const closed = new Promise<void>((resolve) => { close = resolve; });
    let begun!: () => void; const started = new Promise<void>((resolve) => { begun = resolve; });
    const turn = { completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }), items: async function* () { begun(); await closed; if (rejectIterator) throw new Error("closed"); } };
    const session = { opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => turn };
    const controller = new AbortController(); const adapter = new MuseSdkAdapter(starts({ startSession: async () => session, close: async () => { close(); } }));
    const unhandled: unknown[] = []; const handler = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", handler);
    try {
      const running = input(adapter, controller); await started; controller.abort(new Error("cancelled"));
      expect((await running).status).toBe("cancelled"); await new Promise((resolve) => setImmediate(resolve)); expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", handler); }
  });
});
