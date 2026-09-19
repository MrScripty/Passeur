import { describe, expect, it } from "vitest";
import { transition, type TaskState } from "../../src/core/state.js";

describe("task state reducer", () => {
  const accepted: TaskState = { phase: "accepted", updated_at: "2026-01-01T00:00:00Z" };
  it("allows the lifecycle and one terminal outcome", () => {
    const preparing = transition(accepted, "preparing");
    const running = transition(preparing, "running");
    const finalizing = transition(running, "finalizing");
    expect(transition(finalizing, "terminal", { outcome: "completed" }).outcome).toBe("completed");
  });
  it("rejects invalid and unterminated transitions", () => {
    expect(() => transition(accepted, "running")).toThrow(/Invalid/);
    expect(() => transition(transition(accepted, "finalizing"), "terminal")).toThrow(/requires/);
  });
});
