#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { FinalizeRequestSchema, ProfileSchema } from "./contracts/index.js";
import { loadProfile } from "./core/profile.js";
import { cleanupTask } from "./core/cleanup.js";
import { DispositionManager } from "./core/disposition.js";
import { acquireRepositoryLease } from "./core/lease.js";
import { acknowledgeStoppedTask, reconcileStoredTasks } from "./core/recovery.js";
import { Mutex } from "./core/async.js";
import { BridgeError, errorInfo } from "./core/errors.js";
import { doctor } from "./diagnostics/doctor.js";
import { serve } from "./mcp/server.js";
import { discoverMuseModels, type MuseModel } from "./muse/models.js";
import { TaskStore } from "./store/task-store.js";
import { canonicalProject, projectId, repositoryIdentity } from "./workspace/project.js";
import { worktreeEntries } from "./workspace/worktree.js";

function usage(): never {
  console.error("Usage: muse-bridge <setup|configure|doctor|serve|inspect|result|logs|finalize|cleanup|reconcile> --project <path> [options]");
  process.exit(2);
}

async function saveProfile(profilePath: string, project: string, values: {
  model: string; museBin: string; worktreeRoot?: string; confirmed: boolean; maxWorkers?: number; maxQueuedTasks?: number;
}): Promise<void> {
  const profile = ProfileSchema.parse({
    schema_version: 1, muse_bin: values.museBin, model: values.model,
    review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
    implementation: { enabled: Boolean(values.worktreeRoot), ...(values.worktreeRoot ? { worktree_root: resolve(values.worktreeRoot) } : {}), sandbox_network: "proxy-only" },
    max_workers: values.maxWorkers ?? 2, max_queued_tasks: values.maxQueuedTasks ?? 8,
    task_timeout_ms: 1_800_000, stop_grace_ms: 60_000,
    subscription: { provenance: values.confirmed ? "user_confirmed" : "unverified", ...(values.confirmed ? { verified_at: new Date().toISOString(), note: "User-confirmed during setup; not provider billing proof" } : {}) },
  });
  await mkdir(dirname(profilePath), { recursive: true, mode: 0o700 });
  try { await readFile(profilePath); throw new Error("Profile already exists; edit it deliberately or choose a new --profile path"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await chmod(profilePath, 0o600);
  console.log(JSON.stringify({ profile: profilePath, capacity: { workers: profile.max_workers, queued: profile.max_queued_tasks },
    codex_config: { command: process.execPath, args: [fileURLToPath(import.meta.url), "serve", "--project", project, "--profile", profilePath],
      startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: ["delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize"] },
  }, null, 2));
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
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    project: { type: "string" }, profile: { type: "string" }, task: { type: "string" }, follow: { type: "boolean" }, yes: { type: "boolean" },
    "muse-bin": { type: "string" }, model: { type: "string" }, "worktree-root": { type: "string" }, "confirm-subscription": { type: "boolean" },
    "max-workers": { type: "string" }, "max-queued-tasks": { type: "string" }, operations: { type: "string" },
    "confirm-worker-stopped": { type: "boolean" }, owner: { type: "string" }, reason: { type: "string" },
  }, strict: true });
  if (!values.project) usage();
  const project = await canonicalProject(values.project), repository = await repositoryIdentity(project);
  const home = process.env.HOME;
  if (!home && (!process.env.XDG_STATE_HOME || !process.env.XDG_CONFIG_HOME)) throw new Error("HOME or explicit XDG configuration/state roots are required");
  const stateRoot = process.env.XDG_STATE_HOME ?? join(home!, ".local", "state");
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(home!, ".config");
  const storeRoot = join(stateRoot, "muse-bridge", "repositories", repository.id);
  const defaultProfile = join(configRoot, "muse-bridge", "projects", `${projectId(project)}.json`);
  const profilePath = resolve(values.profile ?? defaultProfile), store = new TaskStore(storeRoot);
  // The profile remains project-specific; runtime ownership and records are repository-common.
  if (command === "setup") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup requires a terminal");
    await interactiveSetup(profilePath, project); return;
  }
  if (command === "configure") {
    if (!values.model) throw new Error("configure requires --model with the exact installed model ID");
    await saveProfile(profilePath, project, {
      model: values.model, museBin: values["muse-bin"] ?? "muse",
      ...(values["worktree-root"] ? { worktreeRoot: values["worktree-root"] } : {}),
      confirmed: values["confirm-subscription"] ?? false,
      ...(values["max-workers"] === undefined ? {} : { maxWorkers: Number(values["max-workers"]) }),
      ...(values["max-queued-tasks"] === undefined ? {} : { maxQueuedTasks: Number(values["max-queued-tasks"]) }),
    }); return;
  }
  if (command === "doctor") { console.log(JSON.stringify(await doctor(project, profilePath, await loadProfile(profilePath, false)), null, 2)); return; }
  let legacyRoots = [join(stateRoot, "muse-bridge", "projects", projectId(project))];
  if (repository.common_dir !== project) {
    legacyRoots = [...new Set([...legacyRoots, ...(await worktreeEntries(project)).map((entry) => join(stateRoot, "muse-bridge", "projects", projectId(entry.path)))])];
  }
  if (command === "serve") {
    let profile;
    try { profile = await loadProfile(profilePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (process.stdin.isTTY && process.stdout.isTTY) { await interactiveSetup(profilePath, project); return; }
        throw new Error(`Passeur is not configured for ${project}. Run:\n  ./passeur setup "${project}"`);
      }
      throw error;
    }
    await serve({ project, projectId: repository.id, profile, store, lockPath: storeRoot, legacyStoreRoots: legacyRoots }); return;
  }
  if (command === "inspect") {
    const records = await store.list();
    console.log(JSON.stringify({ repository, frozen: await store.frozenReason(), tasks: await Promise.all(records.map(async (record) => ({ task_id: record.task_id, request_key: record.request.request_key,
      state: await store.readState(record.task_id), resource: await store.readResource(record.task_id) ?? { state: "legacy_unclassified" } }))),
      note: "Start serve or an offline mutation once to import legacy path-keyed records; inspection never mutates them.",
    }, null, 2)); return;
  }
  if (command === "finalize" || command === "cleanup" || command === "reconcile") {
    if (!values.yes) throw new Error(`${command} requires --yes; it never authorizes deletion of unique or dirty work`);
    const release = await acquireRepositoryLease(storeRoot);
    try {
      for (const root of legacyRoots) await store.importLegacy(root);
      await reconcileStoredTasks(store, "unavailable-after-restart");
      if (command === "finalize") {
        if (!values.operations) throw new Error("finalize requires --operations <JSON-file> containing schema_version:2 and operations");
        const request = FinalizeRequestSchema.parse(JSON.parse(await readFile(values.operations, "utf8")));
        const manager = new DispositionManager(project, repository.id, store, { administration: new Mutex(), isActive: () => false,
          assertMutationAllowed: async () => { const frozen = await store.frozenReason(); if (frozen) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", frozen); } });
        const results = [];
        for (const operation of request.operations) {
          try { results.push(await manager.finalize(operation)); }
          catch (error) { results.push({ task_id: operation.task_id, operation_key: operation.operation_key, error: errorInfo(error) }); process.exitCode = 1; }
        }
        console.log(JSON.stringify({ results }, null, 2)); return;
      }
      if (!values.task) throw new Error(`${command} requires --task <UUID>`);
      if (command === "reconcile") {
        if (!values["confirm-worker-stopped"] || !values.owner || !values.reason) throw new Error("reconcile requires --confirm-worker-stopped, --owner and --reason with manual process/workspace evidence");
        await acknowledgeStoppedTask(store, values.task, values.owner, values.reason);
        console.log(JSON.stringify({ resource: await store.readResource(values.task), remaining_safety_condition: await store.frozenReason() }, null, 2)); return;
      }
      if (await store.frozenReason()) throw new BridgeError("PROJECT_NEEDS_RECONCILIATION", "Reconcile repository safety before evidence collection");
      await cleanupTask({ store, taskId: values.task });
      console.log("Collected bulky artifacts/logs; task, result, disposition and request-key receipts remain."); return;
    } finally { await release(); }
  }
  if (!values.task) usage();
  const record = await store.find({ task_id: values.task }); if (!record) throw new Error("Task not found; legacy imports occur only under an owner lease");
  if (command === "result") { console.log(JSON.stringify({ result: await store.readResult(record.task_id), resource: await store.readResource(record.task_id) ?? { state: "legacy_unclassified" } }, null, 2)); return; }
  if (command === "logs") {
    const path = join(store.taskDir(record.task_id), "events.ndjson");
    if (!values.follow) { process.stdout.write(await readFile(path)); return; }
    const child = (await import("node:child_process")).spawn("tail", ["-f", "--", path], { stdio: "inherit" });
    await new Promise<void>((resolveDone, reject) => { child.once("error", reject); child.once("exit", () => resolveDone()); }); return;
  }
  usage();
}
main().catch((error) => { console.error(errorInfo(error).message); process.exitCode = 1; });
