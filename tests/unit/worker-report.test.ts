import { expect, it } from "vitest";
import { parseWorkerReport } from "../../src/agents/report.js";
it("labels parsed checks as worker claims, not independently proven compliance", () => {
  const result = parseWorkerReport('PASSEUR_RESULT {"summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[{"command":"unit-test","cwd":"/work","exit_code":0}],"no_changes_reason":"already implemented"}');
  expect(result.worker_assessment).toBe("met"); expect(result.checks[0]?.evidence).toBe("worker_reported");
  expect(result.no_changes_reason).toBe("already implemented");
});
it("keeps malformed reports unknown without a repair model call", () => {
  expect(() => parseWorkerReport("not structured")).toThrowError(expect.objectContaining({ code: "WORKER_REPORT_INVALID" }));
});
