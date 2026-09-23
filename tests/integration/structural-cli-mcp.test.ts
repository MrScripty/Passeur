import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { test, onTestFinished } from "vitest";
// The shared JavaScript fixture is also used by the core Node test suite.
// @ts-expect-error JavaScript fixture has no TypeScript declaration.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { existingOwner, launchService, readDescriptor } from "../../src/service/bootstrap.js";
import { responseSchemas } from "../../src/contracts/service.js";

const execute = promisify(execFile);
const cli = resolve("dist/src/cli.js");

const receiptSchema = z.object({ receipt: z.object({ item_id: z.string().uuid() }) });
const failureSchema = z.object({ error: z.object({ code: z.string() }) });
function body(reply: unknown): unknown {
  if (!reply || typeof reply !== "object") throw new Error("Missing MCP result");
  const result = reply as { structuredContent?: unknown; content?: { text?: string }[] };
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!result.content?.[0]?.text) throw new Error("Missing MCP text result");
  return JSON.parse(result.content[0].text);
}

async function setup(name: string) {
  const fixture = await serviceFixture({ name, after: onTestFinished });
  await fixture.service.close();
  const profile = join(fixture.temp, "absent-profile.json");
  const common = ["--project", fixture.root, "--state-root", fixture.state, "--profile", profile];
  const run = async (action: string, args: string[] = []) => JSON.parse((await execute(process.execPath,
    [cli, action, ...common, ...args], { timeout: 20000, maxBuffer: 262144 })).stdout);
  const commandFile = join(fixture.temp, "coordination-request.json");
  const coordinate = async (request: unknown) => {
    await writeFile(commandFile, JSON.stringify(request));
    return run("coordinate", ["--request", commandFile, "--yes"]);
  };
  await coordinate({ schema_version: 1, kind: "initialize", limits: fixture.limits });
  return { ...fixture, run, coordinate };
}

async function connect(project: string, state: string, profile: string) {
  const client = new Client({ name: "structural-public-acceptance", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, "serve", "--project", project, "--state-root", state, "--profile", profile],
    cwd: process.cwd(), stderr: "pipe" });
  try { await client.connect(transport, { timeout: 10000 }); return client; }
  catch (error) { await client.close(); throw error; }
}

test("compiled CLI returns a native report and retained exact detail for its registered owner", async () => {
  const f = await setup("structural CLI public route");
  const binding = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state,
    profilePath: join(f.temp, "absent-profile.json") }, process.env, AbortSignal.timeout(10000));
  const settled = AbortSignal.timeout(10000);
  while (true) {
    const descriptor = await readDescriptor(binding);
    if (!descriptor || !await existingOwner(descriptor)) break;
    await delay(20, undefined, { signal: settled });
  }
  const launch = await launchService(binding, cli);
  const exit = once(launch.child, "exit"); exit.catch(() => undefined);
  f.sessions.push({ async close() { launch.released(); const [code] = await exit; assert.equal(code, 0); } });
  const started = AbortSignal.timeout(10000);
  while (!await readDescriptor(binding)) {
    assert.equal(launch.child.exitCode, null, "The guarded service exited before publishing its descriptor");
    await delay(20, undefined, { signal: started });
  }
  const receipt = receiptSchema.parse(await f.coordinate({ schema_version: 1, kind: "command", command: {
    kind: "register_external_work", operation_key: randomUUID(), input_oid: f.base,
    intent: "CLI structural acceptance", areas: [{ kind: "file", path: "source.ts" }], readers: [],
  } }));
  const work = receipt.receipt.item_id;
  const observed = "export function changed(value: number): number { return value + 1; }\n";
  await writeFile(join(f.root, "source.ts"), observed);
  const report = responseSchemas.structural_report.parse(await f.run("structural-report", ["--work", work]));
  assert.equal(report.schema_version, 1);
  assert.equal(report.reports.length, 1);
  const row = report.reports[0]; assert.ok(row);
  assert.equal(row.path, "source.ts");
  assert.match(row.text, /OBSERVED: "export function changed\(value: number\): number"/);
  const id = row.report_id;
  await writeFile(join(f.root, "source.ts"), "export function later() {}\n");
  const detail = responseSchemas.structural_detail.parse(await f.run("structural-detail", ["--work", work, "--report", id,
    "--side", "observed", "--start-byte", "0", "--end-byte", String(Buffer.byteLength(observed))]));
  assert.equal(detail.text, observed);
}, 60000);

test("stdio MCP owner receives native report and detail while another authenticated parent is denied", async () => {
  const f = await setup("structural MCP public route");
  const profile = join(f.temp, "absent-profile.json");
  const owner = await connect(f.root, f.state, profile);
  const reader = await connect(await f.linked("structural-mcp-reader"), f.state, profile);
  f.sessions.push({ async close() { await Promise.all([owner.close(), reader.close()]); } });
  const identity = await owner.callTool({ name: "passeur_coordination", arguments: { request: { schema_version: 1, kind: "identity" } } });
  assert.notEqual(identity.isError, true);
  const readerIdentity = await reader.callTool({ name: "passeur_coordination", arguments: { request: { schema_version: 1, kind: "identity" } } });
  assert.notEqual(readerIdentity.isError, true);
  const readerId = z.object({ parent_id: z.string() }).parse(body(readerIdentity)).parent_id;
  const registration = await owner.callTool({ name: "passeur_work", arguments: { request: {
    schema_version: 1, kind: "command", command: { kind: "register_external_work", operation_key: randomUUID(), input_oid: f.base,
      intent: "MCP structural acceptance", areas: [{ kind: "file", path: "source.ts" }], readers: [readerId] },
  } } });
  assert.notEqual(registration.isError, true);
  const work = receiptSchema.parse(body(registration)).receipt.item_id;
  const observed = "export function changed(value: number): number { return value + 2; }\n";
  await writeFile(join(f.root, "source.ts"), observed);
  const reportResult = await owner.callTool({ name: "passeur_structural_report", arguments: { work_id: work } }, undefined, { timeout: 20000 });
  assert.notEqual(reportResult.isError, true);
  const report = responseSchemas.structural_report.parse(body(reportResult));
  assert.equal(report.schema_version, 1);
  assert.equal(report.reports.length, 1);
  const row = report.reports[0]; assert.ok(row);
  assert.match(row.text, /OBSERVED: "export function changed\(value: number\): number"/);
  const deniedReport = await reader.callTool({ name: "passeur_structural_report", arguments: { work_id: work } });
  assert.equal(deniedReport.isError, true);
  assert.equal(failureSchema.parse(body(deniedReport)).error.code, "STRUCTURAL_SOURCE_FORBIDDEN");
  const args = { work_id: work, report_id: row.report_id, side: "observed", start_byte: 0,
    end_byte: Buffer.byteLength(observed) };
  await writeFile(join(f.root, "source.ts"), "export function later() {}\n");
  const detailResult = await owner.callTool({ name: "passeur_structural_detail", arguments: args });
  assert.notEqual(detailResult.isError, true);
  assert.equal(responseSchemas.structural_detail.parse(body(detailResult)).text, observed);
  const deniedDetail = await reader.callTool({ name: "passeur_structural_detail", arguments: args });
  assert.equal(deniedDetail.isError, true);
  assert.equal(failureSchema.parse(body(deniedDetail)).error.code, "STRUCTURAL_SOURCE_FORBIDDEN");
}, 60000);
