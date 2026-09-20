import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const CODEX_SERVER_NAME = "muse_bridge";
export const CODEX_ENABLED_TOOLS = ["delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize"] as const;

export type CodexMcpRegistration = {
  command: string;
  args: string[];
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  enabled_tools: readonly string[];
};

type InstallOptions = {
  configPath?: string;
  verify?: () => Promise<void>;
};

function tomlString(value: string): string { return JSON.stringify(value); }

export function renderCodexMcpToml(registration: CodexMcpRegistration): string {
  return [
    `[mcp_servers.${CODEX_SERVER_NAME}]`,
    `command = ${tomlString(registration.command)}`,
    `args = [${registration.args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = ${registration.startup_timeout_sec}`,
    `tool_timeout_sec = ${registration.tool_timeout_sec}`,
    `enabled_tools = [${registration.enabled_tools.map(tomlString).join(", ")}]`,
    "",
  ].join("\n");
}

function tablePath(header: string): string[] {
  const parts: string[] = [];
  let current = "", quote: '"' | "'" | undefined;
  for (let index = 0; index < header.length; index++) {
    const character = header[index]!;
    if (quote) {
      if (character === quote && header[index - 1] !== "\\") quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ".") { parts.push(current.trim()); current = ""; }
    else current += character;
  }
  parts.push(current.trim());
  return parts;
}

export function mergeCodexMcpToml(source: string, registration: CodexMcpRegistration): string {
  const headers = [...source.matchAll(/^[ \t]*(?:\[\[([^\]\r\n]+)\]\]|\[([^\]\r\n]+)\])[ \t]*(?:#.*)?(?:\r?\n|$)/gm)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, path: tablePath((match[2] ?? match[1])!) }));
  const owned = headers.filter((header) => header.path[0] === "mcp_servers" && header.path[1] === CODEX_SERVER_NAME);
  const roots = owned.filter((header) => header.path.length === 2);
  if (owned.some((header) => header.path.length > 2)) throw new Error(`Codex server ${CODEX_SERVER_NAME} has nested settings; remove or migrate them before automatic registration`);
  if (roots.length > 1) throw new Error(`Codex config contains duplicate ${CODEX_SERVER_NAME} server tables`);
  const block = renderCodexMcpToml(registration);
  if (!roots.length) {
    if (!source.length) return block;
    const separator = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    return `${source}${separator}${block}`;
  }
  const root = roots[0]!;
  const next = headers.find((header) => header.start >= root.end);
  return `${source.slice(0, root.start)}${block}${source.slice(next?.start ?? source.length)}`;
}

function defaultConfigPath(): string {
  const root = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined);
  if (!root) throw new Error("CODEX_HOME or HOME is required to locate Codex config.toml");
  return join(root, "config.toml");
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function atomicWrite(path: string, contents: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.passeur-codex-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function verifyCodexMcpRegistration(): Promise<void> {
  await exec("codex", ["mcp", "get", CODEX_SERVER_NAME, "--json"], { timeout: 30_000 });
}

export async function installCodexMcpRegistration(registration: CodexMcpRegistration, options: InstallOptions = {}): Promise<{
  configPath: string; backupPath?: string; changed: boolean;
}> {
  const configPath = options.configPath ?? defaultConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  try { if ((await lstat(configPath)).isSymbolicLink()) throw new Error(`Refusing to replace symlinked Codex config: ${configPath}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const original = await readOptional(configPath);
  const source = original?.toString("utf8") ?? "";
  const updated = Buffer.from(mergeCodexMcpToml(source, registration));
  if (original?.equals(updated)) {
    await (options.verify ?? verifyCodexMcpRegistration)();
    return { configPath, changed: false };
  }
  const current = await readOptional(configPath);
  if (Buffer.compare(current ?? Buffer.alloc(0), original ?? Buffer.alloc(0)) !== 0) throw new Error(`Codex config changed concurrently: ${configPath}`);
  const mode = original ? ((await lstat(configPath)).mode & 0o777) : 0o600;
  const backupPath = original ? `${configPath}.passeur-backup` : undefined;
  if (original && backupPath) await atomicWrite(backupPath, original, mode);
  await atomicWrite(configPath, updated, mode);
  try { await (options.verify ?? verifyCodexMcpRegistration)(); }
  catch (error) {
    if (original) await atomicWrite(configPath, original, mode); else await unlink(configPath).catch(() => undefined);
    throw new Error(`Codex rejected the MCP configuration; the previous config was restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { configPath, ...(backupPath ? { backupPath } : {}), changed: true };
}
