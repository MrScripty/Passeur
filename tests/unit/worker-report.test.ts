import { expect, it } from "vitest";
import { parseWorkerReport } from "../../src/muse/report.js";
it("labels parsed checks as worker claims, not independently proven compliance", () => {
  const result = parseWorkerReport('MUSE_BRIDGE_RESULT {"summary":"done","assessment":"met","checks":[{"command":"unit-test","exit_code":0}],"no_changes_reason":"already implemented"}', "/work");
  expect(result.worker_assessment).toBe("met"); expect(result.checks[0]?.evidence).toBe("worker_reported");
  expect(result.no_changes_reason).toBe("already implemented");
});
it("keeps malformed reports unknown without a repair model call", () => {
  expect(parseWorkerReport("not structured", "/work").worker_assessment).toBe("unknown");
});
