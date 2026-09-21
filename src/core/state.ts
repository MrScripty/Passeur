import type { ExecutionStatus } from "../contracts/types.js";
export type TaskPhase = "accepted" | "queued" | "preparing" | "running" | "awaiting_input" | "stopping" | "finalizing" | "terminal";
export type LegacyTaskState = { phase: TaskPhase; outcome?: ExecutionStatus; updated_at: string; reason?: string };
export type TaskState = LegacyTaskState | import("../contracts/tasks.js").TaskControl;
const allowed: Record<TaskPhase, readonly TaskPhase[]> = {
  accepted: ["queued", "preparing", "stopping", "finalizing"],
  queued: ["preparing", "stopping", "finalizing"],
  preparing: ["running", "stopping", "finalizing"],
  running: ["awaiting_input", "stopping", "finalizing"],
  awaiting_input: ["running", "stopping", "finalizing"],
  stopping: ["finalizing"], finalizing: ["terminal"], terminal: [],
};
export function transition(state: LegacyTaskState, phase: TaskPhase, options: { outcome?: ExecutionStatus; reason?: string } = {}): LegacyTaskState {
  if (!allowed[state.phase]?.includes(phase)) throw new Error(`Invalid task transition: ${state.phase} -> ${phase}`);
  if (phase === "terminal" && !options.outcome) throw new Error("A terminal state requires an outcome");
  if (phase !== "terminal" && options.outcome) throw new Error("Only a terminal state may carry an outcome");
  return { phase, updated_at: new Date().toISOString(), ...options };
}
export function validPhase(value: unknown): value is TaskPhase { return typeof value === "string" && Object.hasOwn(allowed, value); }
