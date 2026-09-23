import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { test, onTestFinished } from "vitest";
// @ts-expect-error The shared real-Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { responseSchemas } from "../../src/contracts/service.js";

const execute = promisify(execFile), cli = resolve("dist/src/cli.js");
async function run(args: string[]): Promise<unknown> {
  return JSON.parse((await execute(process.execPath, [cli, ...args], { timeout: 20_000, maxBuffer: 262_144 })).stdout);
}

test("elected service exposes announcement, overlap preflight and exact withdrawal through public CLI and MCP", async () => {
  const f = await serviceFixture({ name: "coordinated public service", after: onTestFinished });
  await f.service.close();
  const common = ["--project", f.root, "--state-root", f.state, "--profile", join(f.temp, "absent-profile.json")];
  const requestFile = join(f.temp, "request.json");
  const writeRequest = async (value: unknown) => { await writeFile(requestFile, JSON.stringify(value)); return requestFile; };
  await run(["coordinate", ...common, "--request", await writeRequest({ schema_version: 1, kind: "initialize", limits: f.limits }), "--yes"]);
  const assignment = { schema_version: 3, agent_id: "fixture", request_key: randomUUID(), mode: "implement",
    objective: "Inspect one scoped function", context: "Real elected service transport", acceptance_criteria: ["Retain exact source"],
    allowed_paths: ["source.ts"], base_commit: f.base, target_ref: "refs/heads/main" };
  const announced = responseSchemas.announce.parse(await run(["announce", ...common, "--request",
    await writeRequest({ schema_version: 1, operation_key: randomUUID(), assignment, readers: [] }), "--yes"]));
  assert.equal(announced.record.state, "unresolved");
  const inspected = responseSchemas.announcement.parse(await run(["announcement", ...common, "--id", announced.record.id]));
  assert.deepEqual(inspected.assignment, assignment);
  const preflight = responseSchemas.preflight.parse(await run(["preflight", ...common, "--request",
    await writeRequest({ schema_version: 2, kind: "reference", announcement: { id: announced.record.id, revision: 1 } })]));
  assert.match(preflight.decision_identity, /^[a-f0-9]{64}$/);
  const withdrawn = responseSchemas.withdraw_announcement.parse(await run(["withdraw-announcement", ...common,
    "--id", announced.record.id, "--expected-revision", String(announced.record.revision), "--operation-key", randomUUID(), "--yes"]));
  assert.equal(withdrawn.state, "withdrawn");
  const client = new Client({ name: "coordinated-service-test", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve", ...common], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["passeur_announce", "passeur_announcement", "passeur_withdraw_announcement", "passeur_preflight", "passeur_submit_coordinated"]) {
      assert.ok(names.includes(name), `${name} missing from installed host tool surface`);
    }
    const reply = await client.callTool({ name: "passeur_preflight", arguments: { request: {
      schema_version: 2, kind: "inline", assignment: { ...assignment, request_key: randomUUID() },
    } } });
    const content = reply.content as { text: string }[];
    const result = reply.structuredContent ?? JSON.parse(content[0]!.text);
    assert.match(responseSchemas.preflight.parse(result).decision_identity, /^[a-f0-9]{64}$/);
  } finally { await client.close(); }
}, 60_000);
