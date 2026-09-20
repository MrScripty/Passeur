import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { installRuntime, installedEntry, runtimeIdentity } from "../../src/install/runtime.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function candidate(root: string, revision = "a".repeat(40)) {
  await mkdir(join(root, "dist", "src"), { recursive: true });
  const pkg = { name: "passeur-artifact-fixture", version: "1.0.0", private: true, type: "module" };
  const lock = JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version: pkg.version } } });
  await writeFile(join(root, "package.json"), JSON.stringify(pkg)); await writeFile(join(root, "package-lock.json"), lock);
  await writeFile(join(root, "sbom.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components: [] }));
  await writeFile(join(root, "dist", "src", "cli.js"), `import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../../runtime-manifest.json", import.meta.url), "utf8"));
console.log(JSON.stringify({package_version:manifest.package_version,build_id:manifest.build_id,source_revision:manifest.source_revision,
mode:manifest.state === "installed" ? "installed" : "development",node_version:process.version,node_executable:process.execPath,pid:process.pid,started_at:new Date().toISOString()}));
`);
  const facts = { source_revision: revision, source_dirty: false, source_sha256: hash("fixture-source"), lock_sha256: hash(lock),
    package_name: pkg.name, package_version: pkg.version, build_node: process.version, build_typescript: "test-fixture", build_npm: "test-fixture",
    platform: process.platform, architecture: process.arch, dependencies: [] };
  await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ schema_version: 1, state: "candidate", ...facts,
    build_id: hash(JSON.stringify(facts)), cli: "dist/src/cli.js", sbom: "sbom.cdx.json" }));
}
it("publishes a complete controlled artifact once, preserves older installations, and reports stable identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-artifact-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), installs = join(root, "installed");
    await candidate(first); await candidate(second, "b".repeat(40));
    const a = await installRuntime(first, installs), before = await readFile(join(a.root, "dist/src/cli.js"));
    expect(a.changed).toBe(true); expect((await installedEntry(a.root)).manifest.state).toBe("installed");
    expect((await installRuntime(first, installs)).changed).toBe(false);
    const b = await installRuntime(second, installs);
    expect(b.root).not.toBe(a.root); expect(await readFile(join(a.root, "dist/src/cli.js"))).toEqual(before);
    expect((await runtimeIdentity(a.root)).build_id).toBe(a.manifest.build_id);
    expect((await runtimeIdentity(b.root)).build_id).toBe(b.manifest.build_id);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
it("refuses a linked or metadata-mismatched candidate instead of borrowing checkout state", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-artifact-"));
  try {
    const source = join(root, "source"); await candidate(source);
    await symlink(join(root, "external"), join(source, "external-link"));
    await expect(installRuntime(source, join(root, "installed"))).rejects.toMatchObject({ code: "RUNTIME_SYMLINK_UNSUPPORTED" });
    await rm(join(source, "external-link")); await writeFile(join(source, "package-lock.json"), "{}");
    await expect(installRuntime(source, join(root, "installed"))).rejects.toMatchObject({ code: "RUNTIME_IDENTITY_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
