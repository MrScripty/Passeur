import { describe, expect, it } from "vitest";
import { MuseSdkAdapter } from "../../src/muse/adapter.js";
import { BridgeError } from "../../src/core/errors.js";
import type { WorkerInput } from "../../src/agents/types.js";
import type { MuseOptions } from "../../src/muse/config.js";

const caseId = "55555555-5555-4555-8555-555555555555";
const options: MuseOptions = { muse_bin: "muse", model: "model",
  review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
  implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed" } };
const change = { path: "src/combined.ts", before_sha256: null, after_base64: "YQ==" };
const proposal = { schema_version: 2, kind: "peer_resolution_proposal", case_id: caseId,
  case_revision: 1, case_generation: 1, proposal_revision: 1, evidence_id: "a".repeat(64), evidence_revision: 1,
  participants: ["b".repeat(64)], sources: [{ work_id: "44444444-4444-4444-8444-444444444444",
    work_revision: 1, input_oid: "c".repeat(40), selected_commit_oid: "d".repeat(40) }],
  scope: [{ kind: "file", path: "src/combined.ts" }], action: "propose", predecessor_digest: null,
  permitted_actions: ["inspect_evidence", "propose", "counter_propose", "acknowledge", "apply", "verify"],
  summary: "Combine the selected changes", changes: [change] };
const message = (proposalValue: unknown) => `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "peer_operation",
  operation: { schema_version: 1, operation_key: "proposal-1", case_id: caseId, kind: "propose", proposal: proposalValue } })}`;
const final = `PASSEUR_MESSAGE ${JSON.stringify({ schema_version: 2, kind: "final", summary: "done",
  assessment: "met", blockers: [], questions: [], checks: [] })}`;

async function run(messages: string[], operation: NonNullable<NonNullable<WorkerInput["peer"]>["operation"]>) {
  const prompts: string[] = [];
  let sessions = 0, humanInputs = 0;
  const session = { sessionId: "same-session", opening: { result: { session: { modelId: "model" } } },
    fold: { current: true, items: { list: () => [], isTerminalUnknown: () => false } },
    onApproval() {}, onApprovalError() {},
    sendUserTurn: async ({ input }: { input: Array<{ text: string }> }) => {
      prompts.push(input[0]!.text);
      const text = messages[Math.min(prompts.length - 1, messages.length - 1)]!;
      return { turnId: `turn-${prompts.length}`,
        completed: Promise.resolve({ kind: "completed", params: { terminal: "completed" } }),
        items: async function* () { yield { kind: "agentMessage", text }; } };
    } };
  const adapter = new MuseSdkAdapter(options, () => ({
    ready: Promise.resolve({ startSession: async () => { sessions++; return session; }, close: async () => {} } as never),
    close: async () => {},
  }));
  const result = await adapter.run({ task_id: "22222222-2222-4222-8222-222222222222", workspace: "/work",
    prompt: "Original assignment", request: { schema_version: 3, agent_id: "muse", request_key: "feedback",
      mode: "review", objective: "Resolve peer proposal", context: "", acceptance_criteria: ["Explicit result"] },
    policy: { implementation: { enabled: false }, max_workers: 2, max_queued_tasks: 8, max_clients: 32,
      max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, stop_grace_ms: 1000 },
    signal: new AbortController().signal, approve: async () => { throw Error("Unexpected approval"); },
    input: async () => { humanInputs++; throw Error("Unexpected human input"); },
    onEvent: async () => {}, peer: { next: async () => undefined, delivered: async () => {},
      observed: async () => {}, operation } });
  return { result, prompts, sessions, humanInputs };
}

describe("Muse peer proposal correction", () => {
  it("returns a malformed proposal to the same session and accepts its corrected request", async () => {
    const operations: string[] = [];
    const malformed = { ...proposal, changes: [{ path: change.path, before_sha256: null }] };
    const observed = await run([message(malformed), message(proposal), final], async request => {
      operations.push(request.kind);
      if (request.kind !== "propose") throw Error("Unexpected operation");
      expect(request.proposal.resolution_digest).toMatch(/^[a-f0-9]{64}$/);
      return { schema_version: 1, task_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333", control_generation: 1,
        workspace_id: "workspace", source_view: "/source", case_id: caseId,
        operation_key: request.operation_key, kind: "receipt", operation: "propose",
        receipt_revision: 2, note_id: "77777777-7777-4777-8777-777777777777" };
    });
    expect(observed.result.status).toBe("completed");
    expect(observed.sessions).toBe(1);
    expect(observed.humanInputs).toBe(0);
    expect(observed.prompts).toHaveLength(3);
    expect(observed.prompts[1]).toContain("could not accept the propose request");
    expect(observed.prompts[1]).toContain("Inspect the current case before retrying");
    expect(operations).toEqual(["propose"]);
  });

  it("counts rejected proposal turns against the existing operation limit", async () => {
    let calls = 0;
    const malformed = { ...proposal, changes: [{ path: change.path }] };
    const observed = await run([message(malformed)], async () => { calls++; throw Error("Should not reach operation port"); });
    expect(observed.result).toMatchObject({ status: "failed", error: { code: "PEER_OPERATION_CAPACITY" } });
    expect(observed.prompts).toHaveLength(65);
    expect(observed.sessions).toBe(1);
    expect(observed.humanInputs).toBe(0);
    expect(calls).toBe(0);
  });

  it("keeps authority failure terminal", async () => {
    const observed = await run([message(proposal), final], async () => {
      throw new BridgeError("PEER_OPERATION_FORBIDDEN", "Selected source grant was revoked");
    });
    expect(observed.result).toMatchObject({ status: "failed", error: { code: "PEER_OPERATION_FORBIDDEN" } });
    expect(observed.prompts).toHaveLength(1);
    expect(observed.humanInputs).toBe(0);
  });
});
