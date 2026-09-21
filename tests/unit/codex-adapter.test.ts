import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/agents/codex/adapter.js";
import type { CodexOptions } from "../../src/agents/codex/config.js";
import type { WorkerInput } from "../../src/agents/types.js";
import { cancellationConformance } from "../fixtures/adapter-conformance.js";

const input: Omit<WorkerInput, "signal"> = {
  task_id: "codex-conformance", workspace: "/unused/pre-cancelled", prompt: "Bounded fixture assignment",
  request: { schema_version: 3, agent_id: "codex-worker", request_key: "codex-test", mode: "implement", objective: "Fixture",
    context: "", acceptance_criteria: ["Fixture report"], base_commit: "a".repeat(40), target_ref: "refs/heads/main" },
  policy: { implementation: { enabled: true }, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, stop_grace_ms: 1_000 },
  approve: async () => ({ choice_id: "decline" }), input: async () => { throw new Error("Unexpected clarification in this fixture"); }, onEvent: async () => {},
};
const options: CodexOptions = { codex_bin: "/missing/codex", codex_home: "/unused/pre-cancelled-home", model: "fixture-model",
  network_access: false, allow_command_escalation: false, subscription_confirmed: true, experimental_opt_in: true };
cancellationConformance("Codex", () => new CodexAdapter(options), input);

describe.runIf(process.platform === "linux")("Codex adapter through an actual controlled stdio process", () => {
  async function scenario(name: string, action: (adapter: CodexAdapter, run: WorkerInput, home: string, control: AbortController) => Promise<void>, escalate = false) {
    const temporary = await mkdtemp(join(tmpdir(), "passeur-codex-contract-"));
    const home = join(temporary, "worker-home"), workspace = join(temporary, "repo"), bin = join(temporary, "app-server.mjs");
    const control = new AbortController();
    try {
      await mkdir(home); await mkdir(workspace); await writeFile(join(home, "fixture-scenario"), name);
      await copyFile(fileURLToPath(new URL("../fixtures/codex/agent-server.mjs", import.meta.url)), bin); await chmod(bin, 0o700);
      await action(new CodexAdapter({ ...options, codex_bin: bin, codex_home: home, allow_command_escalation: escalate }),
        { ...input, workspace, signal: control.signal }, home, control);
    } finally { control.abort(); await rm(temporary, { recursive: true, force: true }); }
  }
  it("preserves outgoing native spelling and correlates early events through completion", async () => {
    await scenario("success", async (adapter, run) => {
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed", reported_model: "fixture-model", worker_assessment: "met" });
    });
  });
  for (const [name, status, code] of [
    ["api-key", "blocked", "CODEX_AUTH_UNAVAILABLE"],
    ["recursive", "blocked", "CODEX_ISOLATION_UNAVAILABLE"], ["wrong-model", "blocked", "CODEX_CONFIGURATION_MISMATCH"],
  ] as const) it(`${name} preserves a distinct failure without provider fallback`, async () => {
    await scenario(name, async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status, worker_stop: "confirmed", error: { code } }));
  });
  for (const name of ["bad-report", "question"]) it(`${name} waits for explicit input and continues the same native session`, async () => {
    await scenario(name, async (adapter, run, home) => {
      let asked=0; run.input=async(question,attention)=>{asked++;expect(question.length).toBeGreaterThan(0);expect(attention??false).toBe(name==="bad-report");return "Continue using JSON";};
      expect(await adapter.run(run)).toMatchObject({status:"completed",worker_stop:"confirmed"}); expect(asked).toBe(1);expect(await readFile(join(home,"fixture-turns"),"utf8")).toBe("2");
    });
  });
  it("does not close a successful turn before known background work settles", async () => {
    await scenario("pending-item",async(adapter,run,home)=>{
      expect(await adapter.run(run)).toMatchObject({status:"completed",worker_stop:"confirmed"});
      expect(await readFile(join(home,"background-settled"),"utf8")).toBe("yes");
    });
  });
  it("native failure cannot be converted to success by the agent report", async () => {
    await scenario("native-failure", async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status: "failed", worker_stop: "confirmed" }));
  });
  it("default policy denies command escalation without asking the worker or human", async () => {
    await scenario("approval", async (adapter, run, home) => {
      run.approve = async () => { throw new Error("No escalation permission was configured"); };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_assessment: "unmet", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("decline");
    });
  });
  it("an explicitly enabled command escalation still requires this exact human decision", async () => {
    await scenario("approval", async (adapter, run, home) => {
      run.approve = async (request) => {
        expect(request.id).toBe("codex:string:approval-fixture"); expect(request.workspace).toBe(run.workspace);
        expect(request.choices.map((choice) => choice.scope)).toEqual(["once", "once"]); return { choice_id: "accept" };
      };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("accept");
    }, true);
  });
  it("persistent policy amendment is refused even when one-operation escalation is enabled", async () => {
    await scenario("amendment", async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status: "failed", error: { code: "CODEX_APPROVAL_UNSUPPORTED" } }), true);
  });
  it("owner cancellation interrupts the turn and observes the actual peer close", async () => {
    await scenario("cancel", async (adapter, run, _home, controller) => {
      run.onEvent = async () => { controller.abort(new Error("Owner cancelled the fixture")); };
      expect(await adapter.run(run)).toMatchObject({ status: "cancelled", worker_stop: "confirmed" });
    });
  });
});
