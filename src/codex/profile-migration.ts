import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";
import { decodeProfileJson, decodeSharedProfile, effectiveProfileFingerprint, MAX_PROFILE_BYTES } from "../core/profile.js";

export const MAX_MIGRATION_CANDIDATES = 128;
export const MAX_MIGRATION_DIRECTORY_ENTRIES = 256;
type Environment = { HOME?: string | undefined; XDG_CONFIG_HOME?: string | undefined };
type Candidate = { path: string; bytes: Buffer; fingerprint: string };
const requirement = (path?: string) => new BridgeError("PROFILE_DEFAULT_CONFIGURATION_REQUIRED", "An unpinned registration requires a usable installation default profile", {
  ...(path === undefined ? {} : { path }),
  stage: "codex.profile.migration", next_action: "Configure a version-3 installation default, or explicitly migrate an existing profile before registering.",
});
const changed = () => new BridgeError("PROFILE_DEFAULT_MIGRATION_CHANGED", "Profile migration inputs changed; preserve them and retry registration", { stage: "codex.profile.migration" });
const limit = () => new BridgeError("PROFILE_DEFAULT_MIGRATION_LIMIT", "Profile migration discovery exceeded its supported bounds", { stage: "codex.profile.migration" });
function checkedPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new BridgeError("PROFILE_DEFAULT_PATH_UNSAFE", "Migration profile paths must be bounded absolute paths without NUL");
  return resolve(path);
}
/** Reject symlink traversal, including symlinked directories; no arbitrary repository search. */
async function checkParents(path: string): Promise<void> {
  let parent = dirname(path);
  while (true) {
    try {
      const metadata = await lstat(parent);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BridgeError("PROFILE_DEFAULT_PATH_UNSAFE", "Migration refuses symlink or non-directory ancestors");
    } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
async function readCandidate(path: string): Promise<Candidate | undefined> {
  checkedPath(path);
  await checkParents(path);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (nativeCode(error) === "ENOENT") return undefined;
    if (nativeCode(error) === "ELOOP") throw new BridgeError("PROFILE_DEFAULT_PATH_UNSAFE", "Migration refuses a symlink profile");
    throw filesystemFailure(error, "codex.profile.read", path);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PROFILE_BYTES) throw new BridgeError("PROFILE_INVALID", "Migration profile must be a regular file no larger than 64 KiB");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    if (length !== before.size || before.ino !== named.ino || before.dev !== named.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw changed();
    const contents = bytes.subarray(0, length);
    return { path, bytes: contents, fingerprint: effectiveProfileFingerprint(decodeSharedProfile(decodeProfileJson(contents))) };
  } finally { await handle.close(); }
}
async function discover(directory: string, pinned: readonly string[]): Promise<string[]> {
  const paths = new Set(pinned.map(checkedPath));
  if (paths.size > MAX_MIGRATION_CANDIDATES) throw limit();
  await checkParents(join(directory, "profile.json"));
  let entries;
  try { entries = await opendir(directory); }
  catch (error) { if (nativeCode(error) === "ENOENT") return [...paths].sort(); throw filesystemFailure(error, "codex.profile.discover", directory); }
  let count = 0;
  for await (const entry of entries) {
    if (++count > MAX_MIGRATION_DIRECTORY_ENTRIES) throw limit();
    if (!entry.name.endsWith(".json")) continue;
    // The subsequent descriptor-based read verifies regular-file identity and rejects links.
    paths.add(checkedPath(join(directory, entry.name)));
    if (paths.size > MAX_MIGRATION_CANDIDATES) throw limit();
  }
  return [...paths].sort();
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  catch (cause) { throw new BridgeError("PROFILE_PUBLICATION_UNCONFIRMED", "Profile may be published; preserve it because directory durability was not confirmed", { cause, path }); }
  finally { await handle.close(); }
}
/** Called only under the existing Codex writer lease. The returned guard spans TOML publication/inspection. */
export async function ensureInstallationDefaultProfile(options: {
  pinnedProfiles: readonly string[]; authority: () => void; environment?: Environment; validateInputs?: () => Promise<void>;
}): Promise<() => Promise<void>> {
  const environment = options.environment ?? process.env;
  const root = environment.XDG_CONFIG_HOME ?? (environment.HOME ? join(environment.HOME, ".config") : undefined);
  if (!root) throw requirement();
  const directory = join(checkedPath(root), "muse-bridge"), target = join(directory, "default-profile.json");
  const guard = (expected: Candidate) => async () => {
    options.authority();
    const current = await readCandidate(target);
    if (!current || !current.bytes.equals(expected.bytes)) throw changed();
    options.authority();
  };
  options.authority();
  const existing = await readCandidate(target);
  if (existing) return guard(existing);
  const projects = join(directory, "projects");
  const paths = await discover(projects, options.pinnedProfiles);
  const candidates: Candidate[] = [], missing: string[] = [];
  for (const path of paths) {
    const candidate = await readCandidate(path);
    if (candidate) candidates.push(candidate); else missing.push(path);
  }
  if (!candidates.length) throw requirement(target);
  // A fixed implementation root is repository-specific authority, not a safe prospective global default.
  // Opaque adapter options retain their canonical owner; grouping compares them without guessing path semantics.
  if (candidates.some((candidate) => decodeSharedProfile(decodeProfileJson(candidate.bytes)).execution.implementation.worktree_root !== undefined)) {
    throw new BridgeError("PROFILE_DEFAULT_MIGRATION_REQUIRED", "A candidate fixes an implementation worktree root; explicitly configure an installation default suitable for multiple repositories", {
      stage: "codex.profile.migration", next_action: "Review repository-specific execution paths before selecting the installation default; preserve all source profiles.",
    });
  }
  const fingerprints = new Set(candidates.map((candidate) => candidate.fingerprint));
  if (fingerprints.size !== 1) throw new BridgeError("PROFILE_DEFAULT_MIGRATION_REQUIRED", `Found ${fingerprints.size} different effective version-3 profile groups; no installation default was selected`, {
    stage: "codex.profile.migration", next_action: "Explicitly configure the desired version-3 installation default; source profiles and registration remain unchanged.",
  });
  const validateSources = async () => {
    if (!isDeepStrictEqual(await discover(projects, options.pinnedProfiles), paths)) throw changed();
    for (const candidate of candidates) {
      const current = await readCandidate(candidate.path);
      if (!current || !current.bytes.equals(candidate.bytes)) throw changed();
    }
    for (const path of missing) if (await readCandidate(path)) throw changed();
  };
  await validateSources();
  await options.validateInputs?.();
  options.authority();
  await checkParents(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkParents(target);
  const temporary = join(directory, `.passeur-profile-${randomUUID()}.tmp`);
  const selected = candidates[0]!;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(selected.bytes); await handle.chmod(0o600); await handle.sync(); }
    finally { await handle.close(); }
    options.authority();
    await validateSources();
    await options.validateInputs?.();
    await checkParents(target);
    // Hard-link publication is atomic and create-only. Never unlink or replace the target, even on failure.
    try { await link(temporary, target); }
    catch (error) {
      if (nativeCode(error) !== "EEXIST") throw filesystemFailure(error, "codex.profile.publish", target);
      const raced = await readCandidate(target);
      if (!raced || raced.fingerprint !== selected.fingerprint) throw changed();
      await syncDirectory(directory);
      return guard(raced);
    }
    await syncDirectory(directory);
    const published = { ...selected, path: target };
    await guard(published)();
    return guard(published);
  } finally {
    await unlink(temporary).catch((error) => { if (nativeCode(error) !== "ENOENT") throw error; });
  }
}
