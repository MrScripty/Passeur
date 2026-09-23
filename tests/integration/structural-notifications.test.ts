import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { test, onTestFinished } from "vitest";
// @ts-expect-error Shared real-Git fixture has no TypeScript declaration.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { responseSchemas } from "../../src/contracts/service.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { existingOwner, launchService, readDescriptor } from "../../src/service/bootstrap.js";

const execute = promisify(execFile);
const cli = resolve("dist/src/cli.js");
function body(reply: unknown): unknown {
  const result = reply as { structuredContent?: unknown; content?: { text?: string }[] };
  return result.structuredContent ?? JSON.parse(result.content![0]!.text!);
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: `passeur_${name}`, arguments: args }, undefined, { timeout: 30_000 });
  assert.notEqual(result.isError, true, JSON.stringify(body(result)));
  return body(result);
}
async function command(client: Client, command: Record<string, unknown>): Promise<unknown> {
  return call(client, "work", { request: { schema_version: 1, kind: "command", command } });
}

test("public observation handles replacement, deletion, repair and durable quiet notices", async () => {
  const f = await serviceFixture({ name: "public structural notices", after: onTestFinished });
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json");
  const common = ["--project", f.root, "--state-root", f.state, "--profile", profile];
  const request = join(f.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  await execute(process.execPath, [cli, "coordinate", ...common, "--request", request, "--yes"], { timeout: 20_000 });
  const connect = async () => {
    const next = new Client({ name: "structural-notice-public-test", version: "1" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", ...common], cwd: process.cwd(), stderr: "pipe" });
    await next.connect(transport, { timeout: 10_000 });
    return next;
  };
  let client = await connect();
  f.sessions.push({ close: () => client.close() });

  const registrationKey = randomUUID();
  const registration = body(await client.callTool({ name: "passeur_work", arguments: { request: {
    schema_version: 1, kind: "command", command: { kind: "register_external_work", operation_key: registrationKey,
      input_oid: f.base, intent: "Observe declared source", areas: [{ kind: "file", path: "source.ts" }], readers: [] },
  } } }));
  const work = (registration as { receipt: { item_id: string } }).receipt.item_id;
  const identity = await call(client, "coordination", { request: { schema_version: 1, kind: "identity" } });
  const ownerId = (identity as { parent_id: string }).parent_id;
  await call(client, "work", { request: { schema_version: 1, kind: "command", command: {
    kind: "watch_source", operation_key: randomUUID(), work_id: work, expected_revision: 1,
    watchers: [{ recipient: ownerId, regions: [{ kind: "file", path: "source.ts" }] }],
  } } });
  const refresh = async () => responseSchemas.structural_refresh.parse(await call(client, "structural_refresh", { work_id: work }));
  const pull = async (cursor = 0) => responseSchemas.structural_notice_pull.parse(await call(client, "structural_notice_pull", { cursor }));
  await writeFile(join(f.root, "source.ts"), "export function run() { return 1; }\n");
  const initial = await refresh();
  assert.ok(["published", "unchanged"].includes(initial.status));
  const first = await pull();
  assert.ok(first.notices.length > 0, "initial native observation must produce a notice");
  const firstId = first.notices.at(-1)!.id;
  assert.equal((await pull()).notices.at(-1)?.id, firstId, "pull cannot consume an unacknowledged notice");
  await refresh();
  assert.equal((await pull()).notices.length, first.notices.length);

  const currentId = async () => responseSchemas.structural_current.parse(await call(client, "structural_current", {}))
    .reports.find(row => row.work_id === work && row.path === "source.ts")?.id;
  const firstCurrent = await currentId();
  assert.ok(firstCurrent);
  let previousCurrent = firstCurrent;
  for (const value of [2, 3]) {
    const bytes = `export function run() { return ${value}; }\n`;
    await writeFile(join(f.root, "source.ts"), bytes);
    await refresh();
    assert.deepEqual((await pull()).notices.map(item => item.id), first.notices.map(item => item.id),
      "body-only revisions with unchanged materiality must not produce repeat notices");
    const artifactId = await currentId();
    assert.ok(artifactId && artifactId !== previousCurrent, "current must advance to the latest exact capture");
    previousCurrent = artifactId;
    const latestDetail = responseSchemas.structural_artifact_detail.parse(await call(client, "structural_artifact_detail", {
      artifact_id: artifactId, side: "observed", start_byte: 0, end_byte: Buffer.byteLength(bytes),
    }));
    assert.equal(latestDetail.text, bytes);
  }

  // Saturate ordinary observation requests while a receipt read uses the reserved control lane.
  const pressure = Array.from({ length: 24 }, () => call(client, "structural_refresh", { work_id: work }).catch(error => error));
  const controlStarted = Date.now();
  const receipt = await call(client, "coordination", { request: { schema_version: 1, kind: "read",
    selector: { kind: "receipt", operation_key: registrationKey }, offset: 0, limit: 8192, expected_hash: null } });
  assert.equal((receipt as { kind: string }).kind, "page");
  assert.ok(Date.now() - controlStarted < 10_000, "task control must remain responsive during observation pressure");
  assert.ok((await Promise.all(pressure)).some(value => !(value instanceof Error)));

  const source = join(f.root, "source.ts");
  const replacement = join(f.root, "replacement.ts");
  await writeFile(replacement, "export function run(value: string): number { return value.length; }\n");
  await rename(replacement, source);
  let afterReplacement = await pull();
  const watcherDeadline = Date.now() + 5_000;
  while (!afterReplacement.notices.some(item => item.id !== firstId) && Date.now() < watcherDeadline) {
    await delay(100);
    afterReplacement = await pull();
  }
  assert.ok(afterReplacement.notices.some(item => item.id !== firstId), "watcher must observe atomic replacement without explicit refresh");
  await refresh();
  assert.ok(afterReplacement.notices.some(item => item.id !== firstId));
  const newest = afterReplacement.notices.at(-1)!;
  const report = responseSchemas.structural_artifact_report.parse(await call(client, "structural_artifact_report", { artifact_id: newest.artifact_id }));
  assert.match(report.text, /value: string/);
  const detail = responseSchemas.structural_artifact_detail.parse(await call(client, "structural_artifact_detail", {
    artifact_id: newest.artifact_id, side: "observed", start_byte: 0, end_byte: 6,
  }));
  assert.equal(detail.text, "export");

  await unlink(source);
  const missing = await refresh();
  assert.ok(["published", "incomplete"].includes(missing.status));
  await writeFile(source, "export function run(value: number) {\n");
  const malformed = await refresh();
  assert.ok(["published", "incomplete"].includes(malformed.status),
    "malformed replacement must be represented as native evidence or an explicit incomplete state");
  await writeFile(source, "export function run(value: number): number { return value + 2; }\n");
  assert.equal((await refresh()).status, "published");
  const repaired = await pull();
  assert.ok(repaired.notices.some(item => item.id !== newest.id));
  const beforeNoop = repaired.notices.map(item => item.id);
  const sameBytes = "export function run(value: number): number { return value + 2; }\n";
  for (let i = 0; i < 4; i++) await writeFile(source, sameBytes);
  await delay(350);
  assert.deepEqual((await pull()).notices.map(item => item.id), beforeNoop,
    "repeated saves of identical compact evidence must remain quiet");
  const acknowledged = responseSchemas.structural_notice_ack.parse(await call(client, "structural_notice_ack", { notice_id: firstId }));
  assert.equal(acknowledged.acknowledged, true);
  assert.ok(!(await pull()).notices.some(item => item.id === firstId));

  // The CLI operator is a separate authenticated principal. It cannot inherit this parent's notices.
  const cliPull = JSON.parse((await execute(process.execPath, [cli, "structural-notice-pull", ...common, "--cursor", "0"],
    { timeout: 20_000 })).stdout);
  assert.deepEqual(responseSchemas.structural_notice_pull.parse(cliPull).notices, []);
  const beforeReopen = (await pull()).notices.map(item => item.id);
  assert.ok(beforeReopen.length > 0);
  await client.close();
  client = await connect();
  assert.deepEqual((await pull()).notices, [], "a new MCP parent cannot inherit the previous session's notices");
  await delay(250);
  const afterQuiet = await pull();
  assert.deepEqual(afterQuiet.notices.map(item => item.id), (await pull()).notices.map(item => item.id));
}, 120_000);

test("two common-base worktrees notify corresponding edits and resolve a reverted pairing", async () => {
  const f = await serviceFixture({ name: "public structural correspondence", after: onTestFinished });
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json"), request = join(f.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  await execute(process.execPath, [cli, "coordinate", "--project", f.root, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 20_000 });
  const connect = async (project: string) => {
    const client = new Client({ name: "structural-correspondence-public-test", version: "1" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cli, "serve", "--project", project, "--state-root", f.state, "--profile", profile],
      cwd: process.cwd(), stderr: "pipe" });
    await client.connect(transport, { timeout: 10_000 });
    return client;
  };
  const left = await connect(f.root);
  const otherRoot = await f.linked("corresponding-worker");
  const right = await connect(otherRoot);
  f.sessions.push({ close: async () => { await Promise.all([right.close(), left.close()]); } });
  const register = async (client: Client) => {
    const result = await call(client, "work", { request: { schema_version: 1, kind: "command", command: {
      kind: "register_external_work", operation_key: randomUUID(), input_oid: f.base,
      intent: "Compare common-base declarations", areas: [{ kind: "file", path: "source.ts" }], readers: [],
    } } });
    return (result as { receipt: { item_id: string } }).receipt.item_id;
  };
  const leftWork = await register(left), rightWork = await register(right);
  const refresh = (client: Client, work_id: string) => call(client, "structural_refresh", { work_id });
  const pull = async (client: Client) => responseSchemas.structural_notice_pull.parse(await call(client, "structural_notice_pull", { cursor: 0 }));

  await writeFile(join(f.root, "source.ts"), "export function run() { return 2; }\n");
  await refresh(left, leftWork);
  assert.deepEqual((await pull(left)).notices, [], "one unwatched edit does not interrupt the parent");
  await writeFile(join(otherRoot, "source.ts"), "export function run() {}\nexport function other() { return 1; }\n");
  await refresh(right, rightWork);
  assert.deepEqual((await pull(left)).notices, [], "an independent declaration adds no correspondence notice");
  assert.deepEqual((await pull(right)).notices, []);

  await writeFile(join(otherRoot, "source.ts"), "export function run() { return 3; }\nexport function other() { return 1; }\n");
  await refresh(right, rightWork);
  const pairedLeft = (await pull(left)).notices, pairedRight = (await pull(right)).notices;
  assert.ok(pairedLeft.length > 0 && pairedRight.length > 0,
    "both work owners should receive evidence when the same committed declaration changes");
  const pairSubject = pairedLeft.at(-1)?.subject_id;
  assert.match(pairSubject ?? "", /^[a-f0-9]{64}$/);
  assert.equal(pairedRight.at(-1)?.subject_id, pairSubject);
  assert.equal(pairedLeft.at(-1)?.correspondence_state, "overlap");
  assert.equal(pairedRight.at(-1)?.correspondence_state, "overlap");

  await writeFile(join(otherRoot, "source.ts"), "export function run() {}\nexport function other() { return 1; }\n");
  await refresh(right, rightWork);
  const resolvedLeft = (await pull(left)).notices, resolvedRight = (await pull(right)).notices;
  assert.ok(resolvedLeft.some(item => item.subject_id === pairSubject && item.correspondence_state === "resolved" &&
    !pairedLeft.some(old => old.id === item.id)),
    "the other parent must learn that its earlier correspondence resolved");
  assert.ok(resolvedRight.some(item => item.subject_id === pairSubject && item.correspondence_state === "resolved" &&
    !pairedRight.some(old => old.id === item.id)),
    "the reverting parent must receive the resolved correspondence state");
}, 120_000);

test("stable CLI operator sees a pruned cursor gap and retains notices across elected service restart", async () => {
  const f = await serviceFixture({ name: "public structural cursor recovery", after: onTestFinished });
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json"), request = join(f.temp, "coordination.json");
  const common = ["--project", f.root, "--state-root", f.state, "--profile", profile];
  const run = async (action: string, args: string[] = []) => JSON.parse((await execute(process.execPath,
    [cli, action, ...common, ...args], { timeout: 30_000, maxBuffer: 262_144 })).stdout);
  const coordinate = async (value: unknown) => {
    await writeFile(request, JSON.stringify(value));
    return run("coordinate", ["--request", request, "--yes"]);
  };
  await coordinate({ schema_version: 1, kind: "initialize", limits: f.limits });
  const binding = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state, profilePath: profile },
    process.env, AbortSignal.timeout(10_000));
  const previousOwnerDeadline = Date.now() + 10_000;
  while (true) {
    const descriptor = await readDescriptor(binding);
    if (!descriptor || !await existingOwner(descriptor)) break;
    assert.ok(Date.now() < previousOwnerDeadline, "initial CLI service did not release its election");
    await delay(25);
  }
  // The descriptor can disappear just before the previous guard releases its flock.
  await delay(250);
  let launch = await launchService(binding, cli);
  let exited = once(launch.child, "exit"); exited.catch(() => undefined);
  f.sessions.push({ async close() { launch.released(); const [code] = await exited; assert.equal(code, 0); } });
  const descriptorDeadline = Date.now() + 10_000;
  while (!await readDescriptor(binding)) {
    assert.equal(launch.child.exitCode, null);
    assert.ok(Date.now() < descriptorDeadline, "elected service did not publish its descriptor");
    await delay(25);
  }

  const identity = await coordinate({ schema_version: 1, kind: "identity" });
  const registered = await coordinate({ schema_version: 1, kind: "command", command: {
    kind: "register_external_work", operation_key: randomUUID(), input_oid: f.base,
    intent: "Exercise retained notice cursor", areas: [{ kind: "file", path: "source.ts" }], readers: [],
  } });
  const work = (registered as { receipt: { item_id: string } }).receipt.item_id;
  await coordinate({ schema_version: 1, kind: "command", command: {
    kind: "watch_source", operation_key: randomUUID(), work_id: work, expected_revision: 1,
    watchers: [{ recipient: (identity as { parent_id: string }).parent_id,
      regions: [{ kind: "file", path: "source.ts" }] }],
  } });
  for (let i = 0; i < 19; i++) {
    await writeFile(join(f.root, "source.ts"),
      `export function run(value: ${i % 2 ? "number" : "string"}): number { return ${i}; }\n`);
    const refreshed = responseSchemas.structural_refresh.parse(await run("structural-refresh", ["--work", work]));
    assert.ok(["published", "unchanged"].includes(refreshed.status));
  }
  const before = responseSchemas.structural_notice_pull.parse(await run("structural-notice-pull", ["--cursor", "0"]));
  assert.equal(before.gap, true, "retention must disclose a pruned zero cursor");
  assert.ok(before.current.length > 0, "a gap must carry the current snapshot");
  assert.ok(before.notices.length > 0);
  const latest = before.notices.at(-1)!;

  launch.released();
  const [firstExitCode] = await exited;
  assert.equal(firstExitCode, 0);
  launch = await launchService(binding, cli);
  exited = once(launch.child, "exit"); exited.catch(() => undefined);
  const reopenedDeadline = Date.now() + 10_000;
  while (!await readDescriptor(binding)) {
    assert.equal(launch.child.exitCode, null);
    assert.ok(Date.now() < reopenedDeadline, "reopened service did not publish its descriptor");
    await delay(25);
  }
  const after = responseSchemas.structural_notice_pull.parse(await run("structural-notice-pull", ["--cursor", "0"]));
  assert.equal(after.gap, true);
  assert.equal(after.notices.at(-1)?.id, latest.id, "restart must retain the same unacknowledged identity");
  assert.deepEqual(after.current, before.current);
  const acked = responseSchemas.structural_notice_ack.parse(await run("structural-notice-ack", ["--notice", latest.id]));
  assert.equal(acked.acknowledged, true);
  assert.ok(!responseSchemas.structural_notice_pull.parse(await run("structural-notice-pull", ["--cursor", "0"]))
    .notices.some(item => item.id === latest.id));
}, 300_000);
