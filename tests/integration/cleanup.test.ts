import { expect, it } from "vitest";
import { cleanupTask } from "../../src/core/cleanup.js";
import { fixture, completed, context } from "../fixtures/bridge.js";
it("collects bulky review evidence while retaining immutable identity and result", async () => {
  const f = await fixture(); const coordinator = f.coordinator({ run: async () => completed() });
  try {
    const result = await coordinator.delegate(f.request("review"), context());
    await cleanupTask({ store: f.store, taskId: result.task_id });
    expect(await f.store.find({ task_id: result.task_id })).toBeDefined(); expect(await f.store.readResult(result.task_id)).toBeDefined();
    expect((await f.store.readResource(result.task_id))?.artifacts_collected_at).toBeDefined();
  } finally { await coordinator.shutdown(); await f.dispose(); }
});
it("refuses record-only cleanup while a task worktree still awaits disposition", async () => {
  const f = await fixture(); const coordinator = f.coordinator({ run: async () => ({ ...completed(), no_changes_reason: "nothing to change" }) });
  try {
    const result = await coordinator.delegate(f.request("pending", "implement"), context());
    await expect(cleanupTask({ store: f.store, taskId: result.task_id })).rejects.toMatchObject({ code: "RESOURCE_DISPOSITION_REQUIRED" });
  } finally { await coordinator.shutdown(); await f.dispose(); }
});
