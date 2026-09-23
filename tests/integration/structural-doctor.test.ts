import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { doctor, inspectInstalledNativeParser } from "../../src/diagnostics/doctor.js";
import { installRuntime, readManifest } from "../../src/install/runtime.js";
import type { PasseurFrontend } from "../../src/service/client.js";

it("keeps the existing doctor fields and leaves native inspection idle in development", async () => {
  const status = { schema_version: 2, service: { state: "not_checked" } };
  const frontend = {
    identity: { mode: "development", build_id: "development-unidentified" },
    exactCli: "/missing/dist/src/cli.js",
    observeStatus: async () => status,
  } as unknown as PasseurFrontend;
  const result = await doctor(frontend);
  expect(result.status).toBe(status);
  expect(result.preparation).toEqual({ status: "not_run" });
  expect(result.installed_workflow).toBe("not_run");
  expect(result.native_parser).toEqual({ schema_version: 1, status: "not_run",
    reason: "Native parser readiness requires an installed runtime artifact" });
});

it("reports a missing installed manifest as unavailable without creating one", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-doctor-missing-"));
  try {
    const result = await inspectInstalledNativeParser(root, "a".repeat(64));
    expect(result).toMatchObject({ schema_version: 1, status: "unavailable", build_id: "a".repeat(64),
      grammars: [], failure: { code: "PATH_NOT_FOUND" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

const candidate = process.env.PASSEUR_NATIVE_CANDIDATE;
it.skipIf(!candidate)("reports installed native readiness, build mismatch, and altered binding and grammar bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "passeur-doctor-installed-"));
  try {
    const selected = await readManifest(candidate!);
    expect(selected.schema_version).toBe(2);
    const installed = await installRuntime(candidate!, join(root, "installed"));
    const frontend = {
      identity: { mode: "installed", build_id: selected.build_id },
      exactCli: join(installed.root, "dist/src/cli.js"),
      observeStatus: async () => ({ schema_version: 2, service: { state: "not_checked" } }),
    } as unknown as PasseurFrontend;
    const observed = await doctor(frontend);
    expect(observed.installed_workflow).toBe("not_run");
    const ready = observed.native_parser;
    expect(ready).toMatchObject({ schema_version: 1, status: "ready", build_id: selected.build_id });
    if (ready.status === "not_run") throw new Error("Installed native diagnostic was not run");
    expect(ready.grammars).toHaveLength(14);
    expect(ready.grammars.every(row => row.status === "ready")).toBe(true);

    const wrong = await inspectInstalledNativeParser(installed.root, "b".repeat(64));
    expect(wrong).toMatchObject({ status: "unavailable", failure: { code: "RUNTIME_IDENTITY_MISMATCH" } });

    const binding = join(installed.root, "node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node");
    const bindingBytes = await readFile(binding);
    try {
      await writeFile(binding, Buffer.concat([bindingBytes, Buffer.from([0])]));
      const damaged = await inspectInstalledNativeParser(installed.root, selected.build_id);
      expect(damaged.status).toBe("unavailable");
      expect(damaged.grammars).toHaveLength(14);
      expect(damaged.grammars.every(row => row.failure?.code === "RUNTIME_PARSER_MISMATCH")).toBe(true);
    } finally { await writeFile(binding, bindingBytes); }

    const grammar = join(installed.root, "node_modules/tree-sitter-rust/build/Release/tree_sitter_rust_binding.node");
    const grammarBytes = await readFile(grammar);
    try {
      await writeFile(grammar, Buffer.concat([grammarBytes, Buffer.from([0])]));
      const damaged = await inspectInstalledNativeParser(installed.root, selected.build_id);
      expect(damaged.status).toBe("unavailable");
      expect(damaged.grammars.find(row => row.dialect === "rust")).toMatchObject({
        status: "unavailable", failure: { code: "RUNTIME_PARSER_MISMATCH" },
      });
      expect(damaged.grammars.find(row => row.dialect === "python")?.status).toBe("ready");
    } finally { await writeFile(grammar, grammarBytes); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
