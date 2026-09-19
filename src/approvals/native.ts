import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApprovalHandler } from "../muse/adapter.js";

export function nativeApprovalHandler(server: Server, timeoutMs: () => number): ApprovalHandler {
  return async (request, signal) => {
    const once = request.choices.filter((choice) => choice.scope === "once" || choice.decision.startsWith("denied"));
    const choices = once.length ? once : request.choices;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Approval expired")), Math.min(300_000, timeoutMs()));
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    try {
      const result = await server.elicitInput({
        mode: "form",
        message: `Muse requests permission\nTool: ${request.tool}\nOperation: ${request.raw_args}\nScope: ${JSON.stringify(request.subject)}`,
        requestedSchema: {
          type: "object",
          properties: { decision: { type: "string", title: "Decision", oneOf: choices.map((choice) => ({ const: choice.id, title: `${choice.label} (${choice.scope})` })) } },
          required: ["decision"],
        },
      }, { signal: controller.signal });
      if (result.action !== "accept" || typeof result.content?.decision !== "string" || !choices.some((choice) => choice.id === result.content!.decision)) throw new Error("Approval declined, dismissed, expired, or invalid");
      return { choice_id: result.content.decision };
    } finally { clearTimeout(timer); }
  };
}
