import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
import * as TOML from "smol-toml";
import { QUALIFIED_LEGACY_BUILD } from "../../src/contracts/service.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { effectiveProfileFingerprint, decodeSharedProfile } from "../../src/core/profile.js";
import { runtimeIdentity } from "../../src/install/runtime.js";
import { PasseurFrontend } from "../../src/service/client.js";
import { existingOwner, preparePaths, readDescriptor } from "../../src/service/bootstrap.js";
import { installCodexMcpRegistration, registrationFingerprint, renderCodexMcpToml, CODEX_ENABLED_TOOLS, type CodexMcpRegistration } from "../../src/codex/config.js";

const legacyRoot = process.env.PASSEUR_LEGACY_RUNTIME ?? `/home/jeremy/.local/share/passeur/runtimes/${QUALIFIED_LEGACY_BUILD}`;
const legacyCli = join(legacyRoot, "dist/src/cli.js");
const legacyRuntimeAvailable = await access(join(legacyRoot, "runtime-manifest.json")).then(() => true, () => false);

async function waitForServiceExit(binding: Awaited<ReturnType<typeof resolveRepositoryBinding>>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const descriptor = await readDescriptor(binding);
    if (!descriptor || !(await existingOwner(descriptor))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Disposable qualification service did not stop after its accepted task settled");
}

async function submitThroughPriorFrontend(options: {
  project: string; stateRoot: string; profilePath: string; ownerToken: string; requestKey: string;
  legacyRoot: string; legacyCli: string; outputFile: string;
}): Promise<void> {
  const script = `import {writeFile} from 'node:fs/promises';
import {PasseurFrontend} from ${JSON.stringify(pathToFileURL(join(options.legacyRoot, "dist/src/service/client.js")).href)};
import {runtimeIdentity} from ${JSON.stringify(pathToFileURL(join(options.legacyRoot, "dist/src/install/runtime.js")).href)};
const [project,stateRoot,profilePath,ownerToken,requestKey,legacyRoot,legacyCli,outputFile]=process.argv.slice(2);
const frontend=new PasseurFrontend({project,stateRoot,profilePath},await runtimeIdentity(legacyRoot),legacyCli,ownerToken);
try {
  await frontend.call('prepare',{});
  const accepted=await frontend.call('submit',{schema_version:1,assignment:{schema_version:3,request_key:requestKey,agent_id:'muse',mode:'review',objective:'Keep accepted upgrade fixture work alive',context:'This is disposable lifecycle qualification with a controlled worker in the prior service.',acceptance_criteria:['Remain active until the owner explicitly cancels']}});
  let task=accepted.task;
  for(let attempt=0;attempt<30 && task.phase!=='active' && task.phase!=='awaiting_input' && task.phase!=='needs_attention' && task.phase!=='terminal';attempt++) {
    const observed=await frontend.call('wait',{schema_version:1,task_id:task.task_id,after_revision:task.revision,wait_ms:500}); task=observed.task;
  }
  if(task.phase==='terminal') {
    let retained;
    try { retained=await frontend.retained({task_id:task.task_id,section:'result',encoding:'utf8',offset:0,limit:8192}); } catch(error) { retained={error:String(error)}; }
    throw new Error('Legacy fixture task ended before upgrade: '+JSON.stringify({task,retained}));
  }
  await writeFile(outputFile,JSON.stringify({task,ownerToken,service:(await frontend.call('status',{})).generation}));
} finally { await frontend.shutdown(); }
`;
  const runner = join(options.project, ".passeur-upgrade-owner.mjs");
  await writeFile(runner, script, { mode: 0o600 });
  const child = spawn(process.execPath, [runner, options.project, options.stateRoot, options.profilePath, options.ownerToken,
    options.requestKey, options.legacyRoot, options.legacyCli, options.outputFile], {
    cwd: options.project, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Prior-build owner process timed out")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); if (code === 0) resolveExit(code); else reject(new Error(`Prior-build owner exited ${code}: ${stderr}\n${stdout}`)); });
  });
  assert.equal(exit, 0);
  return;
}

async function startPriorService(options: {
  project: string; stateRoot: string; profilePath: string; legacyRoot: string;
  binding: Awaited<ReturnType<typeof resolveRepositoryBinding>>; environment: NodeJS.ProcessEnv;
}): Promise<ChildProcess> {
  const script = join(dirname(options.project), "legacy-service.mjs");
  const body = `import {RepositoryRuntime,resolveRepositoryBinding} from ${JSON.stringify(pathToFileURL(join(options.legacyRoot, "dist/src/core/repository-runtime.js")).href)};
import {runRepositoryService} from ${JSON.stringify(pathToFileURL(join(options.legacyRoot, "dist/src/service/server.js")).href)};
import {runtimeIdentity} from ${JSON.stringify(pathToFileURL(join(options.legacyRoot, "dist/src/install/runtime.js")).href)};
const [project,stateRoot,profilePath,legacyRoot]=process.argv.slice(2);
const intent={project,stateRoot,profilePath};
const identity=await runtimeIdentity(legacyRoot);
const definitions={muse:{configure(){return {
 contract:'upgrade-fixture/1',modes:['review','implement'],configuration:{fixture:'prior-service-upgrade'},
 worker:{async run(input){
  await input.onEvent({kind:'turn_started',turn_id:'upgrade-fixture-turn'});
  await new Promise(resolve=>{if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',resolve,{once:true});});
  return {status:'cancelled',summary:'Upgrade fixture task explicitly cancelled after ownership verification',worker_stop:'confirmed',worker_assessment:'unknown',blockers:[],questions:[],checks:[]};
 }}
};}}};
const binding=await resolveRepositoryBinding(intent,process.env,AbortSignal.timeout(10000));
await runRepositoryService(new RepositoryRuntime(intent,identity,{definitions}),binding,identity);
`;
  await writeFile(script, body, { mode: 0o600 });
  const paths = await preparePaths(options.binding);
  const child = spawn("flock", ["--nonblock", "--no-fork", "--conflict-exit-code", "75", paths.guard,
    process.execPath, script, options.project, options.stateRoot, options.profilePath, options.legacyRoot], {
    cwd: options.project, env: options.environment, stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr?.setEncoding("utf8"); child.stderr?.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(options.binding);
    if (descriptor && await existingOwner(descriptor)) return child;
    if (child.exitCode !== null) throw new Error(`Prior-build service exited ${child.exitCode}: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.stdin?.end();
  throw new Error(`Prior-build service did not publish a live descriptor: ${stderr}`);
}

it.skipIf(!legacyRuntimeAvailable)("registration-only upgrade joins an active prior-build service and initializes an unrelated repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-profile-upgrade-"));
  const config = join(root, "config"), codexConfig = join(root, "codex", "config.toml"), state = join(root, "state");
  const home = join(root, "home"), project = join(root, "existing"), unseen = join(root, "unseen");
  const projects = join(config, "muse-bridge", "projects"), cli = resolve("dist/src/cli.js");
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  const priorEnvironment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let existingBinding: Awaited<ReturnType<typeof resolveRepositoryBinding>> | undefined;
  let unseenBinding: Awaited<ReturnType<typeof resolveRepositoryBinding>> | undefined;
  let modern: PasseurFrontend | undefined, unrelated: PasseurFrontend | undefined, originalOwner: PasseurFrontend | undefined;
  let priorService: ChildProcess | undefined, cleanupTask: { task_id: string; revision: number; control_generation: number; phase: string } | undefined;
  let cleanupOwnerToken: string | undefined;
  try {
    await Promise.all([mkdir(project, { recursive: true }), mkdir(unseen), mkdir(home), mkdir(projects, { recursive: true })]);
    const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
    for (const repository of [project, unseen]) {
      await promisify(execFile)("git", ["-C", repository, "init", "-b", "main"]);
      await promisify(execFile)("git", ["-C", repository, "config", "user.name", "Passeur upgrade fixture"]);
      await promisify(execFile)("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
      await promisify(execFile)("git", ["-C", repository, "config", "commit.gpgsign", "false"]);
    }
    existingBinding = await resolveRepositoryBinding({ project, stateRoot: state }, environment, AbortSignal.timeout(10_000));
    unseenBinding = await resolveRepositoryBinding({ project: unseen, stateRoot: state }, environment, AbortSignal.timeout(10_000));

    const profile = decodeSharedProfile({ schema_version: 3, execution: { implementation: { enabled: false } }, agents: [{
      agent_id: "muse", adapter_id: "muse", description: "Controlled prior-build upgrade task", enabled: true, modes: ["review"],
      options: { muse_bin: "muse", model: "fixture-model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" },
        implementation: { sandbox_network: "restricted" }, subscription: { provenance: "user_confirmed",
          verified_at: "2026-09-30T00:00:00.000Z", note: "Disposable configuration-only qualification" } },
    }] });
    const profilePath = join(projects, `${existingBinding.repositoryId}.json`);
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });

    const oldIdentity = await runtimeIdentity(legacyRoot), priorRegistration: CodexMcpRegistration = {
      server_name: "passeur", command: process.execPath,
      args: [legacyCli, "serve", "--project", project, "--profile", profilePath, "--state-root", state, "--expected-repository-id", existingBinding.repositoryId],
      cwd: legacyRoot, env: {}, startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: CODEX_ENABLED_TOOLS,
      project, profile: profilePath, state_root: state, repository_id: existingBinding.repositoryId,
      build_id: oldIdentity.build_id, development: false,
    };
    const priorConfig = renderCodexMcpToml(priorRegistration);
    await mkdir(join(root, "codex"), { recursive: true }); await writeFile(codexConfig, priorConfig, { mode: 0o600 });
    const parsedPrior = TOML.parse(priorConfig) as { mcp_servers: Record<string, unknown> };
    const replaceBinding = registrationFingerprint(parsedPrior.mcp_servers.passeur);

    for (const key of keys) process.env[key] = environment[key];
    const ownerToken = "b".repeat(64), outputFile = join(root, "accepted.json");
    cleanupOwnerToken = ownerToken;
    priorService = await startPriorService({ project, stateRoot: state, profilePath, legacyRoot, binding: existingBinding, environment });
    await submitThroughPriorFrontend({ project, stateRoot: state, profilePath, ownerToken, requestKey: "upgrade-live-task",
      legacyRoot, legacyCli, outputFile });
    const upgradeTask = JSON.parse(await readFile(outputFile, "utf8")) as {
      task: { task_id: string; revision: number; control_generation: number; phase: string; outcome?: string };
      ownerToken: string;
    };
    cleanupTask = upgradeTask.task;
    assert.equal(upgradeTask.ownerToken, ownerToken);
    assert.ok(["active", "awaiting_input", "needs_attention"].includes(upgradeTask.task.phase));
    const legacyDescriptor = await readDescriptor(existingBinding);
    assert.equal(legacyDescriptor?.runtime.build_id, QUALIFIED_LEGACY_BUILD);
    assert.ok(await existingOwner(legacyDescriptor!));

    const currentIdentity = await runtimeIdentity(process.cwd());
    const globalRegistration: CodexMcpRegistration = {
      server_name: "passeur", command: process.execPath, args: [cli, "serve", "--state-root", state],
      env: {}, startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: CODEX_ENABLED_TOOLS,
      state_root: state, build_id: currentIdentity.build_id, development: true,
    };
    const installed = await installCodexMcpRegistration(globalRegistration, {
      configPath: codexConfig, replaceBinding, verify: async () => {},
    });
    assert.equal(installed.configuration, "passed");
    const migrated = decodeSharedProfile(JSON.parse(await readFile(join(config, "muse-bridge", "default-profile.json"), "utf8")));
    assert.equal(effectiveProfileFingerprint(migrated), effectiveProfileFingerprint(profile));
    const published = TOML.parse(await readFile(codexConfig, "utf8")) as { mcp_servers: Record<string, Record<string, unknown>> };
    const globalServer = published.mcp_servers.passeur; assert.ok(globalServer);
    assert.equal(globalServer.cwd, undefined);
    assert.ok(!(globalServer.args as string[]).includes("--project"));
    assert.ok(!(globalServer.args as string[]).includes("--profile"));

    modern = new PasseurFrontend({ project, stateRoot: state }, currentIdentity, cli);
    unrelated = new PasseurFrontend({ project: unseen, stateRoot: state }, currentIdentity, cli);
    const [catalog, status, newStatus] = await Promise.all([modern.agents(0, 4), modern.call("status", {}), unrelated.call("prepare", {})]);
    assert.equal(catalog.agents[0]?.agent_id, "muse");
    const attached = modern.status().service;
    assert.equal(attached.state, "connected");
    if (attached.state === "connected") assert.equal(attached.status.repository.runtime.build_id, QUALIFIED_LEGACY_BUILD);
    assert.equal(status.service_contract, undefined, "the old service remains the authority for its generation");
    assert.equal(legacyDescriptor?.profile_path, profilePath);
    assert.notEqual(upgradeTask.task.phase, "terminal");

    assert.equal(newStatus.service_contract, "passeur-service-v2");
    assert.equal(newStatus.profile_fingerprint, effectiveProfileFingerprint(migrated));
    assert.equal((await unrelated.agents(0, 4)).agents[0]?.agent_id, "muse");
    assert.notEqual(newStatus.generation, status.generation);

    const independent = new PasseurFrontend({ project, stateRoot: state }, currentIdentity, cli);
    try {
      assert.equal((await independent.call("tasks", { schema_version: 1, offset: 0, limit: 16 })).tasks.length, 0);
      await assert.rejects(independent.call("wait", { schema_version: 1, task_id: upgradeTask.task.task_id,
        after_revision: upgradeTask.task.revision, wait_ms: 1 }), { code: "TASK_CONTROL_CONFLICT" });
    } finally { await independent.shutdown(); }

    originalOwner = new PasseurFrontend({ project, stateRoot: state }, currentIdentity, cli, ownerToken);
    const owned = (await originalOwner.call("wait", { schema_version: 1, task_id: upgradeTask.task.task_id,
      after_revision: upgradeTask.task.revision, wait_ms: 1 })).task;
    assert.notEqual(owned.phase, "terminal");
    await originalOwner.call("cancel", { schema_version: 1, task_id: upgradeTask.task.task_id, control_generation: owned.control_generation,
      operation_key: "upgrade-test-cleanup", reason: "End the controlled test fixture after upgrade ownership verification" });
    let terminal = owned;
    for (let attempt = 0; attempt < 30 && terminal.phase !== "terminal"; attempt++) {
      terminal = (await originalOwner.call("wait", { schema_version: 1, task_id: upgradeTask.task.task_id,
        after_revision: terminal.revision, wait_ms: 500 })).task;
    }
    assert.equal(terminal.phase, "terminal"); assert.equal(terminal.outcome, "cancelled");
  } finally {
    if (cleanupTask && cleanupOwnerToken) {
      originalOwner ??= new PasseurFrontend({ project, stateRoot: state }, await runtimeIdentity(process.cwd()), resolve("dist/src/cli.js"), cleanupOwnerToken);
      try {
        const current = (await originalOwner.call("wait", { schema_version: 1, task_id: cleanupTask.task_id,
          after_revision: cleanupTask.revision, wait_ms: 1 })).task;
        if (current.phase !== "terminal") await originalOwner.call("cancel", { schema_version: 1, task_id: cleanupTask.task_id,
          control_generation: current.control_generation, operation_key: "upgrade-test-cleanup-fallback",
          reason: "End the controlled test fixture during teardown" });
      } catch { /* Preserve test evidence if the service has already settled or exited. */ }
      if (originalOwner) {
        let current = cleanupTask;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            current = (await originalOwner.call("wait", { schema_version: 1, task_id: cleanupTask.task_id,
              after_revision: current.revision, wait_ms: 250 })).task;
            if (current.phase === "terminal") break;
          } catch { break; }
        }
      }
    }
    await Promise.allSettled([modern?.shutdown(), unrelated?.shutdown(), originalOwner?.shutdown()]);
    priorService?.stdin?.end();
    if (existingBinding) await waitForServiceExit(existingBinding).catch(() => {});
    if (unseenBinding) await waitForServiceExit(unseenBinding).catch(() => {});
    if (priorService && priorService.exitCode === null) await new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { priorService?.kill("SIGTERM"); resolveExit(); }, 5_000);
      priorService?.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key as typeof keys[number]];
      else process.env[key as typeof keys[number]] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
