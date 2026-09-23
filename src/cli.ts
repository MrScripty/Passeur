#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError, diagnosticInfo, nativeCode } from "./core/errors.js";
import type { SharedProfile } from "./contracts/tasks.js";
import type { LaunchIntent } from "./core/repository-runtime.js";
import type { CodexMcpRegistration } from "./codex/config.js";
import { startupRequirementFromFlags } from "./codex/startup-policy.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const help = `Passeur — repository-scoped agent coordination

Usage: passeur <action> [options]
  serve|start --project PATH [--profile FILE] [--state-root PATH]
  setup|configure --project PATH [--profile FILE] [--server-name NAME]
  register-codex --project PATH --server-name NAME [--runtime DIRECTORY] [--required|--optional]
  doctor --project PATH [--prepare --yes]
  agents --project PATH [--offset NUMBER] [--limit 1..4]
  configure-agent --project PATH --agent-file FILE --yes [--replace-agent FINGERPRINT]
  migrate-profile --project PATH --yes
  service-start|service-status --project PATH
  service-stop --project PATH --operation-key KEY --yes [--cancel-tasks UUID,UUID]
  coordinate --project PATH --request FILE [--yes] [--confirm-external-settled]
  structural-report --project PATH --work UUID
  structural-detail --project PATH --work UUID --report UUID --side input|observed --start-byte N --end-byte N
  submit --project PATH --assignment FILE --yes
  tasks --project PATH [--request-key KEY] [--offset N] [--limit N]
  wait --project PATH --task UUID [--after-revision N] [--wait-ms N]
  attach --project PATH (--task UUID | --request-key KEY) --operation-key KEY --yes
  cancel --project PATH --task UUID --control-generation N --operation-key KEY --reason TEXT --yes
  input --project PATH --task UUID --input-id UUID --control-generation N --operation-key KEY --answer TEXT --yes
  inspect --project PATH
  result|logs --project PATH --task UUID [--follow]
  finalize --project PATH --operations FILE --yes
  cleanup --project PATH --task UUID --yes
  reconcile --project PATH --task UUID --confirm-worker-stopped --owner NAME --reason TEXT --yes
  install --artifact DIRECTORY --install-root DIRECTORY --yes
  --version | --help

configure requires --model ID and supports --muse-bin, --worktree-root,
--confirm-subscription, --max-workers, --max-queued-tasks and --install-codex.
Registration supports --config-path FILE, --verify-readiness --yes,
--replace-binding FINGERPRINT, --adopt-unmanaged, --development-runtime,
and --tool-timeout-sec SECONDS (default 2100). Normal registration requires
an installed runtime. --adopt-unmanaged explicitly permits TOML formatting
and comment loss; the original configuration is backed up.
--required makes this server required for Codex startup/resume; --optional
explicitly restores optional startup. Omission preserves an existing policy
and makes new registrations optional. Required servers use their startup
budget rather than the host's optional-catalog grace, and initialization
failure blocks host startup. These options change only the named server;
no global grace, approval or sandbox setting is changed.

serve never builds, installs or edits configuration. Normal run/setup use
HOME or XDG_CONFIG_HOME/XDG_STATE_HOME unless paths are explicit. Registration
pins project/profile/state paths. Close external config editors while registering.
Exit 0 means the requested action passed; 1 means failure or blocked required
verification; 130/143 represent interruption by SIGINT/SIGTERM. Accepted assignments survive CLI/host closure. wait timeout cancels only observation.
attach/input/cancel are explicit operator-control actions; never use them to bypass host human approvals.
coordinate supports operator-only recovery_read and recover_metadata requests.
Settlement reports additionally require --confirm-external-settled; no process is stopped.
coordinate reads one bounded JSON request. Mutations (including initialize) require --yes.
It manages metadata only: no analysis, agent messaging or Git integration. Read replies
are bounded pages; continue explicitly with next_offset and the same expected_hash.
Use an existing operator identity, or explicitly create it with --yes.
Live agent compatibility is reported separately and is never implied by registration.
`;

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new BridgeError("ARGUMENT_REQUIRED", `${flag} is required`);
  return value;
}
function integer(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BridgeError("ARGUMENT_INVALID", `${flag} requires a nonnegative integer`);
  return Number(value);
}
const options = {
  request: { type: "string" }, "confirm-external-settled": { type: "boolean" }, work: { type: "string" }, report: { type: "string" },
  side: { type: "string" }, "start-byte": { type: "string" }, "end-byte": { type: "string" },
  assignment: { type: "string" }, "request-key": { type: "string" }, "operation-key": { type: "string" }, "control-generation": { type: "string" },
  "input-id": { type: "string" }, answer: { type: "string" }, "after-revision": { type: "string" }, "wait-ms": { type: "string" }, "cancel-tasks": { type: "string" },
  project: { type: "string" }, profile: { type: "string" }, "state-root": { type: "string" }, "expected-repository-id": { type: "string" },
  "agent-file": { type: "string" }, "replace-agent": { type: "string" }, offset: { type: "string" }, limit: { type: "string" },
  task: { type: "string" }, follow: { type: "boolean" }, yes: { type: "boolean" },
  "muse-bin": { type: "string" }, model: { type: "string" }, "worktree-root": { type: "string" }, "confirm-subscription": { type: "boolean" },
  "max-workers": { type: "string" }, "max-queued-tasks": { type: "string" }, operations: { type: "string" },
  "install-codex": { type: "boolean" }, "confirm-worker-stopped": { type: "boolean" }, owner: { type: "string" }, reason: { type: "string" },
  required: { type: "boolean" }, optional: { type: "boolean" },
  "server-name": { type: "string" }, runtime: { type: "string" }, "config-path": { type: "string" }, "replace-binding": { type: "string" },
  "adopt-unmanaged": { type: "boolean" }, "development-runtime": { type: "boolean" }, "verify-readiness": { type: "boolean" },
  "tool-timeout-sec": { type: "string" }, prepare: { type: "boolean" }, artifact: { type: "string" }, "install-root": { type: "string" },
} as const;
type Values = ReturnType<typeof decode>["values"];
function decode(args: string[]) { return parseArgs({ args, options, strict: true, allowPositionals: false }); }

async function saveProfile(path: string, values: Values): Promise<SharedProfile> {
  const { migrateSharedProfile } = await import("./core/profile.js");
  const maxWorkers = integer(values["max-workers"], "--max-workers"), maxQueued = integer(values["max-queued-tasks"], "--max-queued-tasks");
  const profile = migrateSharedProfile({
    schema_version: 1, muse_bin: values["muse-bin"] ?? "muse", model: required(values.model, "--model"),
    review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
    implementation: { enabled: Boolean(values["worktree-root"]), ...(values["worktree-root"] ? { worktree_root: resolve(values["worktree-root"]) } : {}), sandbox_network: "proxy-only" },
    ...(maxWorkers === undefined ? {} : { max_workers: maxWorkers }), ...(maxQueued === undefined ? {} : { max_queued_tasks: maxQueued }),
    subscription: { provenance: values["confirm-subscription"] ? "user_confirmed" : "unverified",
      ...(values["confirm-subscription"] ? { verified_at: new Date().toISOString(), note: "Operator-confirmed credential path; not provider billing proof" } : {}) },
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return profile;
}

async function registration(intent: LaunchIntent, values: Values): Promise<CodexMcpRegistration> {
  const { resolveRepositoryBinding } = await import("./core/repository-runtime.js");
  const { installedEntry, runtimeIdentity } = await import("./install/runtime.js");
  const { CODEX_ENABLED_TOOLS, validateServerName } = await import("./codex/config.js");
  const serverName = validateServerName(required(values["server-name"], "--server-name"));
  const binding = await resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(90_000));
  const profilePath = required(binding.profilePath, "--profile or HOME/XDG_CONFIG_HOME");
  const root = resolve(values.runtime ?? runtimeRoot);
  let cli: string, identity;
  if (values["development-runtime"]) {
    cli = join(root, "dist", "src", "cli.js");
    identity = await runtimeIdentity(root);
  } else {
    const installed = await installedEntry(root);
    cli = installed.entry;
    identity = await runtimeIdentity(installed.root);
  }
  const timeout = integer(values["tool-timeout-sec"], "--tool-timeout-sec") ?? 2100;
  if (timeout < 1) throw new BridgeError("ARGUMENT_INVALID", "--tool-timeout-sec must be positive");
  const startupRequired = startupRequirementFromFlags(values.required, values.optional);
  return {
    ...(startupRequired === undefined ? {} : { required: startupRequired }),
    server_name: serverName, command: process.execPath,
    args: [cli, "serve", "--project", binding.project, "--profile", profilePath, "--state-root", binding.stateRoot, "--expected-repository-id", binding.repositoryId],
    cwd: root, env: {}, startup_timeout_sec: 10, tool_timeout_sec: timeout, enabled_tools: CODEX_ENABLED_TOOLS,
    project: binding.project, profile: profilePath, state_root: binding.stateRoot, repository_id: binding.repositoryId,
    build_id: identity.build_id, development: identity.mode !== "installed",
  };
}
async function register(intent: LaunchIntent, values: Values): Promise<void> {
  if (values["verify-readiness"] && !values.yes) throw new BridgeError("READINESS_AUTHORITY_REQUIRED", "--verify-readiness requires --yes; preparation may import/reconcile state");
  const descriptor = await registration(intent, values);
  const { installCodexMcpRegistration } = await import("./codex/config.js");
  const installed = await installCodexMcpRegistration(descriptor, {
    ...(values["config-path"] ? { configPath: resolve(values["config-path"]) } : {}),
    ...(values["replace-binding"] ? { replaceBinding: values["replace-binding"] } : {}),
    ...(values["adopt-unmanaged"] ? { adoptUnmanaged: true } : {}),
  });
  const { probeRegistration } = await import("./codex/probe.js");
  const probe = await probeRegistration(descriptor, Boolean(values["verify-readiness"]));
  console.log(JSON.stringify({ ...installed, ...probe, configuration: { status: "passed", scope: "codex mcp get configuration inspection" },
    next_action: "After controlled shutdown of the old host, start a fresh Codex session and call this named server's passeur_status. Verify build identity and actual callable tools before preparation or delegation. Direct transport and saved startup policy do not prove host-to-model exposure." }, null, 2));
  if (probe.transport.status !== "passed" || (values["verify-readiness"] && probe.readiness.status !== "passed")) process.exitCode = 1;
}
async function setup(intent: LaunchIntent, values: Values): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new BridgeError("TERMINAL_REQUIRED", "Interactive setup requires a terminal");
  const { resolveRepositoryBinding } = await import("./core/repository-runtime.js");
  const binding = await resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(90_000));
  const { discoverMuseModels } = await import("./muse/models.js");
  const models = await discoverMuseModels();
  if (!models.length) throw new BridgeError("MODEL_CATALOG_EMPTY", "No visible Muse models; refresh the Muse model catalog before setup");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string) => (await terminal.question(prompt)).trim();
  try {
    console.log(`Passeur setup for ${binding.project}`);
    models.forEach((model, index) => console.log(`${index + 1}) ${model.display_label ?? model.model_id}`));
    const choice = Number((await ask("Select model [1]: ")) || "1") - 1;
    const selected = Number.isInteger(choice) ? models[choice] : undefined;
    if (!selected) throw new BridgeError("MODEL_SELECTION_INVALID", "Select one of the numbered models");
    const implement = /^(y|yes)$/i.test(await ask("Enable implementation worktrees? [y/N]: "));
    const worktrees = implement ? required(await ask("Worktree root outside the project: "), "worktree root") : undefined;
    const confirmed = /^(y|yes)$/i.test(await ask("Have you verified the intended Muse subscription credential path? [y/N]: "));
    await saveProfile(required(binding.profilePath, "--profile or HOME/XDG_CONFIG_HOME"), { ...values, model: selected.model_id, "confirm-subscription": confirmed,
      ...(worktrees ? { "worktree-root": worktrees } : {}) });
    const doInstall = values["install-codex"] || /^(y|yes)$/i.test(await ask("Install a named Codex registration now? [y/N]: "));
    if (doInstall) {
      const name = values["server-name"] ?? required(await ask("Codex server name (for example passeur_pumas): "), "server name");
      await register(intent, { ...values, "server-name": name });
    } else console.log(JSON.stringify({ profile: binding.profilePath, configuration: "not_installed", installed_workflow: "not_run" }));
  } finally { terminal.close(); }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "--help" || action === "help" || !action) { process.stdout.write(help); return; }
  if (action === "--version") {
    const { runtimeIdentity } = await import("./install/runtime.js");
    console.log(JSON.stringify(await runtimeIdentity(runtimeRoot))); return;
  }
  const actions = new Set(["serve", "start", "setup", "configure", "register-codex", "doctor", "inspect", "result", "logs", "finalize", "cleanup", "reconcile", "install", "agents", "configure-agent", "migrate-profile", "service-run", "service-start", "service-stop", "service-status", "submit", "tasks", "wait", "attach", "cancel", "input", "coordinate", "structural-report", "structural-detail"]);
  if (!actions.has(action)) throw new BridgeError("ACTION_UNSUPPORTED", `Unknown action: ${action}`);
  const { values } = decode(process.argv.slice(3));
  startupRequirementFromFlags(values.required, values.optional);
  const bindingFlags = ["project", "profile", "state-root", "expected-repository-id"];
  const registrationFlags = ["server-name", "runtime", "config-path", "replace-binding", "adopt-unmanaged", "development-runtime", "verify-readiness", "tool-timeout-sec", "required", "optional", "yes"];
  const configurationFlags = ["model", "muse-bin", "worktree-root", "confirm-subscription", "max-workers", "max-queued-tasks", "install-codex"];
  const actionFlags: Record<string, string[]> = {
    serve: bindingFlags, start: bindingFlags, inspect: bindingFlags, "service-run": bindingFlags,
    "service-start": bindingFlags, "service-status": bindingFlags,
    "service-stop": [...bindingFlags, "operation-key", "cancel-tasks", "yes"],
    coordinate: [...bindingFlags, "request", "yes", "confirm-external-settled"],
    "structural-report": [...bindingFlags, "work"],
    "structural-detail": [...bindingFlags, "work", "report", "side", "start-byte", "end-byte"],
    submit: [...bindingFlags, "assignment", "yes"], tasks: [...bindingFlags, "offset", "limit", "request-key"],
    wait: [...bindingFlags, "task", "after-revision", "wait-ms"],
    attach: [...bindingFlags, "task", "request-key", "operation-key", "yes"],
    cancel: [...bindingFlags, "task", "control-generation", "operation-key", "reason", "yes"],
    input: [...bindingFlags, "task", "input-id", "control-generation", "operation-key", "answer", "yes"],
    agents: [...bindingFlags, "offset", "limit"],
    "configure-agent": [...bindingFlags, "agent-file", "replace-agent", "yes"],
    "migrate-profile": [...bindingFlags, "yes"],
    setup: [...bindingFlags, ...registrationFlags, "install-codex"],
    configure: [...bindingFlags, ...configurationFlags, ...registrationFlags],
    "register-codex": [...bindingFlags, ...registrationFlags],
    doctor: [...bindingFlags, "prepare", "yes"], result: [...bindingFlags, "task"],
    logs: [...bindingFlags, "task", "follow"], finalize: [...bindingFlags, "operations", "yes"],
    cleanup: [...bindingFlags, "task", "yes"], reconcile: [...bindingFlags, "task", "yes", "confirm-worker-stopped", "owner", "reason"],
    install: ["artifact", "install-root", "yes"],
  };
  for (const key of Object.keys(values)) if (!actionFlags[action]!.includes(key)) throw new BridgeError("ARGUMENT_INAPPLICABLE", `--${key} does not apply to ${action}`);
  if (action === "configure" && !values["install-codex"] && (values.required !== undefined || values.optional !== undefined)) {
    throw new BridgeError("ARGUMENT_INAPPLICABLE", "--required/--optional on configure requires --install-codex");
  }
  if (action === "install") {
    if (!values.yes) throw new BridgeError("INSTALL_AUTHORITY_REQUIRED", "install requires --yes");
    const { installRuntime } = await import("./install/runtime.js");
    console.log(JSON.stringify(await installRuntime(resolve(required(values.artifact, "--artifact")), resolve(required(values["install-root"], "--install-root"))), null, 2)); return;
  }
  for (const [key, value] of Object.entries({ project: values.project, profile: values.profile, state: values["state-root"] })) {
    if (value !== undefined && (!value.length || value.length > 4096 || value.includes("\0"))) throw new BridgeError("PATH_ARGUMENT_INVALID", `${key} must be a bounded path without NUL`);
  }
  if (values["expected-repository-id"] !== undefined && !/^[a-f0-9]{24}$/.test(values["expected-repository-id"])) throw new BridgeError("REPOSITORY_ID_INVALID", "Expected the canonical 24-hex repository identity");
  const intent: LaunchIntent = { project: resolve(required(values.project, "--project")),
    ...(values.profile ? { profilePath: resolve(values.profile) } : {}), ...(values["state-root"] ? { stateRoot: resolve(values["state-root"]) } : {}),
    ...(values["expected-repository-id"] ? { expectedRepositoryId: values["expected-repository-id"] } : {}) };
  // Transport bootstrap deliberately has no profile, repository, store or Muse prerequisites.
  if (action === "serve" || action === "start") {
    const [{ PasseurFrontend }, { runtimeIdentity }, { serve }] = await Promise.all([
      import("./service/client.js"), import("./install/runtime.js"), import("./mcp/server.js"),
    ]);
    await serve(new PasseurFrontend(intent, await runtimeIdentity(runtimeRoot), fileURLToPath(import.meta.url))); return;
  }
  if (action === "service-run") {
    const [{ RepositoryRuntime, resolveRepositoryBinding }, { runtimeIdentity }, { runRepositoryService }] = await Promise.all([
      import("./core/repository-runtime.js"), import("./install/runtime.js"), import("./service/server.js"),
    ]);
    const binding = await resolveRepositoryBinding(intent, process.env, new AbortController().signal);
    const identity = await runtimeIdentity(runtimeRoot);
    await runRepositoryService(new RepositoryRuntime(intent, identity), binding, identity); return;
  }
  if (action === "setup") { await setup(intent, values); return; }
  if (action === "register-codex") { await register(intent, values); return; }
  if (action === "configure") {
    const { resolveRepositoryBinding } = await import("./core/repository-runtime.js");
    const binding = await resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(90_000));
    const profile = await saveProfile(required(binding.profilePath, "--profile or HOME/XDG_CONFIG_HOME"), values);
    if (values["install-codex"]) await register(intent, values);
    else console.log(JSON.stringify({ profile: binding.profilePath, capacity: { workers: profile.execution.max_workers, queued: profile.execution.max_queued_tasks }, configuration: "not_installed", installed_workflow: "not_run" }, null, 2));
    return;
  }
  if (action === "configure-agent" || action === "migrate-profile") {
    if (!values.yes) throw new BridgeError("PROFILE_EDIT_AUTHORITY_REQUIRED", `${action} requires --yes`);
    const [{ resolveRepositoryBinding }, { editProfile }, { readProfileJson }] = await Promise.all([
      import("./core/repository-runtime.js"), import("./core/profile-edit.js"), import("./core/profile.js"),
    ]);
    const binding = await resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(90_000));
    const edit = action === "migrate-profile" ? { kind: "migrate" as const } : {
      kind: "configure-agent" as const, registration: await readProfileJson(required(values["agent-file"], "--agent-file")),
      ...(values["replace-agent"] ? { replace_fingerprint: values["replace-agent"] } : {}),
    };
    console.log(JSON.stringify(await editProfile(required(binding.profilePath, "--profile or HOME/XDG_CONFIG_HOME"), edit), null, 2));
    return;
  }
  const [{ RepositoryRuntime, resolveRepositoryBinding }, { runtimeIdentity }, { PasseurFrontend }, { operatorToken }] = await Promise.all([
    import("./core/repository-runtime.js"), import("./install/runtime.js"), import("./service/client.js"), import("./service/bootstrap.js"),
  ]);
  const identity = await runtimeIdentity(runtimeRoot), runtime = new RepositoryRuntime(intent, identity);
  const stop = new AbortController();
  const interrupt = () => { process.exitCode = 130; stop.abort(new BridgeError("REQUEST_CANCELLED", "Operator observation interrupted")); };
  const terminate = () => { process.exitCode = 143; stop.abort(new BridgeError("REQUEST_CANCELLED", "Operator observation terminated")); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  let frontend: InstanceType<typeof PasseurFrontend> | undefined;
  const connected = async () => {
    if (!frontend) {
      const binding = await resolveRepositoryBinding(intent, process.env, stop.signal);
      const credential = await operatorToken(binding, Boolean(values.yes) || action === "service-start");
      if ((action === "coordinate" || action === "structural-report" || action === "structural-detail") && credential === undefined) throw new BridgeError("COORDINATION_OPERATOR_IDENTITY_UNAVAILABLE", "No persistent operator identity exists for this work");
      frontend = new PasseurFrontend(intent, identity, fileURLToPath(import.meta.url), credential);
    }
    return frontend;
  };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const mutation = () => { if (!values.yes) throw new BridgeError("MUTATION_AUTHORITY_REQUIRED", `${action} requires explicit operator --yes authority`); };
  try {
    if (action === "coordinate") {
      const { runCoordinationCli } = await import("./cli/coordination.js");
      print(await runCoordinationCli(required(values.request, "--request"), Boolean(values.yes), connected, stop.signal, Boolean(values["confirm-external-settled"])));
    } else if (action === "structural-report") print(await (await connected()).call("structural_report", { work_id: required(values.work, "--work") }, stop.signal));
    else if (action === "structural-detail") print(await (await connected()).call("structural_detail", {
      work_id: required(values.work, "--work"), report_id: required(values.report, "--report"),
      side: required(values.side, "--side"), start_byte: integer(required(values["start-byte"], "--start-byte"), "--start-byte")!,
      end_byte: integer(required(values["end-byte"], "--end-byte"), "--end-byte")!,
    }, stop.signal));
    else if (action === "inspect") print(await runtime.inspect());
    else if (action === "result") print(await runtime.result(required(values.task, "--task")));
    else if (action === "logs") {
      let offset = 0;
      do {
        stop.signal.throwIfAborted();
        const bytes = await runtime.logs(required(values.task, "--task"), offset); offset += bytes.length;
        if (bytes.length) await new Promise<void>((resolveWrite, reject) => process.stdout.write(bytes, (error) => error ? reject(error) : resolveWrite()));
        else if (values.follow) await delay(250, undefined, { signal: stop.signal }); else break;
      } while (true);
    } else if (action === "agents") print(await runtime.agents(integer(values.offset, "--offset") ?? 0, integer(values.limit, "--limit") ?? 4));
    else if (action === "doctor") {
      const f = await connected();
      if (values.prepare) mutation();
      const { doctor } = await import("./diagnostics/doctor.js");
      print(await doctor(f, Boolean(values.prepare), stop.signal));
    } else if (action === "service-status") {
      const { readDescriptor, existingOwner } = await import("./service/bootstrap.js");
      const binding = await resolveRepositoryBinding(intent, process.env, stop.signal), descriptor = await readDescriptor(binding);
      print(descriptor ? { state: await existingOwner(descriptor) ? "observed_live" : "observed_dead", generation: descriptor.generation, runtime: descriptor.runtime,
        process: descriptor.process, note: "Process observation is not a readiness or native-worker proof" } : { state: "absent" });
    } else {
      const f = await connected();
      if (action === "service-start") print(await f.call("prepare", {}, stop.signal));
      else if (action === "service-stop") {
        mutation(); print(await f.call("stop", { operation_key: required(values["operation-key"], "--operation-key"), cancel_tasks: values["cancel-tasks"]?.split(",") ?? [] }, stop.signal));
      } else if (action === "submit") {
        mutation();
        const { readProfileJson } = await import("./core/profile.js");
        print(await f.call("submit", await readProfileJson(required(values.assignment, "--assignment")), stop.signal));
      } else if (action === "tasks") print(await f.call("tasks", { schema_version: 1, offset: integer(values.offset, "--offset") ?? 0, limit: integer(values.limit, "--limit") ?? 8, ...(values["request-key"] ? { request_key: values["request-key"] } : {}) }, stop.signal));
      else if (action === "wait") print(await f.call("wait", { schema_version: 1, task_id: required(values.task, "--task"), after_revision: integer(values["after-revision"], "--after-revision") ?? 0, wait_ms: integer(values["wait-ms"], "--wait-ms") ?? 20_000 }, stop.signal));
      else if (action === "attach") {
        mutation(); print(await f.call("attach", { schema_version: 1, ...(values.task ? { task_id: values.task } : {}), ...(values["request-key"] ? { request_key: values["request-key"] } : {}), operation_key: required(values["operation-key"], "--operation-key") }, stop.signal));
      } else if (action === "cancel") {
        mutation(); print(await f.call("cancel", { schema_version: 1, task_id: required(values.task, "--task"), control_generation: integer(values["control-generation"], "--control-generation"),
          operation_key: required(values["operation-key"], "--operation-key"), reason: required(values.reason, "--reason") }, stop.signal));
      } else if (action === "input") {
        mutation();
        const args = { task_id: required(values.task, "--task"), input_id: required(values["input-id"], "--input-id"), control_generation: integer(values["control-generation"], "--control-generation") };
        const input = await f.call("input_claim", args, stop.signal);
        try { print(await f.call("input_answer", { ...args, claim_id: input.claim!.id, operation_key: required(values["operation-key"], "--operation-key"), answer: required(values.answer, "--answer") }, stop.signal)); }
        finally { await f.call("input_dismiss", { ...args, claim_id: input.claim!.id }).catch(() => undefined); }
      } else if (action === "finalize") {
        mutation(); const { readProfileJson } = await import("./core/profile.js"); print(await f.call("finalize", await readProfileJson(required(values.operations, "--operations")), stop.signal));
      } else if (action === "cleanup") { mutation(); print(await f.call("cleanup", { task_id: required(values.task, "--task") }, stop.signal)); }
      else if (action === "reconcile") {
        mutation(); if (!values["confirm-worker-stopped"]) throw new BridgeError("RECONCILIATION_AUTHORITY_REQUIRED", "Reconciliation requires actual process evidence and --confirm-worker-stopped");
        print(await f.call("reconcile", { task_id: required(values.task, "--task"), owner: required(values.owner, "--owner"), reason: required(values.reason, "--reason") }, stop.signal));
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    await frontend?.shutdown(); await runtime.shutdown();
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify(diagnosticInfo(error)));
  if (!process.exitCode) process.exitCode = nativeCode(error) === "ABORT_ERR" ? 130 : 1;
});
