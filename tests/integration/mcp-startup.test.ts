import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { RuntimeStatusSchema } from "../../src/contracts/runtime.js";
const exec = promisify(execFile);
const catalog = ["passeur_agents", "passeur_delegate", "passeur_delegate_batch", "passeur_result", "passeur_finalize", "passeur_status", "passeur_prepare", "delegate_to_muse", "delegate_to_muse_batch", "muse_result", "muse_finalize"].sort();
async function connect(project: string, state: string) {
  const client = new Client({ name: "passeur_acceptance", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/cli.js"), "serve", "--project", project, "--state-root", state, "--profile", join(state, "absent-profile.json")],
    cwd: process.cwd(), stderr: "pipe" });
  try { await client.connect(transport, { timeout: 10000 }); return client; }
  catch (error) { await client.close(); throw error; }
}
async function status(client: Client) {
  const result = await client.callTool({ name: "passeur_status", arguments: {} });
  expect(result.isError).not.toBe(true); return RuntimeStatusSchema.parse(result.structuredContent);
}
it("the real CLI exposes all tools before a missing project, profile or state is accessed; repair needs no restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-startup-")); const project = join(root, "project"), state = join(root, "state");
  const client = await connect(project, state);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(catalog);
    expect((await status(client)).coordination.state).toBe("idle");
    const failure = await client.callTool({ name: "passeur_prepare", arguments: {} });
    expect(failure.isError).toBe(true); expect((await status(client)).coordination.failure?.native_code).toBe("ENOENT");
    await mkdir(project);
    const prepared = await client.callTool({ name: "passeur_prepare", arguments: {} });
    expect(prepared.isError).not.toBe(true);
    expect((await status(client)).coordination.state).toBe("ready");
    expect((await status(client)).execution.profile).toBe("not_checked");
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
it("two stdio processes remain discoverable during contention and the blocked process prepares after safe handover", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-contention-")); const project = join(root, "project"), state = join(root, "state");
  await mkdir(project);
  const first = await connect(project, state), second = await connect(project, state);
  try {
    expect((await first.listTools()).tools.map((tool) => tool.name).sort()).toEqual(catalog);
    expect((await second.listTools()).tools.map((tool) => tool.name).sort()).toEqual(catalog);
    expect((await first.callTool({ name: "passeur_prepare", arguments: {} })).isError).not.toBe(true);
    expect((await second.callTool({ name: "passeur_prepare", arguments: {} })).isError).toBe(true);
    expect((await status(second)).coordination.failure?.code).toBe("PROJECT_IN_USE");
    await first.close();
    expect((await second.callTool({ name: "passeur_prepare", arguments: {} })).isError).not.toBe(true);
    expect((await status(second)).coordination.authority).toBe("held");
  } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
it("linked worktrees share authority while a different repository prepares independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-linked-")); const project = join(root, "project"), linked = join(root, "linked"), other = join(root, "other"), state = join(root, "state");
  await mkdir(project); await mkdir(other);
  const git = (...args: string[]) => exec("git", ["-C", project, ...args], { timeout: 10000 });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.name=Passeur Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "test: fixture");
  await git("worktree", "add", "-b", "linked", linked);
  const a = await connect(project, state), b = await connect(linked, state), c = await connect(other, state);
  try {
    expect((await a.callTool({ name: "passeur_prepare", arguments: {} })).isError).not.toBe(true);
    expect((await b.callTool({ name: "passeur_prepare", arguments: {} })).isError).toBe(true);
    expect((await status(b)).coordination.failure?.code).toBe("PROJECT_IN_USE");
    expect((await c.callTool({ name: "passeur_prepare", arguments: {} })).isError).not.toBe(true);
    expect((await status(a)).binding.repository_id).toBe((await status(b)).binding.repository_id);
  } finally { await Promise.all([a.close(), b.close(), c.close()]); await rm(root, { recursive: true, force: true }); }
}, 30000);
