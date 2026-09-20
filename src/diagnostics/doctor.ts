import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Profile } from "../contracts/types.js";
import { git, repositoryIdentity } from "../workspace/project.js";
const exec = promisify(execFile), require = createRequire(import.meta.url);
async function version(command: string): Promise<string> {
  try { const output = await exec(command, ["--version"], { encoding: "utf8", timeout: 5000 }); return `${output.stdout}${output.stderr}`.trim(); }
  catch (error) { return `ERROR: ${error instanceof Error ? error.message : String(error)}`; }
}
async function packageVersion(specifier: string, expectedName: string): Promise<string> {
  try {
    let directory = dirname(require.resolve(specifier));
    while (directory !== dirname(directory)) {
      try { const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string }; if (manifest.name === expectedName && manifest.version) return manifest.version; } catch { /* Continue to the owning package root. */ }
      directory = dirname(directory);
    }
  } catch { return "unavailable"; }
  return "unknown";
}
export async function doctor(project: string, profilePath: string, profile: Profile): Promise<Record<string, unknown>> {
  let hooks: string;
  try { hooks = (await git(project, ["config", "--show-origin", "--get", "core.hooksPath"])).trim(); }
  catch { hooks = "No explicit core.hooksPath; Git's default hooks directory applies"; }
  return {
    project, profile: profilePath, repository: await repositoryIdentity(project), node: process.version,
    codex: await version("codex"), muse: await version(profile.muse_bin),
    sdk: await packageVersion("@muse-code/sdk", "@muse-code/sdk"),
    mcp_sdk: await packageVersion("@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk"),
    requested_model: profile.model, subscription: profile.subscription,
    capacity: { max_workers: profile.max_workers ?? 2, max_queued_tasks: profile.max_queued_tasks ?? 8 },
    hook_configuration: hooks, live_task_run: false,
    warning: "No hooks, project tests, or inference were run. These diagnostics do not prove subscription coverage, model routing, prompt policy, sandboxing, signing availability, or provider parallel-session support.",
  };
}
