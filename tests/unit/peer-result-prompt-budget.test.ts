import { describe, expect, it } from "vitest";
import { peerOperationResultPrompt } from "../../src/agents/report-format.js";
import { peerResolutionDigest, PEER_RESOLUTION_ACTIONS } from "../../src/coordination/peer-resolution.js";
import type { PeerWorkerOperationResult } from "../../src/contracts/peer-operations.js";

describe("peer current result continuation budget", () => {
  it("drops only optional selected work excerpts when a valid near-limit proposal fills the wrapper", () => {
    const taskIds = [1, 2, 3].map(number => `${String(number).repeat(8)}-${String(number).repeat(4)}-4${String(number).repeat(3)}-8${String(number).repeat(3)}-${String(number).repeat(12)}`);
    const caseId = "44444444-4444-4444-8444-444444444444";
    const changes = ["src/a.ts", "src/b.ts"].map(path => ({ path, before_sha256: null,
      after_base64: Buffer.alloc(4_500, path === "src/a.ts" ? 65 : 66).toString("base64") }));
    const summary = "Combine both worker results";
    const proposal = { schema_version: 2 as const, kind: "peer_resolution_proposal" as const,
      case_id: caseId, case_revision: 1, case_generation: 1, proposal_revision: 1,
      evidence_id: "a".repeat(64), evidence_revision: 1,
      participants: ["b".repeat(64), "c".repeat(64), "d".repeat(64)],
      sources: taskIds.map((work_id, index) => ({ work_id, work_revision: 1,
        input_oid: "e".repeat(40), selected_commit_oid: String(index + 1).repeat(40) })),
      scope: [{ kind: "subtree" as const, path: "src" }], action: "propose" as const,
      resolution_digest: peerResolutionDigest(summary, changes), predecessor_digest: null,
      permitted_actions: [...PEER_RESOLUTION_ACTIONS], summary, changes };
    const selectedContext = taskIds.map((task_id, index) => ({ task_id, work_id: task_id,
      intent_excerpt: `${index}:${"i".repeat(250)}`, intent_truncated: true,
      declared_areas: [0, 1, 2, 3].map(number => ({ kind: "file" as const,
        path: `src/${String(index)}${String(number)}${"x".repeat(495)}` })), areas_omitted: 0 }));
    const result: PeerWorkerOperationResult = { schema_version: 1, task_id: taskIds[0]!,
      run_id: "55555555-5555-4555-8555-555555555555", control_generation: 1,
      workspace_id: "git-worktree-v1:" + "f".repeat(64), source_view: "/source",
      case_id: caseId, operation_key: "inspect-budget", kind: "current", operation: "inspect",
      case_revision: 1, case_generation: 1, evidence_status: "current", evidence_id: proposal.evidence_id, evidence_revision: 1,
      negotiation_cursor: "9".repeat(64), proposal_note_id: "66666666-6666-4666-8666-666666666666",
      proposal, participant_task_ids: taskIds, acknowledged_task_ids: [], first_proposal: null,
      application_outcome: null, selected_work_context: selectedContext, selected_work_omitted: 0 };
    const prompt = peerOperationResultPrompt(taskIds[0]!,
      { schema_version: 1, operation_key: "inspect-budget", case_id: caseId, kind: "inspect" }, result);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(24_576);
    const start = prompt.indexOf("Peer operation result: ") + "Peer operation result: ".length;
    const end = prompt.indexOf("\nPeer proposal summary:", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const presented = JSON.parse(prompt.slice(start, end));
    expect(presented.proposal).toEqual(proposal);
    expect(presented.selected_work_context.length).toBeLessThan(selectedContext.length);
    expect(presented.selected_work_context).toEqual(selectedContext.slice(0, presented.selected_work_context.length));
    expect(presented.selected_work_omitted).toBe(selectedContext.length - presented.selected_work_context.length);
    expect(presented.participant_task_ids).toEqual(taskIds);
  });
});
