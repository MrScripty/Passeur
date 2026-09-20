import { expect, it } from "vitest";
import { reconcileStoredTasks } from "../../src/core/recovery.js";
import { fixture, completed, context } from "../fixtures/bridge.js";
it("recovers terminal state from an already-saved result without replay", async () => {
  const f = await fixture(); let runs = 0; const coordinator = f.coordinator({ run: async () => { runs++; return completed(); } });
  try {
    const result = await coordinator.delegate(f.request("recover"), context());
    await f.store.writeState(result.task_id, { phase: "finalizing", updated_at: new Date().toISOString() });
    await reconcileStoredTasks(f.store, "model");
    expect((await f.store.readState(result.task_id)).phase).toBe("terminal"); expect(runs).toBe(1);
  } finally { await coordinator.shutdown(); await f.dispose(); }
});
