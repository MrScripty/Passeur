import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { CoordinationStore } from "../../src/store/coordination-store.js";
import { CoordinationControl } from "../../src/coordination/control.js";
import { TaskStore } from "../../src/store/task-store.js";
import { canonicalHash } from "../../src/core/async.js";
import { baseResult } from "../../src/core/result.js";
import { reconcileStoredTasks } from "../../src/core/recovery.js";
import { fixture as taskFixture } from "../fixtures/bridge.js";

const repository = "structural-compatibility-fixture";
const owner = { owner_id: "a".repeat(64) }, reader = { owner_id: "b".repeat(64) }, operator = { owner_id: "c".repeat(64) };
const limits = { works: 64, cases: 64, notes: 256, receipts: 1024, note_bytes: 4096 };
const historical = resolve("tests/fixtures/structural/compatibility/metadata-v1.json");

async function metadataFixture(authority: () => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "passeur-structural-migration-"));
  const directory = join(root, "coordination"), file = join(directory, "control.json");
  const source = await readFile(historical);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(file, source, { mode: 0o600 });
  await writeFile(join(directory, "initialized.json"), JSON.stringify({ schema_version: 1,
    repository_id: repository, epoch: "11111111-1111-4111-8111-111111111111" }), { mode: 0o600 });
  const store = await CoordinationStore.open(root, repository, authority);
  const control = new CoordinationControl(store);
  return { root, file, source, store, control, close: async () => { await control.close(); await rm(root, { recursive: true, force: true }); } };
}

async function reopen(root: string) {
  const store = await CoordinationStore.open(root, repository, () => {});
  return { store, control: new CoordinationControl(store) };
}

test("historical v1 inspection is byte preserving; real recovery publishes v2 and reopens its receipt", async () => {
  const f = await metadataFixture();
  try {
    assert.equal((await f.store.snapshot()).schema_version, 1);
    assert.deepEqual(await readFile(f.file), f.source);
    const command = { kind: "register_work" as const, operation_key: randomUUID(), workspace_id: "legacy-worktree",
      input_oid: "1".repeat(40), object_format: "sha1" as const, intent: "historical scope", areas: [], readers: [] };
    const recorded = await f.control.execute(owner, command);
    const work = await f.control.work(owner, recorded.item_id);
    const recovery = { kind: "adopt_work" as const, operation_key: randomUUID(), epoch: (await f.store.snapshot()).epoch,
      work_id: work.id, expected_owner: owner.owner_id, expected_revision: work.revision,
      statement: "Operator inspected the retained work", new_owner: reader.owner_id };
    const receipt = await f.control.recoverAuthorized(operator, recovery);
    const v2 = await readFile(f.file);
    assert.equal((await f.store.snapshot()).schema_version, 2);
    const opened = await reopen(f.root);
    try {
      assert.deepEqual(await opened.control.recoverAuthorized(operator, recovery), receipt);
      assert.equal((await opened.control.work(reader, work.id)).owner, reader.owner_id);
      assert.deepEqual(await readFile(f.file), v2);
    } finally { await opened.control.close(); }
  } finally { await f.close(); }
});

test("managed v3, announcement v4 and source-grant v5 reopen under their current readers", async () => {
  const f = await metadataFixture();
  try {
    const taskId = randomUUID();
    const enrollment = await f.control.execute(owner, { kind: "register_task_work", operation_key: randomUUID(),
      workspace_id: "managed-worktree", input_oid: "1".repeat(40), object_format: "sha1", intent: "managed scope",
      areas: [{ kind: "file", path: "source.ts" }], managed: { task_id: taskId, control_generation: 1,
        intent_truncated: false, areas_source: "allowed_paths" } });
    assert.equal(enrollment.item_id, taskId);
    const v3 = await readFile(f.file);
    assert.equal((await f.store.snapshot()).schema_version, 3);
    const old = await reopen(f.root);
    try { assert.equal((await old.control.work(owner, taskId)).managed?.task_id, taskId); }
    finally { await old.control.close(); }
    assert.deepEqual(await readFile(f.file), v3);
    const announcementId = randomUUID();
    await f.control.announce(owner, { operation_key: randomUUID(), id: announcementId,
      payload_digest: "2".repeat(64), source_view: "/tmp/compatibility-source", assignment_hash: "3".repeat(64),
      areas: [], readers: [] });
    const v4 = await readFile(f.file);
    assert.equal((await f.store.snapshot()).schema_version, 4);
    const announced = await reopen(f.root);
    try { assert.equal((await announced.control.announcement(owner, announcementId)).id, announcementId); }
    finally { await announced.control.close(); }
    assert.deepEqual(await readFile(f.file), v4);
    const work = await f.control.work(owner, taskId);
    await f.control.execute(owner, { kind: "grant_source", operation_key: randomUUID(), work_id: taskId,
      expected_revision: work.revision, recipients: [{ recipient: reader.owner_id, scope: "report" }] });
    const v5 = await readFile(f.file);
    assert.equal((await f.store.snapshot()).schema_version, 5);
    const granted = await reopen(f.root);
    try {
      assert.equal((await granted.control.sourceWork(reader, taskId, "report")).id, taskId);
      await assert.rejects(granted.control.sourceWork(reader, taskId, "detail"), { code: "STRUCTURAL_SOURCE_FORBIDDEN" });
    } finally { await granted.control.close(); }
    assert.deepEqual(await readFile(f.file), v5);
  } finally { await f.close(); }
});

test("unsupported and corrupt metadata refuse reopen and retain source bytes", async () => {
  const f = await metadataFixture();
  try {
    for (const [bytes, code] of [
      [Buffer.from(JSON.stringify({ ...JSON.parse(f.source.toString()), schema_version: 99 })), "COORDINATION_VERSION_UNSUPPORTED"],
      [Buffer.from("{unfinished"), "COORDINATION_RECORD_CORRUPT"],
    ] as const) {
      await writeFile(f.file, bytes);
      await assert.rejects(CoordinationStore.open(f.root, repository, () => {}), { code });
      assert.deepEqual(await readFile(f.file), bytes);
    }
  } finally { await f.close(); }
});

test("failed metadata publication keeps uncertainty and a stale key cannot rewrite a receipt", async () => {
  let armed = false, calls = 0;
  const f = await metadataFixture(() => {
    if (armed && ++calls === 6) throw Object.assign(new Error("publication interrupted"), { code: "AUTHORITY_LOST" });
  });
  try {
    const command = { kind: "register_work" as const, operation_key: randomUUID(), workspace_id: "uncertain-worktree",
      input_oid: "1".repeat(40), object_format: "sha1" as const, intent: "preserve publication uncertainty", areas: [], readers: [] };
    armed = true;
    await assert.rejects(f.control.execute(owner, command), { code: "COORDINATION_PUBLICATION_UNCERTAIN" });
    assert.deepEqual(await readFile(f.file), f.source);
    await assert.rejects(f.control.execute(owner, command), { code: "COORDINATION_REOPEN_REQUIRED" });
    armed = false;
    const opened = await reopen(f.root);
    try {
      const receipt = await opened.control.execute(owner, command);
      const accepted = await readFile(f.file);
      assert.equal((await opened.control.execute(owner, command)).item_id, receipt.item_id);
      await assert.rejects(opened.control.execute(owner, { ...command, intent: "changed after retry" }),
        { code: "COORDINATION_KEY_CONFLICT" });
      assert.deepEqual(await readFile(f.file), accepted);
    } finally { await opened.control.close(); }
  } finally { await f.close(); }
});

test("v4 and v5 task admissions and v4 terminal results reopen without changing their records", async () => {
  const f = await taskFixture();
  try {
    const ordinary = f.admission(f.request(randomUUID()));
    const ordinaryControl = f.initial(ordinary.task_id);
    await f.store.create(ordinary, ordinaryControl);
    const finished = baseResult(ordinary.task_id, ordinary.request, ordinary.execution);
    finished.worker_stop = "confirmed"; finished.execution_status = "failed";
    finished.native_evidence = { ...ordinaryControl.native, state: "stopped" };
    await f.store.writeResult(ordinary.task_id, finished);
    const taskId = randomUUID(), assignment = f.request(randomUUID(), "implement");
    const identity = { schema_version: 2 as const, source_view: f.root, assignment };
    const intentHash = canonicalHash(identity);
    const binding = { schema_version: 1 as const, task_id: taskId, request_key: assignment.request_key,
      owner_id: f.owner.owner_id, intent_hash: intentHash, decision_identity: "d".repeat(64) };
    const coordinated = { ...f.admission(assignment, taskId), schema_version: 5 as const,
      canonical_hash: intentHash, linkage: { ...binding, link_hash: canonicalHash(binding) } };
    await f.store.create(coordinated, f.initial(taskId));
    const ordinaryPath = join(f.store.taskDir(ordinary.task_id), "request.json");
    const resultPath = join(f.store.taskDir(ordinary.task_id), "result.json");
    const coordinatedPath = join(f.store.taskDir(taskId), "request.json");
    const bytes = await Promise.all([readFile(ordinaryPath), readFile(resultPath), readFile(coordinatedPath)]);
    const reopened = new TaskStore(f.state);
    assert.equal((await reopened.durableRequest(ordinary.task_id)).schema_version, 4);
    assert.equal((await reopened.durableRequest(taskId)).schema_version, 5);
    assert.equal((await reopened.readResult(ordinary.task_id))?.schema_version, 4);
    assert.equal(await reopened.readCoordinatedLink(taskId), undefined);
    await reconcileStoredTasks(reopened);
    assert.equal((await reopened.readControl(taskId)).phase, "needs_attention");
    assert.deepEqual(await Promise.all([readFile(ordinaryPath), readFile(resultPath), readFile(coordinatedPath)]), bytes);
  } finally { await f.dispose(); }
});

test("historical v1 task/result files reopen as retained evidence without rewriting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-historical-task-"));
  const taskId = "22222222-2222-4222-8222-222222222222";
  const directory = join(root, "tasks", taskId);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const originals = await Promise.all(["request", "state", "result"].map(async kind => {
      const bytes = await readFile(resolve(`tests/fixtures/structural/compatibility/task-v1-${kind}.json`));
      await writeFile(join(directory, `${kind}.json`), bytes, { mode: 0o600 });
      return bytes;
    }));
    const opened = new TaskStore(root);
    assert.equal((await opened.find({ task_id: taskId }))?.request.schema_version, 1);
    assert.equal((await opened.readState(taskId)).phase, "terminal");
    assert.equal((await opened.readResult(taskId))?.schema_version, 1);
    await assert.rejects(opened.durableRequest(taskId), { code: "TASK_API_UPGRADE_REQUIRED" });
    assert.deepEqual(await Promise.all(["request", "state", "result"].map(kind => readFile(join(directory, `${kind}.json`)))), originals);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsupported and corrupt task admissions do not replace durable bytes", async () => {
  const f = await taskFixture();
  try {
    const record = f.admission(f.request(randomUUID()));
    await f.store.create(record, f.initial(record.task_id));
    const path = join(f.store.taskDir(record.task_id), "request.json");
    for (const [bytes, code] of [
      [Buffer.from(JSON.stringify({ ...record, schema_version: 99 })), "STORE_VERSION_UNSUPPORTED"],
      [Buffer.from("{unfinished"), "STORE_CORRUPT"],
    ] as const) {
      await writeFile(path, bytes);
      await assert.rejects(new TaskStore(f.state).durableRequest(record.task_id), { code });
      assert.deepEqual(await readFile(path), bytes);
    }
  } finally { await f.dispose(); }
});
