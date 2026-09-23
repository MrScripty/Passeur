import { COORDINATION_TOOL_NAMES } from "../mcp/coordination-operations.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as TOML from "smol-toml";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { BridgeError, filesystemFailure, nativeCode } from "../core/errors.js";
import { inspectStartupRequirement, resolveStartupRequirement, type StartupPolicyEvidence, type StartupPolicyObservation } from "./startup-policy.js";

const exec = promisify(execFile);
export const CODEX_ENABLED_TOOLS = ["passeur_status", "passeur_prepare", "passeur_agents", "passeur_submit", "passeur_submit_batch", "passeur_tasks", "passeur_wait", "passeur_cancel", "passeur_attach", "passeur_input", "passeur_result", "passeur_structural_report", "passeur_structural_detail", "passeur_finalize", "passeur_delegate", "passeur_delegate_batch", "delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize", ...COORDINATION_TOOL_NAMES] as const;
export type CodexMcpRegistration = {
  server_name: string;
  command: string; args: string[]; cwd: string; env: Record<string, string>;
  startup_timeout_sec: number; tool_timeout_sec: number; enabled_tools: readonly string[];
  project: string; profile: string; state_root: string; repository_id: string; build_id: string;
  development: boolean;
  /** Omitted for an update: preserve the existing server policy. New servers default optional. */
  required?: boolean;
};
export type EditAuthority = { replaceBinding?: string; adoptUnmanaged?: boolean };
type InstallOptions = EditAuthority & { configPath?: string; verify?: () => Promise<StartupPolicyObservation | void> };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function validateServerName(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new BridgeError("SERVER_NAME_INVALID", "Use a 1–64 character server name containing letters, digits, underscore or hyphen");
  return name;
}
function sameToml(left: unknown, right: unknown): boolean {
  // TOML tables are mappings; a parser's null prototype is not a user setting.
  const value = (input: unknown): unknown => Array.isArray(input) ? input.map(value)
    : object(input) && !(input instanceof Date) ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)])) : input;
  return isDeepStrictEqual(value(left), value(right));
}
function document(source: string): Record<string, unknown> {
  try {
    const parsed: unknown = TOML.parse(source, { integersAsBigInt: "asNeeded" });
    if (!object(parsed)) throw new Error("Configuration is not a table");
    return parsed;
  } catch (cause) { throw new BridgeError("CODEX_CONFIG_INVALID", "Codex configuration is not supported valid TOML", { cause, stage: "codex.config.parse" }); }
}
function servers(doc: Record<string, unknown>): Record<string, unknown> {
  const value = doc.mcp_servers;
  if (value === undefined) return {};
  if (!object(value)) throw new BridgeError("CODEX_CONFIG_INVALID", "mcp_servers must be a TOML table");
  return value;
}
function validateRegistration(registration: CodexMcpRegistration): void {
  validateServerName(registration.server_name);
  resolveStartupRequirement(registration.required, undefined);
  for (const [key, value] of Object.entries({ command: registration.command, cwd: registration.cwd, project: registration.project, profile: registration.profile, state_root: registration.state_root })) {
    if (!isAbsolute(value) || value.includes("\0")) throw new BridgeError("REGISTRATION_INVALID", `${key} must be an absolute path without NUL`);
  }
  if (registration.args.some((value) => value.includes("\0")) || !registration.repository_id || !registration.build_id) throw new BridgeError("REGISTRATION_INVALID", "Registration identity or arguments are invalid");
  for (const [name, value] of Object.entries(registration.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /token|secret|password|api.?key/i.test(name) || value.includes("\0")) throw new BridgeError("REGISTRATION_ENV_INVALID", "Only declared noncredential environment inputs may be recorded in registration");
  }
  for (const value of [registration.startup_timeout_sec, registration.tool_timeout_sec]) if (!Number.isFinite(value) || value <= 0) throw new BridgeError("REGISTRATION_INVALID", "Timeouts must be positive seconds");
}
function transport(registration: CodexMcpRegistration) {
  return { command: registration.command, args: [...registration.args], cwd: registration.cwd, required: registration.required ?? false,
    startup_timeout_sec: registration.startup_timeout_sec, tool_timeout_sec: registration.tool_timeout_sec,
    enabled_tools: [...registration.enabled_tools], ...(Object.keys(registration.env).length ? { env: { ...registration.env } } : {}) };
}
function managedBlock(name: string, table: Record<string, unknown>): string {
  return `# passeur:begin ${name}\n${TOML.stringify({ mcp_servers: { [name]: table } } as Parameters<typeof TOML.stringify>[0])}# passeur:end ${name}\n`;
}
export function renderCodexMcpToml(registration: CodexMcpRegistration): string {
  validateRegistration(registration);
  return managedBlock(registration.server_name, transport(registration));
}
function argument(table: unknown, flag: string): string | undefined {
  if (!object(table) || !Array.isArray(table.args) || table.args.some((value) => typeof value !== "string")) return undefined;
  const index = table.args.indexOf(flag);
  return index >= 0 && typeof table.args[index + 1] === "string" ? table.args[index + 1] : undefined;
}
function sameBinding(table: unknown, registration: CodexMcpRegistration): boolean {
  return argument(table, "--project") === registration.project && argument(table, "--profile") === registration.profile
    && argument(table, "--state-root") === registration.state_root && argument(table, "--expected-repository-id") === registration.repository_id;
}
export function registrationFingerprint(table: unknown): string {
  if (!object(table)) throw new BridgeError("REGISTRATION_INVALID", "Existing server binding must be a TOML table");
  // The source is a parsed TOML value. The selected serializer retains dates, bigint and special numbers.
  const encoded = TOML.stringify({ server: table } as Parameters<typeof TOML.stringify>[0]);
  return createHash("sha256").update(encoded).digest("hex");
}

/** Marker text identifies ownership, never TOML grammar. Parse/equivalence proves every resulting edit. */
export function mergeCodexMcpToml(source: string, registration: CodexMcpRegistration, authority: EditAuthority = {}): string {
  validateRegistration(registration);
  const current = document(source), tables = servers(current), prior = tables[registration.server_name];
  registration = { ...registration, required: resolveStartupRequirement(registration.required, object(prior) ? prior.required : undefined) };
  for (const [name, table] of Object.entries(tables)) {
    const repository = argument(table, "--expected-repository-id"), state = argument(table, "--state-root");
    if (repository === registration.repository_id && state && state !== registration.state_root) {
      throw new BridgeError("STATE_BINDING_CONFLICT", `Registration ${name} binds this repository to another state namespace`, {
        stage: "codex.config.binding", next_action: "Use the existing namespace; state migration requires an explicit coordinated cutover.",
      });
    }
  }
  if (prior !== undefined && !sameBinding(prior, registration) && authority.replaceBinding !== registrationFingerprint(prior)) {
    throw new BridgeError("REGISTRATION_COLLISION", `Server ${registration.server_name} already has another or unresolved binding`, {
      stage: "codex.config.binding", next_action: `Review the existing registration, then explicitly replace binding ${registrationFingerprint(prior)}.`,
    });
  }
  // Registration owns launch/catalog fields, not operator approval or denial policy.
  // These already parsed values are preserved exactly, not reinterpreted or weakened.
  const policy = object(prior) ? Object.fromEntries(
    ["enabled", "disabled_tools", "default_tools_approval_mode", "tools"]
      .filter((key) => Object.hasOwn(prior, key)).map((key) => [key, prior[key]]),
  ) : {};
  const selected = { ...policy, ...transport(registration) };
  const expected = { ...current, mcp_servers: { ...tables, [registration.server_name]: selected } };
  const block = managedBlock(registration.server_name, selected);
  const starts = [...source.matchAll(new RegExp(`^# passeur:begin ${registration.server_name}\\r?$`, "gm"))];
  const ends = [...source.matchAll(new RegExp(`^# passeur:end ${registration.server_name}\\r?$`, "gm"))];
  let updated: string;
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index! >= ends[0]!.index!) throw new BridgeError("REGISTRATION_MARKERS_INVALID", "Managed registration markers are incomplete or ambiguous");
    const start = starts[0]!.index!, end = ends[0]!.index! + ends[0]![0].length;
    const owned = document(source.slice(start, end));
    if (Object.keys(owned).length !== 1 || Object.keys(servers(owned)).length !== 1 || !sameToml(servers(owned)[registration.server_name], prior)) throw new BridgeError("REGISTRATION_MARKERS_INVALID", "Managed text does not exclusively own the selected server table");
    updated = source.slice(0, start) + block + source.slice(source[end] === "\n" ? end + 1 : end);
  } else if (prior !== undefined) {
    if (!authority.adoptUnmanaged) throw new BridgeError("REGISTRATION_UNMANAGED", "Existing registration is not in a Passeur-managed block", {
      next_action: "Use explicit --adopt-unmanaged authority to canonicalize TOML; the original backup retains comments and formatting.",
    });
    // Explicit adoption preserves values but not comments/formatting; ordinary updates preserve outside bytes.
    const otherTables = { ...tables }; delete otherTables[registration.server_name];
    const other = { ...current, mcp_servers: otherTables };
    updated = `${TOML.stringify(other as Parameters<typeof TOML.stringify>[0])}\n${block}`;
  } else {
    updated = `${source}${source && !source.endsWith("\n") ? "\n" : ""}${source ? "\n" : ""}${block}`;
  }
  if (!sameToml(document(updated), expected)) {
    throw new BridgeError("CODEX_CONFIG_SEMANTICS_CHANGED", "The edit would change unrelated configuration or misidentify a marker inside a string");
  }
  return updated;
}

export function defaultConfigPath(): string {
  const root = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined);
  if (!root) throw new BridgeError("CODEX_CONFIG_UNAVAILABLE", "CODEX_HOME or HOME is required");
  return join(root, "config.toml");
}
async function readOptional(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if (nativeCode(error) === "ENOENT") return undefined; throw filesystemFailure(error, "codex.config.read", path); }
}
async function atomicWrite(path: string, contents: Buffer, mode: number, authority: () => void): Promise<void> {
  const temporary = join(dirname(path), `.passeur-codex-${randomUUID()}.tmp`);
  try {
    authority();
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(temporary, mode); authority(); await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    catch (cause) { throw new BridgeError("CONFIG_PUBLICATION_UNCONFIRMED", "Configuration may be published, but directory durability was not confirmed; preserve and inspect it", { cause, path }); }
    finally { await directory.close(); }
  } finally { await unlink(temporary).catch((error) => { if (nativeCode(error) !== "ENOENT") throw error; }); }
}
const inspectionSchema = z.object({
  name: z.string(), enabled: z.boolean(), disabled_reason: z.string().nullable().optional(),
  transport: z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()), cwd: z.string(),
    env: z.record(z.string(), z.string()).nullable().optional(), env_vars: z.array(z.string()).nullable().optional(),
  }).passthrough(),
  enabled_tools: z.array(z.string()), disabled_tools: z.array(z.string()).nullable().optional(),
  startup_timeout_sec: z.number(), tool_timeout_sec: z.number(), required: z.boolean().optional(),
}).passthrough();

/** Only the documented stdio inspection variant is supported; unrelated metadata is non-authorizing. */
export function verifyInspection(value: unknown, registration: CodexMcpRegistration): StartupPolicyObservation {
  const parsed = inspectionSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError("CODEX_INSPECTION_UNSUPPORTED", "Codex inspection did not return the supported complete stdio configuration representation");
  const actual = parsed.data;
  if (actual.name !== registration.server_name || !actual.enabled || actual.disabled_reason
    || actual.transport.command !== registration.command || actual.transport.cwd !== registration.cwd
    || !isDeepStrictEqual(actual.transport.args, registration.args)
    || !isDeepStrictEqual(actual.transport.env ?? {}, registration.env)
    || (actual.transport.env_vars?.length ?? 0) !== 0
    || !isDeepStrictEqual([...actual.enabled_tools].sort(), [...registration.enabled_tools].sort())
    || (actual.disabled_tools?.length ?? 0) !== 0
    || actual.startup_timeout_sec !== registration.startup_timeout_sec || actual.tool_timeout_sec !== registration.tool_timeout_sec) {
    throw new BridgeError("CODEX_REGISTRATION_MISMATCH", "Codex resolves a different or disabled registration in the selected project/configuration context");
  }
  return inspectStartupRequirement(actual.required, registration.required);
}
export async function verifyCodexMcpRegistration(registration: CodexMcpRegistration, configPath = defaultConfigPath()): Promise<StartupPolicyObservation> {
  validateServerName(registration.server_name);
  if (basename(configPath) !== "config.toml") throw new BridgeError("CODEX_CONFIG_PATH_UNSUPPORTED", "Codex inspection requires a config.toml inside its selected CODEX_HOME");
  const output = await exec("codex", ["mcp", "get", registration.server_name, "--json"], { cwd: registration.project,
    timeout: 30_000, maxBuffer: 262_144, env: { ...process.env, CODEX_HOME: dirname(configPath) } });
  let value: unknown;
  try { value = JSON.parse(output.stdout); }
  catch (cause) { throw new BridgeError("CODEX_INSPECTION_INVALID", "Codex inspection returned malformed JSON", { cause }); }
  return verifyInspection(value, registration);
}

export async function installCodexMcpRegistration(registration: CodexMcpRegistration, options: InstallOptions = {}): Promise<{ configPath: string; backupPath?: string; changed: boolean; configuration: "passed"; startup_policy: StartupPolicyEvidence }> {
  const configPath = options.configPath ?? defaultConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const lockfile = (await import("proper-lockfile")).default;
  let compromised: Error | undefined;
  const release = await lockfile.lock(configPath, { realpath: false, stale: 30_000, update: 10_000, retries: 0, onCompromised: (error: Error) => { compromised = error; } });
  const authority = () => { if (compromised) throw new BridgeError("CONFIG_LEASE_COMPROMISED", "Codex configuration write authority was lost", { cause: compromised }); };
  try {
    try {
      const metadata = await lstat(configPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new BridgeError("CODEX_CONFIG_UNSAFE", "Refusing to replace a symlink or non-file Codex config");
    } catch (error) { if (nativeCode(error) !== "ENOENT") throw error; }
    const original = await readOptional(configPath);
    const updated = Buffer.from(mergeCodexMcpToml(original?.toString("utf8") ?? "", registration, options));
    // Merge resolves preservation against the original table under the config-writer lease.
    const selected = servers(document(updated.toString("utf8")))[registration.server_name];
    if (!object(selected)) throw new BridgeError("CODEX_CONFIG_INVALID", "Selected registration is missing after merge");
    const resolved = { ...registration, required: resolveStartupRequirement(undefined, selected.required) };
    const verify = options.verify ?? (() => verifyCodexMcpRegistration(resolved, configPath));
    const verifyPublished = async (): Promise<StartupPolicyEvidence> => {
      authority();
      const inspection = await verify();
      authority();
      if (!(await readOptional(configPath))?.equals(updated)) {
        throw new BridgeError("CONFIG_CHANGED_CONCURRENTLY", "Codex config changed during verification; preserve it and inspect the effective configuration");
      }
      return { required: resolved.required, configuration: "passed", inspection: inspection ?? { status: "not_run" }, host_attachment: "not_run" };
    };
    if (original?.equals(updated)) {
      const startup_policy = await verifyPublished();
      return { configPath, changed: false, configuration: "passed", startup_policy };
    }
    const current = await readOptional(configPath);
    if (!isDeepStrictEqual(current, original)) throw new BridgeError("CONFIG_CHANGED_CONCURRENTLY", "Codex config changed before publication");
    const mode = original ? (await lstat(configPath)).mode & 0o777 : 0o600;
    const backupPath = original ? `${configPath}.passeur-${randomUUID()}.bak` : undefined;
    if (original && backupPath) { authority(); await writeFile(backupPath, original, { mode, flag: "wx" }); }
    await atomicWrite(configPath, updated, mode, authority);
    let startup_policy: StartupPolicyEvidence;
    try { startup_policy = await verifyPublished(); }
    catch (cause) {
      const candidate = await readOptional(configPath);
      if (!candidate?.equals(updated) || compromised) throw new BridgeError("CONFIG_ROLLBACK_CONFLICT", "Verification failed, but a changed configuration was preserved rather than overwritten by an old backup", { cause, path: configPath });
      if (original) await atomicWrite(configPath, original, mode, authority);
      else { authority(); await unlink(configPath); }
      throw new BridgeError("CODEX_INSPECTION_FAILED", "Codex configuration inspection failed; the unchanged candidate was rolled back", { cause, path: configPath });
    }
    return { configPath, ...(backupPath ? { backupPath } : {}), changed: true, configuration: "passed", startup_policy };
  } finally { if (!compromised) await release(); }
}
