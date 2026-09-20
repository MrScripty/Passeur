import { expect, it } from "vitest";
import { ApprovalQueue, nativeApprovalHandler } from "../../src/approvals/native.js";
import { deferred } from "../fixtures/bridge.js";
it("serializes human prompts and keeps task identity and decisions distinct", async () => {
  const first = deferred(), entered = deferred(); const messages: string[] = [];
  const handler = nativeApprovalHandler({ elicitInput: async (params) => {
    messages.push(params.message); if (messages.length === 1) { entered.resolve(); await first.promise; }
    return { action: "accept" as const, content: { decision: "deny" } };
  } }, () => 10_000, new ApprovalQueue());
  const request = { id: "vendor", tool: "shell", raw_args: "echo fixture", subject: {}, choices: [{ id: "deny", label: "Deny", decision: "denied", scope: "once" }] };
  const a = handler({ ...request, task_id: "a", workspace: "/a" }, new AbortController().signal);
  await entered.promise;
  const b = handler({ ...request, task_id: "b", workspace: "/b" }, new AbortController().signal);
  await Promise.resolve(); expect(messages).toHaveLength(1); first.resolve(); await Promise.all([a, b]);
  expect(messages[0]).toContain("Task: a"); expect(messages[1]).toContain("Task: b");
});
it("does not authorize a dismissed approval", async () => {
  const handler = nativeApprovalHandler({ elicitInput: async () => ({ action: "cancel" as const }) }, () => 1000);
  await expect(handler({ id: "id", tool: "shell", raw_args: "fixture", subject: {}, choices: [{ id: "allow", label: "Allow", decision: "approved", scope: "once" }] }, new AbortController().signal)).rejects.toThrow(/declined|dismissed/);
});
