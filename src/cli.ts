#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ProfileSchema } from "./contracts/index.js";
import { loadProfile } from "./core/profile.js";
import { doctor } from "./diagnostics/doctor.js";
import { serve } from "./mcp/server.js";
import { TaskStore } from "./store/task-store.js";
import { canonicalProject, projectId } from "./workspace/project.js";

function roots(id: string) {
  const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state");
  const config = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return { store: join(state, "muse-bridge", "projects", id), defaultProfile: join(config, "muse-bridge", "projects", `${id}.json`) };
}
function usage(): never { console.error("Usage: muse-bridge <configure|doctor|serve|inspect|result|logs|cleanup> --project <path> [options]"); process.exit(2); }

async function main(): Promise<void> {
  const command = process.argv[2]; if (!command) usage();
  const { values } = parseArgs({ args: process.argv.slice(3), options: { project: { type: "string" }, profile: { type: "string" }, task: { type: "string" }, follow: { type: "boolean" }, yes: { type: "boolean" }, "muse-bin": { type: "string" }, model: { type: "string" }, "worktree-root": { type: "string" }, "confirm-subscription": { type: "boolean" } }, strict: true });
  if (!values.project) usage();
  const project = await canonicalProject(values.project); const id = projectId(project); const locations = roots(id); const profilePath = resolve(values.profile ?? locations.defaultProfile); const store = new TaskStore(locations.store);
  if (command === "configure") {
    if (!values.model) throw new Error("configure requires --model with an identifier verified against the installed Muse runtime; no default is selected");
    const profile = ProfileSchema.parse({ schema_version: 1, muse_bin: values["muse-bin"] ?? "muse", model: values.model, review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: Boolean(values["worktree-root"]), ...(values["worktree-root"] ? { worktree_root: resolve(values["worktree-root"]) } : {}), sandbox_network: "proxy-only" }, task_timeout_ms: 1_800_000, stop_grace_ms: 60_000, subscription: { provenance: values["confirm-subscription"] ? "user_confirmed" : "unverified", ...(values["confirm-subscription"] ? { verified_at: new Date().toISOString(), note: "Confirmed by user during muse-bridge configure" } : {}) } });
    await mkdir(dirname(profilePath), { recursive: true, mode: 0o700 }); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 }); await chmod(profilePath, 0o600);
    console.log(JSON.stringify({ profile: profilePath, codex_config: { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve", "--project", project, "--profile", profilePath], startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: ["delegate_to_muse", "muse_result"] } }, null, 2)); return;
  }
  const profile = await loadProfile(profilePath);
  if (command === "doctor") { console.log(JSON.stringify(await doctor(project, profilePath, profile), null, 2)); return; }
  if (command === "serve") { await mkdir(locations.store, { recursive: true, mode: 0o700 }); await serve({ project, projectId: id, profile, store, lockPath: locations.store }); return; }
  await store.initialize();
  if (command === "inspect") { const records = await store.list(); console.log(JSON.stringify(await Promise.all(records.map(async (record) => ({ task_id: record.task_id, request_key: record.request.request_key, accepted_at: record.accepted_at, state: await store.readState(record.task_id) }))), null, 2)); return; }
  if (!values.task) usage(); const record = await store.find({ task_id: values.task }); if (!record) throw new Error("Task not found");
  if (command === "result") { console.log(JSON.stringify(await store.readResult(record.task_id), null, 2)); return; }
  if (command === "logs") { const path = join(store.taskDir(record.task_id), "events.ndjson"); if (!values.follow) { process.stdout.write(await readFile(path)); return; } const child = (await import("node:child_process")).spawn("tail", ["-f", path], { stdio: "inherit" }); await new Promise((done) => child.once("exit", done)); return; }
  if (command === "cleanup") { if (!values.yes) throw new Error("cleanup requires --yes; retained worktrees are never removed by this command"); await rm(store.taskDir(record.task_id), { recursive: true }); console.log(`Removed task records for ${record.task_id}; any task worktree was retained.`); return; }
  usage();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
