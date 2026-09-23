/** Prepare an SC15 repository and exact installed-host launch arguments without starting agents. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify, parseArgs } from "node:util";
import * as TOML from "smol-toml";
import { CODEX_ENABLED_TOOLS } from "../src/codex/config.js";
import { installedEntry } from "../src/install/runtime.js";
import { AssignmentSchema } from "../src/contracts/agents.js";
import { CoordinatedSubmitSchema } from "../src/contracts/service.js";
import { repositoryIdentity } from "../src/workspace/project.js";
import { SharedProfileSchema } from "../src/contracts/tasks.js";

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  output: { type: "string" }, installed: { type: "string" },
  "muse-model": { type: "string" }, "codex-model": { type: "string" },
  "muse-bin": { type: "string" }, "codex-bin": { type: "string" },
}, strict: true });
for (const key of ["output", "installed"] as const) {
  if (!values[key] || !isAbsolute(values[key]!)) throw new Error(`--${key} requires an absolute path`);
}
for (const key of ["muse-model", "codex-model"] as const) {
  if (!values[key] || !/^[A-Za-z0-9][A-Za-z0-9._:./-]{0,255}$/.test(values[key]!)) throw new Error(`--${key} requires an exact model ID`);
}
const output = resolve(values.output!), installed = await installedEntry(values.installed!);
if (output === installed.root || output.startsWith(`${installed.root}/`)) throw new Error("Fixture output must be outside the installed runtime");
const museBin = values["muse-bin"], codexBin = values["codex-bin"] ?? "codex";
if (!museBin || !isAbsolute(museBin)) throw new Error("--muse-bin requires the exact absolute existing Muse executable path");
if ([museBin, codexBin].some((value) => value.includes("\0"))) throw new Error("Executable paths cannot contain NUL");

// Exclusive creation avoids changing an existing fixture or active state namespace.
await mkdir(output, { mode: 0o700 });
const project = join(output, "repository"), parentA = join(output, "parent-a"), parentB = join(output, "parent-b");
const state = join(output, "state"), workerRoot = join(output, "workers"), profile = join(output, "profile.json");
await mkdir(project, { mode: 0o700 });
await mkdir(state, { mode: 0o700 });
await mkdir(workerRoot, { mode: 0o700 });
const git = async (cwd: string, args: string[]) => (await exec("git", args, {
  cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
})).stdout.trim();
await git(project, ["init", "-b", "main"]);
await mkdir(join(project, "src"));
await writeFile(join(project, "src/shared.ts"), "export function computeTotal(items: readonly number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n");
await writeFile(join(project, "src/independent.ts"), "export function formatLabel(value: string): string {\n  return value.trim();\n}\n");
await git(project, ["add", "src/shared.ts", "src/independent.ts"]);
// The fixture has no configured hooks; normal Git hook execution remains enabled.
await git(project, ["-c", "user.name=Passeur SC15 Fixture", "-c", "user.email=fixture@invalid.example", "commit", "-m", "chore: seed structural live fixture"]);
const base = await git(project, ["rev-parse", "HEAD"]);
await git(project, ["worktree", "add", "-b", "sc15-parent-a", parentA, base]);
await git(project, ["worktree", "add", "-b", "sc15-parent-b", parentB, base]);
const identity = await repositoryIdentity(project);

// The installed CLI owns fixture profile creation and operator-confirmed provenance.
await exec(process.execPath, [installed.entry, "configure", "--project", project,
  "--profile", profile, "--state-root", state, "--muse-bin", museBin,
  "--model", values["muse-model"]!, "--worktree-root", workerRoot,
  "--max-workers", "3", "--max-queued-tasks", "3", "--confirm-subscription"],
{ cwd: project, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
const configured = SharedProfileSchema.parse(JSON.parse(await readFile(profile, "utf8")));
const baseMuse = configured.agents.find((agent) => agent.agent_id === "muse" && agent.adapter_id === "muse");
if (!baseMuse || typeof baseMuse.options !== "object" || baseMuse.options === null) throw new Error("Installed CLI did not create the expected Muse registration");
const museRegistration = {
  agent_id: "sc15-muse-b", adapter_id: "muse", description: "SC15 overlapping native Muse worker B",
  enabled: true, modes: ["implement"], options: baseMuse.options,
};
const museAgentFile = join(output, "muse-b-agent.json");
await writeFile(museAgentFile, `${JSON.stringify(museRegistration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await exec(process.execPath, [installed.entry, "configure-agent", "--project", project,
  "--profile", profile, "--state-root", state, "--agent-file", museAgentFile, "--yes"],
{ cwd: project, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
const finalMuseProfile = SharedProfileSchema.parse(JSON.parse(await readFile(profile, "utf8")));
if (!finalMuseProfile.agents.some((agent) => agent.agent_id === "sc15-muse-b" && agent.adapter_id === "muse")) {
  throw new Error("Installed CLI did not add the second Muse registration");
}
const codexPending = join(output, "codex-agent.pending.json");
await writeFile(codexPending, `${JSON.stringify({
  agent_id: "sc15-codex", adapter_id: "codex", description: "SC15 independent native Codex worker",
  enabled: true, modes: ["implement"], options: {
    codex_bin: codexBin, codex_home: null, model: values["codex-model"], network_access: false,
    allow_command_escalation: false, subscription_confirmed: false, experimental_opt_in: false,
  },
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });

const key = randomUUID().replaceAll("-", "");
const assignments = [
  { agent_id: "muse", request_key: `sc15-overlap-a-${key}`, objective: "Change only src/shared.ts: update computeTotal to ignore negative values, then commit the change through ordinary Git.", allowed_paths: ["src/shared.ts"] },
  { agent_id: "sc15-muse-b", request_key: `sc15-overlap-b-${key}`, objective: "Change only src/shared.ts: update computeTotal to round each item before summing, then commit the change through ordinary Git.", allowed_paths: ["src/shared.ts"] },
  { agent_id: "sc15-codex", request_key: `sc15-independent-${key}`, objective: "Change only src/independent.ts: add a documented normalizeLabel function that lowercases a trimmed label, then commit the change through ordinary Git.", allowed_paths: ["src/independent.ts"] },
].map(({ agent_id, request_key, objective, allowed_paths }) => AssignmentSchema.parse({
  schema_version: 3, agent_id, request_key, mode: "implement", base_commit: base, target_ref: "refs/heads/main",
  objective, context: "Authorized disposable SC15 live acceptance fixture. Preserve ordinary hooks and permissions. Report native input or blocker without inventing approval; do not modify other files.",
  acceptance_criteria: ["Only the assigned source file changes", "Commit the result through ordinary Git", "Report the exact commit and any native input or blocker"], allowed_paths,
}));
await writeFile(join(output, "assignments.json"), `${JSON.stringify({ schema_version: 1, assignments }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const parentRequests = assignments.map((assignment, index) => {
  const owner = index === 1 ? "parent-b" : "parent-a";
  const path = join(output, `${owner}-${assignment.agent_id}-inline.json`);
  return { owner, path, request: CoordinatedSubmitSchema.parse({ schema_version: 2, kind: "inline", assignment }) };
});
for (const { path, request } of parentRequests) {
  await writeFile(path, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

const tomlValue = (value: string | string[]) => TOML.stringify({ value }).trim().slice("value = ".length);
const host = (name: string, cwd: string) => {
  const serve = [installed.entry, "serve", "--project", cwd, "--profile", profile,
    "--state-root", state, "--expected-repository-id", identity.id];
  const overrides = {
    command: process.execPath, args: serve, cwd, enabled_tools: [...CODEX_ENABLED_TOOLS],
  };
  return { server_name: name, cwd, command: codexBin,
    args: ["-C", cwd, ...Object.entries(overrides).flatMap(([field, value]) =>
      ["-c", `mcp_servers.${name}.${field}=${tomlValue(value)}`])],
    note: "Use in a fresh actual Codex host session. Existing named server approval, denial and required policy still apply; inspect them before launch.",
  };
};
const launches = [host("passeur_pumas", parentA), host("passeur_tuldok", parentB)];
await writeFile(join(output, "parent-host-invocations.json"), `${JSON.stringify(launches, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const record = {
  schema_version: 1, status: "prepared_only", installed_build_id: installed.manifest.build_id,
  installed_source_revision: installed.manifest.source_revision, installed_cli: installed.entry,
  repository_id: identity.id, git_common_dir: identity.common_dir, input_commit: base,
  project, parent_worktrees: [parentA, parentB], state_root: state, worker_root: workerRoot,
  profile, assignment_file: join(output, "assignments.json"), host_invocations: join(output, "parent-host-invocations.json"),
  parent_request_files: parentRequests.map(({ owner, path }) => ({ owner, path })),
  muse_registration_ids: ["muse", "sc15-muse-b"], muse_executable: museBin,
  muse_model: values["muse-model"], muse_provenance: "user_confirmed",
  codex_agent_pending_file: codexPending,
  codex_registration_step: {
    prerequisite: "Operator supplies an existing dedicated authenticated Codex home, distinct from the calling parent's CODEX_HOME and outside every worker workspace; confirm subscription and experimental adapter opt-in, then replace null/false fields in the pending agent file.",
    command: process.execPath,
    args: [installed.entry, "configure-agent", "--project", project, "--profile", profile,
      "--state-root", state, "--agent-file", codexPending, "--yes"],
  },
  unresolved_operator_fields: ["dedicated authenticated Codex worker codex_home outside both parent sessions and worker workspace",
    "Codex subscription confirmation and experimental adapter opt-in after dedicated home qualification"],
  no_worker_started: true, no_host_started: true, no_personal_configuration_changed: true,
};
await writeFile(join(output, "fixture-record.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(record, null, 2));
