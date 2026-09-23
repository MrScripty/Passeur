import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { installRuntime, installedEntry, readManifest, verifyInstalledNativePackages } from "../../src/install/runtime.js";
import { TaskStore } from "../../src/store/task-store.js";
import { probeStructuralInstallation } from "../../scripts/probe-structural.js";

// Set PASSEUR_NATIVE_CANDIDATE to a real clean V2 build. This test intentionally
// uses its complete parser/dependency closure, not a substitute manifest.
const candidate = process.env.PASSEUR_NATIVE_CANDIDATE;
const exec = promisify(execFile);
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

it.skipIf(!candidate)("rejects missing scanner and helper files, altered packaged query and catalog bytes, and invalid installed manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-negative-install-"));
  try {
    const selected = await readManifest(candidate!);
    expect(selected.schema_version).toBe(2);
    expect(selected.source_dirty).toBe(false);
    const installed = await installRuntime(candidate!, join(root, "installed"));
    const changeBytes = async (location: string, code: string): Promise<void> => {
      const path = join(installed.root, location), original = await readFile(path);
      try {
        await writeFile(path, Buffer.concat([original, Buffer.from("\n# changed\n")]));
        await expect(installedEntry(installed.root)).rejects.toMatchObject({ code });
      } finally { await writeFile(path, original); }
    };
    const removeFile = async (location: string, code: string): Promise<void> => {
      const path = join(installed.root, location), withheld = `${path}.withheld`;
      await rename(path, withheld);
      try { await expect(installedEntry(installed.root)).rejects.toMatchObject({ code }); }
      finally { await rename(withheld, path); }
    };

    await removeFile("node_modules/tree-sitter-rust/src/scanner.c", "RUNTIME_PARSER_MISMATCH");
    await removeFile("dist/src/observation/helper-main.js", "RUNTIME_COMPILED_MISMATCH");
    // These are package query data and the compiled in-process catalog, not separate manifest entries.
    await changeBytes("node_modules/tree-sitter-rust/queries/highlights.scm", "RUNTIME_PARSER_MISMATCH");
    await changeBytes("dist/src/observation/native-parser.js", "RUNTIME_COMPILED_MISMATCH");
    await changeBytes("dist/src/observation/native-extraction.js", "RUNTIME_COMPILED_MISMATCH");

    const manifestPath = join(installed.root, "runtime-manifest.json"), original = await readFile(manifestPath);
    try {
      await writeFile(manifestPath, "{");
      await expect(installedEntry(installed.root)).rejects.toMatchObject({ code: "RUNTIME_METADATA_INVALID" });
      await writeFile(manifestPath, JSON.stringify({ ...selected, state: "installed", schema_version: 999 }));
      await expect(installedEntry(installed.root)).rejects.toMatchObject({ code: "RUNTIME_VERSION_UNSUPPORTED" });
      await writeFile(manifestPath, JSON.stringify({ ...selected, state: "installed", build_id: "0".repeat(64) }));
      await expect(installedEntry(installed.root)).rejects.toMatchObject({ code: "RUNTIME_IDENTITY_MISMATCH" });
    } finally { await writeFile(manifestPath, original); }
    expect((await installedEntry(installed.root)).manifest.build_id).toBe(selected.build_id);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 300_000);

it.skipIf(!candidate)("rejects a complete candidate targeting another architecture, libc, or Node ABI", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-target-install-"));
  try {
    const altered = join(root, "candidate");
    await cp(candidate!, altered, { recursive: true });
    const manifestPath = join(altered, "runtime-manifest.json");
    const selected = await readManifest(altered);
    expect(selected.schema_version).toBe(2);
    if (selected.schema_version !== 2) return;
    const reject = async (field: "architecture" | "libc" | "node_abi", value: string, code: string): Promise<void> => {
      await writeFile(manifestPath, JSON.stringify({ ...selected, [field]: value }));
      await expect(installRuntime(altered, join(root, `install-${field}`))).rejects.toMatchObject({ code });
    };
    await reject("architecture", `${selected.architecture}-other`, "INSTALL_TARGET_UNSUPPORTED");
    await reject("libc", `${selected.libc}-other`, "RUNTIME_NATIVE_TARGET_UNSUPPORTED");
    await reject("node_abi", `${selected.node_abi}-other`, "RUNTIME_NATIVE_TARGET_UNSUPPORTED");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 300_000);

it.skipIf(!candidate)("keeps installed MCP discovery and historical result reads available with an unusable native grammar", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-native-history-install-"));
  let client: Client | undefined;
  try {
    const installed = await installRuntime(candidate!, join(root, "installed"));
    const project = join(root, "project"), stateRoot = join(root, "state");
    await exec("git", ["init", "-q", project]);
    const binding = await resolveRepositoryBinding({ project, stateRoot }, {}, AbortSignal.timeout(10_000));
    const fixture = join(process.cwd(), "tests/fixtures/structural/compatibility");
    const [record, state, result] = await Promise.all(["task-v1-request.json", "task-v1-state.json", "task-v1-result.json"]
      .map(async file => JSON.parse(await readFile(join(fixture, file), "utf8"))));
    const store = new TaskStore(binding.storeRoot);
    await store.create(record, state);
    await store.writeResult(record.task_id, result);

    const scanner = join(installed.root, "node_modules/tree-sitter-rust/src/scanner.c");
    await rm(scanner);
    await expect(verifyInstalledNativePackages(installed.root, "tree-sitter-rust", installed.manifest.build_id))
      .rejects.toMatchObject({ code: "RUNTIME_PARSER_MISMATCH" });
    const cli = join(installed.root, "dist/src/cli.js");
    const doctor = await exec(process.execPath, [cli, "doctor", "--project", project, "--state-root", stateRoot],
      { cwd: root, timeout: 30_000 });
    expect(JSON.parse(doctor.stdout).native_parser).toMatchObject({ status: "unavailable" });

    client = new Client({ name: "passeur_installed_history", version: "1" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cli, "serve", "--project", project, "--state-root", stateRoot], cwd: root, stderr: "pipe" });
    await client.connect(transport, { timeout: 10_000 });
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain("passeur_result");
    expect(tools).toContain("passeur_structural_report");
    const retained = await client.callTool({ name: "passeur_result", arguments: { task_id: record.task_id } });
    expect(retained.isError).not.toBe(true);
    const body = retained.structuredContent ?? JSON.parse((retained.content as { text: string }[])[0]!.text);
    expect(body).toMatchObject({ task_id: record.task_id, encoding: "utf8" });
    expect((body as { content: string }).content).toContain("Historical result retained");
  } finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
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
