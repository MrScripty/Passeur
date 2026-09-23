import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
type Row = Readonly<{ id: string; stem: string; file: string; suffix: string; dialect: string;
  override?: "jsx" | "c" | "cpp"; append: string; name: string }>;
// These additions are independently written syntax probes. The complete language
// oracles live with the R2 fixture population; this checks their installed route.
const variants: readonly Readonly<{ id: string; stem: string; file: string; suffixes: readonly string[];
  dialect: string; override?: "jsx" | "c" | "cpp"; append: string; name: string }>[] = [
  { id: "L01", stem: "rust", file: "input.rs", suffixes: [".rs"], dialect: "rust", append: "\npub fn installed_probe(value: i32) -> i32 { value }\n", name: "installed_probe" },
  { id: "L02", stem: "typescript", file: "input.ts", suffixes: [".ts", ".mts", ".cts"], dialect: "typescript", append: "\nexport function installed_probe(value: number): number { return value; }\n", name: "installed_probe" },
  { id: "L03", stem: "javascript", file: "input.mjs", suffixes: [".js", ".mjs"], dialect: "javascript", append: "\nexport function installed_probe(value) { return value; }\n", name: "installed_probe" },
  { id: "L03", stem: "../compatibility", file: "commonjs.cjs", suffixes: [".cjs"], dialect: "javascript", append: "\nfunction installed_probe(value) { return value; }\nmodule.exports.installed_probe = installed_probe;\n", name: "installed_probe" },
  { id: "L04", stem: "python", file: "input.py", suffixes: [".py", ".pyi"], dialect: "python", append: "\ndef installed_probe(value: int) -> int:\n    return value\n", name: "installed_probe" },
  { id: "L05", stem: "lua", file: "input.lua", suffixes: [".lua"], dialect: "lua", append: "\nfunction installed_probe(value)\n    return value\nend\n", name: "installed_probe" },
  { id: "L06", stem: "kotlin", file: "declarations.kt", suffixes: [".kt", ".kts"], dialect: "kotlin", append: "\nfun installed_probe(value: Int): Int = value\n", name: "installed_probe" },
  { id: "L07", stem: "zig", file: "declarations.zig", suffixes: [".zig"], dialect: "zig", append: "\npub fn installed_probe(value: i32) i32 { return value; }\n", name: "installed_probe" },
  { id: "L08", stem: "csharp", file: "input.cs", suffixes: [".cs"], dialect: "csharp", append: "\npublic class InstalledProbe { public int Run(int value) { return value; } }\n", name: "InstalledProbe" },
  { id: "L09", stem: "c", file: "input.c", suffixes: [".c"], dialect: "c", append: "\nint installed_probe(int value) { return value; }\n", name: "installed_probe" },
  { id: "L09", stem: "c", file: "input.c", suffixes: [".h"], dialect: "c", override: "c", append: "\nint installed_probe(int value) { return value; }\n", name: "installed_probe" },
  { id: "L10", stem: "cpp", file: "input.cpp", suffixes: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], dialect: "cpp", append: "\nint installed_probe(int value) { return value; }\n", name: "installed_probe" },
  { id: "L10", stem: "cpp", file: "input.cpp", suffixes: [".h"], dialect: "cpp", override: "cpp", append: "\nint installed_probe(int value) { return value; }\n", name: "installed_probe" },
  { id: "L11", stem: "odin", file: "declarations.odin", suffixes: [".odin"], dialect: "odin", append: "\ninstalled_probe :: proc(value: int) -> int { return value }\n", name: "installed_probe" },
  { id: "L12", stem: "svelte5", file: "input.svelte", suffixes: [".svelte"], dialect: "svelte5", append: "\n{#snippet installed_probe(value)}<span>{value}</span>{/snippet}\n", name: "installed_probe" },
  { id: "L12", stem: "javascript", file: "input.mjs", suffixes: [".svelte.js"], dialect: "javascript", append: "\nexport function installed_probe(value) { return value; }\n", name: "installed_probe" },
  { id: "L12", stem: "typescript", file: "input.ts", suffixes: [".svelte.ts"], dialect: "typescript", append: "\nexport function installed_probe(value: number): number { return value; }\n", name: "installed_probe" },
  { id: "L13", stem: "react", file: "input.jsx", suffixes: [".jsx"], dialect: "jsx", append: "\nexport function InstalledProbe({ value }) { return <span>{value}</span>; }\n", name: "InstalledProbe" },
  { id: "L13", stem: "react", file: "input.jsx", suffixes: [".js"], dialect: "jsx", override: "jsx", append: "\nexport function InstalledProbe({ value }) { return <span>{value}</span>; }\n", name: "InstalledProbe" },
  { id: "L13", stem: "react", file: "input.tsx", suffixes: [".tsx"], dialect: "tsx", append: "\nexport function InstalledProbe({ value }: { value: number }) { return <span>{value}</span>; }\n", name: "InstalledProbe" },
];
const rows: readonly Row[] = variants.flatMap(variant => variant.suffixes.map(suffix => ({ ...variant, suffix })));
const pathFor = (row: Row): string => `${row.id}-installed${row.suffix}`;

type ProbeOptions = Readonly<{ installed: string; fixtures: string; keep?: boolean;
  hostNetns?: string; sourceSnapshotMarker?: string; sourceCheckout?: string }>;
export async function probeStructuralInstallation(options: ProbeOptions): Promise<Record<string, unknown>> {
  const installed = resolve(options.installed), fixtures = resolve(options.fixtures);
  const manifest = JSON.parse(await readFile(join(installed, "runtime-manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.state, "installed");
  assert.equal(manifest.source_dirty, false);
  const temp = await mkdtemp(join(tmpdir(), "passeur-structural-installed-"));
  const project = join(temp, "source project ü spaces"), state = join(temp, "state"), guards = join(temp, "no-build-tools"),
    sockets = join(temp, "service-sockets");
  const cli = join(installed, "dist/src/cli.js"), profile = join(temp, "missing-profile.json");
  const attempted = join(temp, "forbidden-tool-attempt.txt");
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", HOME: temp,
    XDG_CONFIG_HOME: join(temp, "config"), XDG_STATE_HOME: join(temp, "user-state"), npm_config_offline: "true",
    PATH: `${guards}:/usr/bin:/bin` };
  delete environment.PASSEUR_NATIVE_CANDIDATE;
  const sourceCheckout = resolve(options.sourceCheckout ?? process.cwd());
  // The installed executable, Git fixture and state are the only mutable/data
  // mounts. The development checkout and its node_modules do not exist here.
  const isolated = ["--unshare-net", "--die-with-parent", "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin", "--ro-bind", process.execPath, "/node",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--ro-bind", installed, installed, "--bind", temp, temp,
    "--bind", sockets, `/tmp/passeur-${process.getuid?.() ?? "unsupported"}`];
  const call = async (command: string, args: string[], cwd = project): Promise<string> =>
    (await execute(command, args, { cwd, env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const git = (...args: string[]) => call("git", args);
  const installedCall = async (args: string[]): Promise<string> => call("bwrap", [...isolated, "--chdir", project, "--", "/node", ...args]);
  const run = async (action: string, args: string[] = []): Promise<unknown> => JSON.parse(await installedCall(
    [cli, action, "--project", project, "--state-root", state, "--profile", profile, ...args]));
  const request = join(temp, "request.json");
  const coordinate = async (value: unknown): Promise<unknown> => {
    await writeFile(request, JSON.stringify(value));
    return run("coordinate", ["--request", request, "--yes"]);
  };
  const observations: Record<string, unknown>[] = [];
  let started = false;
  let service: ChildProcess | undefined;
  try {
    await mkdir(project); await mkdir(state, { mode: 0o700 }); await mkdir(guards); await mkdir(sockets, { mode: 0o700 });
    await writeFile(join(state, "service-election.lock"), "", { flag: "wx", mode: 0o600 });
    for (const command of ["npm", "npx", "node-gyp", "tsc", "cc", "gcc", "g++", "make", "cmake", "curl", "wget"]) {
      const path = join(guards, command);
      await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${attempted}'\nexit 77\n`, { mode: 0o700 });
      await chmod(path, 0o700);
    }
    await git("init", "-q", "-b", "main");
    await git("config", "--local", "user.name", "Passeur installed structural probe");
    await git("config", "--local", "user.email", "probe@example.invalid");
    await git("config", "--local", "commit.gpgsign", "false");
    await git("config", "--local", "core.hooksPath", join(project, ".git", "hooks"));
    const contents = new Map<string, string>();
    for (const row of rows) {
      const original = await readFile(join(fixtures, row.stem, row.file), "utf8");
      contents.set(pathFor(row), original);
      await writeFile(join(project, pathFor(row)), original);
    }
    await git("add", "--", "."); await git("commit", "-qm", "fixture: installed language baseline");
    const base = await git("rev-parse", "HEAD");
    for (const row of rows) await writeFile(join(project, pathFor(row)), contents.get(pathFor(row))! + row.append);
    const isolation = JSON.parse(await installedCall(["-e", `const fs=require('node:fs'); console.log(JSON.stringify({netns:fs.readlinkSync('/proc/self/ns/net'), interfaces:fs.readFileSync('/proc/net/dev','utf8').split('\\n').slice(2).map(line=>line.split(':')[0]?.trim()).filter(Boolean), routes:fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length-1, checkout_visible:fs.existsSync(${JSON.stringify(sourceCheckout)}), marker_visible:fs.existsSync(${JSON.stringify(options.sourceSnapshotMarker ?? sourceCheckout)}), installed_visible:fs.existsSync(${JSON.stringify(cli)})}))`])) as {
      netns: string; interfaces: string[]; routes: number; checkout_visible: boolean; marker_visible: boolean; installed_visible: boolean };
    const networkIsolated = Boolean(options.hostNetns && isolation.netns !== options.hostNetns &&
      isolation.interfaces.length === 1 && isolation.interfaces[0] === "lo" && isolation.routes === 0);
    const sourceHidden = !isolation.checkout_visible && !isolation.marker_visible;
    assert.equal(isolation.installed_visible, true, "Installed CLI must be mounted in the isolated child");
    assert.equal(networkIsolated, true, "Installed process needs an isolated loopback-only network namespace");
    assert.equal(sourceHidden, true, "Installed process can still see the development checkout or build-source marker");
    service = spawn("bwrap", [...isolated, "--chdir", project, "--", "/usr/bin/flock", "--nonblock", "--no-fork",
      join(state, "service-election.lock"), "/node", cli, "service-run",
      "--project", project, "--state-root", state, "--profile", profile],
    { cwd: project, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let serviceError = "";
    service.stderr?.on("data", chunk => { serviceError = (serviceError + String(chunk)).slice(-8192); });
    const readyBy = Date.now() + 20_000;
    while (Date.now() < readyBy) {
      if (service.exitCode !== null || service.signalCode !== null) throw new Error(`Installed service exited before readiness: ${service.exitCode ?? service.signalCode} ${serviceError}`);
      const status = await run("service-status") as { state: string };
      if (status.state === "observed_live") break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert.equal((await run("service-status") as { state: string }).state, "observed_live", "Installed service did not become ready");
    await coordinate({ schema_version: 1, kind: "initialize", limits: { works: 32, cases: 16, notes: 32,
      receipts: 256, note_bytes: 16384 } });
    started = true;
    const parent = (await coordinate({ schema_version: 1, kind: "identity" }) as { parent_id: string }).parent_id;
    for (const row of rows) {
      const path = pathFor(row);
      const response = await coordinate({ schema_version: 1, kind: "command", command: {
        kind: "register_external_work", operation_key: randomUUID(), input_oid: base,
        intent: `Installed ${row.id} structural route`, areas: [{ kind: "file", path }], readers: [],
      } }) as { receipt: { item_id: string } };
      const work = response.receipt.item_id;
      assert.match(work, /^[a-f0-9-]{36}$/);
      if (row.override) await coordinate({ schema_version: 1, kind: "command", command: {
        kind: "watch_source", operation_key: randomUUID(), work_id: work, expected_revision: 1,
        watchers: [{ recipient: parent, regions: [{ kind: "file", path }],
          dialect_overrides: [{ path, dialect: row.override }] }],
      } });
      const report = await run("structural-report", ["--work", work]) as { reports: { report_id: string; path: string; dialect: string; text: string }[] };
      assert.equal(report.reports.length, 1, `${row.id} must produce exactly one public report`);
      const entry = report.reports[0]!;
      assert.equal(entry.path, path);
      assert.equal(entry.dialect, row.dialect);
      assert.match(entry.text, /Coverage: complete/, `${row.id} installed parser coverage`);
      assert.ok(entry.text.includes(row.name), `${row.id} missing authored declaration ${row.name}`);
      const expected = contents.get(path)! + row.append;
      const detail = await run("structural-detail", ["--work", work, "--report", entry.report_id,
        "--side", "observed", "--start-byte", "0", "--end-byte", String(Buffer.byteLength(expected))]) as { text: string };
      assert.equal(detail.text, expected, `${row.id} exact installed source detail`);
      observations.push({ row: row.id, suffix: row.suffix, dialect: entry.dialect,
        ...(row.override ? { configured_dialect: row.override } : {}), work_id: work, report_id: entry.report_id,
        declaration: row.name, coverage: "complete", exact_detail_bytes: Buffer.byteLength(expected) });
    }
    const mcp = new Client({ name: "installed-structural-probe", version: "1" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: "bwrap",
      args: [...isolated, "--chdir", project, "--", "/node", cli, "serve", "--project", project, "--state-root", state, "--profile", profile],
      cwd: project, env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] =>
        entry[1] !== undefined)), stderr: "pipe" });
    try {
      await mcp.connect(transport, { timeout: 10_000 });
      const first = observations[0]!;
      const result = await mcp.callTool({ name: "passeur_structural_report", arguments: { work_id: first.work_id } }, undefined, { timeout: 60_000 });
      assert.notEqual(result.isError, true, "Installed stdio MCP report failed");
      const content = result.content as { text?: string }[];
      const body = result.structuredContent ?? JSON.parse(content[0]?.text ?? "null");
      assert.equal((body as { work_id: string }).work_id, first.work_id);
      assert.equal((body as { reports: unknown[] }).reports.length, 1);
      const mcpDetail = await mcp.callTool({ name: "passeur_structural_detail", arguments: {
        work_id: first.work_id, report_id: first.report_id, side: "observed", start_byte: 0,
        end_byte: Buffer.byteLength(contents.get(pathFor(rows[0]!))! + rows[0]!.append),
      } }, undefined, { timeout: 60_000 });
      assert.notEqual(mcpDetail.isError, true, "Installed stdio MCP detail failed");
      const detailContent = mcpDetail.content as { text?: string }[];
      const detailBody = mcpDetail.structuredContent ?? JSON.parse(detailContent[0]?.text ?? "null");
      assert.equal((detailBody as { text: string }).text, contents.get(pathFor(rows[0]!))! + rows[0]!.append);
    } finally { await mcp.close(); }
    try { await readFile(attempted); throw new Error("Installed path invoked a forbidden build/network tool"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { schema_version: 1, candidate_build_id: manifest.build_id, installed_root: installed,
      relocated_path: project, rows: observations, stdio_mcp_report: "observed", stdio_mcp_detail: "observed",
      guarded_build_tool_attempts: 0,
      selected_net_namespace: isolation.netns, interfaces: isolation.interfaces, network_namespace_enforced: networkIsolated,
      source_snapshot_hidden: sourceHidden,
      explicitly_configured_routes: ["L09 .h→c", "L10 .h→cpp", "L13 .js→jsx"],
      limitations: ["PATH guards record selected build-tool attempts; inspect final process/syscall trace for absolute executable paths and other build actions."] };
  } finally {
    if (started) await run("service-stop", ["--operation-key", randomUUID(), "--yes"]).catch(() => undefined);
    if (service) {
      const child = service;
      child.stdin?.end();
      const running = () => child.exitCode === null && child.signalCode === null;
      if (running()) {
        const stopped = new Promise<void>(resolveStopped => child.once("exit", () => resolveStopped()));
        await Promise.race([stopped, new Promise<void>(resolveDelay => setTimeout(resolveDelay, 5000))]);
        if (running()) {
          child.kill("SIGTERM");
          await Promise.race([stopped, new Promise<void>(resolveDelay => setTimeout(resolveDelay, 5000))]);
        }
        if (running()) { child.kill("SIGKILL"); await stopped; }
      }
    }
    if (!options.keep) await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { installed: { type: "string" }, fixtures: { type: "string" }, keep: { type: "boolean" },
    "host-netns": { type: "string" }, "source-snapshot-marker": { type: "string" } }, strict: true });
  if (!values.installed || !values.fixtures) throw new Error("Use --installed DIR --fixtures DIR");
  probeStructuralInstallation({ installed: values.installed, fixtures: values.fixtures,
    ...(values.keep === undefined ? {} : { keep: values.keep }),
    ...(values["host-netns"] === undefined ? {} : { hostNetns: values["host-netns"] }),
    ...(values["source-snapshot-marker"] === undefined ? {} : { sourceSnapshotMarker: values["source-snapshot-marker"] }) })
    .then(value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
