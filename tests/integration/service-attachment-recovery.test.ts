import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { PasseurFrontend } from "../../src/service/client.js";
import { preparePaths, readDescriptor, existingOwner } from "../../src/service/bootstrap.js";
import { processIdentity } from "../../src/service/process.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { runtimeIdentity } from "../../src/install/runtime.js";

it("re-elects the service when the discovered owner dies before attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-attachment-recovery-"));
  const project = join(root, "project"), state = join(root, "state"), profile = join(state, "profile.json");
  await mkdir(project);
  const intent = { project, stateRoot: state, profilePath: profile };
  const binding = await resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(10_000));
  const paths = await preparePaths(binding), identity = await runtimeIdentity(process.cwd());
  const owner = spawn("sleep", ["30"], { stdio: "ignore" });
  assert.ok(owner.pid);
  const ownerExited = once(owner, "exit").then(() => undefined);
  const fakeGeneration = randomUUID();
  await writeFile(paths.descriptor, JSON.stringify({ protocol: 1, generation: fakeGeneration,
    repository_id: binding.repositoryId, state_root: binding.stateRoot, profile_path: binding.profilePath,
    endpoint: paths.endpoint, runtime: identity, process: await processIdentity(owner.pid), token: randomBytes(32).toString("hex") }), { mode: 0o600 });

  let closeFake: (() => void) | undefined;
  const fakeClosed = new Promise<void>(resolveClosed => { closeFake = resolveClosed; });
  const fake = createServer(socket => {
    socket.destroy();
    fake.close(() => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      closeFake?.();
    });
  });
  const frontend = new PasseurFrontend(intent, identity, resolve("dist/src/cli.js"));
  try {
    await new Promise<void>((resolveListen, reject) => { fake.once("error", reject); fake.listen(paths.endpoint, resolveListen); });
    const status = await frontend.call("status", {});
    assert.notEqual(status.generation, fakeGeneration);
    assert.equal(frontend.status().service.state, "connected");
    await fakeClosed;
  } finally {
    await frontend.shutdown();
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerExited;
    if (fake.listening) await new Promise<void>(resolveClosed => fake.close(() => resolveClosed()));
    for (let attempt = 0; attempt < 200; attempt++) {
      const descriptor = await readDescriptor(binding);
      if (!descriptor || !await existingOwner(descriptor)) break;
      await delay(25);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
