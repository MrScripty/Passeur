import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { BridgeError } from "../core/errors.js";
import { throwIfAborted } from "../core/async.js";

export async function canonicalProject(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new BridgeError("INVALID_PROJECT", "Project path is not a directory");
  return root;
}
export function projectId(root: string): string { return createHash("sha256").update(root).digest("hex").slice(0, 24); }
export async function repositoryIdentity(root: string, signal?: AbortSignal): Promise<{ common_dir: string; id: string }> {
  try {
    const common = await realpath((await gitSterile(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim());
    return { common_dir: common, id: projectId(common) };
  } catch (error) {
    // Non-Git directories remain supported for read-only assignments only.
    if (error instanceof BridgeError && error.code === "GIT_ERROR" && error.message.includes("not a git repository")) return { common_dir: root, id: projectId(root) };
    throw error;
  }
}
export async function repositoryMainWorktree(root: string, signal?: AbortSignal): Promise<string> {
  try {
    const [topText, gitDirText, commonText] = await Promise.all([
      gitSterile(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"], signal),
      gitSterile(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"], signal),
      gitSterile(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
    ]);
    const [top, gitDir, common] = await Promise.all([
      realpath(topText.trim()), realpath(gitDirText.trim()), realpath(commonText.trim()),
    ]);
    if (gitDir === common) return top;

    try {
      const configured = (await gitSterile(root, ["config", "--path", "--get", "core.worktree"], signal)).trim();
      if (configured) return realpath(isAbsolute(configured) ? configured : resolve(common, configured));
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "GIT_ERROR") throw error;
    }

    const fields = (await gitSterile(root, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0");
    const entry = fields.find((field) => field.startsWith("worktree "));
    if (entry) {
      const candidate = await realpath(entry.slice("worktree ".length));
      try {
        const candidateTop = await realpath((await gitSterile(candidate, ["rev-parse", "--path-format=absolute", "--show-toplevel"], signal)).trim());
        const candidateCommon = await realpath((await gitSterile(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim());
        if (candidateTop === candidate && candidateCommon === common) return candidate;
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "GIT_ERROR") throw error;
      }
    }
    throw new BridgeError("GIT_MAIN_WORKTREE_UNAVAILABLE", "Git metadata does not expose the canonical main-worktree path");
  } catch (error) {
    // Preserve the existing non-Git directory identity used by read-only assignments.
    if (error instanceof BridgeError && error.code === "GIT_ERROR" && error.message.includes("not a git repository")) return root;
    throw error;
  }
}
export async function resolveProjectFile(root: string, input: string): Promise<string> {
  if (isAbsolute(input) || input.includes("\0")) throw new BridgeError("INVALID_PATH", `Invalid project path: ${input}`);
  const candidate = resolve(root, input);
  if (!isWithin(root, candidate)) throw new BridgeError("INVALID_PATH", `Path escapes project: ${input}`);
  const actual = await realpath(candidate);
  if (!isWithin(root, actual)) throw new BridgeError("INVALID_PATH", `Symlink escapes project: ${input}`);
  return actual;
}
export function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function runGit(root: string, args: string[], signal?: AbortSignal, input?: string, environment?: Readonly<Record<string, string>>, sterile = false): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      ...(environment || sterile ? { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !sterile || !key.startsWith("GIT_"))), ...environment } } : {}),
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: unknown, killTimer: NodeJS.Timeout | undefined, lastTimer: NodeJS.Timeout | undefined;
    const sendSignal = (name: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error; }
    };
    const stop = (reason: unknown) => {
      if (failure) return;
      failure = reason;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => sendSignal("SIGKILL"), 1000);
      lastTimer = setTimeout(() => {
        reject(new BridgeError("GIT_STOP_UNCONFIRMED", "Git or its hook descendants did not close after termination"));
        child.stdin?.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
      }, 3000);
    };
    const abort = () => stop(signal?.reason ?? new BridgeError("REQUEST_CANCELLED", "Git operation cancelled"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop(new BridgeError("GIT_OUTPUT_LIMIT", "Git output exceeds 16 MiB")); else stdout.push(data); });
    child.stderr!.on("data", (data: Buffer) => { if (stderr.reduce((n, b) => n + b.length, 0) < 65_536) stderr.push(data); });
    child.on("error", (error) => { failure ??= error; });
    if (input !== undefined) {
      child.stdin!.on("error", (error) => { failure ??= error; });
      child.stdin!.end(input);
    }
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (lastTimer) clearTimeout(lastTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new BridgeError("GIT_ERROR", Buffer.concat(stderr).toString("utf8").trim() || `git ${args[0]} exited ${code}`));
      else resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
/** Git subprocesses, including hooks spawned during worktree creation, remain owned on POSIX. */
export async function git(root: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  return runGit(root, args, signal, input);
}
/** Object inspection must fail locally instead of contacting a configured promisor remote. */
export async function gitWithoutLazyFetch(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  return runGit(root, args, signal, undefined, { GIT_NO_LAZY_FETCH: "1" });
}
/** Use only with a service-created repository whose local config is inert. Worker Git metadata is never a safe root here. */
export async function gitSterile(root: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  const environment = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
  return runGit(root, ["-c", "core.hooksPath=/dev/null", "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", `core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "protocol.file.allow=never", ...args], signal, input, environment, true);
}
export function validateOid(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) throw new BridgeError("INVALID_COMMIT", "Expected a full Git object ID");
}
export async function exactCommit(root: string, oid: string, signal?: AbortSignal): Promise<string> {
  validateOid(oid);
  const actual = (await git(root, ["rev-parse", "--verify", `${oid}^{commit}`], signal)).trim();
  if (actual.toLowerCase() !== oid.toLowerCase()) throw new BridgeError("INVALID_COMMIT", "Expected an exact commit, not a tag object");
  return actual;
}
export async function validateBranchRef(root: string, ref: string, signal?: AbortSignal): Promise<void> {
  if (!ref.startsWith("refs/heads/") || ref.length > 512) throw new BridgeError("INVALID_REF", "Expected a full local branch ref");
  await git(root, ["check-ref-format", ref], signal);
}
export async function refHead(root: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
  const refs = (await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", ref], signal)).trim().split("\n");
  return refs.find((line) => line.startsWith(`${ref} `))?.slice(ref.length + 1);
}
export async function isAncestor(root: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
  validateOid(ancestor); validateOid(descendant);
  const mergeBase = (await git(root, ["merge-base", ancestor, descendant], signal)).trim();
  return mergeBase === ancestor;
}
export async function currentRevision(root: string, signal?: AbortSignal): Promise<string | undefined> {
  try { return (await git(root, ["rev-parse", "HEAD^{commit}"], signal)).trim(); }
  catch (error) { if (error instanceof BridgeError && error.code === "GIT_ERROR") return undefined; throw error; }
}
export async function sourceStatus(root: string, strict = false, signal?: AbortSignal): Promise<string[]> {
  try { return (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)).split("\0").filter(Boolean); }
  catch (error) {
    if (!strict && error instanceof BridgeError && error.code === "GIT_ERROR" && error.message.includes("not a git repository")) return [];
    throw error;
  }
}
export async function digestFiles(root: string, paths: string[], allowMissing = false): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const path of paths) {
    try { result[path] = createHash("sha256").update(await readFile(await resolveProjectFile(root, path))).digest("hex"); }
    catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; result[path] = null; }
  }
  return result;
}
export async function repositoryInstructions(root: string): Promise<Array<{ path: string; text: string }>> {
  const found: Array<{ path: string; text: string }> = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try { found.push({ path: name, text: (await readFile(await resolveProjectFile(root, name), "utf8")).slice(0, 16_384) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return found;
}

/** Delete the exact task ref only while a known protecting ref still has its verified value. */
export async function deleteProtectedRef(root: string, branch: string, expected: string, protectionRef: string, signal?: AbortSignal, assertAuthority?: () => void): Promise<void> {
  await validateBranchRef(root, branch, signal);
  if (branch === protectionRef) throw new BridgeError("INVALID_PROTECTION", "A resource cannot protect itself during deletion");
  await git(root, ["check-ref-format", protectionRef], signal);
  const protectedHead = await refHead(root, protectionRef, signal);
  if (!protectedHead || !await isAncestor(root, expected, protectedHead, signal)) throw new BridgeError("COMMIT_NOT_RETAINED", "The protecting ref does not retain the expected task commit");
  // Git locks and verifies both refs in one transaction; a concurrent target movement refuses deletion.
  assertAuthority?.();
  await git(root, ["update-ref", "--stdin"], signal, `start\nverify ${protectionRef} ${protectedHead}\ndelete ${branch} ${expected}\nprepare\ncommit\n`);
}
