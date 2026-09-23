import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { CoordinationControl } from "../../src/coordination/control.js";
import { canonicalHash } from "../../src/core/async.js";
import { CoordinationStore } from "../../src/store/coordination-store.js";
import { fixture as taskFixture } from "../fixtures/bridge.js";

const run = promisify(execFile);
const historicalRevision = "2de20c756a375c726311767cd78b968c1161fdad"; // Committed F9 reader.
const repositoryId = "structural-cutover-fixture";
const owner = { owner_id: "a".repeat(64) };
const recipient = "b".repeat(64);
const limits = { works: 64, cases: 64, notes: 256, receipts: 1024, note_bytes: 4096 };

async function historicalReader(root: string, coordinationRoot: string, taskRoot: string, taskId: string) {
  const source = join(root, "historical");
  await mkdir(source, { mode: 0o700 });
  // A committed source archive executes its own codecs. Only the already pinned
  // dependency closure is shared, so no historical package install mutates state.
  const { stdout: archive } = await run("git", ["archive", "--format=tar", historicalRevision, "src"],
    { cwd: process.cwd(), encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const tar = join(root, "historical.tar");
  await writeFile(tar, archive);
  await run("tar", ["-xf", tar, "-C", source]);
  await writeFile(join(source, "package.json"), '{"type":"module"}\n');
  await symlink(resolve("node_modules"), join(source, "node_modules"), "dir");
  const script = join(source, "read.mjs");
  const resultFile = join(root, "historical-result.json");
  await writeFile(script, `
import { writeFile } from "node:fs/promises";
import { CoordinationStore } from "./src/store/coordination-store.ts";
import { TaskStore } from "./src/store/task-store.ts";
const [coordinationRoot, taskRoot, taskId, resultFile] = process.argv.slice(2);
const result = {};
try { await CoordinationStore.open(coordinationRoot, ${JSON.stringify(repositoryId)}, () => {}); result.metadata = "accepted"; }
catch (error) { result.metadata = error.code ?? error.name; }
try { await new TaskStore(taskRoot).durableRequest(taskId); result.task = "accepted"; }
catch (error) { result.task = error.code ?? error.name; }
await writeFile(resultFile, JSON.stringify(result));
`);
  const childEnvironment = { ...process.env, NODE_OPTIONS: "" };
  await run("node", ["--import", "tsx", script, coordinationRoot, taskRoot, taskId, resultFile],
    { cwd: source, env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(await readFile(resultFile, "utf8")) as { metadata: string; task: string };
}

test("committed F9 reader refuses current metadata and task admission without rolling state backward", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-cutover-"));
  const stateRoot = join(root, "metadata");
  const tasks = await taskFixture();
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    const store = await CoordinationStore.initialize(stateRoot, repositoryId, limits, () => {});
    const control = new CoordinationControl(store);
    const registered = await control.execute(owner, { kind: "register_work", operation_key: randomUUID(),
      workspace_id: "source-worktree", input_oid: "1".repeat(40), object_format: "sha1",
      intent: "cutover source", areas: [{ kind: "file", path: "source.ts" }], readers: [] });
    const work = await control.work(owner, registered.item_id);
    await control.execute(owner, { kind: "grant_source", operation_key: randomUUID(), work_id: work.id,
      expected_revision: work.revision, recipients: [{ recipient, scope: "report" }] });
    const granted = await control.work(owner, registered.item_id);
    await control.execute(owner, { kind: "watch_source", operation_key: randomUUID(), work_id: work.id,
      expected_revision: granted.revision, watchers: [{ recipient, regions: [{ kind: "file", path: "source.ts" }] }] });
    assert.equal((await store.snapshot()).schema_version, 6);

    const taskId = randomUUID(), assignment = tasks.request(randomUUID(), "implement");
    const identity = { schema_version: 2 as const, source_view: tasks.root, assignment };
    const intentHash = canonicalHash(identity);
    const binding = { schema_version: 1 as const, task_id: taskId, request_key: assignment.request_key,
      owner_id: tasks.owner.owner_id, intent_hash: intentHash, decision_identity: "d".repeat(64) };
    await tasks.store.create({ ...tasks.admission(assignment, taskId), schema_version: 5,
      canonical_hash: intentHash, linkage: { ...binding, link_hash: canonicalHash(binding) } }, tasks.initial(taskId));

    const metadataPath = join(stateRoot, "coordination", "control.json");
    const taskPath = join(tasks.store.taskDir(taskId), "request.json");
    const before = await Promise.all([readFile(metadataPath), readFile(taskPath)]);
    const result = await historicalReader(root, stateRoot, tasks.state, taskId);
    assert.deepEqual(result, { metadata: "COORDINATION_VERSION_UNSUPPORTED", task: "STORE_VERSION_UNSUPPORTED" });
    assert.deepEqual(await Promise.all([readFile(metadataPath), readFile(taskPath)]), before);
    assert.equal((await store.snapshot()).schema_version, 6);
    assert.equal((await tasks.store.durableRequest(taskId)).schema_version, 5);
    await control.close();
  } finally {
    await tasks.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("real bounded tmpfs ENOSPC leaves acknowledged metadata readable and requires reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-cutover-enospc-"));
  const stateRoot = join(root, "state");
  const resultFile = join(root, "result.json");
  const script = join(root, "publish.mjs");
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    const storeModule = pathToFileURL(resolve("src/store/coordination-store.ts")).href;
    const controlModule = pathToFileURL(resolve("src/coordination/control.ts")).href;
    await writeFile(script, `
import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoordinationStore } from ${JSON.stringify(storeModule)};
import { CoordinationControl } from ${JSON.stringify(controlModule)};
const [stateRoot, resultFile] = process.argv.slice(2);
await chmod(stateRoot, 0o700);
const repositoryId = ${JSON.stringify(repositoryId)};
const actor = { owner_id: "a".repeat(64) };
const store = await CoordinationStore.initialize(stateRoot, repositoryId,
  ${JSON.stringify(limits)}, () => {});
const control = new CoordinationControl(store);
const path = join(stateRoot, "coordination", "control.json");
let before, failure, completed = 0;
for (let index = 0; index < 64; index++) {
  before = await readFile(path);
  try {
    await control.execute(actor, { kind: "register_work", operation_key: randomUUID(),
      workspace_id: "workspace-" + index, input_oid: "1".repeat(40), object_format: "sha1",
      intent: "x".repeat(3900), areas: [], readers: [] });
    completed++;
  } catch (error) {
    failure = { code: error.code, native: error.cause?.code, stage: error.context?.stage };
    break;
  }
}
const after = await readFile(path);
let postFailureOutcome;
try { await control.execute(actor, { kind: "register_work", operation_key: randomUUID(),
  workspace_id: "retry", input_oid: "1".repeat(40), object_format: "sha1", intent: "retry", areas: [], readers: [] }); }
catch (error) { postFailureOutcome = error.code; }
await control.close();
for (const name of await readdir(join(stateRoot, "coordination"))) {
  if (/^control\\.json\\..+\\.tmp$/.test(name)) await rm(join(stateRoot, "coordination", name));
}
const reopened = await CoordinationStore.open(stateRoot, repositoryId, () => {});
const snapshot = await reopened.snapshot();
await reopened.close();
await writeFile(resultFile, JSON.stringify({ completed, failure, postFailureOutcome,
  bytesPreserved: before?.equals(after), revision: snapshot.revision,
  reopenedBytesPreserved: after.equals(await readFile(path)) }));
`);
    await run("bwrap", ["--die-with-parent", "--ro-bind", "/", "/", "--bind", root, root,
      "--size", String(128 * 1024), "--tmpfs", stateRoot, "--", process.execPath,
      "--import", "tsx", script, stateRoot, resultFile],
    { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "" }, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(await readFile(resultFile, "utf8")) as {
      completed: number; failure: { code: string; native: string; stage: string }; postFailureOutcome: string;
      bytesPreserved: boolean; revision: number; reopenedBytesPreserved: boolean;
    };
    assert.ok(result.completed > 0 && result.completed < 64);
    assert.deepEqual(result.failure, { code: "COORDINATION_PUBLICATION_UNCERTAIN", native: "ENOSPC", stage: "coordination.publish" });
    assert.equal(result.postFailureOutcome, "COORDINATION_REOPEN_REQUIRED");
    assert.equal(result.bytesPreserved, true);
    assert.equal(result.reopenedBytesPreserved, true);
    assert.equal(result.revision, result.completed);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
