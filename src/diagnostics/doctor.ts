import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryRuntime } from "../core/repository-runtime.js";
import { diagnosticInfo, safeText } from "../core/errors.js";
const exec = promisify(execFile);

/** Diagnostic observations are not inferred execution or provider compatibility evidence. */
export async function doctor(runtime: RepositoryRuntime, prepare = false, signal?: AbortSignal) {
  let preparation;
  if (prepare) {
    try { await runtime.prepare(signal); preparation = { status: "passed" as const }; }
    catch (error) { preparation = { status: "blocked" as const, failure: diagnosticInfo(error) }; }
  }
  let codex;
  try {
    const result = await exec("codex", ["--version"], { timeout: 5000, maxBuffer: 8192, ...(signal ? { signal } : {}) });
    codex = { status: "observed" as const, version: safeText(result.stdout.trim(), 512) };
  } catch (error) { codex = { status: "unavailable" as const, failure: diagnosticInfo(error) }; }
  return { status: runtime.status(), codex, preparation: preparation ?? { status: "not_run" }, installed_workflow: "not_run",
    warning: "No inference, repository test, provider sandbox, credential billing, signing, approval or host attachment claim is established by this diagnostic." };
}
