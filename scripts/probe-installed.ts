import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { BridgeError, diagnosticInfo } from "../src/core/errors.js";
const exec = promisify(execFile);
const markerSchema = z.object({ schema_version: z.literal(1), nonce: z.string().uuid(), root: z.string().min(1) }).strict();
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, ...args], { timeout: 30000, maxBuffer: 1048576 })).stdout.trim();

async function main(): Promise<void> {
  const action = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    fixture: { type: "string" }, yes: { type: "boolean" }, commit: { type: "string" }, report: { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values.fixture || !["create", "verify"].includes(action ?? "")) throw new BridgeError("PROBE_ARGUMENT_INVALID", "Use probe:installed -- create --fixture NEW_DIRECTORY --yes, or verify --fixture DIRECTORY --commit FULL_OID");
  const root = resolve(values.fixture);
  let report: Record<string, unknown>;
  if (action === "create") {
    if (!values.yes) throw new BridgeError("PROBE_AUTHORITY_REQUIRED", "Fixture creation requires --yes; it creates a new repository and fixture-local Git settings");
    await mkdir(root, { recursive: false, mode: 0o700 });
    const marker = { schema_version: 1 as const, nonce: randomUUID(), root };
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "--local", "user.name", "Passeur Acceptance"]);
    await git(root, ["config", "--local", "user.email", "acceptance@example.invalid"]);
    await git(root, ["config", "--local", "commit.gpgsign", "false"]);
    // The explicitly disposable fixture does not inherit arbitrary host hook programs.
    await git(root, ["config", "--local", "core.hooksPath", join(root, ".git", "hooks")]);
    await writeFile(join(root, ".passeur-fixture.json"), JSON.stringify(marker, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "README.md"), "Disposable Passeur installed-workflow fixture.\n", { flag: "wx", mode: 0o600 });
    await git(root, ["add", "--", ".passeur-fixture.json", "README.md"]);
    await git(root, ["commit", "-qm", "test: establish disposable Passeur fixture"]);
    const base = await git(root, ["rev-parse", "HEAD"]);
    report = { fixture: root, base_commit: base, target_ref: "refs/heads/main", nonce: marker.nonce,
      installed_workflow: "not_run", inference_launched: false,
      assignment: `Through the actual installed Codex namespace, delegate one implementation task with base_commit ${base}, target_ref refs/heads/main, and allowed_paths [probe-output.txt]. Create probe-output.txt containing exactly ${marker.nonce} followed by a newline. Verify that content and commit through ordinary Git. Return the real Passeur receipt.`,
      next_action: "Record actual Codex attachment, approvals, cancellation, worker stop and receipt evidence using docs/installed-acceptance.md; this fixture command proves none of those claims." };
  } else {
    const marker = markerSchema.parse(JSON.parse(await readFile(join(root, ".passeur-fixture.json"), "utf8")));
    if (marker.root !== root) throw new BridgeError("PROBE_FIXTURE_CHANGED", "Fixture location does not match its creation identity");
    const oid = values.commit;
    if (!oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) throw new BridgeError("PROBE_COMMIT_REQUIRED", "Use the full observed task commit ID");
    const actual = await git(root, ["rev-parse", "--verify", `${oid}^{commit}`]);
    if (actual.toLowerCase() !== oid.toLowerCase()) throw new BridgeError("PROBE_COMMIT_INVALID", "Expected an actual commit, not an annotated tag");
    const content = (await exec("git", ["-C", root, "show", `${oid}:probe-output.txt`], { timeout: 10000, maxBuffer: 8192 })).stdout;
    if (content !== `${marker.nonce}\n`) throw new BridgeError("PROBE_DELIVERY_INVALID", "The observed commit does not contain the requested fixture result");
    report = { fixture: root, commit: actual, delivery: "observed", observed_content: content,
      installed_workflow: "requires_operator_evidence", warning: "Git content proves delivery identity only. Attach the actual Codex/Passeur/Muse transcript and task receipt; do not infer agent execution, approvals, billing or sandbox enforcement." };
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.report) await writeFile(resolve(values.report), output, { mode: 0o600, flag: "wx" });
  process.stdout.write(output);
}
main().catch((error: unknown) => { console.error(JSON.stringify(diagnosticInfo(error))); process.exitCode = 1; });
