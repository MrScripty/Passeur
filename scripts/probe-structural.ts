import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveRepositoryBinding } from "../src/core/repository-runtime.js";
import { servicePaths } from "../src/service/bootstrap.js";
import { probeStructuralOracles, publicOracleCases, publicOracleVariantCases,
  type PublicOracleCase, type PublicOracleVariantCase } from "./probe-structural-oracles.js";
import { startStructuralRunner, type StructuralRunner } from "./probe-structural-runner.js";

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
type PublicCase = PublicOracleCase | PublicOracleVariantCase;
function publicSections(text: string): { name: string; start: number; kind: string }[] {
  return [...text.matchAll(/^(modified|added|removed|ambiguous|unobserved): ("[^"\n]*") \("[^"\n]+"\)/gm)]
    .map(match => ({ name: (JSON.parse(match[2]!) as string).split(" :: ").at(-1)!,
      start: match.index!, kind: match[1]! }));
}

function assertCanonicalInputReport(row: PublicCase, text: string): string {
  assert.ok(text.includes(`Dialect: ${JSON.stringify(row.dialect)}`), `${row.id} input public dialect`);
  const coverage = /\nCoverage: (complete|incomplete)\n/.exec(text)?.[1];
  assert.ok(coverage, `${row.id} input public coverage missing`);
  assert.equal(coverage, row.expected.public_input_coverage,
    `${row.id} input public coverage differs from authored comparison expectation`);
  const sections = publicSections(text);
  const expectedKind = row.expected.input_coverage === "complete" ? "removed" : "unobserved";
  assert.ok(sections.every(section => section.kind === expectedKind),
    `${row.id} input public population has an unexpected change kind: ${JSON.stringify(sections)}`);
  assert.deepEqual(sections.map(section => section.name).sort(), [...row.expected.input_names].sort(),
    `${row.id} input public declaration population`);
  for (const signature of row.expected.input_signatures) assert.ok(text.includes(`  INPUT: ${JSON.stringify(signature)}`),
    `${row.id} input public written signature ${signature}`);
  for (const literal of row.expected.redacted_literals) assert.ok(!text.includes(literal),
    `${row.id} input public report exposed a masked literal`);
  return coverage;
}

function assertCanonicalReport(row: PublicCase, stage: "changed" | "incomplete", text: string):
  { coverage: string; limitations: string[]; changed_names: string[] } {
  assert.ok(text.includes(`Dialect: ${JSON.stringify(row.dialect)}`), `${row.id} ${stage} public dialect`);
  const coverage = /\nCoverage: (complete|incomplete)\n/.exec(text)?.[1];
  assert.ok(coverage, `${row.id} ${stage} public coverage missing`);
  const limitations = [...text.matchAll(/^Limitation: "([^"]+)"$/gm)].map(match => match[1]!);
  const sections = publicSections(text);
  const changedNames = sections.map(section => section.name);
  for (const literal of row.expected.redacted_literals) assert.ok(!text.includes(literal),
    `${row.id} ${stage} public report exposed a masked literal`);
  if (stage === "incomplete") {
    assert.equal(coverage, "incomplete", `${row.id} malformed public coverage`);
    assert.ok(limitations.length > 0, `${row.id} malformed public limitations missing`);
    for (const limitation of row.expected.incomplete_limitations ?? []) assert.ok(limitations.includes(limitation),
      `${row.id} malformed public report lacks ${limitation}`);
  } else {
    assert.deepEqual(sections.map(section => ({ name: section.name, kind: section.kind }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    row.expected.changed_sections.map(section => ({ name: section.name, kind: section.kind }))
      .sort((a, b) => a.name.localeCompare(b.name)), `${row.id} changed public declaration set and classification`);
    assert.equal(coverage, row.expected.public_changed_coverage,
      `${row.id} changed public coverage differs from authored comparison expectation`);
    if (row.expected.changed_limitations !== null) assert.deepEqual([...limitations].sort(),
      [...row.expected.changed_limitations].sort(), `${row.id} changed public limitations`);
    const actualBlocks = sections.map(section => {
      const next = sections.find(item => item.start > section.start)?.start ?? text.length;
      const block = text.slice(section.start, next);
      return { ...section, block, body_changed: block.includes("  body_changed (body omitted)"),
        default_changed: block.includes("  concealed_header_changed"),
        declaration_changed: !block.includes("  declaration_unchanged") };
    });
    const unmatched = new Set(actualBlocks.map((_block, index) => index));
    for (const expected of row.expected.changed_sections) {
      const match = [...unmatched].find(index => {
        const actual = actualBlocks[index]!;
        return actual.name === expected.name && actual.kind === expected.kind &&
          (expected.body_changed === undefined || actual.body_changed === expected.body_changed) &&
          (expected.default_changed === undefined || actual.default_changed === expected.default_changed) &&
          (expected.declaration_changed === undefined || actual.declaration_changed === expected.declaration_changed);
      });
      assert.ok(match !== undefined, `${row.id} ${expected.name} public change flags or multiplicity differ`);
      unmatched.delete(match);
      if (row.expected.changed_sections.filter(section => section.name === expected.name).length === 1) {
        const signature = row.expected.unchanged_signatures_for_changed_names[expected.name];
        if (signature) assert.ok(actualBlocks[match]!.block.includes(`  INPUT: ${JSON.stringify(signature)}`),
          `${row.id} ${expected.name} public written input signature`);
      }
    }
    assert.equal(unmatched.size, 0, `${row.id} has unreviewed public change sections`);
  }
  return { coverage, limitations, changed_names: changedNames };
}

async function installedNativeBindings(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && item.name.endsWith(".node") &&
        (!path.includes("/prebuilds/") || path.includes(`/prebuilds/linux-${process.arch}/`))) {
        const handle = await open(path, "r");
        try {
          const magic = Buffer.alloc(4);
          const { bytesRead } = await handle.read(magic, 0, 4, 0);
          if (bytesRead === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) found.push(path);
        } finally { await handle.close(); }
      }
    }
  };
  await walk(join(root, "node_modules"));
  assert.ok(found.length > 0, "Installed candidate has no native binding to qualify");
  return found;
}

/** Mount only the executable closure needed by the installed runtime and Git. */
async function isolatedExecutables(root: string): Promise<string[]> {
  const executables = [process.execPath, "/usr/bin/git", "/usr/bin/flock", ...await installedNativeBindings(root)];
  const libraries = new Map<string, string>();
  for (const binary of executables) {
    const output = (await execute("ldd", [binary], { timeout: 10_000, maxBuffer: 256 * 1024 })).stdout;
    assert.ok(!output.includes("not found"), `A native dependency is unavailable for ${binary}`);
    for (const line of output.split("\n")) {
      const match = /(?:=>\s*)?(\/[\w.+/\-]+)/.exec(line);
      if (match) {
        const reported = match[1]!;
        const target = reported.startsWith("/lib64/") ? reported.replace("/lib64/", "/usr/lib/x86_64-linux-gnu/") :
          reported.startsWith("/lib/") ? reported.replace("/lib/", "/usr/lib/") : reported;
        libraries.set(target, await realpath(reported));
      }
    }
  }
  const dirs = new Set(["/usr", "/usr/bin", "/usr/lib"]);
  for (const file of libraries.keys()) {
    for (let dir = dirname(file); dir !== "/"; dir = dirname(dir)) dirs.add(dir);
  }
  const argumentsList = [...[...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .flatMap(dir => ["--dir", dir]), "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib/x86_64-linux-gnu", "/lib64",
    ...[...libraries].sort(([a], [b]) => a.localeCompare(b)).flatMap(([target, source]) => ["--ro-bind", source, target]),
    "--ro-bind", "/usr/bin/git", "/usr/bin/git", "--ro-bind", "/usr/bin/flock", "/usr/bin/flock",
    "--ro-bind", process.execPath, "/node"];
  return argumentsList;
}

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
  const isolated = ["--unshare-net", "--new-session", "--die-with-parent",
    ...await isolatedExecutables(installed), "--ro-bind", "/etc", "/etc",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--ro-bind", installed, installed, "--bind", temp, temp,
    "--bind", sockets, `/tmp/passeur-${process.getuid?.() ?? "unsupported"}`];
  const call = async (command: string, args: string[], cwd = project): Promise<string> =>
    (await execute(command, args, { cwd, env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const git = (...args: string[]) => call("git", args);
  let runner: StructuralRunner | undefined;
  const installedCall = async (args: string[]): Promise<string> => {
    assert.ok(runner, "Installed namespace has not started");
    return runner.execNode(args);
  };
  const run = async (action: string, args: string[] = []): Promise<unknown> => JSON.parse(await installedCall(
    [cli, action, "--project", project, "--state-root", state, "--profile", profile, ...args]));
  const request = join(temp, "request.json");
  const coordinate = async (value: unknown): Promise<unknown> => {
    await writeFile(request, JSON.stringify(value));
    return run("coordinate", ["--request", request, "--yes"]);
  };
  const observations: Record<string, unknown>[] = [];
  const canonicalPublic: Record<string, unknown>[] = [];
  let started = false;
  try {
    await mkdir(project); await mkdir(state, { mode: 0o700 }); await mkdir(guards); await mkdir(sockets, { mode: 0o700 });
    for (const command of ["npm", "npx", "node-gyp", "tsc", "cc", "gcc", "g++", "make", "cmake", "curl", "wget"]) {
      const path = join(guards, command);
      await writeFile(path, `#!/node\nrequire('node:fs').appendFileSync(${JSON.stringify(attempted)}, ${JSON.stringify(`${command}\n`)}); process.exit(77);\n`, { mode: 0o700 });
      await chmod(path, 0o700);
    }
    await git("init", "-q", "-b", "main");
    await git("config", "--local", "user.name", "Passeur installed structural probe");
    await git("config", "--local", "user.email", "probe@example.invalid");
    await git("config", "--local", "commit.gpgsign", "false");
    await git("config", "--local", "core.hooksPath", join(project, ".git", "hooks"));
    const binding = await resolveRepositoryBinding({ project, stateRoot: state, profilePath: profile },
      environment, AbortSignal.timeout(90_000));
    const electionGuard = servicePaths(binding).guard;
    await mkdir(binding.storeRoot, { recursive: true, mode: 0o700 });
    await writeFile(electionGuard, "", { flag: "wx", mode: 0o600 });
    const contents = new Map<string, string>();
    for (const row of rows) {
      const original = await readFile(join(fixtures, row.stem, row.file), "utf8");
      contents.set(pathFor(row), original);
      await writeFile(join(project, pathFor(row)), original);
    }
    const canonicalCases: readonly PublicCase[] = [...await publicOracleCases(fixtures),
      ...await publicOracleVariantCases(fixtures)];
    for (const row of canonicalCases) await writeFile(join(project, row.path), row.input);
    await git("add", "--", "."); await git("commit", "-qm", "fixture: installed language baseline");
    const base = await git("rev-parse", "HEAD");
    for (const row of rows) await writeFile(join(project, pathFor(row)), contents.get(pathFor(row))! + row.append);
    runner = await startStructuralRunner({ isolatedArgs: isolated, project, environment,
      runnerFile: join(temp, "isolated-runner.mjs") });
    const processIsolation = await runner.selfCheck(process.pid);
    assert.equal(processIsolation.hostPidVisible, false, "Installed namespace can see the host probe process");
    assert.equal(processIsolation.hostPidRootVisible, false, "Installed namespace can traverse the host probe root");
    assert.deepEqual(processIsolation.forbiddenVisible, [], "Installed namespace exposes a build or shell executable");
    assert.ok(processIsolation.absoluteAttempts.every(attempt => attempt.error === "ENOENT"),
      "An absolute build or shell executable ran inside the installed namespace");
    const isolation = JSON.parse(await installedCall(["-e", `const fs=require('node:fs'); console.log(JSON.stringify({netns:fs.readlinkSync('/proc/self/ns/net'), interfaces:fs.readFileSync('/proc/net/dev','utf8').split('\\n').slice(2).map(line=>line.split(':')[0]?.trim()).filter(Boolean), routes:fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length-1, checkout_visible:fs.existsSync(${JSON.stringify(sourceCheckout)}), marker_visible:fs.existsSync(${JSON.stringify(options.sourceSnapshotMarker ?? sourceCheckout)}), installed_visible:fs.existsSync(${JSON.stringify(cli)})}))`])) as {
      netns: string; interfaces: string[]; routes: number; checkout_visible: boolean; marker_visible: boolean; installed_visible: boolean };
    const networkIsolated = Boolean(options.hostNetns && isolation.netns !== options.hostNetns &&
      isolation.interfaces.length === 1 && isolation.interfaces[0] === "lo" && isolation.routes === 0);
    const sourceHidden = !isolation.checkout_visible && !isolation.marker_visible;
    assert.equal(isolation.installed_visible, true, "Installed CLI must be mounted in the isolated child");
    assert.equal(networkIsolated, true, "Installed process needs an isolated loopback-only network namespace");
    assert.equal(sourceHidden, true, "Installed process can still see the development checkout or build-source marker");
    await runner.startService({ guard: electionGuard, cli, project, state, profile });
    const readyBy = Date.now() + 20_000;
    while (Date.now() < readyBy) {
      const serviceState = await runner.serviceState();
      if (serviceState.exited) throw new Error(`Installed service exited before readiness: ${serviceState.error}`);
      const status = await run("service-status") as { state: string };
      if (status.state === "observed_live") break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert.equal((await run("service-status") as { state: string }).state, "observed_live",
      `Installed service did not become ready: ${(await runner.serviceState()).error}`);
    await coordinate({ schema_version: 1, kind: "initialize", limits: { works: 128, cases: 16, notes: 32,
      receipts: 512, note_bytes: 16384 } });
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
      const coverage = /\nCoverage: (complete|incomplete)\n/.exec(entry.text)?.[1];
      assert.ok(coverage, `${row.id} ${row.suffix} installed report has no explicit coverage state`);
      const limitations = [...entry.text.matchAll(/^Limitation: "([^"]+)"$/gm)].map(match => match[1]!);
      if (coverage === "incomplete") assert.ok(limitations.length > 0,
        `${row.id} ${row.suffix} reported incomplete coverage without a named limitation`);
      assert.ok(entry.text.includes(row.name), `${row.id} missing authored declaration ${row.name}`);
      const expected = contents.get(path)! + row.append;
      const detail = await run("structural-detail", ["--work", work, "--report", entry.report_id,
        "--side", "observed", "--start-byte", "0", "--end-byte", String(Buffer.byteLength(expected))]) as { text: string };
      assert.equal(detail.text, expected, `${row.id} exact installed source detail`);
      observations.push({ row: row.id, suffix: row.suffix, dialect: entry.dialect,
        ...(row.override ? { configured_dialect: row.override } : {}), work_id: work, report_id: entry.report_id,
        declaration: row.name, coverage, limitations, exact_detail_bytes: Buffer.byteLength(expected) });
      if (observations.length === 1) {
        await coordinate({ schema_version: 1, kind: "command", command: {
          kind: "close_work", operation_key: randomUUID(), work_id: work, expected_revision: 1,
        } });
        try {
          await runner.mcpConnect({ cli, project, state, profile });
          const registration: Awaited<ReturnType<StructuralRunner["mcpCallTool"]>> = await runner.mcpCallTool("passeur_work", {
            request: { schema_version: 1, kind: "command", command: {
              kind: "register_external_work", operation_key: randomUUID(), input_oid: base,
              intent: "Installed stdio MCP structural route", areas: [{ kind: "file", path }], readers: [],
            } },
          });
          assert.notEqual(registration.isError, true, `Installed stdio MCP work registration failed: ${JSON.stringify(registration.content)}`);
          const registrationContent = registration.content as { text?: string }[];
          const registrationBody: unknown = registration.structuredContent ?? JSON.parse(registrationContent[0]?.text ?? "null");
          const mcpWork: string = (registrationBody as { receipt: { item_id: string } }).receipt.item_id;
          assert.match(mcpWork, /^[a-f0-9-]{36}$/);
          const result: Awaited<ReturnType<StructuralRunner["mcpCallTool"]>> = await runner.mcpCallTool("passeur_structural_report", { work_id: mcpWork });
          assert.notEqual(result.isError, true, `Installed stdio MCP report failed: ${JSON.stringify(result.content)}`);
          const content = result.content as { text?: string }[];
          const body: unknown = result.structuredContent ?? JSON.parse(content[0]?.text ?? "null");
          assert.equal((body as { work_id: string }).work_id, mcpWork);
          assert.equal((body as { reports: unknown[] }).reports.length, 1);
          const mcpReport = (body as { reports: { report_id: string }[] }).reports[0]!;
          const mcpDetail: Awaited<ReturnType<StructuralRunner["mcpCallTool"]>> = await runner.mcpCallTool("passeur_structural_detail", {
            work_id: mcpWork, report_id: mcpReport.report_id, side: "observed", start_byte: 0,
            end_byte: Buffer.byteLength(expected),
          });
          assert.notEqual(mcpDetail.isError, true, `Installed stdio MCP detail failed: ${JSON.stringify(mcpDetail.content)}`);
          const detailContent = mcpDetail.content as { text?: string }[];
          const detailBody: unknown = mcpDetail.structuredContent ?? JSON.parse(detailContent[0]?.text ?? "null");
          assert.equal((detailBody as { text: string }).text, expected);
          const closure = await runner.mcpCallTool("passeur_work", {
            request: { schema_version: 1, kind: "command", command: {
              kind: "close_work", operation_key: randomUUID(), work_id: mcpWork, expected_revision: 1,
            } },
          });
          assert.notEqual(closure.isError, true, `Installed stdio MCP work close failed: ${JSON.stringify(closure.content)}`);
        } finally { await runner.mcpClose(); }
      } else await coordinate({ schema_version: 1, kind: "command", command: {
        kind: "close_work", operation_key: randomUUID(), work_id: work, expected_revision: row.override ? 2 : 1,
      } });
    }
    await runner.mcpConnect({ cli, project, state, profile });
    try {
      const mcpIdentity = await runner.mcpCallTool("passeur_coordination", {
        request: { schema_version: 1, kind: "identity" },
      });
      assert.notEqual(mcpIdentity.isError, true, `Installed MCP identity failed: ${JSON.stringify(mcpIdentity.content)}`);
      const identityContent = mcpIdentity.content as { text?: string }[];
      const identityBody: unknown = mcpIdentity.structuredContent ?? JSON.parse(identityContent[0]?.text ?? "null");
      const mcpParent = (identityBody as { parent_id: string }).parent_id;
      for (const row of canonicalCases) {
        const dialectOverride = "override" in row ? row.override : undefined;
        const cliRegistration = await coordinate({ schema_version: 1, kind: "command", command: {
          kind: "register_external_work", operation_key: randomUUID(), input_oid: base,
          intent: `Installed ${row.id} canonical source comparison`,
          areas: [{ kind: "file", path: row.path }], readers: [],
        } }) as { receipt: { item_id: string } };
        const cliWork = cliRegistration.receipt.item_id;
        if (dialectOverride) await coordinate({ schema_version: 1, kind: "command", command: {
          kind: "watch_source", operation_key: randomUUID(), work_id: cliWork, expected_revision: 1,
          watchers: [{ recipient: parent, regions: [{ kind: "file", path: row.path }],
            dialect_overrides: [{ path: row.path, dialect: dialectOverride }] }],
        } });
        await writeFile(join(project, row.path), "");
        const cliInput = await run("structural-report", ["--work", cliWork]) as {
          reports: { report_id: string; path: string; dialect: string; text: string }[] };
        assert.equal(cliInput.reports.length, 1, `${row.id} installed CLI input population report count`);
        assert.equal(cliInput.reports[0]!.path, row.path);
        canonicalPublic.push({ row: row.id, variant: row.variant, stage: "input_population", route: "cli",
          report_id: cliInput.reports[0]!.report_id,
          coverage: assertCanonicalInputReport(row, cliInput.reports[0]!.text),
          declarations: row.expected.input_names.length });
        for (const stage of row.incomplete === null ? ["changed"] as const : ["changed", "incomplete"] as const) {
          const bytes = row[stage];
          assert.ok(bytes !== null);
          await writeFile(join(project, row.path), bytes);
          const response = await run("structural-report", ["--work", cliWork]) as {
            reports: { report_id: string; path: string; dialect: string; text: string }[] };
          assert.equal(response.reports.length, 1, `${row.id} ${stage} installed CLI report count`);
          const entry = response.reports[0]!;
          assert.equal(entry.path, row.path);
          const checked = assertCanonicalReport(row, stage, entry.text);
          const detail = await run("structural-detail", ["--work", cliWork, "--report", entry.report_id,
            "--side", "observed", "--start-byte", "0", "--end-byte", String(Buffer.byteLength(bytes))]) as { text: string };
          assert.equal(detail.text, bytes, `${row.id} ${stage} installed CLI exact detail`);
          canonicalPublic.push({ row: row.id, variant: row.variant, stage, route: "cli", report_id: entry.report_id,
            coverage: checked.coverage, limitations: checked.limitations, changed_names: checked.changed_names,
            exact_detail_bytes: Buffer.byteLength(bytes) });
        }
        await coordinate({ schema_version: 1, kind: "command", command: {
          kind: "close_work", operation_key: randomUUID(), work_id: cliWork,
          expected_revision: dialectOverride ? 2 : 1,
        } });
        await writeFile(join(project, row.path), row.changed);
        const mcpRegistration = await runner.mcpCallTool("passeur_work", { request: {
          schema_version: 1, kind: "command", command: {
            kind: "register_external_work", operation_key: randomUUID(), input_oid: base,
            intent: `Installed MCP ${row.id} canonical source comparison`,
            areas: [{ kind: "file", path: row.path }], readers: [],
          },
        } });
        assert.notEqual(mcpRegistration.isError, true, `${row.id} installed MCP canonical work registration: ${JSON.stringify(mcpRegistration.content)}`);
        const registrationContent = mcpRegistration.content as { text?: string }[];
        const registrationBody: unknown = mcpRegistration.structuredContent ?? JSON.parse(registrationContent[0]?.text ?? "null");
        const mcpWork = (registrationBody as { receipt: { item_id: string } }).receipt.item_id;
        if (dialectOverride) {
          const watch = await runner.mcpCallTool("passeur_work", { request: {
            schema_version: 1, kind: "command", command: {
              kind: "watch_source", operation_key: randomUUID(), work_id: mcpWork, expected_revision: 1,
              watchers: [{ recipient: mcpParent, regions: [{ kind: "file", path: row.path }],
                dialect_overrides: [{ path: row.path, dialect: dialectOverride }] }],
            },
          } });
          assert.notEqual(watch.isError, true, `${row.id} ${row.variant} installed MCP watch: ${JSON.stringify(watch.content)}`);
        }
        await writeFile(join(project, row.path), "");
        const mcpInput = await runner.mcpCallTool("passeur_structural_report", { work_id: mcpWork });
        assert.notEqual(mcpInput.isError, true, `${row.id} installed MCP input population: ${JSON.stringify(mcpInput.content)}`);
        const inputContent = mcpInput.content as { text?: string }[];
        const inputBody: unknown = mcpInput.structuredContent ?? JSON.parse(inputContent[0]?.text ?? "null");
        const inputReports = (inputBody as { reports: { report_id: string; path: string; text: string }[] }).reports;
        assert.equal(inputReports.length, 1, `${row.id} installed MCP input population report count`);
        assert.equal(inputReports[0]!.path, row.path);
        canonicalPublic.push({ row: row.id, variant: row.variant, stage: "input_population", route: "mcp",
          report_id: inputReports[0]!.report_id,
          coverage: assertCanonicalInputReport(row, inputReports[0]!.text),
          declarations: row.expected.input_names.length });
        for (const stage of row.incomplete === null ? ["changed"] as const : ["changed", "incomplete"] as const) {
          const bytes = row[stage];
          assert.ok(bytes !== null);
          await writeFile(join(project, row.path), bytes);
          const result = await runner.mcpCallTool("passeur_structural_report", { work_id: mcpWork });
          assert.notEqual(result.isError, true, `${row.id} ${stage} installed MCP report: ${JSON.stringify(result.content)}`);
          const reportContent = result.content as { text?: string }[];
          const reportBody: unknown = result.structuredContent ?? JSON.parse(reportContent[0]?.text ?? "null");
          const reports = (reportBody as { reports: { report_id: string; path: string; dialect: string; text: string }[] }).reports;
          assert.equal(reports.length, 1, `${row.id} ${stage} installed MCP report count`);
          const entry = reports[0]!;
          assert.equal(entry.path, row.path);
          const checked = assertCanonicalReport(row, stage, entry.text);
          const detailResult = await runner.mcpCallTool("passeur_structural_detail", {
            work_id: mcpWork, report_id: entry.report_id, side: "observed", start_byte: 0,
            end_byte: Buffer.byteLength(bytes),
          });
          assert.notEqual(detailResult.isError, true, `${row.id} ${stage} installed MCP detail: ${JSON.stringify(detailResult.content)}`);
          const detailContent = detailResult.content as { text?: string }[];
          const detailBody: unknown = detailResult.structuredContent ?? JSON.parse(detailContent[0]?.text ?? "null");
          assert.equal((detailBody as { text: string }).text, bytes, `${row.id} ${stage} installed MCP exact detail`);
          canonicalPublic.push({ row: row.id, variant: row.variant, stage, route: "mcp", report_id: entry.report_id,
            coverage: checked.coverage, limitations: checked.limitations, changed_names: checked.changed_names,
            exact_detail_bytes: Buffer.byteLength(bytes) });
        }
        const mcpClosure = await runner.mcpCallTool("passeur_work", { request: {
          schema_version: 1, kind: "command", command: {
            kind: "close_work", operation_key: randomUUID(), work_id: mcpWork,
            expected_revision: dialectOverride ? 2 : 1,
          },
        } });
        assert.notEqual(mcpClosure.isError, true, `${row.id} installed MCP canonical work close: ${JSON.stringify(mcpClosure.content)}`);
      }
    } finally { await runner.mcpClose(); }
    const semanticOracles = await probeStructuralOracles({ installed, fixtures, stagingRoot: temp,
      project, runInstalledNode: installedCall });
    try { await readFile(attempted); throw new Error("Installed path invoked a forbidden build/network tool"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { schema_version: 1, candidate_build_id: manifest.build_id, installed_root: installed,
      relocated_path: project, rows: observations, canonical_public: canonicalPublic,
      semantic_oracles: semanticOracles,
      stdio_mcp_report: "observed", stdio_mcp_detail: "observed",
      guarded_build_tool_attempts: 0,
      selected_net_namespace: isolation.netns, interfaces: isolation.interfaces, network_namespace_enforced: networkIsolated,
      selected_pid_namespace: processIsolation.pidNamespace, host_pid_hidden: !processIsolation.hostPidVisible,
      host_pid_root_hidden: !processIsolation.hostPidRootVisible,
      forbidden_executables_hidden: processIsolation.forbiddenVisible.length === 0,
      absolute_executable_attempts: processIsolation.absoluteAttempts,
      allowed_executables: processIsolation.allowedExecutables,
      source_snapshot_hidden: sourceHidden,
      explicitly_configured_routes: ["L09 .h→c", "L10 .h→cpp", "L13 .js→jsx"],
      limitations: ["Executable allowlist limits installed child paths to Node, Git, flock, installed native bindings and their shared libraries; inspect final process/syscall trace for unexpected executable attempts."] };
  } finally {
    if (started && runner) await run("service-stop", ["--operation-key", randomUUID(), "--yes"]).catch(() => undefined);
    await runner?.close();
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
