import { describe, expect, it } from "vitest";
import { parseWorkerReport } from "../../src/muse/adapter.js";

describe("parseWorkerReport", () => {
  it("extracts bounded assessment, questions, blockers, and worker-reported checks", () => {
    const report = parseWorkerReport('prefix\nMUSE_BRIDGE_RESULT {"summary":"done","assessment":"partial","blockers":["blocked"],"questions":["which?"],"checks":[{"command":"npm test","cwd":"/work","exit_code":1}]}', "/fallback");
    expect(report).toEqual({ summary: "done", worker_assessment: "partial", blockers: ["blocked"], questions: ["which?"], checks: [{ command: "npm test", cwd: "/work", exit_code: 1, evidence: "worker_reported" }] });
  });
  it("keeps an honest unknown assessment for invalid output", () => { expect(parseWorkerReport("plain report", "/work")).toMatchObject({ summary: "plain report", worker_assessment: "unknown", checks: [] }); });
});
