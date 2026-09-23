import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { onTestFinished, test } from "vitest";
// @ts-expect-error Shared real-Git fixture has no TypeScript declaration.
import { serviceFixture } from "../fixtures/structural/service-fixture.mjs";
import { responseSchemas } from "../../src/contracts/service.js";

const execute = promisify(execFile);
const cli = resolve("dist/src/cli.js");
type Fixture = Awaited<ReturnType<typeof serviceFixture>>;

function content(reply: unknown): unknown {
  const result = reply as { structuredContent?: unknown; content?: { text?: string }[] };
  if (result.structuredContent !== undefined) return result.structuredContent;
  assert.ok(result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function call(client: Client, name: string, arguments_: Record<string, unknown>, failure?: string): Promise<unknown> {
  const reply = await client.callTool({ name: `passeur_${name}`, arguments: arguments_ }, undefined, { timeout: 30000 });
  const value = content(reply);
  if (failure) {
    assert.equal(reply.isError, true, JSON.stringify(value));
    assert.equal((value as { error: { code: string } }).error.code, failure);
  } else assert.notEqual(reply.isError, true, JSON.stringify(value));
  return value;
}

async function start(format: "sha1" | "sha256"): Promise<{ f: Fixture; profile: string }> {
  const f = await serviceFixture({ name: `source-trust-${format}`, after: onTestFinished }, { format });
  await f.service.close();
  const profile = join(f.temp, "absent-profile.json");
  const request = join(f.temp, "initialize.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  await execute(process.execPath, [cli, "coordinate", "--project", f.root, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 30000 });
  return { f, profile };
}

async function connect(f: Fixture, profile: string, project: string): Promise<Client> {
  const client = new Client({ name: "source-trust-acceptance", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, "serve", "--project", project, "--state-root", f.state, "--profile", profile],
    cwd: process.cwd(), stderr: "pipe" });
  try { await client.connect(transport, { timeout: 10000 }); }
  catch (error) { await client.close(); throw error; }
  f.sessions.push({ close: () => client.close() });
  return client;
}

async function register(client: Client, input: string, path: string): Promise<string> {
  const result = await call(client, "work", { request: { schema_version: 1, kind: "command", command: {
    kind: "register_external_work", operation_key: randomUUID(), input_oid: input,
    intent: `Inspect identified ${path}`, areas: [{ kind: "file", path }], readers: [],
  } } });
  return (result as { receipt: { item_id: string } }).receipt.item_id;
}

async function report(client: Client, work: string, path: string) {
  const result = responseSchemas.structural_report.parse(await call(client, "structural_report", { work_id: work }));
  const row = result.reports.find(item => item.path === path);
  assert.ok(row, JSON.stringify(result));
  return row;
}

async function detail(client: Client, work: string, reportId: string, side: "input" | "observed", bytes: Buffer) {
  const result = responseSchemas.structural_detail.parse(await call(client, "structural_detail", {
    work_id: work, report_id: reportId, side, start_byte: 0, end_byte: bytes.length,
  }));
  assert.equal(result.text, bytes.toString("utf8"));
  assert.equal(result.content_sha256, createHash("sha256").update(bytes).digest("hex"));
}

for (const format of ["sha1", "sha256"] as const) {
  test(`public source identity uses exact ${format} input blobs across linked worktrees and divergent bases`, async () => {
    const { f, profile } = await start(format);
    const initial = Buffer.from("export function run() {}\n");
    const inputOid = (await execute("git", ["rev-parse", `${f.base}:source.ts`], { cwd: f.root })).stdout.trim();
    assert.equal(inputOid.length, format === "sha1" ? 40 : 64);
    const gitBlob = Buffer.from((await execute("git", ["cat-file", "blob", inputOid], { cwd: f.root })).stdout);
    assert.deepEqual(gitBlob, initial);

    const first = await f.linked(`${format}-worker-one`);
    const second = await f.linked(`${format}-worker-two`);
    const third = await f.linked(`${format}-worker-three`);
    const a = await connect(f, profile, first), b = await connect(f, profile, second), c = await connect(f, profile, third);
    const workA = await register(a, f.base, "source.ts");
    const workB = await register(b, f.base, "source.ts");
    const workC = await register(c, f.base, "independent.ts");
    const firstBytes = Buffer.from("export function run(value: number): number { return value + 11; }\n");
    const secondBytes = Buffer.from("export function run(value: number): number { return value + 22; }\n");
    const thirdBytes = Buffer.from("export function independent(): number { return 33; }\n");
    await Promise.all([writeFile(join(first, "source.ts"), firstBytes), writeFile(join(second, "source.ts"), secondBytes),
      writeFile(join(third, "independent.ts"), thirdBytes)]);
    // A dirty parent and its later HEAD must not change any registered worker input.
    await f.commit(f.root, "source.ts", "export function run() { return 99; }\n");
    await writeFile(join(f.root, "source.ts"), "export function run() { return 999; }\n");
    const ra = await report(a, workA, "source.ts");
    const rb = await report(b, workB, "source.ts");
    const rc = await report(c, workC, "independent.ts");
    for (const [row, work] of [[ra, workA], [rb, workB], [rc, workC]] as const) {
      assert.match(row.text, new RegExp(`WORK "${work}"`));
      assert.match(row.text, new RegExp(`INPUT — commit ${f.base}`));
      assert.match(row.text, /Attribution: observed in this work; exclusive authorship is not established\./);
      assert.match(row.text, new RegExp(`\\(${format}\\)`));
    }
    await detail(a, workA, ra.report_id, "input", gitBlob);
    await detail(b, workB, rb.report_id, "input", gitBlob);
    await detail(a, workA, ra.report_id, "observed", firstBytes);
    await detail(b, workB, rb.report_id, "observed", secondBytes);
    await detail(c, workC, rc.report_id, "observed", thirdBytes);
    assert.match(rc.text, /status: absent_in_commit/);
    assert.match(rc.text, /added: "independent"/);

    // A new work registered against another base sees that exact commit, while the old reports remain identified.
    const changedBase = await f.commit(f.root, "base.ts", "export const baseline = 7;\n");
    const fourth = await f.linked(`${format}-other-base`);
    await execute("git", ["checkout", "--detach", changedBase], { cwd: fourth });
    const d = await connect(f, profile, fourth);
    await writeFile(join(fourth, "source.ts"), firstBytes);
    const workOtherBase = await register(d, changedBase, "source.ts");
    const other = await report(d, workOtherBase, "source.ts");
    assert.match(other.text, new RegExp(`INPUT — commit ${changedBase}`));
    await detail(d, workOtherBase, other.report_id, "observed", firstBytes);

    const deletedRoot = await f.linked(`${format}-deletion`);
    const deletionClient = await connect(f, profile, deletedRoot);
    await unlink(join(deletedRoot, "source.ts"));
    const deletionWork = await register(deletionClient, f.base, "source.ts");
    const deletion = await report(deletionClient, deletionWork, "source.ts");
    assert.match(deletion.text, /OBSERVED — capture [^\n]+\n[\s\S]*?status: missing_during_capture/);
    await detail(deletionClient, deletionWork, deletion.report_id, "input", gitBlob);

    const importedBytes = Buffer.from("export function imported(): number { return 44; }\n");
    const importedCommit = await f.commit(f.root, "imported.ts", importedBytes.toString("utf8"));
    const importedRoot = await f.linked(`${format}-imported`);
    await execute("git", ["cherry-pick", importedCommit], { cwd: importedRoot });
    const importedClient = await connect(f, profile, importedRoot);
    const importedWork = await register(importedClient, f.base, "imported.ts");
    const imported = await report(importedClient, importedWork, "imported.ts");
    assert.match(imported.text, new RegExp(`HEAD anchor: ${(await execute("git", ["rev-parse", "HEAD"], { cwd: importedRoot })).stdout.trim()}`));
    assert.match(imported.text, /Attribution: observed in this work; exclusive authorship is not established\./);
    await detail(importedClient, importedWork, imported.report_id, "observed", importedBytes);

    const addRootA = await f.linked(`${format}-add-a`);
    const addRootB = await f.linked(`${format}-add-b`);
    const addClientA = await connect(f, profile, addRootA);
    const addClientB = await connect(f, profile, addRootB);
    const addA = Buffer.from("export function shared(): number { return 101; }\n");
    const addB = Buffer.from("export function shared(): number { return 202; }\n");
    await writeFile(join(addRootA, "shared.ts"), addA);
    await writeFile(join(addRootB, "shared.ts"), addB);
    const addWorkA = await register(addClientA, f.base, "shared.ts");
    const addWorkB = await register(addClientB, f.base, "shared.ts");
    const addedA = await report(addClientA, addWorkA, "shared.ts");
    const addedB = await report(addClientB, addWorkB, "shared.ts");
    assert.match(addedA.text, /status: absent_in_commit/);
    assert.match(addedB.text, /status: absent_in_commit/);
    assert.match(addedA.text, /added: "shared"/);
    assert.match(addedB.text, /added: "shared"/);
    await detail(addClientA, addWorkA, addedA.report_id, "observed", addA);
    await detail(addClientB, addWorkB, addedB.report_id, "observed", addB);
  }, 120000);
}

test("public source trust refuses unsafe captures and retains exact detail after an editor replacement", async () => {
  const { f, profile } = await start("sha1");
  const owner = await connect(f, profile, f.root);
  const safe = await register(owner, f.base, "source.ts");
  const original = Buffer.from("export function run(value: number): number { return value + 2; }\n");
  await writeFile(join(f.root, "source.ts"), original);
  const first = await report(owner, safe, "source.ts");
  await writeFile(join(f.root, "source.ts"), "export function run() { return -1; }\n");
  await detail(owner, safe, first.report_id, "observed", original);
  await call(owner, "structural_detail", { work_id: safe, report_id: first.report_id, side: "observed",
    start_byte: 0, end_byte: original.length + 1 }, "SOURCE_RANGE_INVALID");
  await call(owner, "structural_detail", { work_id: safe, report_id: first.report_id, side: "observed",
    start_byte: 0, end_byte: 8193 }, "STRUCTURAL_RANGE_INVALID");

  const secret = join(f.temp, "outside-secret.ts");
  await writeFile(secret, "export const secret = 'never expose';\n");
  const symlinkRoot = await f.linked("unsafe-symlink");
  const symlinkClient = await connect(f, profile, symlinkRoot);
  await symlink(secret, join(symlinkRoot, "linked.ts"));
  const symlinkWork = await register(symlinkClient, f.base, "linked.ts");
  const symlinkResult = await call(symlinkClient, "structural_report", { work_id: symlinkWork });
  assert.match(responseSchemas.structural_report.parse(symlinkResult).reports[0]!.text, /entry: symlink/);
  assert.ok(!(JSON.stringify(symlinkResult)).includes("never expose"));

  const binaryRoot = await f.linked("unsafe-binary");
  const binaryClient = await connect(f, profile, binaryRoot);
  const binary = join(binaryRoot, "binary.ts");
  await writeFile(binary, Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0xff]));
  const binaryWork = await register(binaryClient, f.base, "binary.ts");
  await call(binaryClient, "structural_report", { work_id: binaryWork }, "SOURCE_ENCODING_UNSUPPORTED");

  const largeRoot = await f.linked("unsafe-large");
  const largeClient = await connect(f, profile, largeRoot);
  const large = join(largeRoot, "large.ts");
  await writeFile(large, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const largeWork = await register(largeClient, f.base, "large.ts");
  await call(largeClient, "structural_report", { work_id: largeWork }, "SOURCE_TOO_LARGE");

  const nestedRoot = await f.linked("unsafe-nested");
  const nestedClient = await connect(f, profile, nestedRoot);
  await mkdir(join(nestedRoot, "nested"));
  await mkdir(join(nestedRoot, "nested", ".git"));
  await writeFile(join(nestedRoot, "nested", "hidden.ts"), "export const secret = 'nested secret';\n");
  const nestedWork = await register(nestedClient, f.base, "nested/hidden.ts");
  const nestedResult = await call(nestedClient, "structural_report", { work_id: nestedWork });
  assert.ok(responseSchemas.structural_report.parse(nestedResult).limitations.includes("nested_repository_boundary"));
  assert.ok(!(JSON.stringify(nestedResult)).includes("nested secret"));

  const ancestorRoot = await f.linked("unsafe-ancestor");
  const ancestorClient = await connect(f, profile, ancestorRoot);
  const outside = join(f.temp, "outside-directory");
  await mkdir(outside);
  await writeFile(join(outside, "hidden.ts"), "export const secret = 'ancestor secret';\n");
  await symlink(outside, join(ancestorRoot, "ancestor"));
  const ancestorWork = await register(ancestorClient, f.base, "ancestor/hidden.ts");
  const ancestorResult = await call(ancestorClient, "structural_report", { work_id: ancestorWork }, "SOURCE_PATH_UNSAFE");
  assert.ok(!(JSON.stringify(ancestorResult)).includes("ancestor secret"));

  const fifoRoot = await f.linked("unsafe-fifo");
  const fifoClient = await connect(f, profile, fifoRoot);
  await execute("mkfifo", [join(fifoRoot, "pipe.ts")]);
  const fifoWork = await register(fifoClient, f.base, "pipe.ts");
  const fifoResult = await call(fifoClient, "structural_report", { work_id: fifoWork });
  const fifoReport = responseSchemas.structural_report.parse(fifoResult);
  assert.equal(fifoReport.reports.length, 1);
  assert.match(fifoReport.reports[0]!.text, /entry: special/);
  assert.ok(fifoReport.limitations.includes("non_source_working_entry"));

  const gitlinkRoot = await f.linked("unsafe-gitlink");
  const gitlinkClient = await connect(f, profile, gitlinkRoot);
  await execute("git", ["update-index", "--add", "--cacheinfo", `160000,${f.base},submodule`], { cwd: gitlinkRoot });
  await mkdir(join(gitlinkRoot, "submodule"));
  await writeFile(join(gitlinkRoot, "submodule", "secret.ts"), "export const secret = 'gitlink secret';\n");
  const gitlinkWork = await register(gitlinkClient, f.base, "submodule/secret.ts");
  const gitlinkResult = await call(gitlinkClient, "structural_report", { work_id: gitlinkWork });
  assert.ok(responseSchemas.structural_report.parse(gitlinkResult).limitations.includes("nested_repository_boundary"));
  assert.ok(!(JSON.stringify(gitlinkResult)).includes("gitlink secret"));

  const escaped = Buffer.from("export const text = '\u001b[31m';\n");
  await writeFile(join(f.root, "source.ts"), escaped);
  const escapedReport = await report(owner, safe, "source.ts");
  assert.ok(!escapedReport.text.includes("\u001b"));
  await detail(owner, safe, escapedReport.report_id, "observed", escaped);
  assert.equal(await readFile(secret, "utf8"), "export const secret = 'never expose';\n");

  const filterScript = join(f.temp, "filter-sentinel.sh");
  const filterSentinel = join(f.temp, "filter-invoked");
  const escapedSentinel = `'${filterSentinel.replace(/'/g, "'\\''")}'`;
  await writeFile(filterScript, `#!/bin/sh\nprintf invoked > ${escapedSentinel}\ncat\n`);
  await chmod(filterScript, 0o700);
  await execute("git", ["config", "filter.structural-trust.smudge", filterScript], { cwd: f.root });
  await execute("git", ["config", "filter.structural-trust.clean", filterScript], { cwd: f.root });
  await writeFile(join(f.root, ".gitattributes"), "source.ts filter=structural-trust\n");
  const filtered = await report(owner, safe, "source.ts");
  await detail(owner, safe, filtered.report_id, "observed", escaped);
  await assert.rejects(access(filterSentinel), { code: "ENOENT" });
}, 120000);

test("descriptor capture rejects a deterministic ancestor replacement while Git HEAD verification is paused", async () => {
  const { f } = await start("sha1");
  const sourceDir = join(f.root, "owned");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "target.ts"), "export function owned() {}\n");
  const gate = join(f.temp, "gate"), wrapperDir = join(f.temp, "wrapper");
  await mkdir(gate); await mkdir(wrapperDir);
  const realGit = (await execute("which", ["git"])).stdout.trim();
  const wrapper = join(wrapperDir, "git");
  await writeFile(wrapper, `#!/bin/sh\ncase " $* " in\n  *'HEAD^{commit}'*)\n    n=0\n    if [ -f "$PASSEUR_TEST_GATE/count" ]; then n=$(cat "$PASSEUR_TEST_GATE/count"); fi\n    n=$((n + 1))\n    printf '%s' "$n" > "$PASSEUR_TEST_GATE/count"\n    if [ "$n" -eq 2 ]; then\n      : > "$PASSEUR_TEST_GATE/ready"\n      while [ ! -f "$PASSEUR_TEST_GATE/release" ]; do sleep 0.01; done\n    fi\n    ;;\nesac\nexec "$PASSEUR_TEST_REAL_GIT" "$@"\n`);
  await chmod(wrapper, 0o700);
  const script = `import { captureWorkingFile } from ${JSON.stringify(resolve("dist/src/observation/source.js"))};\n` +
    `try { await captureWorkingFile({root:process.argv[1],workspace_id:'fixture',workspace_generation:1,capture_sequence:1,` +
    `input_commit_oid:process.argv[2]},'owned/target.ts',{max_bytes:1024}); console.log(JSON.stringify({code:'unexpected_success'})); }` +
    ` catch (error) { console.log(JSON.stringify({code:error.code,message:error.message})); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.root, f.base], {
    cwd: process.cwd(), env: { ...process.env, PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
      PASSEUR_TEST_GATE: gate, PASSEUR_TEST_REAL_GIT: realGit }, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", part => stdout.push(part));
  child.stderr.on("data", part => stderr.push(part));
  const exit = once(child, "exit");
  let setupFailure: unknown;
  try {
    const deadline = AbortSignal.timeout(10000);
    while (true) {
      try { await access(join(gate, "ready")); break; }
      catch { await delay(20, undefined, { signal: deadline }); }
    }
    await rename(sourceDir, join(f.root, "owned-retired"));
    const outside = join(f.temp, "replacement");
    await mkdir(outside);
    await writeFile(join(outside, "target.ts"), "export const secret = 'wrong ancestor';\n");
    await symlink(outside, sourceDir);
  } catch (error) {
    setupFailure = error;
  } finally {
    await writeFile(join(gate, "release"), "release");
  }
  const [code] = await exit;
  if (setupFailure) throw setupFailure;
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { code: string; message: string };
  assert.equal(result.code, "SOURCE_CAPTURE_MOVED", JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("wrong ancestor"));
}, 30000);

test("public source identity survives retirement of the original checkout when the shared Git object store remains", async () => {
  const f = await serviceFixture({ name: "retired-original-source", after: onTestFinished });
  await f.service.close();
  const bare = join(f.temp, "shared-objects.git");
  const original = join(f.temp, "original-checkout");
  const surviving = join(f.temp, "surviving-checkout");
  await execute("git", ["clone", "--bare", f.root, bare]);
  await execute("git", ["--git-dir", bare, "worktree", "add", "-b", "original", original, f.base]);
  await execute("git", ["--git-dir", bare, "worktree", "add", "-b", "surviving", surviving, f.base]);
  const profile = join(f.temp, "absent-profile.json");
  const request = join(f.temp, "initialize-retired.json");
  await writeFile(request, JSON.stringify({ schema_version: 1, kind: "initialize", limits: f.limits }));
  await execute(process.execPath, [cli, "coordinate", "--project", original, "--state-root", f.state,
    "--profile", profile, "--request", request, "--yes"], { timeout: 30000 });
  const owner = await connect(f, profile, surviving);
  const work = await register(owner, f.base, "source.ts");
  const observed = Buffer.from("export function run(): number { return 87; }\n");
  await writeFile(join(surviving, "source.ts"), observed);
  await execute("git", ["--git-dir", bare, "worktree", "remove", original]);
  await assert.rejects(access(original), { code: "ENOENT" });
  const row = await report(owner, work, "source.ts");
  assert.match(row.text, new RegExp(`INPUT — commit ${f.base}`));
  await detail(owner, work, row.report_id, "observed", observed);
}, 60000);

test("a mounted character device cannot cross the registered worktree source boundary", async context => {
  try { await execute("which", ["bwrap"]); }
  catch { context.skip("bubblewrap is unavailable on this test host"); return; }
  const f = await serviceFixture({ name: "device-source-boundary", after: onTestFinished });
  const placeholder = join(f.root, "device.ts");
  const sentinel = "export const secret = 'placeholder must remain unread';\n";
  await writeFile(placeholder, sentinel);
  const script = `import { stat } from 'node:fs/promises';\n` +
    `import { captureWorkingFile } from ${JSON.stringify(resolve("dist/src/observation/source.js"))};\n` +
    `const device = await stat(process.argv[2]);\n` +
    `try { const result = await captureWorkingFile({root:process.argv[1],workspace_id:'fixture',` +
    `workspace_generation:1,capture_sequence:1,input_commit_oid:process.argv[3]},` +
    `'device.ts',{max_bytes:1024}); console.log(JSON.stringify({character:device.isCharacterDevice(),result})); }` +
    `catch (error) { console.log(JSON.stringify({character:device.isCharacterDevice(),code:error.code,message:error.message})); }`;
  const observed = await execute("bwrap", ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev",
    "--dev-bind", "/dev/null", placeholder,
    "--proc", "/proc", "--", process.execPath, "--input-type=module", "-e", script, f.root, placeholder, f.base],
  { timeout: 30000, maxBuffer: 16384 });
  const result = JSON.parse(observed.stdout) as { character: boolean; code?: string; message?: string; result?: unknown };
  assert.equal(result.character, true, "the child must see a real character device, not the host placeholder");
  assert.equal(result.code, "SOURCE_MOUNT_BOUNDARY", JSON.stringify(result));
  assert.equal(result.result, undefined);
  assert.ok(!JSON.stringify(result).includes("placeholder must remain unread"));
  assert.equal(await readFile(placeholder, "utf8"), sentinel);
}, 60000);
