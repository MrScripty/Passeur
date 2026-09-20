import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApprovalHandler } from "../muse/types.js";
import { Mutex, throwIfAborted, withAbort } from "../core/async.js";

/** One arbiter per MCP connection. It serializes human prompts, not worker execution. */
export class ApprovalQueue {
  #mutex = new Mutex();
  run<T>(signal: AbortSignal, prompt: () => Promise<T>): Promise<T> {
    return withAbort(this.#mutex.run(async () => { throwIfAborted(signal); return withAbort(prompt(), signal); }), signal);
  }
}
export function nativeApprovalHandler(server: Pick<Server, "elicitInput">, timeoutMs: () => number, queue = new ApprovalQueue()): ApprovalHandler {
  return async (request, signal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Approval expired")), Math.max(1, Math.min(300_000, timeoutMs())));
    try {
      return await queue.run(controller.signal, async () => {
        const once = request.choices.filter((choice) => choice.scope === "once" || choice.decision.startsWith("denied"));
        const choices = once.length ? once : request.choices;
        const result = await server.elicitInput({
          mode: "form",
          message: `Muse requests permission\nTask: ${request.task_id ?? "unknown"}\nWorkspace: ${request.workspace ?? "unknown"}\nRequest: ${request.id}\nTool: ${request.tool}\nOperation: ${request.raw_args}\nScope: ${JSON.stringify(request.subject)}`,
          requestedSchema: { type: "object", properties: {
            decision: { type: "string", title: "Decision", oneOf: choices.map((choice) => ({ const: choice.id, title: `${choice.label} (${choice.scope})` })) },
          }, required: ["decision"] },
        }, { signal: controller.signal });
        throwIfAborted(controller.signal);
        if (result.action !== "accept" || typeof result.content?.decision !== "string" || !choices.some((choice) => choice.id === result.content!.decision)) throw new Error("Approval declined, dismissed, expired, or invalid");
        return { choice_id: result.content.decision };
      });
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  };
}
