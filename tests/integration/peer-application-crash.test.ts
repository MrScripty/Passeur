import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
// @ts-expect-error The shared Git fixture is JavaScript.
import { git } from "../fixtures/structural/service-fixture.mjs";

type Frontier = "before-intent" | "after-intent" | "after-write" | "after-result" | "after-case";
type Message = { kind: string; frontier?: Frontier; code?: string; message?: string; stack?: string };
const fixtureScript = join(process.cwd(), "tests/fixtures/structural/peer-application-crash.mjs");
const source = (value: number) => `export function run() { return ${value}; }\n`;

async function runChild(configFile: string, mode: "run" | "recover", frontier: Frontier): Promise<Message> {
  const child = spawn(process.execPath, [fixtureScript, configFile, mode], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", chunk => { stderr += chunk; });
  let stopped = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => { stopped = true; resolve({ code, signal }); });
  });
  try {
    const message = await new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out at ${frontier}/${mode}: ${stderr}`)),
        mode === "run" ? 180_000 : 30_000);
      child.once("message", value => { clearTimeout(timer); resolve(value as Message); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Child exited before ${frontier}/${mode}: ${code}/${signal}: ${stderr}`));
      });
    });
    if (mode === "run") {
      assert.equal(message.kind, "checkpoint", message.stack ?? message.message);
      assert.equal(message.frontier, frontier);
      assert.ok(child.pid);
      assert.equal(child.kill("SIGKILL"), true);
      const ended = await exit;
      assert.equal(ended.signal, "SIGKILL", `Crash child stop uncertain: ${JSON.stringify(ended)} ${stderr}`);
    } else {
      assert.equal(message.kind, "recovery");
      const ended = await exit;
      assert.equal(ended.code, 0, `Recovery child exit uncertain: ${JSON.stringify(ended)} ${stderr}`);
    }
    return message;
  } finally {
    if (!stopped) {
      child.kill("SIGKILL");
      const ended = await Promise.race([exit, new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000))]);
      if (!ended) process.stderr.write(`Unconfirmed fixture child stop: pid=${child.pid} root=${configFile}\n`);
    }
  }
}

test.each<Frontier>(["before-intent", "after-intent", "after-write", "after-result", "after-case"])(
  "fresh Runtime refuses application recovery after %s", async frontier => {
    const temp = await mkdtemp(join(tmpdir(), "passeur-application-crash-"));
    try {
      const root = join(temp, "repo"), state = join(temp, "state");
      await mkdir(root); await mkdir(state, { mode: 0o700 });
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.name", "Passeur crash fixture"]);
      await git(root, ["config", "user.email", "fixture@example.invalid"]);
      await git(root, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(root, "source.ts"), source(0));
      await git(root, ["add", "--", "source.ts"]);
      await git(root, ["commit", "-m", "test: source baseline"]);
      const base = (await git(root, ["rev-parse", "HEAD"])).trim();
      const configFile = join(temp, "config.json");
      await writeFile(configFile, JSON.stringify({ temp, root, state, base, frontier,
        run_id: randomUUID(), limits: { works: 32, cases: 16, notes: 32, receipts: 256, note_bytes: 16384 } }));
      const checkpoint = await runChild(configFile, "run", frontier);
      const expected = JSON.parse(await readFile(join(temp, "expected.json"), "utf8"));
      assert.equal((checkpoint as Message & { task_id?: string }).task_id, expected.ids[1]);
      assert.equal((checkpoint as Message & { key?: string }).key, expected.key);
      assert.equal(expected.ids.length, 2);
      assert.match(expected.run_id, /^[0-9a-f-]{36}$/);
      assert.ok(expected.control_generation > 0);
      assert.match(expected.proposal_digest, /^[0-9a-f]{64}$/);
      const fromBuild = (name: string) => import(pathToFileURL(join(process.cwd(), "dist/src", name)).href);
      const [{ TaskStore }, { resolveRepositoryBinding }, { decodePeerResolutionText }] = await Promise.all([
        fromBuild("store/task-store.js"), fromBuild("core/repository-runtime.js"),
        fromBuild("coordination/peer-resolution.js"),
      ]);
      const binding = await resolveRepositoryBinding({ project: root, stateRoot: state,
        profilePath: join(temp, "missing-profile.json") }, {}, new AbortController().signal);
      const store = new TaskStore(binding.storeRoot);
      const fileIdentity = async (path: string) => {
        const value = await stat(path, { bigint: true });
        return { dev: value.dev.toString(), ino: value.ino.toString(), size: value.size.toString(),
          mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString() };
      };
      const read = async () => {
        const operation = await store.readPeerOperation(expected.ids[1], expected.key);
        const controls = await Promise.all(expected.ids.map((id: string) => store.readControl(id)));
        const coordination = JSON.parse(await readFile(join(binding.storeRoot, "coordination/control.json"), "utf8"));
        const applicationPrefix = `worker-peer-v1:${expected.ids[1]}:${expected.run_id}:`;
        const outcomeReceipts = coordination.receipts.filter((receipt: { key: string }) =>
          receipt.key.startsWith(applicationPrefix) && receipt.key.endsWith(":outcome"));
        const pendingReceipts = coordination.receipts.filter((receipt: { key: string }) =>
          receipt.key.startsWith(applicationPrefix) && receipt.key.endsWith(":pending"));
        return { operation, controls, coordination, outcomeReceipts, pendingReceipts,
          original: await readFile(join(root, "source.ts"), "utf8"),
          first: await readFile(join(expected.worktrees[0], "source.ts"), "utf8"),
          second: await readFile(join(expected.worktrees[1], "source.ts"), "utf8"),
          fileIdentities: await Promise.all([join(root, "source.ts"), ...expected.worktrees.map((path: string) =>
            join(path, "source.ts"))].map(fileIdentity)) };
      };
      const before = await read();
      assert.equal(before.original, source(0));
      assert.equal(before.first, source(1));
      assert.equal(before.second, frontier === "before-intent" || frontier === "after-intent" ? source(2) : source(3));
      if (before.second === source(3)) {
        const module = await import(`data:text/javascript;base64,${Buffer.from(before.second).toString("base64")}`);
        assert.equal(module.run(), 3);
      }
      assert.equal(before.operation?.disposition,
        frontier === "before-intent" ? undefined : frontier === "after-intent" || frontier === "after-write" ? "started" : "settled");
      assert.equal(before.pendingReceipts.length, 1);
      assert.equal(before.outcomeReceipts.length, frontier === "after-case" ? 1 : 0);
      for (const [receipt, status] of [
        [before.pendingReceipts[0], "pending"],
        ...(frontier === "after-case" ? [[before.outcomeReceipts[0], "applied"]] : []),
      ] as Array<[any, string]>) {
        const note = before.coordination.notes.find((item: { id: string }) => item.id === receipt.item_id);
        assert.ok(note);
        const record = decodePeerResolutionText(note.text);
        assert.equal(record?.kind, "peer_resolution_application");
        assert.equal(record.case_id, expected.case_id);
        assert.equal(record.proposal_digest, expected.proposal_digest);
        assert.equal(record.status, status);
      }
      assert.equal(before.controls[1].native.run_id, expected.run_id);
      assert.equal(before.controls[1].control_generation, expected.control_generation);
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovery = await runChild(configFile, "recover", frontier);
        assert.equal(recovery.code, "PROJECT_NEEDS_RECONCILIATION", recovery.message);
        await assert.rejects(access(join(temp, "unexpected-turn")), { code: "ENOENT" });
        const after = await read();
        assert.deepEqual([after.original, after.first, after.second],
          [before.original, before.first, before.second], "recovery must not apply another file effect");
        assert.deepEqual(after.fileIdentities, before.fileIdentities,
          "recovery must not replace a source file with identical bytes");
        assert.deepEqual(after.coordination, before.coordination,
          "recovery must not publish or alter a case receipt");
        assert.deepEqual(after.pendingReceipts, before.pendingReceipts);
        assert.deepEqual(after.outcomeReceipts, before.outcomeReceipts);
        assert.equal(after.operation?.request_hash, before.operation?.request_hash);
        assert.deepEqual(after.operation?.result, before.operation?.result,
          "recovery must preserve the exact settled task receipt");
        if (after.operation) {
          assert.equal(after.operation.request.run_id, expected.run_id);
          assert.equal(after.operation.request.control_generation, expected.control_generation);
          assert.equal(after.operation.request.workspace_id, expected.workspace_id);
          assert.equal(after.operation.request.operation_key, expected.key);
        }
        assert.equal(after.operation?.disposition, before.operation?.disposition === "started" ? "unavailable" : before.operation?.disposition);
        assert.equal(after.controls[1].native.run_id, expected.run_id);
        assert.equal(after.controls[1].control_generation, expected.control_generation);
        assert.equal(after.controls[1].native.state, "unknown");
        assert.equal(after.controls[1].phase, "needs_attention");
      }
    } finally {
      // A SIGKILL proves the Runtime child's stop, but does not prove every
      // observation helper descendant stopped. Keep this registered root.
      await access(temp);
      process.stderr.write(`Retained application crash fixture: ${temp}\n`);
    }
  }, 240_000);
