import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RuntimeIdentitySchema, RuntimeManifestSchema, type RuntimeIdentity, type RuntimeManifest } from "../contracts/runtime.js";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";

const exec = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const parserPackages = ["tree-sitter-rust", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python",
  "@tree-sitter-grammars/tree-sitter-lua", "@tree-sitter-grammars/tree-sitter-kotlin", "tree-sitter-zig",
  "tree-sitter-c-sharp", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-odin",
  "@tree-sitter-grammars/tree-sitter-svelte"] as const;
function nativeEnvironment(): { node_abi: string; napi: string; libc: string } {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const version = report.header?.glibcVersionRuntime;
  if (process.platform !== "linux" || typeof version !== "string" || !process.versions.modules || !process.versions.napi) {
    throw new BridgeError("BUILD_NATIVE_PLATFORM_UNSUPPORTED", "The parser bundle currently requires qualified Linux/glibc and Node ABI/N-API facts");
  }
  return { node_abi: process.versions.modules, napi: process.versions.napi, libc: `glibc-${version}` };
}
async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name), label = relative(root, path).split(sep).join("/");
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) throw new BridgeError("BUILD_DEPENDENCY_LINK_UNSUPPORTED", "Native parser artifacts may not contain symlinks", { path });
      if (entry.isDirectory()) { hash.update(`D:${label}\n`); await visit(path); }
      else if (entry.isFile()) { const bytes = await readFile(path); hash.update(`F:${label}:${bytes.length}:`); hash.update(bytes); }
      else throw new BridgeError("BUILD_SOURCE_UNSUPPORTED", "Parser artifact contains a special file", { path });
    }
  };
  await visit(root);
  return hash.digest("hex");
}
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
  if (Number.isInteger(value.schema_version) && value.schema_version !== 1 && value.schema_version !== 2) throw new BridgeError("RUNTIME_VERSION_UNSUPPORTED", "Unsupported runtime manifest version", { path });
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
  catch (cause) { throw new BridgeError("RUNTIME_PROCEDURE_FAILED", `Runtime procedure failed: ${command} ${args[0] ?? ""}`, { cause, stage: "runtime.build", path: cwd }); }
}
async function sourceFacts(source: string): Promise<{ revision: string; dirty: boolean; hash: string }> {
  const revision = (await run("git", ["rev-parse", "HEAD"], source)).trim();
  const dirty = Boolean((await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], source)).trim());
  const files = (await run("git", ["ls-files", "-z", "--", "src", "scripts/build-runtime.ts", "tsconfig.json", "package.json", "package-lock.json", "LICENSE", "vendor/native-grammars"], source)).split("\0").filter(Boolean).sort();
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

function manifestBuildId(manifest: RuntimeManifest): string {
  const facts = { source_revision: manifest.source_revision, source_dirty: manifest.source_dirty, source_sha256: manifest.source_sha256,
    lock_sha256: manifest.lock_sha256, package_name: manifest.package_name, package_version: manifest.package_version,
    build_node: manifest.build_node, build_typescript: manifest.build_typescript, build_npm: manifest.build_npm,
    platform: manifest.platform, architecture: manifest.architecture, dependencies: manifest.dependencies,
    ...(manifest.schema_version === 2 ? { compiled_sha256: manifest.compiled_sha256, node_abi: manifest.node_abi,
      napi: manifest.napi, libc: manifest.libc, parser_artifacts: manifest.parser_artifacts } : {}) };
  return digest(JSON.stringify(facts));
}

/** Called in the native child immediately before loading a parser package. */
export async function verifyInstalledNativePackages(rootPath: string, grammarName: string, expectedBuildId?: string): Promise<void> {
  const root = await realpath(rootPath);
  try {
    const manifestFile = await lstat(join(root, "runtime-manifest.json"));
    if (!manifestFile.isFile()) throw new BridgeError("RUNTIME_MANIFEST_INVALID", "Native runtime manifest is not a regular file");
  }
  catch (error) {
    if (nativeCode(error) === "ENOENT") {
      if (expectedBuildId) throw new BridgeError("RUNTIME_MANIFEST_INVALID", "Selected installed native runtime manifest is missing");
      return;
    }
    throw error;
  }
  const manifest = await readManifest(root);
  if (expectedBuildId && manifest.build_id !== expectedBuildId) {
    throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Native child selected a different installed build");
  }
  if (manifest.schema_version !== 2 || manifest.state !== "installed" || manifest.source_dirty) {
    throw new BridgeError("RUNTIME_PARSER_INVALID", "Selected runtime has no installed native parser inventory");
  }
  if (manifestBuildId(manifest) !== manifest.build_id) throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Native parser inventory does not match the selected build");
  const environment = nativeEnvironment();
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch ||
      manifest.node_abi !== environment.node_abi || manifest.napi !== environment.napi || manifest.libc !== environment.libc) {
    throw new BridgeError("RUNTIME_NATIVE_TARGET_UNSUPPORTED", "The selected native parser targets another runtime environment");
  }
  if (!parserPackages.includes(grammarName as typeof parserPackages[number])) {
    throw new BridgeError("RUNTIME_PARSER_INVALID", "Requested grammar is outside the installed parser catalog");
  }
  const engine = manifest.dependencies.find(dependency => dependency.location === "node_modules/tree-sitter" && dependency.name === "tree-sitter");
  const grammar = manifest.parser_artifacts.find(artifact => artifact.name === grammarName && artifact.location === `node_modules/${grammarName}`);
  if (!engine || !("sha256" in engine) || !grammar ||
      manifest.dependencies.filter(dependency => dependency.location === "node_modules/tree-sitter").length !== 1 ||
      manifest.parser_artifacts.filter(artifact => artifact.name === grammarName).length !== 1) {
    throw new BridgeError("RUNTIME_PARSER_INVALID", "Selected native parser packages are absent or ambiguous in the artifact inventory");
  }
  const enginePath = join(root, engine.location), grammarPath = join(root, grammar.location);
  let matches = false;
  try {
    matches = (await lstat(enginePath)).isDirectory() && (await lstat(grammarPath)).isDirectory() &&
      await hashTree(enginePath) === engine.sha256 && await hashTree(grammarPath) === grammar.sha256;
  } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
  if (!matches) {
    throw new BridgeError("RUNTIME_PARSER_MISMATCH", "Selected native parser binding or grammar bytes differ from the installed manifest");
  }
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
    if (manifest.schema_version === 2 && "sha256" in dependency && await hashTree(path) !== dependency.sha256) {
      throw new BridgeError("RUNTIME_DEPENDENCY_MISMATCH", "Installed production dependency bytes differ from the manifest", { path });
    }
  }
  await verifyDependencyTree(root);
  const paths = (await run("npm", ["ls", "--all", "--omit=dev", "--parseable"], root)).trim().split(/\r?\n/).filter((path) => path && resolve(path) !== root);
  const observed = [...new Set(paths.map((path) => relative(root, path).split(sep).join("/")))].sort();
  const expected = [...locations].sort();
  if (!isDeepStrictEqual(observed, expected)) {
    const difference = observed.find((path, index) => path !== expected[index]) ?? expected[observed.length] ?? "none";
    throw new BridgeError("RUNTIME_DEPENDENCY_MISMATCH", `Dependency inventory does not match the complete runtime closure (${observed.length} observed, ${expected.length} declared; first difference: ${difference})`);
  }
  if (manifest.schema_version === 2) {
    const environment = nativeEnvironment();
    if (manifest.node_abi !== environment.node_abi || manifest.napi !== environment.napi || manifest.libc !== environment.libc) {
      throw new BridgeError("RUNTIME_NATIVE_TARGET_UNSUPPORTED", "The installed parser bundle targets another Node ABI/N-API or libc");
    }
    if (await hashTree(join(root, "dist/src")) !== manifest.compiled_sha256) {
      throw new BridgeError("RUNTIME_COMPILED_MISMATCH", "Compiled runtime bytes differ from the manifest");
    }
    const lock: unknown = JSON.parse(lockBytes.toString("utf8"));
    if (!object(lock) || !object(lock.packages)) throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Parser bundle lock metadata is invalid");
    const names = new Set<string>();
    for (const artifact of manifest.parser_artifacts) {
      if (!parserPackages.includes(artifact.name as typeof parserPackages[number]) || names.has(artifact.name) ||
          artifact.location !== `node_modules/${artifact.name}` || locations.has(artifact.location)) {
        throw new BridgeError("RUNTIME_PARSER_INVALID", "Parser inventory contains an unexpected or duplicate package");
      }
      names.add(artifact.name);
      const location = join(root, artifact.location), metadata = await json(join(location, "package.json"));
      const locked = lock.packages[artifact.location];
      if (!object(locked) || metadata.name !== artifact.name || metadata.version !== artifact.version ||
          locked.version !== artifact.version || `${locked.resolved}#${locked.integrity}` !== artifact.source_pin ||
          await hashTree(location) !== artifact.sha256 ||
          !(await readdir(location)).some(name => /^LICENSE(?:\..+)?$/i.test(name))) {
        throw new BridgeError("RUNTIME_PARSER_MISMATCH", "Installed parser source, binary or license differs from its pinned identity", { path: location });
      }
    }
    if (names.size !== parserPackages.length) throw new BridgeError("RUNTIME_PARSER_INVALID", "The parser bundle omits a required grammar package");
  }
  const bom = await json(join(root, manifest.sbom));
  if (bom.bomFormat !== "CycloneDX") throw new BridgeError("SBOM_INVALID", "Runtime has no valid CycloneDX inventory");
  if (manifest.schema_version === 2) {
    const components = bom.components;
    if (!Array.isArray(components) || manifest.dependencies.some(dependency => !components.some((component: unknown) =>
      object(component) && component["bom-ref"] === `urn:passeur:runtime-dependency:${encodeURIComponent(dependency.location)}` &&
      component.name === dependency.name && component.version === dependency.version &&
      Array.isArray(component.hashes) && component.hashes.some(hash => object(hash) && hash.alg === "SHA-256" && hash.content === dependency.sha256))) ||
      manifest.parser_artifacts.some(artifact => !components.some((component: unknown) =>
      object(component) && component.name === artifact.name && component.version === artifact.version &&
      Array.isArray(component.hashes) && component.hashes.some(hash => object(hash) && hash.alg === "SHA-256" && hash.content === artifact.sha256)))) {
      throw new BridgeError("SBOM_INVALID", "CycloneDX inventory omits a hashed production dependency or pinned native parser artifact");
    }
  }
  if (manifestBuildId(manifest) !== manifest.build_id) throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Artifact build identity differs from its declared inputs");
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
  const dependencies: { location: string; name: string; version: string; sha256: string }[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const location = relative(source, path).split(sep).join("/");
    if (!location.startsWith("node_modules/") || !contained(source, await realpath(path)) || (await lstat(path)).isSymbolicLink()) throw new BridgeError("BUILD_DEPENDENCY_LINK_UNSUPPORTED", "Runtime dependencies must be installed within the selected source tree", { path });
    const metadata = await json(join(path, "package.json"));
    const resolvedPackage = lock.packages[location];
    if (!object(resolvedPackage) || resolvedPackage.version !== metadata.version || typeof metadata.name !== "string" || typeof metadata.version !== "string") throw new BridgeError("BUILD_DEPENDENCY_MISMATCH", "Installed dependency does not match the selected lock", { path });
    dependencies.push({ location, name: metadata.name, version: metadata.version, sha256: await hashTree(path) });
  }
  const parserArtifacts: { location: string; name: string; version: string; source_pin: string; sha256: string }[] = [];
  for (const name of parserPackages) {
    const location = `node_modules/${name}`, path = join(source, location);
    if ((await lstat(path)).isSymbolicLink() || !contained(source, await realpath(path))) {
      throw new BridgeError("BUILD_PARSER_LINK_UNSUPPORTED", "Parser package must be a regular installed directory", { path });
    }
    const metadata = await json(join(path, "package.json"));
    const locked = lock.packages[location];
    if (!object(locked) || metadata.name !== name || metadata.version !== locked.version ||
        typeof metadata.version !== "string" || typeof locked.resolved !== "string" || typeof locked.integrity !== "string" ||
        !(await readdir(path)).some(file => /^LICENSE(?:\..+)?$/i.test(file))) {
      throw new BridgeError("BUILD_PARSER_MISMATCH", "Parser package differs from the selected lock or omits its license", { path });
    }
    if (locked.resolved.startsWith("file:")) {
      const archiveLocation = locked.resolved.slice(5);
      const archivePath = resolve(source, archiveLocation);
      if (!archiveLocation.startsWith("vendor/native-grammars/") || !archiveLocation.endsWith(".tgz") ||
          !contained(source, archivePath) || !(await lstat(archivePath)).isFile() ||
          `sha512-${createHash("sha512").update(await readFile(archivePath)).digest("base64")}` !== locked.integrity) {
        throw new BridgeError("BUILD_PARSER_MISMATCH", "Vendored parser source archive differs from its lock integrity", { path: archivePath });
      }
    }
    parserArtifacts.push({ location, name, version: metadata.version, source_pin: `${locked.resolved}#${locked.integrity}`,
      sha256: await hashTree(path) });
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
      if (await hashTree(to) !== dependency.sha256) throw new BridgeError("BUILD_DEPENDENCY_MISMATCH", "Copied production dependency bytes changed during staging", { path: to });
    }
    for (const artifact of parserArtifacts) {
      const from = join(source, artifact.location), to = join(stage, artifact.location);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await cp(from, to, { recursive: true, errorOnExist: true, force: false,
        filter: candidate => !relative(from, candidate).split(sep).includes("node_modules") });
      if (await hashTree(to) !== artifact.sha256) throw new BridgeError("BUILD_PARSER_MISMATCH", "Copied parser bytes changed during staging", { path: to });
    }
    await assertNoSymlinks(stage);
    await verifyDependencyTree(stage);
    const sbom = await run("npm", ["sbom", "--omit=dev", "--sbom-format=cyclonedx"], source);
    const bom: unknown = JSON.parse(sbom);
    if (!object(bom) || bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components)) throw new BridgeError("SBOM_INVALID", "npm did not produce the selected CycloneDX inventory");
    bom.components.push(...dependencies.map(dependency => ({ type: "library",
      "bom-ref": `urn:passeur:runtime-dependency:${encodeURIComponent(dependency.location)}`,
      name: dependency.name, version: dependency.version,
      hashes: [{ alg: "SHA-256", content: dependency.sha256 }],
      properties: [{ name: "passeur:runtime-location", value: dependency.location }] })));
    bom.components.push(...parserArtifacts.map(artifact => ({ type: "library", name: artifact.name, version: artifact.version,
      hashes: [{ alg: "SHA-256", content: artifact.sha256 }],
      externalReferences: [{ type: "distribution", url: artifact.source_pin.split("#")[0] }] })));
    await writeFile(join(stage, "sbom.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const after = await sourceFacts(source);
    if (before.revision !== after.revision || before.hash !== after.hash || (!allowDirty && after.dirty)) throw new BridgeError("BUILD_SOURCE_CHANGED", "Selected source changed during artifact construction");
    const compiled_sha256 = await hashTree(join(stage, "dist/src"));
    const facts = { source_revision: before.revision, source_dirty: before.dirty, source_sha256: before.hash,
      lock_sha256: digest(lockBytes), package_name: pkg.name, package_version: pkg.version,
      build_node: process.version, build_typescript: compilerPackage.version, build_npm: npmVersion, platform: process.platform, architecture: process.arch, dependencies,
      compiled_sha256, ...nativeEnvironment(), parser_artifacts: parserArtifacts };
    const manifest: RuntimeManifest = { schema_version: 2, state: "candidate", ...facts,
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
  // npm redacts UUID-shaped directory components in parseable output, which would corrupt dependency-location checks.
  const destination = join(installRoot, manifest.build_id), stage = join(installRoot, `.install-${randomBytes(16).toString("hex")}`);
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
  // Selection is an explicit registration action. Verify the V2 bytes before a
  // native parser can be advertised; ordinary identity and retained-result
  // reads remain independent of parser package loading.
  if (manifest.schema_version === 2) { await assertNoSymlinks(root); await validateArtifact(root, manifest); }
  const entry = join(root, manifest.cli);
  try { if (!(await lstat(entry)).isFile()) throw new BridgeError("RUNTIME_ENTRY_INVALID", "Installed CLI is not a regular file"); }
  catch (error) { throw filesystemFailure(error, "runtime.entry", entry); }
  return { root, entry, manifest };
}
