import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { test, onTestFinished, vi } from "vitest";
// @ts-expect-error Shared real Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { BridgeError, diagnosticInfo } from "../../src/core/errors.js";
import { resolveRepositoryBinding, type RepositoryRuntime } from "../../src/core/repository-runtime.js";
import { ServiceClient } from "../../src/service/client.js";
import { readDescriptor } from "../../src/service/bootstrap.js";

// The in-process fixture owns the socket lifecycle; election-lock policy is exercised elsewhere.
vi.mock("../../src/service/process.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/service/process.js")>(),
  assertElectionGuard: async () => undefined,
}));

test("service IPC preserves a normalized selected-result finalize refusal", async () => {
  const f = await serviceFixture({ name: "service finalize error projection", after: onTestFinished });
  await f.service.close();
  const binding = await resolveRepositoryBinding({ project: f.root, stateRoot: f.state,
    profilePath: join(f.temp, "absent-profile.json") }, {}, new AbortController().signal);
  const taskId = randomUUID(), operationKey = randomUUID();
  const expected = diagnosticInfo(new BridgeError("COORDINATION_RESULT_SELECTED",
    "Selected result still belongs to an active case"));
  const runtime = {
    configuredProfile: undefined,
    status: () => ({}),
    authorizeTask: async () => undefined,
    finalize: async () => [{ task_id: taskId, operation_key: operationKey, error: expected }],
    hasObligations: async () => false,
    detachClient: async () => undefined,
    stopAdmission: async () => undefined,
    drain: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as RepositoryRuntime;
  const identity = { package_version: "fixture", build_id: "fixture", mode: "development" as const,
    node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString() };
  const bootstrap = new PassThrough();
  const { runRepositoryService } = await import("../../src/service/server.js");
  const serving = runRepositoryService(runtime, binding, identity, bootstrap);
  let client: ServiceClient | undefined;
  f.sessions.push({ close: async () => {
    client?.close(); bootstrap.end(); await serving;
  } });
  let descriptor = await readDescriptor(binding);
  for (let attempt = 0; !descriptor && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    descriptor = await readDescriptor(binding);
  }
  assert.ok(descriptor, "The real service transport published its descriptor");
  client = new ServiceClient(descriptor, binding, randomBytes(32).toString("hex"));
  await client.ready;
  const reply = await client.call("finalize", { schema_version: 2, operations: [{ task_id: taskId, operation_key: operationKey,
    disposition: "archived", expected_head: f.base, expected_branch_ref: "refs/heads/fixture",
    cleanup_authorized: true, archive_authorized: true, reason: "Retire selected result" }] });
  assert.equal(reply.results.length, 1);
  const result = reply.results[0];
  assert.ok(result && "error" in result);
  assert.deepEqual(result.error, { code: "COORDINATION_RESULT_SELECTED", message: expected.message });
}, 30_000);
