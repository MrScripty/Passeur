import type { Assignment, AgentResult } from "../contracts/agents.js";
import type { TaskStore } from "../store/task-store.js";
import { canonicalHash } from "./async.js";
import { BridgeError } from "./errors.js";
/** Shared retry semantics. Neither a current registration nor a live provider owns historical identity. */
export type PriorTask = { kind: "absent" } | { kind: "pending"; task_id: string } | { kind: "complete"; result: AgentResult };
export async function lookupPriorTask(store: TaskStore, request: Assignment): Promise<PriorTask> {
  const prior = await store.find({ request_key: request.request_key });
  if (!prior) return { kind: "absent" };
  if ("schema_version" in prior) throw new BridgeError("TASK_API_UPGRADE_REQUIRED", "This key belongs to durable execution; use task observations");
  if (prior.request.schema_version !== 3) throw new BridgeError("LEGACY_REQUEST_KEY", "Read this historical task through passeur_result; use a new key for a new assignment");
  if (prior.canonical_hash !== canonicalHash(request)) throw new BridgeError("REQUEST_KEY_CONFLICT", "The key belongs to a different assignment");
  const result = await store.readResult(prior.task_id);
  if (!result) return { kind: "pending", task_id: prior.task_id };
  if (result.schema_version !== 3) throw new BridgeError("STORE_CORRUPT", "Task and result contract versions disagree");
  return { kind: "complete", result };
}

export function terminalPriorTask(prior: PriorTask): AgentResult | undefined {
  if (prior.kind === "pending") throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", "The admitted task lacks terminal evidence; prepare or reconcile it without replaying inference");
  return prior.kind === "complete" ? prior.result : undefined;
}
export async function priorTaskResult(store: TaskStore, request: Assignment): Promise<AgentResult | undefined> {
  return terminalPriorTask(await lookupPriorTask(store, request));
}
