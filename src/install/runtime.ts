import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RuntimeIdentitySchema, RuntimeManifestSchema, type RuntimeIdentity, type RuntimeManifest } from "../contracts/runtime.js";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";

const exec = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
async function json(path: string): Promise<Record<string, unknown>> {
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch (error) { throw filesystemFailure(error, "runtime.metadata.read", path); }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (cause) { throw new BridgeError("RUNTIME_METADATA_INVALID", "Runtime metadata contains malformed JSON", { cause, path }); }
  if (!object(value)) throw new BridgeError("RUNTIME_METADATA_INVALID", "Runtime metadata must be an object", { path });
  return value;
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
async function assertNoSymlinks(root: string): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isSymbolicLink()) throw new BridgeError("RUNTIME_SYMLINK_UNSUPPORTED", "Installed runtime candidates must be self-contained regular files", { path });
    if (item.isDirectory()) await assertNoSymlinks(path);
  }
}
export async function readManifest(root: string): Promise<RuntimeManifest> {
  const path = join(root, "runtime-manifest.json");
  const value = await json(path);
  if (Number.isInteger(value.schema_version) && value.schema_version !== 1) throw new BridgeError("RUNTIME_VERSION_UNSUPPORTED", "Unsupported runtime manifest version", { path });
  const decoded = RuntimeManifestSchema.safeParse(value);
  if (!decoded.success) throw new BridgeError("RUNTIME_MANIFEST_INVALID", "Runtime manifest does not satisfy the installed artifact contract", { path });
  return decoded.data;
}
export async function runtimeIdentity(root: string): Promise<RuntimeIdentity> {
  const pkg = await json(join(root, "package.json"));
  if (typeof pkg.version !== "string") throw new BridgeError("RUNTIME_METADATA_INVALID", "Package version is unavailable");
  let manifest: RuntimeManifest | undefined;
  try { await lstat(join(root, "runtime-manifest.json")); manifest = await readManifest(root); }
  catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
  if (manifest && manifest.package_version !== pkg.version) throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Package and artifact manifest versions disagree");
  return {
    package_version: pkg.version, build_id: manifest?.build_id ?? "development-unidentified",
    mode: manifest?.state === "installed" && !manifest.source_dirty ? "installed" : "development",
    ...(manifest ? { source_revision: manifest.source_revision } : {}),
    node_version: process.version, node_executable: process.execPath, pid: process.pid, started_at: new Date().toISOString(),
  };
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  try { return (await exec(command, args, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (cause) { throw new BridgeError("RUNTIME_PROCEDURE_FAILED", `Runtime procedure failed: ${command} ${args[0] ?? ""}`, { cause, stage: "runtime.build" }); }
}
async function sourceFacts(source: string): Promise<{ revision: string; dirty: boolean; hash: string }> {
  const revision = (await run("git", ["rev-parse", "HEAD"], source)).trim();
  const dirty = Boolean((await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], source)).trim());
  const files = (await run("git", ["ls-files", "-z", "--", "src", "scripts/build-runtime.ts", "tsconfig.json", "package.json", "package-lock.json", "LICENSE"], source)).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(source, file);
    if (!(await lstat(path)).isFile()) throw new BridgeError("BUILD_SOURCE_UNSUPPORTED", "Build inputs must be regular files", { path });
    const bytes = await readFile(path);
    hash.update(`${Buffer.byteLength(file)}:${file}:${bytes.length}:`); hash.update(bytes);
  }
  return { revision, dirty, hash: hash.digest("hex") };
}
async function verifyRuntimeStartup(root: string, manifest: RuntimeManifest): Promise<void> {
  const output = await run(process.execPath, [join(root, manifest.cli), "--version"], root);
  let value: unknown;
  try { value = JSON.parse(output); }
  catch (cause) { throw new BridgeError("RUNTIME_STARTUP_INVALID", "Runtime did not emit a valid identity response", { cause }); }
  const decoded = RuntimeIdentitySchema.safeParse(value);
  const mode = manifest.state === "installed" && !manifest.source_dirty ? "installed" : "development";
  if (!decoded.success || decoded.data.build_id !== manifest.build_id || decoded.data.package_version !== manifest.package_version
    || decoded.data.source_revision !== manifest.source_revision || decoded.data.mode !== mode) {
    throw new BridgeError("RUNTIME_STARTUP_MISMATCH", "Runtime startup identity does not match the selected artifact");
  }
}
async function verifyDependencyTree(root: string): Promise<void> {
  await run("npm", ["ls", "--all", "--omit=dev", "--json"], root);
}

/** Check the selected artifact's metadata and actual installed dependency identities at publication. */
async function validateArtifact(root: string, manifest: RuntimeManifest): Promise<void> {
  const pkg = await json(join(root, "package.json"));
  const lockBytes = await readFile(join(root, "package-lock.json"));
  if (pkg.name !== manifest.package_name || pkg.version !== manifest.package_version || digest(lockBytes) !== manifest.lock_sha256) {
    throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Artifact package or lock identity differs from its manifest");
  }
  const locations = new Set<string>();
  for (const dependency of manifest.dependencies) {
    const path = resolve(root, dependency.location);
    if (!dependency.location.startsWith("node_modules/") || !contained(root, path) || locations.has(dependency.location)) throw new BridgeError("RUNTIME_DEPENDENCY_INVALID", "Dependency inventory has an invalid or duplicate location");
    locations.add(dependency.location);
    const metadata = await json(join(path, "package.json"));
    if (metadata.name !== dependency.name || metadata.version !== dependency.version) throw new BridgeError("RUNTIME_DEPENDENCY_MISMATCH", "Artifact dependency differs from its manifest", { path });
  }
  await verifyDependencyTree(root);
  const paths = (await run("npm", ["ls", "--all", "--omit=dev", "--parseable"], root)).trim().split(/\r?\n/).filter((path) => path && resolve(path) !== root);
  const observed = [...new Set(paths.map((path) => relative(root, path).split(sep).join("/")))].sort();
  if (!isDeepStrictEqual(observed, [...locations].sort())) throw new BridgeError("RUNTIME_DEPENDENCY_MISMATCH", "Dependency inventory does not match the complete runtime closure");
  const bom = await json(join(root, manifest.sbom));
  if (bom.bomFormat !== "CycloneDX") throw new BridgeError("SBOM_INVALID", "Runtime has no valid CycloneDX inventory");
  const facts = { source_revision: manifest.source_revision, source_dirty: manifest.source_dirty, source_sha256: manifest.source_sha256,
    lock_sha256: manifest.lock_sha256, package_name: manifest.package_name, package_version: manifest.package_version,
    build_node: manifest.build_node, build_typescript: manifest.build_typescript, build_npm: manifest.build_npm,
    platform: manifest.platform, architecture: manifest.architecture, dependencies: manifest.dependencies };
  if (digest(JSON.stringify(facts)) !== manifest.build_id) throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Artifact build identity differs from its declared inputs");
}

/** Build from already provisioned, pinned dependencies. This procedure never installs packages. */
export async function buildRuntimeCandidate(sourcePath: string, outputParentPath: string, allowDirty = false): Promise<string> {
  const source = await realpath(sourcePath), outputParent = resolve(outputParentPath);
  const before = await sourceFacts(source);
  if (before.dirty && !allowDirty) throw new BridgeError("BUILD_SOURCE_DIRTY", "Normal installed candidates require a clean selected source revision");
  const pkg = await json(join(source, "package.json"));
  const lockBytes = await readFile(join(source, "package-lock.json"));
  const lock: unknown = JSON.parse(lockBytes.toString("utf8"));
  if (!object(lock) || !object(lock.packages) || typeof pkg.name !== "string" || typeof pkg.version !== "string" || !object(pkg.devDependencies)) throw new BridgeError("BUILD_INPUT_INVALID", "Expected package metadata and a modern package lock");
  const compilerPackage = await json(join(source, "node_modules/typescript/package.json"));
  if (compilerPackage.version !== pkg.devDependencies.typescript || typeof compilerPackage.version !== "string") throw new BridgeError("BUILD_TOOLCHAIN_MISMATCH", "Provision the exact declared TypeScript version before building");
  await verifyDependencyTree(source);
  const npmVersion = (await run("npm", ["--version"], source)).trim();
  const paths = (await run("npm", ["ls", "--all", "--omit=dev", "--parseable"], source)).trim().split(/\r?\n/).filter((path) => path && resolve(path) !== source);
  const dependencies: RuntimeManifest["dependencies"] = [];
  for (const path of [...new Set(paths)].sort()) {
    const location = relative(source, path).split(sep).join("/");
    if (!location.startsWith("node_modules/") || !contained(source, await realpath(path)) || (await lstat(path)).isSymbolicLink()) throw new BridgeError("BUILD_DEPENDENCY_LINK_UNSUPPORTED", "Runtime dependencies must be installed within the selected source tree", { path });
    const metadata = await json(join(path, "package.json"));
    const resolvedPackage = lock.packages[location];
    if (!object(resolvedPackage) || resolvedPackage.version !== metadata.version || typeof metadata.name !== "string" || typeof metadata.version !== "string") throw new BridgeError("BUILD_DEPENDENCY_MISMATCH", "Installed dependency does not match the selected lock", { path });
    dependencies.push({ location, name: metadata.name, version: metadata.version });
  }
  await mkdir(outputParent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(outputParent, ".passeur-candidate-"));
  let published = false;
  try {
    await run(process.execPath, [join(source, "node_modules/typescript/bin/tsc"), "-p", join(source, "tsconfig.json"), "--outDir", join(stage, ".compiled")], source);
    await mkdir(join(stage, "dist"));
    await cp(join(stage, ".compiled/src"), join(stage, "dist/src"), { recursive: true, errorOnExist: true, force: false });
    await rm(join(stage, ".compiled"), { recursive: true });
    await cp(join(source, "package.json"), join(stage, "package.json"));
    await writeFile(join(stage, "package-lock.json"), lockBytes, { flag: "wx", mode: 0o600 });
    await cp(join(source, "LICENSE"), join(stage, "LICENSE"));
    for (const dependency of dependencies) {
      const from = join(source, dependency.location), to = join(stage, dependency.location);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await cp(from, to, { recursive: true, errorOnExist: true, force: false,
        filter: (candidate) => !relative(from, candidate).split(sep).includes("node_modules") });
    }
    await assertNoSymlinks(stage);
    await verifyDependencyTree(stage);
    const sbom = await run("npm", ["sbom", "--omit=dev", "--sbom-format=cyclonedx"], stage);
    const bom: unknown = JSON.parse(sbom);
    if (!object(bom) || bom.bomFormat !== "CycloneDX") throw new BridgeError("SBOM_INVALID", "npm did not produce the selected CycloneDX inventory");
    await writeFile(join(stage, "sbom.cdx.json"), sbom, { flag: "wx", mode: 0o600 });
    const after = await sourceFacts(source);
    if (before.revision !== after.revision || before.hash !== after.hash || (!allowDirty && after.dirty)) throw new BridgeError("BUILD_SOURCE_CHANGED", "Selected source changed during artifact construction");
    const facts = { source_revision: before.revision, source_dirty: before.dirty, source_sha256: before.hash,
      lock_sha256: digest(lockBytes), package_name: pkg.name, package_version: pkg.version,
      build_node: process.version, build_typescript: compilerPackage.version, build_npm: npmVersion, platform: process.platform, architecture: process.arch, dependencies };
    const manifest: RuntimeManifest = { schema_version: 1, state: "candidate", ...facts,
      build_id: digest(JSON.stringify(facts)), cli: "dist/src/cli.js", sbom: "sbom.cdx.json" };
    await writeFile(join(stage, "runtime-manifest.json"), `${JSON.stringify(RuntimeManifestSchema.parse(manifest), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await verifyRuntimeStartup(stage, manifest);
    const destination = join(outputParent, manifest.build_id);
    try { await lstat(destination); throw new BridgeError("CANDIDATE_EXISTS", "Build identity already has a candidate; it will not be overwritten", { path: destination }); }
    catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    await rename(stage, destination); published = true;
    return destination;
  } finally { if (!published) await rm(stage, { recursive: true, force: true }); }
}

export async function installRuntime(candidatePath: string, installRootPath: string): Promise<{ root: string; manifest: RuntimeManifest; changed: boolean }> {
  const candidate = await realpath(candidatePath);
  let installRoot = resolve(installRootPath);
  const manifest = await readManifest(candidate);
  if (manifest.source_dirty || manifest.state !== "candidate") throw new BridgeError("INSTALL_CANDIDATE_INVALID", "Install requires a clean, explicitly built candidate");
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new BridgeError("INSTALL_TARGET_UNSUPPORTED", "Candidate target does not match this installation environment");
  if (contained(candidate, installRoot)) throw new BridgeError("INSTALL_ROOT_INVALID", "Install root cannot be within the candidate");
  await assertNoSymlinks(candidate);
  await validateArtifact(candidate, manifest);
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  installRoot = await realpath(installRoot);
  if (contained(candidate, installRoot)) throw new BridgeError("INSTALL_ROOT_INVALID", "Install root resolves within the candidate");
  const lockfile = (await import("proper-lockfile")).default;
  let compromised: Error | undefined;
  const release = await lockfile.lock(installRoot, { realpath: true, stale: 30_000, update: 10_000, retries: 0,
    onCompromised: (error: Error) => { compromised = error; } });
  const authority = () => { if (compromised) throw new BridgeError("INSTALL_LEASE_COMPROMISED", "Installer publication authority was lost", { cause: compromised }); };
  const destination = join(installRoot, manifest.build_id), stage = join(installRoot, `.install-${randomUUID()}`);
  let published = false;
  try {
    try {
      await lstat(destination);
      const current = await readManifest(destination);
      if (!isDeepStrictEqual(current, { ...manifest, state: "installed" })) throw new BridgeError("INSTALL_IDENTITY_CONFLICT", "Existing installation does not match the selected build", { path: destination });
      await assertNoSymlinks(destination); await validateArtifact(destination, current);
      await verifyRuntimeStartup(destination, current);
      return { root: destination, manifest: current, changed: false };
    } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    authority();
    await cp(candidate, stage, { recursive: true, force: false, errorOnExist: true });
    const installed: RuntimeManifest = { ...manifest, state: "installed" };
    await writeFile(join(stage, "runtime-manifest.json"), `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o600 });
    await assertNoSymlinks(stage); await validateArtifact(stage, installed);
    await verifyRuntimeStartup(stage, installed);
    authority(); await rename(stage, destination); published = true;
    const directory = await open(installRoot, "r");
    try { await directory.sync(); } catch (cause) { throw new BridgeError("INSTALL_PUBLICATION_UNCONFIRMED", "Runtime may be installed, but directory durability was not confirmed; preserve and inspect it", { cause, path: destination }); }
    finally { await directory.close(); }
    return { root: destination, manifest: installed, changed: true };
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
    if (!compromised) await release();
  }
}

export async function installedEntry(rootPath: string): Promise<{ root: string; entry: string; manifest: RuntimeManifest }> {
  const root = await realpath(rootPath), manifest = await readManifest(root);
  if (manifest.state !== "installed" || manifest.source_dirty) throw new BridgeError("RUNTIME_NOT_INSTALLED", "Select an installed clean runtime or explicitly choose development registration");
  const entry = join(root, manifest.cli);
  try { if (!(await lstat(entry)).isFile()) throw new BridgeError("RUNTIME_ENTRY_INVALID", "Installed CLI is not a regular file"); }
  catch (error) { throw filesystemFailure(error, "runtime.entry", entry); }
  return { root, entry, manifest };
}
