import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "../core/errors.js";

const exec = promisify(execFile);

export async function canonicalProject(path: string): Promise<string> {
  const root = await realpath(path);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new BridgeError("INVALID_PROJECT", "Project path is not a directory");
  return root;
}

export function projectId(root: string): string { return createHash("sha256").update(root).digest("hex").slice(0, 24); }

export async function resolveProjectFile(root: string, input: string): Promise<string> {
  if (isAbsolute(input)) throw new BridgeError("INVALID_PATH", `Absolute path is not allowed: ${input}`);
  const candidate = resolve(root, input);
  const lexical = relative(root, candidate);
  if (lexical === ".." || lexical.startsWith(`..${sep}`)) throw new BridgeError("INVALID_PATH", `Path escapes project: ${input}`);
  const actual = await realpath(candidate);
  const resolved = relative(root, actual);
  if (resolved === ".." || resolved.startsWith(`..${sep}`)) throw new BridgeError("INVALID_PATH", `Symlink escapes project: ${input}`);
  return actual;
}

export async function git(root: string, args: string[]): Promise<string> {
  try { return (await exec("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new BridgeError("GIT_ERROR", error instanceof Error ? error.message : String(error)); }
}

export async function currentRevision(root: string): Promise<string | undefined> { try { return await git(root, ["rev-parse", "HEAD^{commit}"]); } catch { return undefined; } }
export async function sourceStatus(root: string): Promise<string[]> { try { const out = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]); return out ? out.split("\n") : []; } catch { return []; } }

export async function digestFiles(root: string, paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of paths) {
    const absolute = await resolveProjectFile(root, path);
    result[path] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
  return result;
}

export async function repositoryInstructions(root: string): Promise<Array<{ path: string; text: string }>> {
  const names = ["AGENTS.md", "CLAUDE.md"];
  const found: Array<{ path: string; text: string }> = [];
  for (const name of names) {
    try { const path = await resolveProjectFile(root, name); found.push({ path: name, text: (await readFile(path, "utf8")).slice(0, 16_384) }); } catch {}
  }
  return found;
}
