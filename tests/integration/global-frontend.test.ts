import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
import { FrontendStatusSchema, type FrontendStatus } from "../../src/contracts/service.js";
import { PasseurFrontend } from "../../src/service/client.js";
import { readDescriptor, existingOwner } from "../../src/service/bootstrap.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { setTimeout as delay } from "node:timers/promises";

it("independent frontend processes elect per repository and preserve worktree source and principal identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-global-process-"));
  const config = join(root, "config"), state = join(root, "state"), first = join(root, "first"), second = join(root, "second"), linked = join(root, "linked");
  const run = promisify(execFile);
  await mkdir(join(config, "muse-bridge"), { recursive: true });
  await writeFile(join(config, "muse-bridge/default-profile.json"), JSON.stringify({ schema_version: 3,
    execution: { implementation: { enabled: false } }, agents: [] }));
  for (const project of [first, second]) {
    await mkdir(project); await run("git", ["-C", project, "init", "-b", "main"]);
    await run("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  }
  await run("git", ["-C", first, "worktree", "add", "-b", "linked", linked]);
  const script = join(root, "frontend.mjs"), cli = resolve("dist/src/cli.js");
  await writeFile(script, `import {PasseurFrontend} from ${JSON.stringify(pathToFileURL(resolve("dist/src/service/client.js")).href)};
import {runtimeIdentity} from ${JSON.stringify(pathToFileURL(resolve("dist/src/install/runtime.js")).href)};
const f=new PasseurFrontend({project:process.cwd()},await runtimeIdentity(process.argv[2]),process.argv[3]);
await f.call('prepare',{}); const identity=await f.coordinate({schema_version:1,kind:'identity'});
console.log(JSON.stringify({status:f.status(),identity}));
process.stdin.resume();process.stdin.on('end',async()=>{await f.shutdown();});`);
  const children: ReturnType<typeof spawn>[] = [];
  const environment = { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const bindings = await Promise.all([first, second].map(project => resolveRepositoryBinding({ project }, environment, AbortSignal.timeout(10_000))));
  type BoundStatus = FrontendStatus & { resolved: NonNullable<FrontendStatus["resolved"]>; service: Extract<FrontendStatus["service"], { state: "connected" }> };
  const launch = async (cwd: string) => {
    const child = spawn(process.execPath, [script, process.cwd(), cli], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
    let output = "", error = ""; child.stderr!.on("data", b => { error += b; });
    const result = new Promise<{ status: BoundStatus; identity: { parent_id: string } }>((yes, no) => {
      child.stdout!.on("data", b => { output += b; if (output.includes("\n")) { try { const value = JSON.parse(output.split("\n")[0]!) as { status: unknown; identity: { parent_id: string } };
          assert.equal(typeof value.identity.parent_id, "string");
          const status = FrontendStatusSchema.parse(value.status);
          if (status.service.state !== "connected" || !status.resolved) throw Error("Frontend did not resolve and connect");
          yes({ status: { ...status, service: status.service, resolved: status.resolved }, identity: value.identity }); } catch (e) { no(e); } } });
      child.once("exit", code => { if (!output.includes("\n")) no(Error(`frontend exited ${code}: ${error}`)); });
    });
    return result;
  };
  try {
    const [a, b, other, worktree] = await Promise.all([launch(first), launch(first), launch(second), launch(linked)]);
    assert.equal(a.status.service.status.generation, b.status.service.status.generation);
    assert.equal(a.status.service.status.generation, worktree.status.service.status.generation);
    assert.notEqual(a.status.service.status.generation, other.status.service.status.generation);
    assert.notEqual(a.identity.parent_id, b.identity.parent_id);
    assert.equal(worktree.status.resolved.source_view, linked);
    assert.equal(a.status.resolved.repository_id, worktree.status.resolved.repository_id);
    assert.notEqual(a.status.resolved.store_root, other.status.resolved.store_root);
    for (const item of [a, b, other, worktree]) {
      assert.equal(item.status.resolved.profile_source, "global");
      assert.equal(item.status.resolved.profile_path, join(config, "muse-bridge/default-profile.json"));
      assert.equal(item.status.frontend.build_id, item.status.service.status.repository.runtime.build_id);
    }
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.stdin!.end(); await exited; }
    }));
    for (const binding of bindings) {
      for (let i = 0; i < 200; i++) { const descriptor = await readDescriptor(binding); if (!descriptor || !await existingOwner(descriptor)) break; await delay(25); }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("accepted tasks remain service-owned after a frontend disconnects and service discovery grants no task control", async () => {
  const { PasseurFrontend } = await import("../../src/service/client.js");
  const { runtimeIdentity } = await import("../../src/install/runtime.js");
  const { randomBytes } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "passeur-owner-process-"));
  const project = join(root, "project"), otherProject = join(root, "other-project"), state = join(root, "state"), profile = join(root, "profile.json"), release = join(root, "release");
  await mkdir(project); await mkdir(otherProject);
  await promisify(execFile)("git", ["-C", project, "init", "-b", "main"]);
  await promisify(execFile)("git", ["-C", otherProject, "init", "-b", "main"]);
  await writeFile(profile, JSON.stringify({ schema_version: 3, execution: { implementation: { enabled: false } },
    agents: [{ agent_id: "fixture", adapter_id: "fixture", options: {} }] }));
  const cli = join(root, "service.mjs"), identity = await runtimeIdentity(process.cwd());
  await writeFile(cli, `import {RepositoryRuntime,resolveRepositoryBinding} from ${JSON.stringify(pathToFileURL(resolve("dist/src/core/repository-runtime.js")).href)};
import {runRepositoryService} from ${JSON.stringify(pathToFileURL(resolve("dist/src/service/server.js")).href)};
import {runtimeIdentity} from ${JSON.stringify(pathToFileURL(resolve("dist/src/install/runtime.js")).href)};
import {access} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';import {randomUUID} from 'node:crypto';
const arg=k=>process.argv[process.argv.indexOf(k)+1];
const intent={project:arg('--project'),profilePath:arg('--profile'),stateRoot:arg('--state-root')};
const identity=await runtimeIdentity(${JSON.stringify(process.cwd())});
const definitions={fixture:{configure:()=>({modes:['review'],contract:'controlled/1',configuration:{},worker:{async run(input){
 const turn_id=randomUUID();await input.onEvent({kind:'turn_started',turn_id});
 while(true){try{await access(${JSON.stringify(release)});break}catch(e){if(e.code!=='ENOENT')throw e;await delay(10)}}
 await input.onEvent({kind:'turn_settled',turn_id,terminal:'completed'});
 return {status:'completed',summary:'controlled process completed',worker_stop:'confirmed',worker_assessment:'met',blockers:[],questions:[],checks:[]};
}}})}};
const binding=await resolveRepositoryBinding(intent,{},AbortSignal.timeout(10000));
await runRepositoryService(new RepositoryRuntime(intent,identity,{definitions},{}),binding,identity);`);
  const intent = { project, stateRoot: state, profilePath: profile }, owner = randomBytes(32).toString("hex");
  const a = new PasseurFrontend(intent, identity, cli, owner), b = new PasseurFrontend(intent, identity, cli);
  const independent = new PasseurFrontend({ ...intent, project: otherProject }, identity, cli);
  const binding = await resolveRepositoryBinding(intent, {}, AbortSignal.timeout(10_000));
  const independentBinding = await resolveRepositoryBinding({ ...intent, project: otherProject }, {}, AbortSignal.timeout(10_000));
  let reopened: InstanceType<typeof PasseurFrontend> | undefined;
  try {
    await Promise.all([a.call("prepare", {}), b.call("prepare", {})]);
    const submit = (frontend: InstanceType<typeof PasseurFrontend>, key: string) => frontend.call("submit", {
      schema_version: 1, assignment: { schema_version: 3, request_key: key, agent_id: "fixture", mode: "review", objective: "Controlled lifetime fixture", context: "", acceptance_criteria: ["Complete after fixture release"] },
    });
    const [one, two] = await Promise.all([submit(a, "owner-a"), submit(b, "owner-b")]);
    assert.notEqual(one.task.task_id, two.task.task_id);
    const lookup = (task_id: string) => ({ schema_version: 1, task_id, after_revision: 0, wait_ms: 1 });
    await assert.rejects(b.call("wait", lookup(one.task.task_id)), { code: "TASK_CONTROL_CONFLICT" });
    const separate = await independent.call("prepare", {});
    assert.notEqual(separate.generation, (await b.call("status", {})).generation);
    assert.equal(separate.repository.coordination.state, "ready");
    await a.shutdown();
    const current = b.status().service;
    assert.equal((await b.call("status", {})).generation, current.state === "connected" ? current.status.generation : "");
    await writeFile(release, "released");
    reopened = new PasseurFrontend(intent, identity, cli, owner);
    for (const [frontend, task] of [[reopened, one.task], [b, two.task]] as const) {
      let observation = task;
      const budget = AbortSignal.timeout(10_000);
      while (observation.phase !== "terminal") {
        observation = (await frontend.call("wait", { schema_version: 1, task_id: task.task_id, after_revision: observation.revision, wait_ms: 1000 }, budget)).task;
      }
      assert.equal(observation.outcome, "completed");
    }
  } finally {
    await writeFile(release, "released");
    await Promise.all([a.shutdown(), b.shutdown(), independent.shutdown(), reopened?.shutdown()]);
    for (const selected of [binding, independentBinding]) {
      for (let i = 0; i < 200; i++) { const descriptor = await readDescriptor(selected); if (!descriptor || !await existingOwner(descriptor)) break; await delay(25); }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("service startup inherits the frontend's captured allowlisted environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-launch-environment-"));
  const project = join(root, "project"), config = join(root, "config"), state = join(root, "state");
  const keys = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "PASSEUR_OBSERVATION_MONITOR"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let frontend: PasseurFrontend | undefined;
  let binding: Awaited<ReturnType<typeof resolveRepositoryBinding>> | undefined;
  try {
    await mkdir(join(config, "muse-bridge"), { recursive: true }); await mkdir(project);
    await writeFile(join(config, "muse-bridge/default-profile.json"), JSON.stringify({ schema_version: 3,
      execution: { implementation: { enabled: false } }, agents: [] }));
    await promisify(execFile)("git", ["-C", project, "init", "-b", "main"]);
    process.env.XDG_CONFIG_HOME = config; process.env.XDG_STATE_HOME = state; process.env.PASSEUR_OBSERVATION_MONITOR = "off";
    const { runtimeIdentity } = await import("../../src/install/runtime.js");
    const identity = await runtimeIdentity(process.cwd());
    frontend = new PasseurFrontend({ project }, identity, resolve("dist/src/cli.js"));
    binding = await resolveRepositoryBinding({ project }, process.env, AbortSignal.timeout(10_000));
    process.env.PASSEUR_OBSERVATION_MONITOR = "invalid-after-frontend-launch";
    const status = await frontend.call("prepare", {});
    assert.equal(status.repository.coordination.state, "ready");
  } finally {
    await frontend?.shutdown();
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (binding) for (let i = 0; i < 200; i++) {
      const descriptor = await readDescriptor(binding);
      if (!descriptor || !await existingOwner(descriptor)) break;
      await delay(25);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);


it("configure writes the installation default and leaves existing repository overrides intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-global-configure-"));
  const project = join(root, "project"), config = join(root, "config"), state = join(root, "state");
  await mkdir(project);
  const environment = { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
  const before = await resolveRepositoryBinding({ project }, environment, AbortSignal.timeout(10_000));
  const local = join(config, "muse-bridge/projects", `${before.repositoryId}.json`);
  await mkdir(join(config, "muse-bridge/projects"), { recursive: true }); await writeFile(local, "existing repository bytes");
  try {
    const result = await promisify(execFile)(process.execPath, [resolve("dist/src/cli.js"), "configure", "--project", project, "--model", "fixture-model"], { env: environment });
    const fallback = join(config, "muse-bridge/default-profile.json");
    assert.equal(JSON.parse(result.stdout).profile, fallback);
    assert.equal(JSON.parse(await readFile(fallback, "utf8")).schema_version, 3);
    assert.equal(await readFile(local, "utf8"), "existing repository bytes");
    assert.equal((await resolveRepositoryBinding({ project }, environment, AbortSignal.timeout(10_000))).profilePath, local);
  } finally { await rm(root, { recursive: true, force: true }); }
});
