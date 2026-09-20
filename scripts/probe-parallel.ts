/** Opt-in, subscription-backed smoke. Never runs in ordinary tests. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { loadProfile } from "../src/core/profile.js";
import { canonicalProject, currentRevision, git, sourceStatus } from "../src/workspace/project.js";
if (process.env.MUSE_BRIDGE_LIVE !== "1") throw new Error("Set MUSE_BRIDGE_LIVE=1 after verifying the subscription credential path");
const { values } = parseArgs({ options: { project: { type: "string" }, profile: { type: "string" }, "confirm-disposable": { type: "boolean" } }, strict: true });
if (!values.project || !values.profile || !values["confirm-disposable"] || !isAbsolute(values.project) || !isAbsolute(values.profile)) throw new Error("Use --project /absolute/disposable/repo --profile /absolute/profile.json --confirm-disposable");
const project = await canonicalProject(values.project), profile = await loadProfile(values.profile);
if (!profile.implementation.enabled || (profile.max_workers ?? 2) < 2) throw new Error("The profile must allow implementation and at least two workers");
if ((await sourceStatus(project, true)).length) throw new Error("The disposable source repository must be clean");
const base = await currentRevision(project), target = (await git(project, ["symbolic-ref", "HEAD"])).trim();
if (!base) throw new Error("A committed base is required");
const client = new Client({ name: "passeur-parallel-probe", version: "0.1.0" }, { capabilities: { elicitation: {} } });
// Noninteractive smoke: no prompt may silently grant permission. Exercise human approvals separately in Codex.
client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" as const }));
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "serve", "--project", project, "--profile", values.profile], stderr: "inherit" });
try {
  await client.connect(transport);
  const label = Date.now();
  const assignments = ["a", "b"].map((name) => ({ schema_version: 2, request_key: `live-${label}-${name}`, mode: "implement",
    base_commit: base, target_ref: target, objective: `Create passeur-probe-${name}.txt containing the word ${name}, then commit this single file through ordinary Git.`,
    context: "This is a disposable parallel-workflow smoke. Read the repository instructions. Verify this file's contents; do not run a full application suite or bypass hooks. Report blockers rather than changing permission policy.",
    acceptance_criteria: ["Only the named file changes", "The file contents are checked", "An ordinary standards-compliant commit is created"], allowed_paths: [`passeur-probe-${name}.txt`] }));
  const result = await client.callTool({ name: "delegate_to_muse_batch", arguments: { schema_version: 2, assignments } }, undefined, { timeout: profile.task_timeout_ms + profile.stop_grace_ms + 60_000 });
  console.log(JSON.stringify({ at: new Date().toISOString(), source: project, requested_model: profile.model, result }, null, 2));
  console.error("This smoke does not certify billing, backend concurrency, sandbox enforcement, or human approval behavior. Inspect both retained task records. Integrate/archive and retire their resources explicitly; the probe does not merge or delete them.");
} finally { await client.close(); }
