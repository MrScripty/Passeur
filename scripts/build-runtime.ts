import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { buildRuntimeCandidate } from "../src/install/runtime.js";
import { diagnosticInfo } from "../src/core/errors.js";

const { values } = parseArgs({ options: {
  source: { type: "string", default: process.cwd() },
  output: { type: "string" }, "allow-dirty": { type: "boolean", default: false },
}, strict: true });
try {
  const source = resolve(values.source);
  const candidate = await buildRuntimeCandidate(source, resolve(values.output ?? `${source}/.passeur-build`), values["allow-dirty"]);
  console.log(JSON.stringify({ candidate, installation: "not_run", note: "Candidate construction is not installed-host compatibility evidence." }, null, 2));
} catch (error) { console.error(JSON.stringify(diagnosticInfo(error))); process.exitCode = 1; }
