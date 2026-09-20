import { expect, it } from "vitest";
import { fixture, completed, context, deferred } from "../fixtures/bridge.js";
it("uses the same worker for matching concurrent requests and rejects changed content", async () => {
  const f = await fixture(), held = deferred(), started = deferred(); let runs = 0;
  const coordinator = f.coordinator({ run: async () => { runs++; started.resolve(); await held.promise; return completed(); } });
  try {
    const a = coordinator.delegate(f.request("key"), context()), b = coordinator.delegate(f.request("key"), context());
    await started.promise;
    await expect(coordinator.delegate({ ...f.request("key"), objective: "Changed" }, context())).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });
    held.resolve(); const [first, second] = await Promise.all([a, b]);
    expect(first.task_id).toBe(second.task_id); expect(runs).toBe(1);
    expect(await f.store.readResult(first.task_id)).toBeDefined();
  } finally { held.resolve(); await coordinator.shutdown(); await f.dispose(); }
});
it("drains every running sibling before declaring shutdown complete", async () => {
  const f = await fixture(); const starts = deferred(); let count = 0;
  const coordinator = f.coordinator({ run: async ({ signal }) => {
    if (++count === 2) starts.resolve(); await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { ...completed(), status: "cancelled" };
  } });
  try {
    const a = coordinator.delegate(f.request("a"), context()), b = coordinator.delegate(f.request("b"), context());
    await starts.promise; await coordinator.shutdown();
    for (const result of await Promise.all([a, b])) expect((await f.store.readState(result.task_id)).phase).toBe("terminal");
  } finally { await coordinator.shutdown(); await f.dispose(); }
});
// Detailed write-failure, deletion, stale-HEAD, compaction and admission regressions
// run in tests/core/* using Node's built-in runner against the same production modules.
