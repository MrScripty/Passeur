import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Profile } from "../contracts/index.js";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
async function version(command: string, args = ["--version"]): Promise<string> { try { const output = await exec(command, args, { encoding: "utf8" }); return `${output.stdout}${output.stderr}`.trim(); } catch (error) { return `ERROR: ${error instanceof Error ? error.message : String(error)}`; } }
async function packageVersion(specifier: string, expectedName: string): Promise<string> {
  let directory = dirname(require.resolve(specifier));
  while (directory !== dirname(directory)) {
    try { const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string }; if (manifest.name === expectedName && manifest.version) return manifest.version; } catch {}
    directory = dirname(directory);
  }
  return "unknown";
}

export async function doctor(project: string, profilePath: string, profile: Profile): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    project, profile: profilePath, node: process.version,
    codex: await version("codex"), muse: await version(profile.muse_bin),
    sdk: await packageVersion("@muse-code/sdk", "@muse-code/sdk"),
    mcp_sdk: await packageVersion("@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk"),
    requested_model: profile.model, subscription: profile.subscription, live_task_run: false,
  };
  try { await access(profile.muse_bin); checks.muse_executable = true; } catch { checks.muse_executable = !profile.muse_bin.includes("/"); }
  checks.warning = "Local checks do not prove subscription coverage, model routing, Codex elicitation policy, or runtime sandbox enforcement. Run the explicit live probes in a disposable project.";
  return checks;
}
