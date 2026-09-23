import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { installRuntime, installedEntry, readManifest, verifyInstalledNativePackages } from "../../src/install/runtime.js";
import { probeStructuralInstallation } from "../../scripts/probe-structural.js";

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

    const grammarPath = join(installed.root, "node_modules/tree-sitter-rust/build/Release/tree_sitter_rust_binding.node");
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

it.skipIf(!candidate)("runs every required language through the relocated installed CLI and an installed stdio MCP route", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-language-install-"));
  try {
    const selected = await readManifest(candidate!);
    expect(selected.schema_version).toBe(2);
    expect(selected.source_dirty).toBe(false);
    const hostNetns = process.env.PASSEUR_HOST_NETNS_ID;
    const sourceMarker = process.env.PASSEUR_BUILD_SOURCE_MARKER;
    expect(hostNetns, "Record host /proc/self/ns/net before entering a network-isolated runner").toMatch(/^net:\[\d+\]$/);
    expect(sourceMarker, "Hide the disposable build-source marker from the installed runner").toBeTruthy();
    const installed = await installRuntime(candidate!, join(root, "installed ü with spaces"));
    const result = await probeStructuralInstallation({ installed: installed.root,
      fixtures: join(process.cwd(), "tests/fixtures/structural/languages"),
      hostNetns: hostNetns!, sourceSnapshotMarker: sourceMarker! });
    expect(result.candidate_build_id).toBe(selected.build_id);
    expect((result.rows as unknown[]).length).toBe(30);
    expect((result.canonical_public as unknown[]).length).toBe(106);
    const semantic = result.semantic_oracles as { rows: unknown[]; variants: unknown[] };
    expect(semantic.rows.length).toBe(13);
    expect(semantic.variants.length).toBe(21);
    expect(result.stdio_mcp_report).toBe("observed");
    expect(result.stdio_mcp_detail).toBe("observed");
    expect(result.guarded_build_tool_attempts).toBe(0);
    expect(result.network_namespace_enforced).toBe(true);
    expect(result.host_pid_root_hidden).toBe(true);
    expect(result.forbidden_executables_hidden).toBe(true);
    expect((result.absolute_executable_attempts as unknown[]).length).toBe(11);
    expect(result.source_snapshot_hidden).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 1_200_000);
