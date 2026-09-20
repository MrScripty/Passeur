import { expect, it } from "vitest";
import { BridgeError } from "../../src/core/errors.js";
import type { WorkerAdapter, WorkerInput } from "../../src/agents/types.js";

/** Reused invariant, not a new test runner: a cancelled task cannot acquire a runtime. */
export function cancellationConformance(name: string, create: () => WorkerAdapter, input: Omit<WorkerInput, "signal">): void {
  for (const [code, status] of [["OWNER_CANCELLED", "cancelled"], ["TASK_TIMEOUT", "timed_out"]] as const) {
    it(`${name}: ${code} before startup preserves not-started stop evidence`, async () => {
      const controller = new AbortController(); controller.abort(new BridgeError(code, "Controlled pre-start cancellation"));
      const result = await create().run({ ...input, signal: controller.signal });
      expect(result).toMatchObject({ status, worker_stop: "not_started", worker_assessment: "unknown", checks: [] });
    });
  }
}
