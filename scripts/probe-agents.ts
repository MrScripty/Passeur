/** Opt-in installed-runtime system probe. This is never part of ordinary tests and never approves permissions. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeStatusSchema } from "../src/contracts/runtime.js";
import { AgentCatalogSchema, AgentIdSchema, type AgentCatalog } from "../src/contracts/agents.js";
import { loadAgentProfile } from "../src/core/profile.js";
import { canonicalProject, currentRevision, git, repositoryIdentity, sourceStatus } from "../src/workspace/project.js";

if (process.env.PASSEUR_LIVE_AGENTS !== "1") throw new Error("Set PASSEUR_LIVE_AGENTS=1 only after authorizing account use for this disposable probe");
const { values } = parseArgs({ options: {
  project: { type: "string" }, profile: { type: "string" }, runtime: { type: "string" }, "state-root": { type: "string" },
  agents: { type: "string" }, "confirm-disposable": { type: "boolean" },
}, strict: true });
for (const key of ["project", "profile", "runtime", "state-root"] as const) if (!values[key] || !isAbsolute(values[key]!)) throw new Error(`--${key} requires an explicit absolute path`);
if (!values["confirm-disposable"]) throw new Error("--confirm-disposable is required; the probe creates retained Git worktrees and commits");
const agents = z.array(AgentIdSchema).min(2).max(8).parse(values.agents?.split(","));
const project = await canonicalProject(values.project!), profile = await loadAgentProfile(values.profile!);
if (!profile.execution.implementation.enabled || profile.execution.max_workers < 2) throw new Error("The profile must allow implementation with at least two workers");
if ((await sourceStatus(project, true)).length) throw new Error("The disposable repository must be clean");
const base = await currentRevision(project), target = (await git(project, ["symbolic-ref", "HEAD"])).trim();
if (!base) throw new Error("A committed disposable base is required");
const identity = await repositoryIdentity(project);
const client = new Client({ name: "passeur-registered-agent-probe", version: "0.1.0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" as const }));
const transport = new StdioClientTransport({ command: process.execPath, args: [values.runtime!, "serve", "--project", project,
  "--profile", values.profile!, "--state-root", values["state-root"]!, "--expected-repository-id", identity.id], stderr: "inherit" });
const body = (value: unknown): unknown => {
  const envelope = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).length(1), isError: z.boolean().optional() }).passthrough().parse(value);
  if (envelope.isError) throw new Error("The probe operation failed; inspect retained runtime diagnostics");
  return JSON.parse(envelope.content[0]!.text);
};
try {
  await client.connect(transport);
  const status = RuntimeStatusSchema.parse(body(await client.callTool({ name: "passeur_status", arguments: {} })));
  if (status.runtime.mode !== "installed" || status.binding.project_input !== project) throw new Error("This probe requires the exact installed runtime and expected project binding");
  const known = new Map<string, z.output<typeof AgentCatalogSchema>["agents"][number]>();
  let offset: number | null = 0;
  do {
    const page: AgentCatalog = AgentCatalogSchema.parse(body(await client.callTool({ name: "passeur_agents", arguments: { offset, limit: 4 } })));
    for (const agent of page.agents) known.set(agent.agent_id, agent);
    offset = page.next_offset;
  } while (offset !== null);
  for (const id of agents) if (known.get(id)?.state !== "configured" || !known.get(id)!.modes.includes("implement")) throw new Error(`Agent ${id} is not configured for implementation`);
  const label = randomUUID();
  const assignments = agents.map((agent_id, index) => {
    const path = `passeur-agent-probe-${label}-${index}.txt`;
    return { schema_version: 3, agent_id, request_key: `probe-${label}-${index}`, mode: "implement", base_commit: base, target_ref: target,
      objective: `Create ${path} containing ${agent_id}. Verify it and commit that file through ordinary Git.`,
      context: "Explicitly authorized disposable system probe. Preserve repository instructions, hooks, signing and permissions. Report blockers rather than bypassing them.",
      acceptance_criteria: ["Only the named file changes", "Actual file contents are checked", "An ordinary commit is created"], allowed_paths: [path] };
  });
  const response = await client.callTool({ name: "passeur_delegate_batch", arguments: { schema_version: 3, assignments } }, undefined,
    { timeout: profile.execution.task_timeout_ms + profile.execution.stop_grace_ms + 60_000 });
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), runtime: status.runtime, repository_id: identity.id, agents, response }, null, 2));
  if (response.isError) process.exitCode = 1;
  console.error("This probe never grants human approvals, integrates commits, deletes worktrees, or certifies billing/native permissions. Inspect retained tasks and explicitly account for their resources. Actual host attachment and human approval require separate operator evidence.");
} finally { await client.close(); }
