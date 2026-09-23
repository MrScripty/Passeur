import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { test, onTestFinished } from "vitest";
// @ts-expect-error Shared real-Git fixture has no TypeScript declaration.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { responseSchemas } from "../../src/contracts/service.js";

const execute = promisify(execFile), cli = resolve("dist/src/cli.js");
function body(reply: unknown): unknown {
  const result = reply as { structuredContent?: unknown; content?: { text?: string }[] };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("MCP result has no content");
  try { return JSON.parse(text); } catch { return text; }
}
async function tool(client: Client, name: string, args: Record<string, unknown>, failure?: string): Promise<unknown> {
  const result = await client.callTool({ name: `passeur_${name}`, arguments: args }, undefined, { timeout: 30_000 });
  if (failure) {
    assert.equal(result.isError, true, JSON.stringify(body(result)));
    assert.equal((body(result) as { error: { code: string } }).error.code, failure);
  } else assert.notEqual(result.isError, true, JSON.stringify(body(result)));
  return body(result);
}
async function connect(project: string, state: string, profile: string): Promise<Client> {
  const client = new Client({ name: "structural-sharing-public-test", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, "serve", "--project", project, "--state-root", state, "--profile", profile],
    cwd: process.cwd(), stderr: "pipe" });
  await client.connect(transport, { timeout: 10_000 });
  return client;
}
const workCommand = (client: Client, command: Record<string, unknown>) =>
  tool(client, "work", { request: { schema_version: 1, kind: "command", command } });

test("two public parents require explicit current source scope for reports, detail and notices", async () => {
  const f = await serviceFixture({ name: "public structural sharing", after: onTestFinished });
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json");
  const request = join(f.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  const initialization = JSON.parse((await execute(process.execPath, [cli, "coordinate", "--project", f.root, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 20_000 })).stdout);
  const epoch = (initialization as { epoch: string }).epoch;
  const owner = await connect(f.root, f.state, profile);
  const recipient = await connect(await f.linked("sharing-reader"), f.state, profile);
  f.sessions.push({ close: async () => { await Promise.all([recipient.close(), owner.close()]); } });
  const recipientIdentity = await tool(recipient, "coordination", { request: { schema_version: 1, kind: "identity" } });
  const recipientId = (recipientIdentity as { parent_id: string }).parent_id;
  const ownerIdentity = await tool(owner, "coordination", { request: { schema_version: 1, kind: "identity" } });
  const ownerId = (ownerIdentity as { parent_id: string }).parent_id;
  const registered = await workCommand(owner, { kind: "register_external_work", operation_key: randomUUID(),
    input_oid: f.base, intent: "Observe one source", areas: [{ kind: "file", path: "source.ts" }], readers: [recipientId] });
  const workId = (registered as { receipt: { item_id: string } }).receipt.item_id;
  await tool(recipient, "structural_report", { work_id: workId }, "STRUCTURAL_SOURCE_FORBIDDEN");
  await tool(owner, "structural_refresh", { work_id: workId });
  const ownerPull = responseSchemas.structural_notice_pull.parse(await tool(owner, "structural_notice_pull", { cursor: 0 }));
  assert.deepEqual(ownerPull.notices, [], "registration alone must not create unsolicited notices");
  const currentOwner = responseSchemas.structural_current.parse(await tool(owner, "structural_current", {}));
  assert.ok(currentOwner.reports.length > 0, "unwatched current evidence remains queryable");
  assert.deepEqual(responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 })).notices, []);

  await workCommand(owner, { kind: "grant_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 1, recipients: [{ recipient: recipientId, scope: "report" }] });
  await tool(owner, "structural_refresh", { work_id: workId });
  assert.ok(responseSchemas.structural_current.parse(await tool(recipient, "structural_current", {})).reports.length > 0,
    "a grant permits current report discovery without a watch");
  assert.deepEqual(responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 })).notices, [],
    "a source grant alone must not create unsolicited notices");
  await workCommand(owner, { kind: "watch_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 2, watchers: [ownerId, recipientId].map(recipient => ({ recipient,
      regions: [{ kind: "file", path: "source.ts" }] })) });
  const observed = "export function run(value: string): number { return value.length; }\n";
  await writeFile(join(f.root, "source.ts"), observed);
  await tool(owner, "structural_refresh", { work_id: workId });
  const granted = responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 }));
  assert.ok(granted.notices.length > 0);
  const item = granted.notices.at(-1)!;
  assert.match(responseSchemas.structural_artifact_report.parse(await tool(recipient, "structural_artifact_report", {
    artifact_id: item.artifact_id })).text, /value: string/);
  await tool(recipient, "structural_artifact_detail", { artifact_id: item.artifact_id,
    side: "observed", start_byte: 0, end_byte: 6 }, "STRUCTURAL_SOURCE_FORBIDDEN");
  await tool(recipient, "structural_notice_ack", { notice_id: item.id });

  // Replacing the grant increments the work generation. Acknowledgment gives no retained read authority.
  await workCommand(owner, { kind: "grant_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 3, recipients: [{ recipient: recipientId, scope: "detail" }] });
  await tool(recipient, "structural_artifact_report", { artifact_id: item.artifact_id }, "STRUCTURAL_SOURCE_FORBIDDEN");
  assert.deepEqual(responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 })).notices, []);
  await workCommand(owner, { kind: "watch_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 4, watchers: [ownerId, recipientId].map(recipient => ({ recipient,
      regions: [{ kind: "file", path: "source.ts" }] })) });
  await tool(owner, "structural_refresh", { work_id: workId });
  const detailed = responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 }));
  assert.ok(detailed.notices.length > 0);
  const current = detailed.notices.at(-1)!;
  assert.equal(responseSchemas.structural_artifact_detail.parse(await tool(recipient, "structural_artifact_detail", {
    artifact_id: current.artifact_id, side: "observed", start_byte: 0, end_byte: 6 })).text, "export");
  await workCommand(owner, { kind: "grant_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 5, recipients: [] });
  await tool(recipient, "structural_artifact_detail", { artifact_id: current.artifact_id,
    side: "observed", start_byte: 0, end_byte: 6 }, "STRUCTURAL_SOURCE_FORBIDDEN");
  assert.deepEqual(responseSchemas.structural_notice_pull.parse(await tool(recipient, "structural_notice_pull", { cursor: 0 })).notices, []);

  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "recover_metadata", recovery: {
    kind: "adopt_work", operation_key: randomUUID(), epoch, work_id: workId,
    expected_owner: ownerId, expected_revision: 6, new_owner: recipientId,
    statement: "Operator transferred source ownership after inspecting retained work.",
  } }));
  await execute(process.execPath, [cli, "coordinate", "--project", f.root, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 20_000 });
  await tool(owner, "structural_artifact_report", { artifact_id: current.artifact_id }, "STRUCTURAL_SOURCE_FORBIDDEN");
  await tool(owner, "structural_refresh", { work_id: workId }, "COORDINATION_NOT_FOUND");
}, 120_000);

test("public watch dialect overrides route exact JSX and C family headers without widening source scope", async () => {
  const f = await serviceFixture({ name: "public structural dialect overrides", after: onTestFinished });
  const jsx = "widget.js", c = "api.h", cpp = "model.h";
  await f.commit(f.root, jsx, "export const view = () => <span>old</span>;\n");
  await f.commit(f.root, c, "int count(void);\n");
  const base = await f.commit(f.root, cpp, "struct Box { int value; };\n");
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json"), request = join(f.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  await execute(process.execPath, [cli, "coordinate", "--project", f.root, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 20_000 });
  const owner = await connect(f.root, f.state, profile);
  f.sessions.push({ close: () => owner.close() });
  const identity = await tool(owner, "coordination", { request: { schema_version: 1, kind: "identity" } });
  const ownerId = (identity as { parent_id: string }).parent_id;
  const areas = [jsx, c, cpp].map(path => ({ kind: "file", path }));
  const registered = await workCommand(owner, { kind: "register_external_work", operation_key: randomUUID(),
    input_oid: base, intent: "Inspect exact ambiguous syntax routes", areas, readers: [] });
  const workId = (registered as { receipt: { item_id: string } }).receipt.item_id;

  const invalid = await owner.callTool({ name: "passeur_work", arguments: { request: { schema_version: 1,
    kind: "command", command: { kind: "watch_source", operation_key: randomUUID(), work_id: workId,
      expected_revision: 1, watchers: [{ recipient: ownerId, regions: areas,
        dialect_overrides: [{ path: c, dialect: "jsx" }] }] } } } });
  assert.equal(invalid.isError, true, "an invalid .h to JSX override must be rejected before changing metadata");
  const override = { kind: "watch_source", operation_key: randomUUID(), work_id: workId,
    expected_revision: 1, watchers: [{ recipient: ownerId, regions: areas,
      dialect_overrides: [{ path: jsx, dialect: "jsx" }, { path: c, dialect: "c" }, { path: cpp, dialect: "cpp" }] }] };
  await workCommand(owner, override);
  await writeFile(join(f.root, jsx), "export const view = () => <span>new</span>;\n");
  await writeFile(join(f.root, c), "int count(int delta);\n");
  await writeFile(join(f.root, cpp), "struct Box { int value; int next; };\n");
  const direct = responseSchemas.structural_report.parse(await tool(owner, "structural_report", { work_id: workId }));
  assert.deepEqual(direct.reports.map(row => [row.path, row.dialect]).sort(),
    [[c, "c"], [cpp, "cpp"], [jsx, "jsx"]].sort());
  assert.ok(direct.reports.every(row => row.text.includes("OBSERVED:")));
  await tool(owner, "structural_refresh", { work_id: workId });
  const current = responseSchemas.structural_current.parse(await tool(owner, "structural_current", {}));
  assert.deepEqual(current.reports.filter(row => row.work_id === workId).map(row => row.path).sort(), [jsx, c, cpp].sort());
  const notices = responseSchemas.structural_notice_pull.parse(await tool(owner, "structural_notice_pull", { cursor: 0 }));
  assert.ok(notices.notices.length > 0, "the explicit watch must notify on changed syntax evidence");
}, 120_000);
