#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ProfileSchema, type Profile } from "./contracts/index.js";
import { loadProfile } from "./core/profile.js";
import { cleanupTask } from "./core/cleanup.js";
import { doctor } from "./diagnostics/doctor.js";
import { serve } from "./mcp/server.js";
import { discoverMuseModels, type MuseModel } from "./muse/models.js";
import { TaskStore } from "./store/task-store.js";
import { canonicalProject, projectId } from "./workspace/project.js";

function roots(id: string) {
  const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state");
  const config = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return { store: join(state, "muse-bridge", "projects", id), defaultProfile: join(config, "muse-bridge", "projects", `${id}.json`) };
}
function usage(): never { console.error("Usage: muse-bridge <setup|configure|doctor|serve|inspect|result|logs|cleanup> --project <path> [options]"); process.exit(2); }

async function saveProfile(profilePath: string, project: string, values: { model: string; museBin: string; worktreeRoot?: string; confirmed: boolean }): Promise<void> {
  const profile = ProfileSchema.parse({ schema_version: 1, muse_bin: values.museBin, model: values.model, review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: Boolean(values.worktreeRoot), ...(values.worktreeRoot ? { worktree_root: resolve(values.worktreeRoot) } : {}), sandbox_network: "proxy-only" }, task_timeout_ms: 1_800_000, stop_grace_ms: 60_000, subscription: { provenance: values.confirmed ? "user_confirmed" : "unverified", ...(values.confirmed ? { verified_at: new Date().toISOString(), note: "Confirmed by user during muse-bridge setup" } : {}) } });
  await mkdir(dirname(profilePath), { recursive: true, mode: 0o700 }); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 }); await chmod(profilePath, 0o600);
  console.log(JSON.stringify({ profile: profilePath, codex_config: { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve", "--project", project, "--profile", profilePath], startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: ["delegate_to_muse", "muse_result"] } }, null, 2));
}

async function interactiveSetup(profilePath: string, project: string): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, fallback?: string) => (await terminal.question(`${prompt}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
  try {
    console.log(`Passeur setup for ${project}\n`);
    const models = await discoverMuseModels();
    if (!models.length) throw new Error("No visible Muse models were found. Start Muse once to refresh its local model catalog, then rerun setup");
    console.log("Muse models:");
    models.forEach((model, index) => console.log(`  ${index + 1}) ${model.display_label ?? model.model_id}${model.is_default ? " (default)" : model.is_current ? " (current)" : ""}${model.description ? `\n     ${model.description}` : ""}`));
    let selected: MuseModel | undefined;
    while (!selected) {
      const choice = await ask("Select a model", "1"); const index = Number(choice) - 1;
      selected = Number.isInteger(index) ? models[index] : undefined;
      if (!selected) console.log(`Enter a number from 1 to ${models.length}.`);
    }
    const model = selected.model_id;
    const museBin = "muse";
    console.log("Using Muse executable from PATH: muse");
    const implementation = /^y(es)?$/i.test(await ask("Enable implementation worktrees? (y/N)", "N"));
    const worktreeRoot = implementation ? await ask("Worktree root (must be outside the project)") : undefined;
    if (implementation && !worktreeRoot) throw new Error("A worktree root is required when implementation tasks are enabled");
    const confirmed = /^y(es)?$/i.test(await ask("Have you verified this Muse login uses your intended subscription? (y/N)", "N"));
    if (!confirmed) throw new Error("Subscription confirmation is required before Passeur can delegate work");
    await saveProfile(profilePath, project, { model, museBin, ...(worktreeRoot ? { worktreeRoot } : {}), confirmed });
    console.log("\nSetup complete. Add the codex_config values above to Codex, then run ./passeur again.");
  } finally { terminal.close(); }
}

async function main(): Promise<void> {
  const command = process.argv[2]; if (!command) usage();
  const { values } = parseArgs({ args: process.argv.slice(3), options: { project: { type: "string" }, profile: { type: "string" }, task: { type: "string" }, follow: { type: "boolean" }, yes: { type: "boolean" }, reconcile: { type: "boolean" }, "muse-bin": { type: "string" }, model: { type: "string" }, "worktree-root": { type: "string" }, "confirm-subscription": { type: "boolean" } }, strict: true });
  if (!values.project) usage();
  const project = await canonicalProject(values.project); const id = projectId(project); const locations = roots(id); const profilePath = resolve(values.profile ?? locations.defaultProfile); const store = new TaskStore(locations.store);
  if (command === "setup") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup requires a terminal");
    await interactiveSetup(profilePath, project); return;
  }
  if (command === "configure") {
    if (!values.model) throw new Error("configure requires --model with an identifier verified against the installed Muse runtime; no default is selected");
    await saveProfile(profilePath, project, { model: values.model, museBin: values["muse-bin"] ?? "muse", ...(values["worktree-root"] ? { worktreeRoot: values["worktree-root"] } : {}), confirmed: values["confirm-subscription"] ?? false }); return;
  }
  let profile: Profile;
  try { profile = await loadProfile(profilePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (command === "serve" && process.stdin.isTTY && process.stdout.isTTY) { await interactiveSetup(profilePath, project); return; }
      throw new Error(`Passeur is not configured for ${project}. Run:\n  ./passeur setup "${project}"`);
    }
    throw error;
  }
  if (command === "doctor") { console.log(JSON.stringify(await doctor(project, profilePath, profile), null, 2)); return; }
  if (command === "serve") { await mkdir(locations.store, { recursive: true, mode: 0o700 }); await serve({ project, projectId: id, profile, store, lockPath: locations.store }); return; }
  await store.initialize();
  if (command === "inspect") { const records = await store.list(); console.log(JSON.stringify(await Promise.all(records.map(async (record) => ({ task_id: record.task_id, request_key: record.request.request_key, accepted_at: record.accepted_at, state: await store.readState(record.task_id) }))), null, 2)); return; }
  if (!values.task) usage(); const record = await store.find({ task_id: values.task }); if (!record) throw new Error("Task not found");
  if (command === "result") { console.log(JSON.stringify(await store.readResult(record.task_id), null, 2)); return; }
  if (command === "logs") { const path = join(store.taskDir(record.task_id), "events.ndjson"); if (!values.follow) { process.stdout.write(await readFile(path)); return; } const child = (await import("node:child_process")).spawn("tail", ["-f", path], { stdio: "inherit" }); await new Promise((done) => child.once("exit", done)); return; }
  if (command === "cleanup") { if (!values.yes) throw new Error("cleanup requires --yes; retained worktrees are never removed by this command"); await cleanupTask({ store, lockPath: locations.store, taskId: record.task_id, reconcile: values.reconcile ?? false }); console.log(`Removed task records for ${record.task_id}; any task worktree was retained.`); return; }
  usage();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
