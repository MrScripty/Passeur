import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve("dist/src/cli.js");
it("documents the per-server choice and its startup consequence", async () => {
  const { stdout } = await exec(process.execPath, [cli, "--help"]);
  expect(stdout).toContain("--required|--optional");
  expect(stdout).toContain("failure blocks host startup");
});
it("rejects conflicting policy flags before profile, repository or runtime lookup", async () => {
  await expect(exec(process.execPath, [cli, "register-codex", "--required", "--optional"]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Choose --required or --optional") });
});
it("does not allow policy flags on a serve process", async () => {
  await expect(exec(process.execPath, [cli, "serve", "--required"]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ARGUMENT_INAPPLICABLE") });
});
it("does not silently accept policy flags when configure will not register", async () => {
  await expect(exec(process.execPath, [cli, "configure", "--required"]))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("requires --install-codex") });
});
