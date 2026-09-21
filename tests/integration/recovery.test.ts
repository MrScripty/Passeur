import { expect, it } from "vitest";
import { reconcileStoredTasks } from "../../src/core/recovery.js";
import { fixture, completed, context } from "../fixtures/bridge.js";
it("recovers terminal state from an already-saved result without replay", async () => {
  const f = await fixture(); let runs = 0; const coordinator = f.coordinator({ run: async () => { runs++; return completed(); } });
  try {
    const result = await coordinator.execute(f.request("recover"), context());
    const interrupted = await f.store.readControl(result.task_id); interrupted.phase = "finalizing"; delete interrupted.outcome;
    await f.store.writeControl(result.task_id, interrupted);
    await reconcileStoredTasks(f.store);
    expect((await f.store.readState(result.task_id)).phase).toBe("terminal"); expect(runs).toBe(1);
  } finally { await coordinator.shutdown(); await f.dispose(); }
});
