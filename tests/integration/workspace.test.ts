import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { DelegateRequest, Profile } from "../../src/contracts/index.js";
import { createDiff, createManifest, prepareWorkspace, type Workspace } from "../../src/workspace/worktree.js";

const exec = promisify(execFile);
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "muse-workspace-test-"));
  await exec("git", ["init", "-q", root]); await exec("git", ["-C", root, "config", "user.email", "test@example.com"]); await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "tracked.txt"), "before\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

describe("implementation workspace artifacts", () => {
  it("copies untracked bytes and records hashes, modes, and change kinds", async () => {
    const root = await repository(); const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(root, "tracked.txt"), "after\n"); await mkdir(join(root, "new")); await writeFile(join(root, "new", "binary.bin"), Buffer.from([0, 1, 2, 255]));
    const workspace: Workspace = { kind: "task_worktree", path: root, base_commit: base }; const artifacts = join(root, ".artifacts"); await mkdir(artifacts);
    const manifest = await createManifest(workspace, artifacts); const created = manifest.find((entry) => entry.path === "new/binary.bin");
    expect(created).toMatchObject({ kind: "created", bytes: 4, artifact_path: "files/new/binary.bin", artifact_id: "file-1" }); expect(created?.sha256).toHaveLength(64); expect(created?.mode).toBeTypeOf("number");
    expect(await readFile(join(artifacts, created!.artifact_path!))).toEqual(Buffer.from([0, 1, 2, 255])); expect(await createDiff(workspace)).toContain("tracked.txt");
  });
  it("rejects a configured worktree root inside the source checkout", async () => {
    const root = await repository(); const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(); const nested = join(root, "tasks");
    const request: DelegateRequest = { schema_version: 1, request_key: "implement", mode: "implement", objective: "Change", context: "Context", acceptance_criteria: ["Done"], base_commit: base };
    const profile: Profile = { schema_version: 1, muse_bin: "muse", model: "model", review: { disable_write: true, disable_shell: true, sandbox_network: "restricted" }, implementation: { enabled: true, worktree_root: nested, sandbox_network: "restricted" }, task_timeout_ms: 60_000, stop_grace_ms: 1_000, subscription: { provenance: "user_confirmed" } };
    await expect(prepareWorkspace(root, request, profile, "project", crypto.randomUUID())).rejects.toMatchObject({ code: "INVALID_WORKTREE_ROOT" });
  });
  it("preserves byte-exact patch context that git can apply", async () => {
    const root = await repository(); const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(); await writeFile(join(root, "tracked.txt"), "after\n\n");
    const patch = await createDiff({ kind: "task_worktree", path: root, base_commit: base }); const patchPath = join(await mkdtemp(join(tmpdir(), "muse-patch-test-")), "change.patch"); await writeFile(patchPath, patch);
    await exec("git", ["-C", root, "apply", "--check", "--reverse", patchPath]);
  });
  it("handles quoted and arrow-containing filenames without interpreting Git display text", async () => {
    const root = await repository(); const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(); const odd = 'a" -> b.txt'; await writeFile(join(root, odd), "odd\n"); const artifacts = await mkdtemp(join(tmpdir(), "muse-artifacts-test-"));
    const manifest = await createManifest({ kind: "task_worktree", path: root, base_commit: base }, artifacts);
    expect(manifest).toContainEqual(expect.objectContaining({ path: odd, kind: "created" }));
  });
  it("reports worker changes committed after the assignment base", async () => {
    const root = await repository(); const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(); await writeFile(join(root, "tracked.txt"), "committed\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "worker"]); const artifacts = await mkdtemp(join(tmpdir(), "muse-artifacts-test-"));
    const workspace: Workspace = { kind: "task_worktree", path: root, base_commit: base }; const manifest = await createManifest(workspace, artifacts);
    expect(manifest).toContainEqual(expect.objectContaining({ path: "tracked.txt", kind: "modified" }));
  });
});
