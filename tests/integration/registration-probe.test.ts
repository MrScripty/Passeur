import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { probeRegistration } from "../../src/codex/probe.js";
import { CODEX_ENABLED_TOOLS, type CodexMcpRegistration } from "../../src/codex/config.js";
import { runtimeIdentity } from "../../src/install/runtime.js";
import { readDescriptor, existingOwner } from "../../src/service/bootstrap.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
it("probes the exact compiled registration and keeps provider compatibility unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-probe-")), project = join(root, "project"); await mkdir(project);
  let binding: Awaited<ReturnType<typeof resolveRepositoryBinding>> | undefined;
  try {
    binding = await resolveRepositoryBinding({ project, stateRoot: join(root, "state"), profilePath: join(root, "missing.json") }, {}, new AbortController().signal);
    const identity = await runtimeIdentity(process.cwd());
    const registration: CodexMcpRegistration = {
      server_name: "fixture", command: process.execPath, args: [resolve("dist/src/cli.js"), "serve", "--project", project,
        "--profile", binding.profilePath!, "--state-root", binding.stateRoot, "--expected-repository-id", binding.repositoryId],
      cwd: process.cwd(), env: {}, startup_timeout_sec: 10, tool_timeout_sec: 2100, enabled_tools: CODEX_ENABLED_TOOLS,
      project, profile: binding.profilePath!, state_root: binding.stateRoot, repository_id: binding.repositoryId, build_id: identity.build_id, development: true,
    };
    const report = await probeRegistration(registration, true);
    expect(report.transport.status).toBe("passed"); expect(report.readiness.status).toBe("passed");
    expect(report.configuration.status).toBe("not_run"); expect(report.installed_workflow.status).toBe("not_run");
    const wrong = await probeRegistration({ ...registration, build_id: "wrong" });
    expect(wrong.transport.status).toBe("failed"); expect(wrong.transport.error?.code).toBe("PROBE_IDENTITY_MISMATCH");
    const missing = await probeRegistration({ ...registration, command: join(root, "missing-node") });
    expect(missing.transport.status).toBe("failed");
  } finally {
    // Do not remove the synthetic store while its service still owns coordination.
    if (binding) { const descriptor=await readDescriptor(binding);if(descriptor){
      let stopped=false;for(let n=0;n<1000;n++){if(!await existingOwner(descriptor)){stopped=true;break;}await new Promise(r=>setTimeout(r,5));}
      expect(stopped).toBe(true);
    }}
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
