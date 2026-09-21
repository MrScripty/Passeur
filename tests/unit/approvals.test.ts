import { expect, it } from "vitest";
import { ApprovalQueue } from "../../src/approvals/native.js";
import { deferred } from "../fixtures/bridge.js";
it("serializes presentations within a client without a task timeout", async () => {
  const gate = deferred(), entered = deferred(), order: string[] = [], queue = new ApprovalQueue();
  const a = queue.run(new AbortController().signal, async () => { order.push("a"); entered.resolve(); await gate.promise; return "deny"; });
  await entered.promise;
  const b = queue.run(new AbortController().signal, async () => { order.push("b"); return "allow"; });
  await Promise.resolve(); expect(order).toEqual(["a"]); gate.resolve();
  expect(await Promise.all([a, b])).toEqual(["deny", "allow"]); expect(order).toEqual(["a", "b"]);
});
it("presentation cancellation releases the queue without deciding the task's permission", async () => {
  const queue = new ApprovalQueue(), controller = new AbortController(), entered = deferred(); let nativeDecision: string | undefined;
  const wait = queue.run(controller.signal, async () => { entered.resolve(); return new Promise<string>(() => {}); });
  await entered.promise; controller.abort(new Error("presentation closed")); await expect(wait).rejects.toThrow("presentation closed");
  expect(await queue.run(new AbortController().signal, async () => "new presentation")).toBe("new presentation");
  expect(nativeDecision).toBeUndefined();
});
