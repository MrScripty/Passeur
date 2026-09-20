import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDiff, createManifest, type Workspace } from "../../src/workspace/worktree.js";
import { fixture } from "../fixtures/bridge.js";
it("preserves binary artifacts and raw patch bytes for committed and untracked changes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "tracked.txt"), "after\n\n"); await f.git("add", "tracked.txt"); await f.git("commit", "-qm", "feat: update fixture");
    const odd = 'a" -> b.bin'; await writeFile(join(f.root, odd), Buffer.from([0, 255, 1]));
    const workspace: Workspace = { kind: "task_worktree", path: f.root, base_commit: f.base };
    const artifacts = join(f.temporary, "artifacts"); await mkdir(artifacts);
    const manifest = await createManifest(workspace, artifacts);
    const copied = manifest.find((entry) => entry.path === odd)!;
    expect(await readFile(join(artifacts, copied.artifact_path!))).toEqual(Buffer.from([0, 255, 1]));
    expect(manifest.some((entry) => entry.path === "tracked.txt")).toBe(true);
    const patchPath = join(f.temporary, "change.patch"); await writeFile(patchPath, await createDiff(workspace));
    await f.git("apply", "--check", "--reverse", patchPath);
  } finally { await f.dispose(); }
});
