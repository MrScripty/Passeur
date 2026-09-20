import type { WorkerRun } from "./types.js";
export function parseWorkerReport(text: string | undefined, workspace: string): Pick<WorkerRun, "summary" | "worker_assessment" | "blockers" | "questions" | "checks" | "no_changes_reason"> {
  const fallback = { summary: text ?? "No worker report was returned", worker_assessment: "unknown" as const, blockers: [] as string[], questions: [] as string[], checks: [] as WorkerRun["checks"] };
  const marker = text?.match(/MUSE_BRIDGE_RESULT\s*(\{[\s\S]*\})\s*$/);
  if (!marker?.[1]) return fallback;
  try {
    const value = JSON.parse(marker[1]) as Record<string, unknown>;
    const assessment = ["met", "partial", "unmet", "unknown"].includes(String(value.assessment)) ? value.assessment as WorkerRun["worker_assessment"] : "unknown";
    const strings = (item: unknown) => Array.isArray(item) ? item.filter((part): part is string => typeof part === "string").slice(0, 50).map((part) => part.slice(0, 2048)) : [];
    return {
      summary: typeof value.summary === "string" ? value.summary.slice(0, 16_384) : fallback.summary,
      worker_assessment: assessment, blockers: strings(value.blockers), questions: strings(value.questions),
      ...(typeof value.no_changes_reason === "string" && value.no_changes_reason.trim() ? { no_changes_reason: value.no_changes_reason.trim().slice(0, 2048) } : {}),
      checks: Array.isArray(value.checks) ? value.checks.slice(0, 100).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const check = item as Record<string, unknown>;
        if (typeof check.command !== "string") return [];
        return [{ command: check.command.slice(0, 4096), cwd: typeof check.cwd === "string" ? check.cwd.slice(0, 4096) : workspace,
          exit_code: typeof check.exit_code === "number" && Number.isSafeInteger(check.exit_code) ? check.exit_code : null, evidence: "worker_reported" as const }];
      }) : [],
    };
  } catch { return fallback; }
}
