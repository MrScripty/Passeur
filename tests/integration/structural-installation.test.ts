import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { installRuntime, installedEntry, readManifest, verifyInstalledNativePackages } from "../../src/install/runtime.js";

// Set PASSEUR_NATIVE_CANDIDATE to a real clean V2 build. This test intentionally
// uses its complete parser/dependency closure, not a substitute manifest.
const candidate = process.env.PASSEUR_NATIVE_CANDIDATE;
it("requires a manifest when the native child has an installed build identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-development-"));
  try {
    await verifyInstalledNativePackages(root, "tree-sitter-rust");
    await expect(verifyInstalledNativePackages(root, "tree-sitter-rust", "a".repeat(64))).rejects.toMatchObject({
      code: "RUNTIME_MANIFEST_INVALID",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(!candidate)("refuses altered native binding bytes at publication and installed selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-integrity-"));
  try {
    const selected = await readManifest(candidate!);
    expect(selected.schema_version).toBe(2);
    expect(selected.source_dirty).toBe(false);
    const installed = await installRuntime(candidate!, join(root, "installed"));
    expect((await installedEntry(installed.root)).manifest.build_id).toBe(selected.build_id);
    await verifyInstalledNativePackages(installed.root, "tree-sitter-rust", selected.build_id);
    const wrongBuildId = selected.build_id === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    await expect(verifyInstalledNativePackages(installed.root, "tree-sitter-rust", wrongBuildId)).rejects.toMatchObject({
      code: "RUNTIME_IDENTITY_MISMATCH",
    });

    const binding = "node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node";
    const nativePath = join(installed.root, binding);
    const original = await readFile(nativePath);
    expect(original.length).toBeGreaterThan(0);
    await writeFile(nativePath, Buffer.concat([original, Buffer.from([0])]));
    await expect(installedEntry(installed.root)).rejects.toMatchObject({ code: "RUNTIME_DEPENDENCY_MISMATCH" });
    await expect(verifyInstalledNativePackages(installed.root, "tree-sitter-rust")).rejects.toMatchObject({ code: "RUNTIME_PARSER_MISMATCH" });
    await writeFile(nativePath, original);

    const grammarPath = join(installed.root, "node_modules/tree-sitter-rust/prebuilds/linux-x64/tree-sitter-rust.node");
    const grammarOriginal = await readFile(grammarPath);
    await writeFile(grammarPath, Buffer.concat([grammarOriginal, Buffer.from([0])]));
    await expect(verifyInstalledNativePackages(installed.root, "tree-sitter-rust")).rejects.toMatchObject({ code: "RUNTIME_PARSER_MISMATCH" });

    const alteredCandidate = join(root, "altered-candidate");
    await cp(candidate!, alteredCandidate, { recursive: true });
    await writeFile(join(alteredCandidate, binding), Buffer.concat([original, Buffer.from([0])]));
    await expect(installRuntime(alteredCandidate, join(root, "other-installed"))).rejects.toMatchObject({
      code: "RUNTIME_DEPENDENCY_MISMATCH",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
