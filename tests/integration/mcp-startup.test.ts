import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FrontendStatusSchema } from "../../src/contracts/service.js";
import { CODEX_ENABLED_TOOLS } from "../../src/codex/config.js";
import { resolveRepositoryBinding } from "../../src/core/repository-runtime.js";
import { readDescriptor, existingOwner } from "../../src/service/bootstrap.js";
const exec = promisify(execFile);
async function connect(project: string, state: string) {
  const client = new Client({ name: "passeur_acceptance", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/cli.js"), "serve", "--project", project, "--state-root", state, "--profile", join(state, "absent-profile.json")],
    cwd: process.cwd(), stderr: "pipe" });
  try { await client.connect(transport, { timeout: 10000 }); return client; }
  catch (error) { await client.close(); throw error; }
}
function body(reply: unknown): unknown {
  if (!reply || typeof reply !== "object") throw new Error("Missing response body");
  const result = reply as Record<string, unknown>;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) throw new Error("Missing response body");
  const item: unknown = result.content[0];
  if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") throw new Error("Missing text response");
  return JSON.parse(item.text) as unknown;
}
async function status(client: Client) {
  const result = await client.callTool({ name: "passeur_status", arguments: {} });
  expect(result.isError).not.toBe(true); return FrontendStatusSchema.parse(body(result));
}
async function prepare(client: Client) {
  const result = await client.callTool({ name: "passeur_prepare", arguments: {} }, undefined, { timeout: 20000 });
  expect(result.isError).not.toBe(true);
  const value = FrontendStatusSchema.parse(body(result));
  if (value.service.state !== "connected") throw new Error("No observed service");
  expect(value.service.status.repository.coordination.authority).toBe("held");
  return value.service.status;
}
async function assertGone(project: string, state: string) {
  const binding = await resolveRepositoryBinding({ project, stateRoot: state, profilePath: join(state, "absent-profile.json") }, process.env, AbortSignal.timeout(10000));
  const observation = AbortSignal.timeout(10000);
  while (true) {
    const descriptor = await readDescriptor(binding);
    if (!descriptor || !await existingOwner(descriptor)) return;
    await delay(25, undefined, { signal: observation });
  }
}
it("real front-end discovery survives missing project/profile and permits repair without a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-startup-")), project = join(root, "project"), state = join(root, "state");
  const client = await connect(project, state);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...CODEX_ENABLED_TOOLS].sort());
    expect((await status(client)).service.state).toBe("not_checked");
    expect((await client.callTool({ name: "passeur_prepare", arguments: {} })).isError).toBe(true);
    await mkdir(project);
    const prepared = await prepare(client);
    expect(prepared.repository.execution.profile).toBe("not_checked");
  } finally { await client.close(); await assertGone(project, state); await rm(root, { recursive: true, force: true }); }
}, 30000);
it("two real stdio clients concurrently prepare one service and closing either preserves the other", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-shared-")), project = join(root, "project"), state = join(root, "state");
  await mkdir(project);
  const first = await connect(project, state), second = await connect(project, state);
  try {
    const [a, b] = await Promise.all([prepare(first), prepare(second)]);
    expect(a.generation).toBe(b.generation);
    await first.close();
    const after = await prepare(second);
    expect(after.generation).toBe(a.generation);
    expect((await second.listTools()).tools.map((t) => t.name).sort()).toEqual([...CODEX_ENABLED_TOOLS].sort());
  } finally { await Promise.all([first.close(), second.close()]); await assertGone(project, state); await rm(root, { recursive: true, force: true }); }
}, 30000);
it("linked source views share the service while distinct repositories have different owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-linked-")), project = join(root, "project"), linked = join(root, "linked"), other = join(root, "other"), state = join(root, "state");
  await mkdir(project); await mkdir(other);
  const git = (...args: string[]) => exec("git", ["-C", project, ...args], { timeout: 10000 });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.name=Passeur Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "test: fixture");
  await git("worktree", "add", "-b", "linked", linked);
  const a = await connect(project, state), b = await connect(linked, state), c = await connect(other, state);
  try {
    const [one, two, three] = await Promise.all([prepare(a), prepare(b), prepare(c)]);
    expect(one.generation).toBe(two.generation); expect(three.generation).not.toBe(one.generation);
    expect((await status(a)).binding.project_input).toBe(project); expect((await status(b)).binding.project_input).toBe(linked);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]); await assertGone(project, state); await assertGone(other, state);
    // The only linked fixture head remains reachable through its own named fixture ref.
    await git("worktree", "remove", linked); await rm(root, { recursive: true, force: true });
  }
}, 30000);
