import { expect, it } from "vitest";
import { parseWorkerMessage, finalReport } from "../../src/agents/report.js";
it("only explicit final dispositions supply worker-reported checks", () => {
  const message = parseWorkerMessage('PASSEUR_MESSAGE {"schema_version":2,"kind":"final","summary":"done","assessment":"met","blockers":[],"questions":[],"checks":[{"command":"unit-test","cwd":"/work","exit_code":0}],"no_changes_reason":"already implemented"}');
  if (message.kind !== "final") throw new Error("Expected final fixture");
  const result = finalReport(message); expect(result.worker_assessment).toBe("met"); expect(result.checks[0]?.evidence).toBe("worker_reported"); expect(result.no_changes_reason).toBe("already implemented");
});
it("an explicit question or blocker is not a completed assignment", () => {
  expect(parseWorkerMessage('PASSEUR_MESSAGE {"schema_version":2,"kind":"input_required","question":"Which format?"}').kind).toBe("input_required");
  expect(parseWorkerMessage('PASSEUR_MESSAGE {"schema_version":2,"kind":"blocked","reason":"Required dependency absent"}').kind).toBe("blocked");
});
it("old, malformed, and ambiguous turn output supplies no final disposition", () => {
  for (const text of ["done", "not structured", 'PASSEUR_RESULT {"summary":"done"}', 'PASSEUR_MESSAGE {"schema_version":2,"kind":"final"}']) expect(() => parseWorkerMessage(text)).toThrowError(expect.objectContaining({ code: "WORKER_MESSAGE_INVALID" }));
});
