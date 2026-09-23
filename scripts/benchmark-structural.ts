/** Component measurement using actual Git source capture and the native child parser. Compile tsconfig.native.json first. */
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeDialect } from "../src/observation/native-parser.js";

const run = promisify(execFile);
type Pair = Readonly<{ dialect: NativeDialect; input: string; observed: string; path: string; append_comment?: boolean }>;
if (process.argv[2] === "public") await publicBenchmark();
else if (process.argv.length > 2) throw new Error("Usage: npx tsx scripts/benchmark-structural.ts [public --runtime-root ABSOLUTE_PATH]");
else {
// The benchmark executes the generated native build. Resolve it at runtime so the
// ordinary TypeScript build also works before tsconfig.native.json is compiled.
const nativeBuildRoot = resolve(".passeur-native/src/observation");
const nativeModule = (name: string) => pathToFileURL(join(nativeBuildRoot, `${name}.js`)).href;
const { NativeAnalysisHelper } = await import(nativeModule("helper"));
const { compareCapturedWork } = await import(nativeModule("comparison"));
const { captureWorkingFile, readCommittedFile } = await import(nativeModule("source"));
type Sample = Readonly<{ wall_ms: number; parent_cpu_ms: number; sampled_child_cpu_ms: number;
  peak_parent_rss_bytes: number; peak_child_rss_bytes: number; parent_context_bytes: number; reports: number }>;
const workloadPath = resolve("tests/fixtures/structural/workload.json");
const workload = JSON.parse(await readFile(workloadPath, "utf8")) as { description: string; pairs: Pair[] };
if (!Array.isArray(workload.pairs) || !workload.pairs.length || process.platform !== "linux") {
  throw new Error("This workload needs a nonempty pair list on the documented Linux source-capture platform");
}
const clockTicks = Number((await run("getconf", ["CLK_TCK"])).stdout.trim());
if (!Number.isSafeInteger(clockTicks) || clockTicks <= 0) throw new Error("Linux clock tick rate unavailable");
const optionalLimit = async (path: string) => {
  try { return (await readFile(path, "utf8")).trim(); }
  catch { return "unavailable"; }
};
const root = await mkdtemp(join(tmpdir(), "passeur-structural-benchmark-"));
const git = async (...args: string[]) => (await run("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
const inputBytes = new Map<string, Buffer>();
try {
  await git("init", "-q");
  for (const pair of workload.pairs) {
    if (!/^[a-z0-9_-]+\/[a-z0-9_.-]+$/.test(pair.path) ||
        !(pair.input.startsWith("tests/fixtures/structural/languages/") || pair.input.startsWith("src/")) ||
        !(pair.observed.startsWith("tests/fixtures/structural/languages/") ||
          (pair.append_comment === true && pair.observed === pair.input && pair.observed.startsWith("src/")))) {
      throw new Error("Invalid benchmark source path");
    }
    const bytes = await readFile(resolve(pair.input));
    inputBytes.set(pair.path, bytes);
    await mkdir(dirname(join(root, pair.path)), { recursive: true });
    await writeFile(join(root, pair.path), bytes);
  }
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "input");
  const commit = await git("rev-parse", "HEAD");
  for (const pair of workload.pairs) await writeFile(join(root, pair.path), pair.append_comment
    ? Buffer.concat([inputBytes.get(pair.path)!, Buffer.from("\n// benchmark observed workspace edit\n")])
    : await readFile(resolve(pair.observed)));

  const measure = async (): Promise<Sample> => {
    const helper = new NativeAnalysisHelper();
    const children = new Map<number, number>();
    let peakParentRss = process.memoryUsage().rss;
    let peakChildRss = 0;
    let contextBytes = 0;
    const sample = async () => {
      peakParentRss = Math.max(peakParentRss, process.memoryUsage().rss);
      const pids = (await readFile(`/proc/self/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
      for (const rawPid of pids) {
        const pid = Number(rawPid);
        try {
          const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8")]);
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const ticks = Number(fields[11]) + Number(fields[12]);
          if (Number.isSafeInteger(ticks)) children.set(pid, Math.max(children.get(pid) ?? 0, ticks));
          const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
          if (rss) peakChildRss = Math.max(peakChildRss, Number(rss[1]) * 1024);
        } catch { /* A child may exit between the PID list and its status read. */ }
      }
    };
    const started = performance.now();
    const cpu = process.cpuUsage();
    const timer = setInterval(() => { void sample(); }, 25);
    try {
      await sample();
      for (let index = 0; index < workload.pairs.length; index++) {
        const pair = workload.pairs[index]!;
        const [input, observed] = await Promise.all([
          readCommittedFile(root, commit, pair.path, { max_bytes: 8 * 1024 * 1024 }),
          captureWorkingFile({ root, workspace_id: "benchmark", workspace_generation: 1,
            capture_sequence: index + 1, input_commit_oid: commit }, pair.path, { max_bytes: 8 * 1024 * 1024 })
        ]);
        let result;
        try {
          result = await compareCapturedWork({ work_id: `work-${index}`, parent_id: "benchmark-parent",
            dialect: pair.dialect, input, observed }, helper);
        } catch (cause) { throw new Error(`Native benchmark pair ${pair.path} failed`, { cause }); }
        contextBytes += Buffer.byteLength(result.text, "utf8");
      }
      await sample();
    } finally { clearInterval(timer); await helper.close(); }
    const elapsed = performance.now() - started;
    const parentCpu = process.cpuUsage(cpu);
    return { wall_ms: elapsed, parent_cpu_ms: (parentCpu.user + parentCpu.system) / 1000,
      sampled_child_cpu_ms: [...children.values()].reduce((sum, ticks) => sum + ticks, 0) * 1000 / clockTicks,
      peak_parent_rss_bytes: peakParentRss, peak_child_rss_bytes: peakChildRss,
      parent_context_bytes: contextBytes, reports: workload.pairs.length };
  };
  await measure(); // Warm parser modules and filesystem caches before recorded runs.
  const samples = [await measure(), await measure(), await measure()];
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), node: process.version, platform: process.platform,
    arch: process.arch, environment: { cpu_parallelism: availableParallelism(), host_total_memory_bytes: totalmem(),
      cgroup_memory_max: await optionalLimit("/sys/fs/cgroup/memory.max"),
      cgroup_cpu_max: await optionalLimit("/sys/fs/cgroup/cpu.max") },
    workload: workload.description, pair_count: workload.pairs.length,
    input_bytes: workload.pairs.map(pair => inputBytes.get(pair.path)!.byteLength),
    limits: { child_rss_bytes: 512 * 1024 * 1024, child_v8_heap_mib: 256, source_bytes: 8 * 1024 * 1024,
      reply_bytes: 1024 * 1024, timeout_ms: 30_000 },
    method: "one warmup then three sequential real Git capture/native parser/report samples; 25 ms Linux /proc child CPU/RSS sampling",
    limitations: ["sampled child CPU and RSS are lower bounds, especially for short lived children",
      "this component corpus includes small fixtures and current project files; public service, installed host, saturated controls and coding-worker lifecycle need separate runs",
      "parent context bytes count rendered report UTF-8 and exclude transport envelope"], samples }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
}

/**
 * Public resource run on one disposable repository/state with two fresh elected services.
 * Usage: npx tsx scripts/benchmark-structural.ts public --runtime-root /absolute/candidate [--installed] [--rounds N] [--edits N]
 * Compile the development candidate first; an installed root must already be separately published.
 * This command never submits or controls a coding worker. Record actual worker evidence in V14/V15 separately.
 */
async function publicBenchmark(): Promise<void> {
  const args = process.argv.slice(3);
  const rootIndex = args.indexOf("--runtime-root");
  const runtimeRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const roundsIndex = args.indexOf("--rounds");
  const rounds = roundsIndex >= 0 ? Number(args[roundsIndex + 1]) : 10;
  const editsIndex = args.indexOf("--edits");
  const edits = editsIndex >= 0 ? Number(args[editsIndex + 1]) : 5;
  if (!runtimeRoot || !isAbsolute(runtimeRoot) ||
      !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 100 ||
      !Number.isSafeInteger(edits) || edits < 1 || edits > 20 ||
      args.some((item, index) => ["--runtime-root", "--rounds", "--edits"].includes(item) ? !args[index + 1] :
        item.startsWith("--") && !["--runtime-root", "--installed", "--rounds", "--edits"].includes(item))) {
    throw new Error("Usage: npx tsx scripts/benchmark-structural.ts public --runtime-root ABSOLUTE_PATH [--installed] [--rounds 3..100] [--edits 1..20]");
  }
  const runtime = resolve(runtimeRoot);
  const runtimeModule = await import(pathToFileURL(join(runtime, "dist/src/install/runtime.js")).href);
  const serviceModule = await import(pathToFileURL(join(runtime, "dist/src/service/client.js")).href);
  const repositoryModule = await import(pathToFileURL(join(runtime, "dist/src/core/repository-runtime.js")).href);
  const tokenModule = await import(pathToFileURL(join(runtime, "dist/src/service/operator-token.js")).href);
  const bootstrapModule = await import(pathToFileURL(join(runtime, "dist/src/service/bootstrap.js")).href);
  const identity = await runtimeModule.runtimeIdentity(runtime);
  if (args.includes("--installed") && identity.mode !== "installed") throw new Error("Selected runtime root is not an installed candidate");
  if (!args.includes("--installed") && identity.mode !== "development") throw new Error("Use --installed for an installed runtime root");

  const corpus = JSON.parse(await readFile(resolve("tests/fixtures/structural/workload.json"), "utf8")) as { pairs: Pair[]; description: string; public_paths: string[] };
  if (corpus.public_paths.length !== 4 || corpus.public_paths.some(path => !corpus.pairs.some(pair => pair.path === path))) {
    throw new Error("Public benchmark selects exactly four declared corpus files, matching the report bound");
  }
  const temp = await mkdtemp(join(tmpdir(), "passeur-sc16-public-"));
  const project = join(temp, "source project ü spaces"), stateRoot = join(temp, "state");
  const profilePath = join(temp, "no-worker-profile.json");
  const cli = join(runtime, "dist/src/cli.js");
  const git = async (...gitArgs: string[]) => (await run("git", ["-C", project, ...gitArgs], { encoding: "utf8" })).stdout.trim();
  const inputBytes = new Map<string, Buffer>();
  const changedBytes = new Map<string, Buffer>();
  let currentFrontend: { shutdown: () => Promise<void>; call: (operation: string, args: unknown) => Promise<any>;
    coordinate: (request: unknown) => Promise<any> } | undefined;
  let currentPid: number | undefined;
  let cleanupBinding: unknown;
  let cleanupUncertain = false;
  const raw: Record<string, unknown> = { observed_at: new Date().toISOString(), runtime: identity,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu_parallelism: availableParallelism(), host_total_memory_bytes: totalmem(),
      cgroup_memory_max: await optionalLinuxLimit("/sys/fs/cgroup/memory.max"),
      cgroup_cpu_max: await optionalLinuxLimit("/sys/fs/cgroup/cpu.max") },
    corpus: { description: corpus.description, paths: corpus.pairs.map(pair => pair.path), public_paths: corpus.public_paths },
    command: "npx tsx scripts/benchmark-structural.ts public --runtime-root ABSOLUTE_PATH [--installed] [--rounds 3..100] [--edits 1..20]",
    rounds, edits,
    worker_lifecycle: { status: "not_exercised", reason: "Disposable public benchmark does not submit live agents; correlate with actual V14/V15 worker evidence" } };
  try {
    await mkdir(project); await mkdir(stateRoot, { mode: 0o700 });
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Passeur SC16 benchmark");
    await git("config", "user.email", "sc16@example.invalid");
    await git("config", "commit.gpgsign", "false");
    for (const pair of corpus.pairs) {
      const input = await readFile(resolve(pair.input));
      inputBytes.set(pair.path, input);
      changedBytes.set(pair.path, pair.append_comment
        ? Buffer.concat([input, Buffer.from("\n// SC16 observed workspace edit\n")])
        : await readFile(resolve(pair.observed)));
      await mkdir(dirname(join(project, pair.path)), { recursive: true });
      await writeFile(join(project, pair.path), input);
    }
    await git("add", ".");
    await git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "input corpus");
    const base = await git("rev-parse", "HEAD");
    for (const pair of corpus.pairs) await writeFile(join(project, pair.path), changedBytes.get(pair.path)!);
    raw.corpus = { ...raw.corpus as object, base_commit: base,
      files: corpus.pairs.map(pair => ({ path: pair.path, input_bytes: inputBytes.get(pair.path)!.byteLength,
        observed_bytes: changedBytes.get(pair.path)!.byteLength,
        input_sha256: createHash("sha256").update(inputBytes.get(pair.path)!).digest("hex"),
        observed_sha256: createHash("sha256").update(changedBytes.get(pair.path)!).digest("hex") })) };
    const intent = { project, stateRoot, profilePath };
    const binding = await repositoryModule.resolveRepositoryBinding(intent, process.env, AbortSignal.timeout(30_000));
    cleanupBinding = binding;
    const token = await tokenModule.operatorToken(binding, true);
    const ids: string[] = [];
    const phase = async (monitor: "off" | "on") => {
      process.env.PASSEUR_OBSERVATION_MONITOR = monitor;
      const before = await bootstrapModule.readDescriptor(binding);
      if (before && await bootstrapModule.existingOwner(before)) throw new Error("A fresh elected service is required for each monitor phase");
      const frontend = new serviceModule.PasseurFrontend(intent, identity, cli, token);
      currentFrontend = frontend;
      await frontend.call("prepare", {});
      const descriptor = await bootstrapModule.readDescriptor(binding);
      if (!descriptor || !await bootstrapModule.existingOwner(descriptor)) throw new Error("Elected service descriptor unavailable");
      currentPid = descriptor.process.pid;
      return { frontend, pid: descriptor.process.pid, generation: descriptor.generation };
    };
    const stop = async (front: typeof currentFrontend, pid: number) => {
      if (!front) return;
      await front.call("stop", { cancel_tasks: [], operation_key: randomUUID() });
      await front.shutdown(); currentFrontend = undefined;
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        try { process.kill(pid, 0); await delay(50); }
        catch { currentPid = undefined; return; }
      }
      throw new Error("Owned disposable service did not stop after drain");
    };
    const baseline = await phase("off");
    await baseline.frontend.coordinate({ schema_version: 1, kind: "initialize",
      limits: { works: 32, cases: 16, notes: 32, receipts: 256, note_bytes: 16384 } });
    const registered = await baseline.frontend.coordinate({ schema_version: 1, kind: "command", command: {
      kind: "register_external_work", operation_key: randomUUID(), input_oid: base,
      intent: "SC16 public representative corpus", areas: corpus.public_paths.map(path => ({ kind: "file", path })), readers: [] } });
    ids.push(registered.receipt.item_id);
    raw.work_ids = ids;
    raw.baseline = { monitor: "off", generation: baseline.generation,
      samples: await measurePublicProcess(baseline.pid, async () => {
        const rows = [];
        for (let index = 0; index < rounds; index++) {
          const started = performance.now();
          await Promise.all([baseline.frontend.call("status", {}),
            baseline.frontend.call("tasks", { schema_version: 1, offset: 0, limit: 8 })]);
          rows.push(performance.now() - started);
        }
        await delay(2_000);
        return { control_roundtrip_ms: rows, control_percentiles_ms: latencyPercentiles(rows), observation_calls: 0 };
      }) };
    await stop(baseline.frontend, baseline.pid);
    const enabled = await phase("on");
    raw.enabled = { monitor: "on", generation: enabled.generation,
      samples: await measurePublicProcess(enabled.pid, async () => {
        const refreshes = [];
        for (const id of ids) {
          const started = performance.now();
          const outcome = await enabled.frontend.call("structural_refresh", { work_id: id });
          refreshes.push({ work_id: id, latency_ms: performance.now() - started,
            status: outcome.status, limitations: outcome.limitations });
        }
        const reports = [];
        for (const id of ids) {
          const started = performance.now();
          const response = await enabled.frontend.call("structural_report", { work_id: id });
          reports.push({ work_id: id, latency_ms: performance.now() - started,
            response_bytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
            paths: response.reports.map((entry: { path: string }) => entry.path), limitations: response.limitations });
        }
        const saturationSamples = [];
        for (let index = 0; index < rounds; index++) {
          const started = performance.now();
          let analysisEnded = 0;
          const analysis = enabled.frontend.call("structural_report", { work_id: ids[0]! })
            .then((value: unknown) => { analysisEnded = performance.now(); return value; });
          const overload = index === 0 ? enabled.frontend.call("structural_report", { work_id: ids[0]! })
            .then(() => ({ outcome: "returned" }), (error: { code?: string }) => ({ outcome: error.code ?? "failed" }))
            : Promise.resolve(undefined);
          const controlStart = performance.now();
          const [status, tasks] = await Promise.all([enabled.frontend.call("status", {}),
            enabled.frontend.call("tasks", { schema_version: 1, offset: 0, limit: 8 })]);
          const controlEnded = performance.now();
          const [report, overloaded] = await Promise.all([analysis, overload]);
          saturationSamples.push({ analysis_ms: analysisEnded - started, control_ms: controlEnded - controlStart,
            control_completed_before_analysis: controlEnded < analysisEnded,
            ...(overloaded ? { overload: overloaded } : {}), task_count: tasks.total, admission: status.admission,
            response_bytes: Buffer.byteLength(JSON.stringify(report), "utf8") });
        }
        const saturation = { samples: saturationSamples,
          control_percentiles_ms: latencyPercentiles(saturationSamples.map(row => row.control_ms)),
          analysis_percentiles_ms: latencyPercentiles(saturationSamples.map(row => row.analysis_ms)) };
        const idle = await measurePublicProcess(enabled.pid, async () => { await delay(2_000); return { idle_ms: 2000 }; });
        const editPath = corpus.pairs.find(pair => pair.path === "project/repository-runtime.ts")?.path;
        let edit: Record<string, unknown> = { status: "unavailable", reason: "No representative project file selected" };
        if (editPath) {
          const editSamples = [];
          for (let editIndex = 0; editIndex < edits; editIndex++) {
            const before = await enabled.frontend.call("structural_current", {});
            const initial = before.reports.find((item: { path: string }) => item.path === editPath);
            const edited = Buffer.concat([changedBytes.get(editPath)!, Buffer.from(`\n// SC16 watcher replay ${editIndex}\n`)]);
            const editStarted = performance.now();
            await writeFile(join(project, editPath), edited);
            let changed: unknown;
            const deadline = performance.now() + 10_000;
            while (performance.now() < deadline) {
              const current = await enabled.frontend.call("structural_current", {});
              changed = current.reports.find((item: { path: string }) => item.path === editPath);
              if (changed && (changed as { id: string }).id !== initial?.id) break;
              await delay(50);
            }
            const status = changed && (changed as { id: string }).id !== initial?.id ? "observed" : "unavailable";
            editSamples.push({ status, edit_to_current_ms: performance.now() - editStarted,
              materiality_changed: changed ? (changed as { materiality: string }).materiality !== initial?.materiality : false,
              baseline_artifact_id: initial?.id ?? null, observed_artifact_id: (changed as { id?: string } | undefined)?.id ?? null,
              service_rss_bytes: await processRss(enabled.pid) });
            if (status !== "observed") break;
          }
          edit = { samples: editSamples, edit_percentiles_ms: latencyPercentiles(editSamples.map(row => row.edit_to_current_ms)),
            all_observed: editSamples.length === edits && editSamples.every(row => row.status === "observed") };
          await writeFile(join(project, editPath), changedBytes.get(editPath)!);
          await enabled.frontend.call("structural_refresh", { work_id: ids[0]! });
        }
        return { refreshes, reports, saturation, idle, edit,
          parent_context_bytes: reports.reduce((sum, row) => sum + row.response_bytes, 0) +
            saturationSamples.reduce((sum, row) => sum + row.response_bytes, 0) };
      }) };
    await stop(enabled.frontend, enabled.pid);
    raw.limitations = ["No live coding workers are launched by this disposable benchmark",
      "No input/cancel/recovery operation is executed without an actual authorized task scenario",
      "Child CPU/RSS sampling is a lower bound and includes Git plus native helper children",
      "Installed mode uses its published public socket path; host stdio and source-hidden qualifications are separate V13/V14 gates",
      "Baseline and enabled use the same build, repository, registered works and changed source bytes, but separate fresh service generations"];
    console.log(JSON.stringify(raw, null, 2));
  } finally {
    if (currentFrontend) {
      try { await currentFrontend.call("stop", { cancel_tasks: [], operation_key: randomUUID() }); }
      catch { /* Preserve the owned state below if shutdown cannot be established. */ }
      await currentFrontend.shutdown().catch(() => undefined);
    }
    if (currentPid === undefined && cleanupBinding) {
      try {
        const descriptor = await bootstrapModule.readDescriptor(cleanupBinding);
        if (descriptor && await bootstrapModule.existingOwner(descriptor)) currentPid = descriptor.process.pid;
      } catch { cleanupUncertain = true; }
    }
    delete process.env.PASSEUR_OBSERVATION_MONITOR;
    if (currentPid !== undefined) {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        try { process.kill(currentPid, 0); await delay(50); }
        catch { currentPid = undefined; break; }
      }
    }
    if (currentPid === undefined && !cleanupUncertain) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`SC16 disposable service may still be live; retained state for disposition: ${temp}\n`);
  }
}

async function optionalLinuxLimit(path: string): Promise<string> {
  try { return (await readFile(path, "utf8")).trim(); }
  catch { return "unavailable"; }
}

async function processRss(pid: number): Promise<number | null> {
  try {
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(await readFile(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : null;
  } catch { return null; }
}

function latencyPercentiles(samples: readonly number[]): Readonly<{ p50: number; p95: number; p99: number; count: number }> {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), count: sorted.length };
}

async function measurePublicProcess<T>(pid: number, action: () => Promise<T>): Promise<Readonly<{
  wall_ms: number; parent_cpu_ms_sampled: number; child_cpu_ms_sampled: number;
  peak_parent_rss_bytes: number; peak_child_rss_bytes: number; result: T
}>> {
  const ticks = Number((await run("getconf", ["CLK_TCK"])).stdout.trim());
  const children = new Map<number, number>();
  let firstCpu: number | undefined, lastCpu = 0, peakParent = 0, peakChild = 0;
  const sample = async () => {
    try {
      const [stat, status, list] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"), readFile(`/proc/${pid}/task/${pid}/children`, "utf8")]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const cpu = Number(fields[11]) + Number(fields[12]);
      if (firstCpu === undefined) firstCpu = cpu;
      lastCpu = Math.max(lastCpu, cpu);
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (rss) peakParent = Math.max(peakParent, Number(rss[1]) * 1024);
      for (const child of list.trim().split(/\s+/).filter(Boolean)) {
        const id = Number(child);
        try {
          const [childStat, childStatus] = await Promise.all([readFile(`/proc/${id}/stat`, "utf8"), readFile(`/proc/${id}/status`, "utf8")]);
          const parts = childStat.slice(childStat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const value = Number(parts[11]) + Number(parts[12]);
          if (Number.isSafeInteger(value)) children.set(id, Math.max(children.get(id) ?? 0, value));
          const childRss = /^VmRSS:\s+(\d+) kB$/m.exec(childStatus);
          if (childRss) peakChild = Math.max(peakChild, Number(childRss[1]) * 1024);
        } catch { /* A short lived child may exit between reads. */ }
      }
    } catch { /* The elected service may close after the sample; the caller owns its status. */ }
  };
  await sample();
  const started = performance.now();
  const timer = setInterval(() => { void sample(); }, 25);
  try {
    const result = await action();
    await sample();
    return { wall_ms: performance.now() - started, parent_cpu_ms_sampled: (lastCpu - (firstCpu ?? lastCpu)) * 1000 / ticks,
      child_cpu_ms_sampled: [...children.values()].reduce((sum, value) => sum + value, 0) * 1000 / ticks,
      peak_parent_rss_bytes: peakParent, peak_child_rss_bytes: peakChild, result };
  } finally { clearInterval(timer); }
}
