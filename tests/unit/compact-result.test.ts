import { describe, expect, it } from "vitest";
import type { DelegateResult } from "../../src/contracts/index.js";
import { compactResult } from "../../src/core/coordinator.js";

describe("compactResult", () => {
  it("always returns at most 24 KiB while retaining critical status", () => {
    const result: DelegateResult = { schema_version: 1, task_id: crypto.randomUUID(), request_key: "key", execution_status: "failed", worker_stop: "unconfirmed", worker_assessment: "partial", summary: "x".repeat(100_000), blockers: Array.from({ length: 100 }, () => "b".repeat(4_000)), error: { code: "FAIL", message: "e".repeat(100_000) }, questions: Array.from({ length: 100 }, () => "q".repeat(4_000)), model: { requested: "model" }, workspace: { kind: "task_worktree", stale: true }, changed_files: Array.from({ length: 500 }, (_, index) => `${"p".repeat(200)}/${index}`), checks: Array.from({ length: 100 }, () => ({ command: "c".repeat(1_000), cwd: "/work", exit_code: 1, evidence: "runtime_observed" })), artifacts: [], output_truncated: false };
    const compact = compactResult(result);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(24_576);
    expect(compact.execution_status).toBe("failed"); expect(compact.worker_stop).toBe("unconfirmed"); expect(compact.error?.code).toBe("FAIL");
  });
});
