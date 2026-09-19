import { describe, expect, it } from "vitest";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import type { DelegateRequest, Profile } from "../../src/contracts/index.js";

const request: DelegateRequest = { schema_version: 1, request_key: "cancel", mode: "review", objective: "Review", context: "Context", acceptance_criteria: ["Done"] };
const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: false, sandbox_network: "restricted" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed" } };

describe("MuseSdkAdapter lifecycle", () => {
  it("settles a rejecting item iterator after cancellation without an unhandled rejection", async () => {
    let close!: () => void; const closed = new Promise<void>((resolve) => { close = resolve; });
    const turn = { turnId: "turn", observedStart: true, completed: new Promise<never>(() => {}), items: async function* () { await closed; throw new Error("iterator closed"); }, deltas: async function* () {} };
    let markStarted!: () => void; const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const session = { opening: { result: { session: { modelId: "model" } } }, onApproval() {}, onApprovalError() {}, sendUserTurn: async () => { markStarted(); return turn; } };
    const client = { startSession: async () => session, close: async () => { close(); } };
    const adapter = new MuseSdkAdapter(async () => client as never); const controller = new AbortController();
    const unhandled: unknown[] = []; const handler = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", handler);
    try {
      const running = adapter.run({ request, profile, workspace: "/work", prompt: "prompt", signal: controller.signal, approve: async () => ({ choice_id: "deny" }), onEvent: async () => {} });
      await started; controller.abort(new Error("cancelled")); const result = await running; await new Promise((resolve) => setImmediate(resolve));
      expect(result.status).toBe("cancelled"); expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", handler); }
  });
});
