import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { onTestFinished, test } from "vitest";
// @ts-expect-error The shared real Git fixture is JavaScript.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { existingOwner, launchService, readDescriptor, servicePaths } from "../../src/service/bootstrap.js";
import { ServiceClient } from "../../src/service/client.js";
import type { ServiceDescriptor } from "../../src/contracts/service.js";

const cli = resolve("dist/src/cli.js");
const execute = promisify(execFile);

async function elected(name: string) {
  const fixture = await serviceFixture({ name, after: onTestFinished });
  await fixture.service.close();
  const profile = join(fixture.temp, "absent-profile.json");
  const request = join(fixture.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: fixture.limits }));
  await execute(process.execPath, [cli, "coordinate", "--project", fixture.root, "--state-root", fixture.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 20_000 });
  const binding = await resolveRepositoryBinding({ project: fixture.root, stateRoot: fixture.state,
    profilePath: profile }, process.env, AbortSignal.timeout(10_000));
  const priorDeadline = Date.now() + 10_000;
  const guard = servicePaths(binding).guard;
  while (true) {
    const prior = await readDescriptor(binding);
    // The prior process can remove its descriptor before flock releases the election guard.
    let guardReleased = false;
    try { await execute("flock", ["--nonblock", guard, "true"], { timeout: 5_000 }); guardReleased = true; }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if ((!prior || !await existingOwner(prior)) && guardReleased) break;
    assert.ok(Date.now() < priorDeadline, "initialization service did not release its election");
    await delay(20);
  }
  const launch = await launchService(binding, cli);
  const exit = once(launch.child, "exit"); exit.catch(() => undefined);
  fixture.sessions.push({ async close() { launch.released(); const [code] = await exit; assert.equal(code, 0); } });
  let descriptor: ServiceDescriptor | undefined;
  const deadline = Date.now() + 10_000;
  while (!(descriptor = await readDescriptor(binding))) {
    assert.equal(launch.child.exitCode, null, "elected service exited before publishing its descriptor");
    assert.ok(Date.now() < deadline, "elected service did not publish its descriptor");
    await delay(20);
  }
  const clients: ServiceClient[] = [];
  fixture.sessions.push({ async close() { for (const client of clients) client.close(); } });
  const connect = async (ownerToken = randomBytes(32).toString("hex")) => {
    const client = new ServiceClient(descriptor, binding, ownerToken);
    clients.push(client);
    await client.ready;
    return client;
  };
  return { fixture, binding, descriptor, launch, connect };
}

async function rawSocket(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  await once(socket, "connect");
  return socket;
}

test("elected listener and framed IPC discard saturated or malformed observers while controls recover", async () => {
  const { descriptor, connect } = await elected("structural public listener capacity");
  const owner = await connect();
  assert.equal((await owner.call("status", {})).admission, "open");

  // These real sockets consume listener slots without impersonating a task owner.
  const sockets: Socket[] = [];
  try {
    for (let index = 0; index < 31; index++) sockets.push(await rawSocket(descriptor.endpoint));
    const overflow = await rawSocket(descriptor.endpoint);
    try {
      await Promise.race([once(overflow, "close"), delay(5_000).then(() => { throw new Error("listener accepted an excess observer"); })]);
      assert.equal(overflow.destroyed, true, "listener must close an excess observer");
    } finally { overflow.destroy(); }
  } finally {
    for (const socket of sockets) socket.destroy();
  }
  assert.equal((await owner.call("status", {})).admission, "open",
    "listener pressure must leave an established control connection usable");

  for (const payload of ["{bad json}\n", "x".repeat(1_048_577)]) {
    const socket = await rawSocket(descriptor.endpoint);
    socket.write(payload);
    await Promise.race([once(socket, "close"), delay(5_000).then(() => { throw new Error("malformed observer was not closed"); })]);
    assert.equal((await owner.call("status", {})).admission, "open");
  }
  const truncated = await rawSocket(descriptor.endpoint);
  truncated.end('{"kind":"hello"');
  await Promise.race([once(truncated, "close"), delay(5_000).then(() => { throw new Error("truncated observer was not closed"); })]);
  const stale = await connect();
  await stale.connection.send({ kind: "request", id: randomUUID(), generation: "wrong", operation: "status", arguments: {} });
  await Promise.race([stale.connection.closed, delay(5_000).then(() => { throw new Error("wrong-generation observer was not closed"); })]);
  const recovered = await connect();
  assert.equal((await recovered.call("status", {})).admission, "open",
    "freed listener slots must admit another real client");
}, 60_000);

test("observation overload and complete parent detachment leave accepted external work and control available", async () => {
  const { fixture, connect, descriptor } = await elected("structural public lifecycle capacity");
  const token = randomBytes(32).toString("hex");
  const parent = await connect(token);
  const operationKey = randomUUID();
  const registration = await parent.coordinate({ schema_version: 1, kind: "command", command: {
    kind: "register_external_work", operation_key: operationKey, input_oid: fixture.base,
    intent: "Keep accepted work while structural analysis is overloaded", areas: [{ kind: "file", path: "source.ts" }], readers: [],
  } });
  assert.equal(registration.kind, "receipt");
  const workId = registration.receipt.item_id;
  await writeFile(join(fixture.root, "source.ts"), "export function run(value: number): number { return value + 1; }\n");

  const first = parent.call("structural_report", { work_id: workId });
  const second = parent.call("structural_report", { work_id: workId }).catch(error => error);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.reports.length, 1, "real helper must complete the admitted report");
  assert.equal((secondResult as { code?: string }).code, "STRUCTURAL_ANALYSIS_CAPACITY",
    "the second report must return the explicit bounded admission outcome");

  const pressure = Array.from({ length: 40 }, () => parent.call("structural_refresh", { work_id: workId }).catch(error => error));
  const control = await parent.coordinate({ schema_version: 1, kind: "read", selector: { kind: "receipt", operation_key: operationKey },
    offset: 0, limit: 8192, expected_hash: null });
  assert.equal(control.kind, "page", "the control lane must remain available under observation pressure");
  const outcomes = await Promise.all(pressure);
  assert.ok(outcomes.some(value => (value as { code?: string }).code === "SERVICE_REQUEST_LIMIT" ||
    (value as { code?: string }).code === "STRUCTURAL_ANALYSIS_CAPACITY"),
  "saturated optional observation must report a typed capacity result");

  parent.close();
  await parent.connection.closed;
  const rejoined = await connect(token);
  assert.equal(rejoined.descriptor.generation, descriptor.generation, "the accepted work must retain the elected service");
  const receipt = await rejoined.coordinate({ schema_version: 1, kind: "read", selector: { kind: "receipt", operation_key: operationKey },
    offset: 0, limit: 8192, expected_hash: null });
  assert.equal(receipt.kind, "page");
  assert.ok(receipt.content.includes(workId), "disconnection must preserve the accepted work receipt");
  assert.equal((await rejoined.call("structural_observation_status", { work_id: workId })).work_id, workId);
}, 90_000);

test("CLI admits the structural observation status action and work argument", async () => {
  await assert.rejects(execute(process.execPath, [cli, "structural-observation-status", "--work", randomUUID()],
    { timeout: 5_000 }), error => {
    assert.match((error as { stderr: string }).stderr, /ARGUMENT_REQUIRED/);
    return true;
  });
  const { stdout } = await execute(process.execPath, [cli, "--help"], { timeout: 5_000 });
  assert.match(stdout, /structural-observation-status --project PATH --work UUID/);
});
