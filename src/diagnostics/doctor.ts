import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { PasseurFrontend } from "../service/client.js";
import { BridgeError, diagnosticInfo, safeText } from "../core/errors.js";
const exec = promisify(execFile);

const nativeCatalog = [
  ["rust", "tree-sitter-rust"], ["typescript", "tree-sitter-typescript"], ["tsx", "tree-sitter-typescript"],
  ["javascript", "tree-sitter-javascript"], ["jsx", "tree-sitter-javascript"], ["python", "tree-sitter-python"],
  ["lua", "@tree-sitter-grammars/tree-sitter-lua"], ["kotlin", "@tree-sitter-grammars/tree-sitter-kotlin"],
  ["zig", "tree-sitter-zig"], ["csharp", "tree-sitter-c-sharp"], ["c", "tree-sitter-c"],
  ["cpp", "tree-sitter-cpp"], ["odin", "tree-sitter-odin"], ["svelte5", "@tree-sitter-grammars/tree-sitter-svelte"],
] as const;

type NativeDialect = typeof nativeCatalog[number][0];
type NativeResult = { dialect: NativeDialect; package: string; status: "ready" | "unavailable"; failure?: ReturnType<typeof diagnosticInfo> };

/** Explicit diagnostic only: never called by discovery, startup, or retained-result reads. */
export async function inspectInstalledNativeParser(root: string, expectedBuildId: string, signal?: AbortSignal): Promise<{
  schema_version: 1; status: "ready" | "unavailable"; build_id: string;
  grammars: NativeResult[]; failure?: ReturnType<typeof diagnosticInfo>;
}> {
  const grammars: NativeResult[] = [];
  try {
    const { readManifest, verifyInstalledNativePackages } = await import("../install/runtime.js");
    const manifest = await readManifest(root);
    if (manifest.schema_version !== 2 || manifest.state !== "installed" || manifest.source_dirty)
      throw new BridgeError("RUNTIME_PARSER_INVALID", "Selected runtime has no installed native parser inventory");
    if (manifest.build_id !== expectedBuildId)
      throw new BridgeError("RUNTIME_IDENTITY_MISMATCH", "Doctor selected a different installed build");
    for (const [dialect, name] of nativeCatalog) {
      try {
        await verifyInstalledNativePackages(root, name, expectedBuildId);
        grammars.push({ dialect, package: name, status: "ready" });
      } catch (error) { grammars.push({ dialect, package: name, status: "unavailable", failure: diagnosticInfo(error) }); }
    }
    if (grammars.some(row => row.status === "unavailable")) return { schema_version: 1, status: "unavailable", build_id: expectedBuildId, grammars };

    // Load every dialect from the selected artifact in a child, so a native loader failure cannot take down doctor.
    const moduleUrl = pathToFileURL(join(root, "dist/src/observation/native-parser.js")).href;
    const script = `const { loadNativeParser } = await import(process.argv[1]); ` +
      `const rows = []; for (const dialect of JSON.parse(process.argv[2])) { try { const value = await loadNativeParser(dialect); value.parser.parse(""); rows.push({ dialect, status: "ready" }); } catch (error) { rows.push({ dialect, status: "unavailable", code: typeof error?.code === "string" ? error.code : "STRUCTURAL_PARSER_UNAVAILABLE", message: String(error?.message ?? error).slice(0, 512) }); } } console.log(JSON.stringify(rows));`;
    const result = await exec(process.execPath, ["--input-type=module", "-e", script, moduleUrl,
      JSON.stringify(nativeCatalog.map(([dialect]) => dialect))], {
      cwd: root, timeout: 30_000, maxBuffer: 64 * 1024,
      env: { ...process.env, PASSEUR_NATIVE_BUILD_ID: expectedBuildId }, ...(signal ? { signal } : {}),
    });
    const loaded: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(loaded) || loaded.length !== nativeCatalog.length)
      throw new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE", "Native loader returned an incomplete catalog");
    for (const [index, row] of loaded.entries()) {
      const expected = grammars[index];
      if (!expected || typeof row !== "object" || row === null || row.dialect !== expected.dialect ||
          (row.status !== "ready" && row.status !== "unavailable"))
        throw new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE", "Native loader returned an invalid catalog");
      if (row.status === "unavailable") grammars[index] = { ...expected, status: "unavailable",
        failure: { code: safeText(typeof row.code === "string" ? row.code : "STRUCTURAL_PARSER_UNAVAILABLE", 128),
          message: safeText(typeof row.message === "string" ? row.message : "Native grammar could not be loaded", 512) } };
    }
    return { schema_version: 1, status: grammars.every(row => row.status === "ready") ? "ready" : "unavailable",
      build_id: expectedBuildId, grammars };
  } catch (error) {
    const failure = error instanceof BridgeError ? error : new BridgeError("STRUCTURAL_PARSER_UNAVAILABLE",
      "Installed native parser diagnostic could not complete", { cause: error });
    const info = diagnosticInfo(failure);
    return { schema_version: 1, status: "unavailable", build_id: expectedBuildId,
      grammars: grammars.map(row => ({ ...row, status: "unavailable", failure: info })), failure: info };
  }
}

/** Diagnostic observations are not inferred execution or provider compatibility evidence. */
export async function doctor(frontend: PasseurFrontend, prepare = false, signal?: AbortSignal) {
  let preparation;
  if (prepare) {
    try { await frontend.call("prepare", {}, signal); preparation = { status: "passed" as const }; }
    catch (error) { preparation = { status: "blocked" as const, failure: diagnosticInfo(error) }; }
  }
  let codex;
  try {
    const result = await exec("codex", ["--version"], { timeout: 5000, maxBuffer: 8192, ...(signal ? { signal } : {}) });
    codex = { status: "observed" as const, version: safeText(result.stdout.trim(), 512) };
  } catch (error) { codex = { status: "unavailable" as const, failure: diagnosticInfo(error) }; }
  const status = await frontend.observeStatus(signal);
  const native_parser = frontend.identity.mode === "installed"
    ? await inspectInstalledNativeParser(resolve(dirname(frontend.exactCli), "../.."), frontend.identity.build_id, signal)
    : { schema_version: 1 as const, status: "not_run" as const,
      reason: "Native parser readiness requires an installed runtime artifact" };
  return { status, codex, preparation: preparation ?? { status: "not_run" }, installed_workflow: "not_run", native_parser,
    warning: "No inference, repository test, provider sandbox, credential billing, signing, approval or host attachment claim is established by this diagnostic." };
}
