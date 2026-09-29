import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAdapter, codexEnvironment, resolveCodexHome, failOnProtectedCredentialExposure, failOnProtectedTerminalAuth,
  initializeAfterProtectedCapture, protectedNativeRejection, threadStartArguments, dispositionFailureCategory } from "../../src/agents/codex/adapter.js";
import { parseWorkerMessage } from "../../src/agents/report.js";
import { BridgeError } from "../../src/core/errors.js";
import { assertConfiguration, assertEmptySkills, assertProtectedConfiguration, assertProtectedProfile, assertSyntheticSeedAccount, protectedItemType, protectedThreadStarted, protectedUserEcho } from "../../src/agents/codex/protocol.js";
import type { CodexOptions } from "../../src/agents/codex/config.js";
import type { WorkerInput } from "../../src/agents/types.js";
import { cancellationConformance } from "../fixtures/adapter-conformance.js";

const input: Omit<WorkerInput, "signal"> = {
  task_id: "codex-conformance", workspace: "/unused/pre-cancelled", prompt: "Bounded fixture assignment",
  request: { schema_version: 3, agent_id: "codex-worker", request_key: "codex-test", mode: "implement", objective: "Fixture",
    context: "", acceptance_criteria: ["Fixture report"], base_commit: "a".repeat(40), target_ref: "refs/heads/main" },
  policy: { implementation: { enabled: true }, max_workers: 2, max_queued_tasks: 8, max_clients: 32, max_waiters: 128, max_pending_inputs: 16, max_control_receipts: 512, stop_grace_ms: 1_000 },
  approve: async () => ({ choice_id: "decline" }), input: async () => { throw new Error("Unexpected clarification in this fixture"); }, onEvent: async () => {},
};
const options: CodexOptions = { codex_bin: "/missing/codex", codex_home: "/unused/pre-cancelled-home", model: "fixture-model",
  network_access: false, allow_command_escalation: false, subscription_confirmed: true, experimental_opt_in: true };
cancellationConformance("Codex", () => new CodexAdapter(options), input);

describe("real protected Codex output contract", () => {
  it("adds only a static bounded developer instruction to real protected thread/start", () => {
    const workspace = "/tmp/private-workspace-sensitive", provider = "fixture-provider";
    const ordinary = threadStartArguments(options, workspace, provider, "ordinary");
    expect(ordinary).toEqual({ model: options.model, modelProvider: "openai", cwd: workspace,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true });
    const synthetic = threadStartArguments(options, workspace, provider, "protected_synthetic");
    expect(synthetic).toEqual({ model: options.model, modelProvider: provider, cwd: workspace,
      permissions: "passeur-boundary", ephemeral: true, allowProviderModelFallback: false });
    const real = threadStartArguments(options, workspace, provider, "protected_real");
    expect(real).toEqual({ ...synthetic, developerInstructions: expect.any(String) });
    if (!("developerInstructions" in real) || typeof real.developerInstructions !== "string") {
      throw new Error("Real protected thread/start lacks developer instructions");
    }
    expect(real.developerInstructions).toContain('PASSEUR_MESSAGE');
    expect(real.developerInstructions).toContain('"schema_version":2,"kind":"final"');
    expect(Buffer.byteLength(real.developerInstructions, "utf8")).toBeLessThan(1_024);
    for (const sensitive of [workspace, provider, "private_git", "peer content", "fixture-provider"]) {
      expect(real.developerInstructions).not.toContain(sensitive);
    }
  });
  it.each([
    [undefined, "missing_or_oversize"],
    ["plain native prose", "marker_missing"],
    ["PASSEUR_MESSAGE {", "json_invalid"],
    ['PASSEUR_MESSAGE {"schema_version":2,"kind":"final"}', "contract_invalid"],
  ] as const)("classifies only a parser-owned invalid disposition from %s", (report, category) => {
    let error: unknown;
    try { parseWorkerMessage(report); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "WORKER_MESSAGE_INVALID" });
    expect(dispositionFailureCategory((error as BridgeError).message)).toBe(category);
  });
  it("uses a fixed unknown category without exposing an arbitrary parser error", () => {
    const secret = "native-secret@example.invalid";
    expect(dispositionFailureCategory(secret)).toBe("unknown");
    expect(dispositionFailureCategory(`${secret} Assignment disposition is not valid JSON`)).toBe("unknown");
  });
});

describe("ordinary Codex effective configuration", () => {
  const allowed = { config: { mcp_servers: {}, features: { multi_agent: false, apps: false, plugins: false },
    web_search: "disabled", forced_login_method: "chatgpt" } };
  const message = "Effective configuration did not establish child-tool and credential isolation";
  it("accepts empty MCP inventory and disabled native features", () => {
    expect(() => assertConfiguration(allowed)).not.toThrow();
  });
  it("permits existing MCP registrations only for an explicit caller-home ordinary worker", () => {
    const configured = { config: { ...allowed.config, mcp_servers: { ordinary: { url: "https://example.invalid" } } } };
    expect(() => assertConfiguration(configured)).toThrowError(expect.objectContaining({ code: "CODEX_ISOLATION_UNAVAILABLE" }));
    expect(() => assertConfiguration(configured, true)).not.toThrow();
    expect(() => assertConfiguration({ config: { ...configured.config, features: { ...allowed.config.features, apps: true } } }, true))
      .toThrowError(expect.objectContaining({ code: "CODEX_ISOLATION_UNAVAILABLE" }));
  });
  it.each([
    [{ mcp_servers: { server: {} } }, "mcp_servers"],
    [{ features: { ...allowed.config.features, multi_agent: true } }, "features.multi_agent"],
    [{ features: { ...allowed.config.features, apps: true } }, "features.apps"],
    [{ features: { ...allowed.config.features, plugins: true } }, "features.plugins"],
    [{ web_search: "live" }, "web_search"],
    [{ forced_login_method: "api_key" }, "forced_login_method"],
  ] as const)("reports only the fixed category for isolated mismatch %j", (change, category) => {
    expect(() => assertConfiguration({ config: { ...allowed.config, ...change } })).toThrowError(
      expect.objectContaining({ code: "CODEX_ISOLATION_UNAVAILABLE", message: `${message} (${category})` }));
  });
  it("reports all categories once in stable order without native values", () => {
    const secret = "fixture-secret-token@example.invalid";
    const value = { config: { mcp_servers: { [secret]: { url: `https://${secret}` } },
      features: { multi_agent: secret, apps: secret, plugins: secret }, web_search: secret,
      forced_login_method: secret } };
    let error: unknown;
    try { assertConfiguration(value); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "CODEX_ISOLATION_UNAVAILABLE", message: `${message} (` +
      "mcp_servers, features.multi_agent, features.apps, features.plugins, web_search, forced_login_method)" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
  it("keeps malformed containers on the protocol error path and hides native strings", () => {
    const secret = "fixture-secret-token@example.invalid";
    for (const value of [
      { config: { ...allowed.config, features: secret } },
      { config: { ...allowed.config, mcp_servers: [secret] } },
      { config: secret },
    ]) {
      let error: unknown;
      try { assertConfiguration(value); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "CODEX_PROTOCOL_INVALID" });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("ordinary Codex caller-home policy", () => {
  it("uses HOME/.codex when CODEX_HOME is unset without reading auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-codex-home-fallback-"));
    const home = join(root, ".codex"), workspace = join(root, "workspace");
    const previous = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME };
    try {
      await mkdir(home); await mkdir(workspace);
      delete process.env.CODEX_HOME;
      process.env.HOME = root;
      await expect(resolveCodexHome(home, workspace)).rejects.toMatchObject({ code: "CODEX_HOME_NOT_ISOLATED" });
      await expect(resolveCodexHome(home, workspace, true)).resolves.toBe(home);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  it("requires opt-in and the exact canonical current caller home", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-codex-caller-home-"));
    const home = join(root, "caller"), other = join(root, "other"), workspace = join(root, "workspace");
    const alias = join(root, "caller-alias"), old = process.env.CODEX_HOME;
    try {
      await mkdir(home); await mkdir(other); await mkdir(workspace); await symlink(home, alias);
      process.env.CODEX_HOME = alias;
      await expect(resolveCodexHome(home, workspace)).rejects.toMatchObject({ code: "CODEX_HOME_NOT_ISOLATED" });
      await expect(resolveCodexHome(home, workspace, true)).resolves.toBe(home);
      await expect(resolveCodexHome(alias, workspace, true)).rejects.toMatchObject({ code: "CODEX_HOME_NOT_ISOLATED" });
      await expect(resolveCodexHome(other, workspace, true)).rejects.toMatchObject({ code: "CODEX_HOME_NOT_ISOLATED" });
      await expect(resolveCodexHome(other, workspace)).resolves.toBe(other);
      await expect(resolveCodexHome(workspace, workspace, true)).rejects.toMatchObject({ code: "CODEX_HOME_INVALID" });
      await expect(resolveCodexHome(home, root, true)).rejects.toMatchObject({ code: "CODEX_HOME_INVALID" });
      process.env.CODEX_HOME = join(root, "missing");
      await expect(resolveCodexHome(home, workspace, true)).rejects.toMatchObject({ code: "CODEX_HOME_NOT_ISOLATED" });
    } finally {
      if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("passes only the home path and approved ordinary variables to native", () => {
    const values = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      CODEX_HOME: process.env.CODEX_HOME };
    try {
      process.env.OPENAI_API_KEY = "fixture-api-secret";
      process.env.GITHUB_TOKEN = "fixture-git-secret";
      process.env.CODEX_HOME = "/fixture/caller-home";
      const output = codexEnvironment("/fixture/caller-home");
      expect(output.CODEX_HOME).toBe("/fixture/caller-home");
      expect(output).not.toHaveProperty("OPENAI_API_KEY");
      expect(output).not.toHaveProperty("GITHUB_TOKEN");
      expect(JSON.stringify(output)).not.toContain("fixture-api-secret");
      expect(JSON.stringify(output)).not.toContain("fixture-git-secret");
    } finally {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe("protected native profile correlation", () => {
  it("retains capture before a pre-initialize terminal abort and sends no initialize", async () => {
    const events: string[] = [];
    const terminal = new AbortController();
    const captured = { nativePid: 42 } as Parameters<Parameters<typeof initializeAfterProtectedCapture>[1]>[0];
    await expect(initializeAfterProtectedCapture({ statusFile: "status", nativePath: "/bin/codex", guestStartPermit: true },
      value => { expect(value).toBe(captured); events.push("retain"); },
      async () => { events.push("initialize"); return { userAgent: "fixture" }; }, terminal.signal,
      () => events.push("after-capture"), async () => {
        events.push("capture"); terminal.abort(new Error("fixture TLS refusal")); return captured;
      }, async () => { events.push("permit"); })).rejects.toThrow("fixture TLS refusal");
    expect(events).toEqual(["permit", "capture", "retain", "after-capture"]);
  });
  it("initializes normally after retaining the protected namespace", async () => {
    const events: string[] = [];
    const captured = { nativePid: 42 } as Parameters<Parameters<typeof initializeAfterProtectedCapture>[1]>[0];
    await expect(initializeAfterProtectedCapture({ statusFile: "status", nativePath: "/bin/codex", guestStartPermit: true },
      () => events.push("retain"), async () => { events.push("initialize"); return "ready"; },
      new AbortController().signal, undefined, async () => { events.push("capture"); return captured; },
      async () => { events.push("permit"); }
    )).resolves.toBe("ready");
    expect(events).toEqual(["permit", "capture", "retain", "initialize"]);
  });
  it("captures and initializes a direct protected launch without writing a guest permit", async () => {
    const events: string[] = [];
    const captured = { nativePid: 42 } as Parameters<Parameters<typeof initializeAfterProtectedCapture>[1]>[0];
    await expect(initializeAfterProtectedCapture({ statusFile: "status", nativePath: "/bin/codex", guestStartPermit: false },
      () => events.push("retain"), async () => { events.push("initialize"); return "ready"; },
      new AbortController().signal, undefined, async () => { events.push("capture"); return captured; },
      async () => { events.push("unexpected-permit"); }
    )).resolves.toBe("ready");
    expect(events).toEqual(["capture", "retain", "initialize"]);
  });
  it.each(["initialize", "account/read", "config/read", "permissionProfile/list", "skills/list",
    "thread/start", "mcpServerStatus/list", "turn/start"])(
    "attributes protected native rejection during %s without native text", stage => {
      const diagnostic = { code: "CODEX_NATIVE_REJECTED", message: "native-secret@example.invalid" };
      const projected = protectedNativeRejection(diagnostic, stage, true);
      expect(projected).toEqual({ code: diagnostic.code, message: `Native operation rejected during ${stage}` });
      expect(JSON.stringify(projected)).not.toContain(diagnostic.message);
    });
  it("uses an unknown stage for unrecognized protected rejection and preserves ordinary behavior", () => {
    const diagnostic = { code: "CODEX_NATIVE_REJECTED", message: "native-secret@example.invalid" };
    for (const stage of ["secret-value", "", "initialize/native-secret@example.invalid"]) {
      expect(protectedNativeRejection(diagnostic, stage, true)).toEqual({ code: diagnostic.code,
        message: "Native operation rejected during unknown" });
    }
    expect(protectedNativeRejection(diagnostic, "thread/start", false)).toEqual(diagnostic);
    expect(protectedNativeRejection({ code: "CODEX_AUTH_UNAVAILABLE", message: "fixed" }, "thread/start", true))
      .toEqual({ code: "CODEX_AUTH_UNAVAILABLE", message: "fixed" });
  });
  it("downgrades a completed protected result for a late out-of-guest exposure marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-codex-late-exposure-"));
    try {
      const status = join(root, "status.jsonl");
      const completed = { status: "completed" as const, summary: "done", worker_stop: "confirmed" as const,
        worker_assessment: "met" as const, blockers: [], questions: [], checks: [] };
      expect(failOnProtectedCredentialExposure(completed, status)).toEqual(completed);
      await writeFile(`${status}.exposure`, "seed-output-exposure\n", { mode: 0o600 });
      expect(failOnProtectedCredentialExposure(completed, status)).toMatchObject({ status: "failed",
        worker_stop: "confirmed", error: { code: "CODEX_PROTECTED_SECRET_EXPOSED" } });
      expect(failOnProtectedCredentialExposure({ ...completed, status: "cancelled" }, status).status).toBe("failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a denied synthetic refresh terminal even after native completion", () => {
    const completed = { status: "completed" as const, summary: "done", worker_stop: "confirmed" as const,
      worker_assessment: "met" as const, blockers: [], questions: [], checks: [] };
    const latch = new AbortController();
    expect(failOnProtectedTerminalAuth(completed, latch.signal)).toEqual(completed);
    latch.abort(new Error("synthetic refresh denied"));
    expect(failOnProtectedTerminalAuth(completed, latch.signal)).toMatchObject({ status: "failed",
      worker_stop: "confirmed", error: { code: "CODEX_PROTECTED_REFRESH_DENIED" } });
    const upstream = new AbortController();
    upstream.abort(new Error("CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED"));
    expect(failOnProtectedTerminalAuth(completed, upstream.signal)).toMatchObject({ status: "failed",
      worker_stop: "confirmed", error: { code: "CODEX_PROTECTED_UPSTREAM_UNAUTHORIZED" } });
    const tls = new AbortController();
    tls.abort(new Error("CODEX_PROTECTED_TLS_REFUSED"));
    expect(failOnProtectedTerminalAuth(completed, tls.signal)).toMatchObject({ status: "failed",
      worker_stop: "confirmed", error: { code: "CODEX_PROTECTED_TLS_REFUSED" } });
    expect(failOnProtectedTerminalAuth({ ...completed, status: "failed",
      error: { code: "CODEX_PROTECTED_SECRET_EXPOSED", message: "exposure" } }, upstream.signal)
    ).toMatchObject({ error: { code: "CODEX_PROTECTED_SECRET_EXPOSED" } });
  });
  it("accepts only the synthetic seeded persona during direct qualification", () => {
    const account = { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "passeur-synthetic@example.invalid" } };
    expect(() => assertSyntheticSeedAccount(account)).not.toThrow();
    expect(() => assertSyntheticSeedAccount({ ...account, account: { ...account.account, email: "personal@example.com" } })).toThrow();
    expect(() => assertSyntheticSeedAccount({ ...account, account: { ...account.account, type: "apiKey" } })).toThrow();
  });
  const config = { config: { default_permissions: "passeur-boundary", forced_login_method: "chatgpt",
    mcp_servers: {}, features: { multi_agent: false, apps: false, plugins: false, image_generation: false }, web_search: "disabled",
    model_provider: "openai" } };
  it("requires one exact effective selector and complete allowed profile inventory", () => {
    expect(() => assertProtectedConfiguration(config)).toThrowError(expect.objectContaining({ code: "CODEX_CONFIGURATION_MISMATCH" }));
    expect(() => assertProtectedConfiguration({ config: { ...config.config, sandbox_mode: "workspace-write" } })).toThrow();
    expect(() => assertProtectedConfiguration({ config: { ...config.config, default_permissions: "other" } })).toThrow();
    expect(() => assertProtectedProfile({ data: [{ id: "passeur-boundary", allowed: true }], nextCursor: null })).not.toThrow();
    expect(() => assertProtectedProfile({ data: [{ id: "passeur-boundary", allowed: true },
      { id: "passeur-boundary", allowed: true }], nextCursor: null })).toThrow();
  });
  it("rejects a same-name project override even when the selected profile ID matches", () => {
    const workspace = "/tmp/fixture-work", canonical = "/tmp/fixture-private", admin = `${canonical}/worktrees/task`, native = "/usr/bin/codex";
    const permissions = { "passeur-boundary": { workspace_roots: { [workspace]: true, [canonical]: true },
      filesystem: { ":root": "deny", ":minimal": "read", ":slash_tmp": "deny", ":tmpdir": "deny",
        [native]: "read", [admin]: "write", ":workspace_roots": { ".": "write" } }, network: { enabled: false } } };
    const response = { config: config.config, origins: { default_permissions: { name: { type: "sessionFlags" }, version: "1" } },
      layers: [{ name: { type: "sessionFlags" }, version: "1", config: { default_permissions: "passeur-boundary",
        features: { image_generation: false } } },
        { name: { type: "system", file: "/etc/codex/config.toml" }, version: "1", config: {} },
        { name: { type: "user", file: "/mounts/home/config.toml", profile: null }, version: "1", config: { permissions } }] };
    const scope = { workspace, canonical, admin, native };
    expect(() => assertProtectedConfiguration(response, "passeur-boundary", true, scope)).not.toThrow();
    const realPermissions = { "passeur-boundary": { ...permissions["passeur-boundary"],
      filesystem: { ...permissions["passeur-boundary"].filesystem,
        "/usr/bin/codex-code-mode-host": "read" }, network: { enabled: true } } };
    const realSettings = { cli_auth_credentials_store: "file",
      skills: { include_instructions: false, bundled: { enabled: false } },
      memories: { use_memories: false, generate_memories: false } };
    const effectivePermissions = { "passeur-boundary": { ...realPermissions["passeur-boundary"],
      description: null, extends: null,
      filesystem: { ...realPermissions["passeur-boundary"].filesystem, glob_scan_max_depth: null },
      network: { enabled: true, proxy_url: null, enable_socks5: null, socks_url: null,
        enable_socks5_udp: null, allow_upstream_proxy: null,
        dangerously_allow_non_loopback_proxy: null, dangerously_allow_all_unix_sockets: null,
        mode: null, domains: null, unix_sockets: null, allow_local_binding: null, mitm: null } } };
    const effectiveMemories = { ...realSettings.memories, version: null, dual_write: null,
      disable_on_external_context: null, dedicated_tools: null,
      max_raw_memories_for_consolidation: null, max_unused_days: null, max_rollout_age_days: null,
      max_rollouts_per_startup: null, min_rollout_idle_hours: null,
      min_rate_limit_remaining_percent: null, extract_model: null, consolidation_model: null };
    const real = { ...response, config: { ...response.config, permissions: effectivePermissions,
      ...realSettings, memories: effectiveMemories, chatgpt_base_url: "https://chatgpt.com/backend-api/" },
      layers: response.layers.map(layer => layer.name.type === "sessionFlags" ? {
        ...layer, config: { default_permissions: "passeur-boundary", model_provider: "openai",
          forced_login_method: "chatgpt", mcp_servers: {},
          features: { multi_agent: false, apps: false, plugins: false, image_generation: false },
          web_search: "disabled" } } : layer.name.type === "user" ?
        { ...layer, config: { permissions: realPermissions, ...realSettings } } : layer) };
    expect(() => assertProtectedConfiguration(real, "passeur-boundary", false, scope)).not.toThrow();
    const { "/usr/bin/codex-code-mode-host": _companion, ...withoutCompanion } =
      realPermissions["passeur-boundary"].filesystem;
    expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config,
      permissions: { "passeur-boundary": { ...effectivePermissions["passeur-boundary"],
        filesystem: { ...withoutCompanion, glob_scan_max_depth: null } } } } },
    "passeur-boundary", false, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config, permissions: realPermissions } },
      "passeur-boundary", false, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config, memories: realSettings.memories } },
      "passeur-boundary", false, scope)).toThrow();
    for (const changed of [
      { cli_auth_credentials_store: "auto" },
      { skills: { include_instructions: true, bundled: { enabled: false } } },
      { memories: { ...effectiveMemories, use_memories: true } },
      { instructions: "private instruction" },
      { developer_instructions: "private instruction" },
      { model_instructions_file: "/home/private" },
    ]) expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config, ...changed } },
      "passeur-boundary", false, scope)).toThrowError(expect.objectContaining({ code: "CODEX_CONFIGURATION_MISMATCH" }));
    expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config, permissions: {
      "passeur-boundary": { ...effectivePermissions["passeur-boundary"], network: {
        ...effectivePermissions["passeur-boundary"].network, enabled: false } } } } },
    "passeur-boundary", false, scope)).toThrow();
    for (const changed of [
      { description: "unsafe" }, { extends: "permissive" }, { extra: "unknown" },
      { filesystem: { ...effectivePermissions["passeur-boundary"].filesystem, glob_scan_max_depth: 3 } },
      { network: { ...effectivePermissions["passeur-boundary"].network, proxy_url: "http://proxy.invalid" } },
      { network: { ...effectivePermissions["passeur-boundary"].network, unexpected: true } },
    ]) expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config, permissions: {
      "passeur-boundary": { ...effectivePermissions["passeur-boundary"], ...changed } } } },
    "passeur-boundary", false, scope)).toThrow();
    for (const changed of [{ dual_write: true }, { unrecognized: null }]) {
      expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config,
        memories: { ...effectiveMemories, ...changed } } }, "passeur-boundary", false, scope)).toThrow();
    }
    for (const url of [null, "https://chatgpt.com/backend-api/codex", "https://other.invalid/"]) {
      expect(() => assertProtectedConfiguration({ ...real, config: { ...real.config,
        chatgpt_base_url: url } }, "passeur-boundary", false, scope)).toThrow();
    }
    expect(() => assertProtectedConfiguration({ ...real, layers: [...real.layers,
      { name: { type: "project", dotCodexFolder: `${workspace}/.codex` }, config: {} }] },
    "passeur-boundary", false, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...response,
      config: { ...response.config, features: { ...response.config.features, image_generation: true } } },
    "passeur-boundary", true, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...response, layers: response.layers.map(layer =>
      layer.name.type === "sessionFlags" ? { ...layer, config: { ...layer.config,
        features: { image_generation: true } } } : layer) }, "passeur-boundary", true, scope)).toThrow();
    const seeded = { ...scope, seededPort: 39173, provider: "passeur_fixture_loopback" };
    const accountConfig = { chatgpt_base_url: "http://127.0.0.1:39173", model_providers: {
      passeur_fixture_loopback: { requires_openai_auth: true, base_url: "http://127.0.0.1:39173/v1" } } };
    const seededResponse = { ...response, config: { ...response.config, ...accountConfig },
      layers: response.layers.map(layer => layer.name.type === "user" ?
        { ...layer, config: { ...layer.config, ...accountConfig } } : layer) };
    expect(() => assertProtectedConfiguration(seededResponse, "passeur-boundary", true, seeded)).not.toThrow();
    const tlsPolicy = { ...scope, provider: "passeur_fixture_tls",
      tls: { accountHost: "accounts.fixture.invalid", inferenceHost: "inference.fixture.invalid" } };
    const tlsConfig = { chatgpt_base_url: "https://accounts.fixture.invalid", analytics: { enabled: false }, model_providers: {
      passeur_fixture_tls: { requires_openai_auth: true, base_url: "https://inference.fixture.invalid/v1" } } };
    const tlsResponse = { ...response, config: { ...response.config, ...tlsConfig },
      layers: response.layers.map(layer => layer.name.type === "user" ?
        { ...layer, config: { ...layer.config, ...tlsConfig } } : layer) };
    expect(() => assertProtectedConfiguration(tlsResponse, "passeur-boundary", true, tlsPolicy)).not.toThrow();
    expect(() => assertProtectedConfiguration({ ...tlsResponse,
      config: { ...tlsResponse.config, analytics: { enabled: true } } },
    "passeur-boundary", true, tlsPolicy)).toThrow();
    expect(() => assertProtectedConfiguration({ ...tlsResponse,
      layers: tlsResponse.layers.map(layer => layer.name.type === "user" ?
        { ...layer, config: { ...layer.config, analytics: { enabled: true } } } : layer) },
    "passeur-boundary", true, tlsPolicy)).toThrow();
    expect(() => assertProtectedConfiguration({ ...tlsResponse,
      config: { ...tlsResponse.config, chatgpt_base_url: "https://wrong.fixture.invalid" } },
    "passeur-boundary", true, tlsPolicy)).toThrow();
    expect(() => assertProtectedConfiguration({ ...seededResponse,
      config: { ...seededResponse.config, chatgpt_base_url: "https://example.invalid" } },
    "passeur-boundary", true, seeded)).toThrow();
    expect(() => assertProtectedConfiguration({ ...response, layers: response.layers.map(layer =>
      layer.name.type === "system" ? { ...layer, config: { permissions: { "passeur-boundary": { network: { enabled: true } } } } } : layer) },
    "passeur-boundary", true, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...response, layers: [...response.layers,
      { name: { type: "project", dotCodexFolder: `${workspace}/.codex` }, version: "1",
        config: { permissions: { "passeur-boundary": { network: { enabled: true } } } } }] },
    "passeur-boundary", true, scope)).toThrow();
    expect(() => assertProtectedConfiguration({ ...response, layers: [response.layers[0], response.layers[1],
      { ...response.layers[2], config: { permissions: { "passeur-boundary": { ...permissions["passeur-boundary"], network: { enabled: true } } } } }] },
    "passeur-boundary", true, scope)).toThrow();
  });
  it("requires the exact selected native thread profile, provider and model", () => {
    const response = { thread: { id: "native-thread" }, cwd: "/tmp/work", model: "candidate", modelProvider: "openai",
      activePermissionProfile: { id: "passeur-boundary" } };
    expect(protectedThreadStarted(response, "/tmp/work", "candidate")).toMatchObject({ threadId: "native-thread" });
    expect(() => protectedThreadStarted({ ...response, activePermissionProfile: { id: "other" } }, "/tmp/work", "candidate")).toThrow();
    expect(() => protectedThreadStarted({ ...response, modelProvider: "fallback" }, "/tmp/work", "candidate")).toThrow();
  });
  it("requires an empty exact native skill inventory for the task cwd", () => {
    const accepted = { data: [{ cwd: "/tmp/work", skills: [], errors: [] }] };
    expect(() => assertEmptySkills(accepted, "/tmp/work")).not.toThrow();
    for (const bad of [{ data: [] }, { data: [accepted.data[0], accepted.data[0]] },
      { data: [{ ...accepted.data[0], cwd: "/tmp/other" }] },
      { data: [{ ...accepted.data[0], skills: [{ name: "private-skill" }] }] },
      { data: [{ ...accepted.data[0], errors: [{ path: "/home/private", message: "secret" }] }] }]) {
      expect(() => assertEmptySkills(bad, "/tmp/work")).toThrowError(expect.objectContaining({ code: "CODEX_ISOLATION_UNAVAILABLE" }));
    }
  });
  it("retains only a version-matched item type name for rejected native items", () => {
    expect(protectedItemType("userMessage")).toBe("userMessage");
    expect(protectedItemType("mcpToolCall")).toBe("mcpToolCall");
    expect(protectedItemType("auth-canary-secret")).toBe("unknown");
    expect(protectedItemType({ type: "userMessage", text: "auth-canary-secret" })).toBe("unknown");
  });
  it("correlates one input echo start and completion without consuming its content", () => {
    const state: { id?: string; completed?: boolean } = {};
    const event = { threadId: "thread-1", turnId: "turn-1", item: { type: "userMessage", id: "echo-1", content: [{ text: "private canary" }] } };
    expect(protectedUserEcho(event, "thread-1", "turn-1", "item/started", state)).toBe("echo-1");
    expect(state).toEqual({ id: "echo-1" });
    expect(() => protectedUserEcho(event, "thread-1", "turn-1", "item/started", state)).toThrow();
    expect(() => protectedUserEcho({ ...event, turnId: "other" }, "thread-1", "turn-1", "item/completed", state)).toThrow();
    expect(() => protectedUserEcho({ ...event, item: { ...event.item, id: "echo-2" } }, "thread-1", "turn-1", "item/completed", state)).toThrow();
    expect(protectedUserEcho(event, "thread-1", "turn-1", "item/completed", state, true)).toBe("echo-1");
    expect(state).toEqual({ id: "echo-1", completed: true });
    expect(() => protectedUserEcho(event, "thread-1", "turn-1", "item/completed", state)).toThrow();
    expect(() => protectedUserEcho(event, "thread-1", "turn-1", "item/started", {}, true)).toThrow();
    expect(() => protectedUserEcho(event, "thread-1", "turn-1", "item/completed", {})).toThrow();
  });
});

describe.runIf(process.platform === "linux")("Codex adapter through an actual controlled stdio process", () => {
  async function scenario(name: string, action: (adapter: CodexAdapter, run: WorkerInput, home: string, control: AbortController) => Promise<void>, escalate = false) {
    const temporary = await mkdtemp(join(tmpdir(), "passeur-codex-contract-"));
    const home = join(temporary, "worker-home"), workspace = join(temporary, "repo"), bin = join(temporary, "app-server.mjs");
    const control = new AbortController();
    try {
      await mkdir(home); await mkdir(workspace); await writeFile(join(home, "fixture-scenario"), name);
      await copyFile(fileURLToPath(new URL("../fixtures/codex/agent-server.mjs", import.meta.url)), bin); await chmod(bin, 0o700);
      await action(new CodexAdapter({ ...options, codex_bin: bin, codex_home: home, allow_command_escalation: escalate }),
        { ...input, workspace, signal: control.signal }, home, control);
    } finally { control.abort(); await rm(temporary, { recursive: true, force: true }); }
  }
  it("blocks the caller home by default and runs with an exact opt-in", async () => {
    await scenario("success", async (_adapter, run, home) => {
      const previous = process.env.CODEX_HOME;
      try {
        process.env.CODEX_HOME = home;
        const defaultRun = await new CodexAdapter({ ...options, codex_home: home }).run(run);
        expect(defaultRun).toMatchObject({ status: "blocked", worker_stop: "not_started",
          error: { code: "CODEX_HOME_NOT_ISOLATED" } });
        expect(await new CodexAdapter({ ...options, codex_bin: join(home, "..", "app-server.mjs"),
          codex_home: home, use_caller_codex_home: true }).run(run)).toMatchObject({
            status: "completed", worker_stop: "confirmed", reported_model: "fixture-model" });
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      }
    });
  });
  it("does not start a real protected worker with a different executable hash", async () => {
    await scenario("success", async (_adapter, run, home) => {
      const previous = process.env.CODEX_HOME;
      try {
        process.env.CODEX_HOME = home;
        const result = await new CodexAdapter({ ...options, codex_bin: join(home, "fixture-scenario"),
          codex_home: home, use_caller_codex_home: true, experimental_real_protected: true }).run({
          ...run, private_git: { schema_version: 1, mount_kind: "canonical_common_dir",
            view: { private_common_dir: "/tmp/unused-private", canonical_common_dir: "/tmp/unused-canonical",
              admin_relative: "worktrees/task", baseline_index_sha256: "0".repeat(64) } },
        });
        expect(result).toMatchObject({ status: "failed", worker_stop: "not_started",
          error: { code: "CODEX_NATIVE_UNSUPPORTED" } });
      } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
    });
  });
  it("refuses configured real protected startup without a private Git view", async () => {
    await scenario("success", async (_adapter, run, home) => {
      const result = await new CodexAdapter({ ...options, codex_bin: join(home, "..", "app-server.mjs"),
        codex_home: home, use_caller_codex_home: true, experimental_real_protected: true }).run(run);
      expect(result).toMatchObject({ status: "failed", worker_stop: "not_started",
        error: { code: "CODEX_PRIVATE_GIT_REQUIRED" } });
    });
  });
  for (const [name, expected, code] of [
    ["mcp-success", "completed", undefined],
    ["mcp-invalid-status", "failed", "CODEX_PROTOCOL_INVALID"],
    ["mcp-wrong-turn", "failed", "CODEX_CORRELATION_INVALID"],
  ] as const) it(`${name} keeps native MCP lifecycle correlated through turn settlement`, async () => {
    await scenario(name, async (_adapter, run, home) => {
      const previous = process.env.CODEX_HOME;
      try {
        process.env.CODEX_HOME = home;
        const configured = { ...options, codex_bin: join(home, "..", "app-server.mjs"), codex_home: home };
        expect(await new CodexAdapter(configured).run(run)).toMatchObject({
          status: "blocked", worker_stop: "not_started", error: { code: "CODEX_HOME_NOT_ISOLATED" } });
        const result = await new CodexAdapter({ ...configured, use_caller_codex_home: true }).run(run);
        expect(result).toMatchObject({ status: expected, worker_stop: "confirmed",
          ...(code ? { error: { code } } : { worker_assessment: "met" }) });
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      }
    });
  });
  it("preserves outgoing native spelling and correlates early events through completion", async () => {
    await scenario("success", async (adapter, run) => {
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed", reported_model: "fixture-model", worker_assessment: "met" });
    });
  });
  for (const [name, status, code] of [
    ["api-key", "blocked", "CODEX_AUTH_UNAVAILABLE"],
    ["recursive", "blocked", "CODEX_ISOLATION_UNAVAILABLE"], ["wrong-model", "blocked", "CODEX_CONFIGURATION_MISMATCH"],
  ] as const) it(`${name} preserves a distinct failure without provider fallback`, async () => {
    await scenario(name, async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status, worker_stop: "confirmed", error: { code } }));
  });
  for (const name of ["bad-report", "question"]) it(`${name} waits for explicit input and continues the same native session`, async () => {
    await scenario(name, async (adapter, run, home) => {
      let asked = 0, release!: (value: string) => void, observe!: () => void;
      const answer = new Promise<string>(resolve => { release = resolve; });
      const requested = new Promise<void>(resolve => { observe = resolve; });
      run.input = async (question, attention) => {
        asked++; expect(question.length).toBeGreaterThan(0); expect(attention ?? false).toBe(name === "bad-report");
        if (name === "bad-report") expect(question).toContain("(marker_missing)");
        observe(); return answer;
      };
      const execution = adapter.run(run);
      try {
        await Promise.race([requested, execution.then(() => { throw new Error("Adapter settled before explicit input"); })]);
        expect(await readFile(join(home, "fixture-turns"), "utf8")).toBe("1");
      } finally { release("Continue using JSON"); }
      expect(await execution).toMatchObject({ status: "completed", worker_stop: "confirmed" });
      expect(asked).toBe(1); expect(await readFile(join(home, "fixture-turns"), "utf8")).toBe("2");
    });
  });
  it("does not close a successful turn before known background work settles", async () => {
    await scenario("pending-item",async(adapter,run,home)=>{
      expect(await adapter.run(run)).toMatchObject({status:"completed",worker_stop:"confirmed"});
      expect(await readFile(join(home,"background-settled"),"utf8")).toBe("yes");
    });
  });
  it("native failure cannot be converted to success by the agent report", async () => {
    await scenario("native-failure", async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status: "failed", worker_stop: "confirmed" }));
  });
  it("default policy denies command escalation without asking the worker or human", async () => {
    await scenario("approval", async (adapter, run, home) => {
      run.approve = async () => { throw new Error("No escalation permission was configured"); };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_assessment: "unmet", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("decline");
    });
  });
  it("an explicitly enabled command escalation still requires this exact human decision", async () => {
    await scenario("approval", async (adapter, run, home) => {
      run.approve = async (request) => {
        expect(request.id).toBe("codex:string:approval-fixture"); expect(request.workspace).toBe(run.workspace);
        expect(request.choices.map((choice) => choice.scope)).toEqual(["once", "once"]); return { choice_id: "accept" };
      };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("accept");
    }, true);
  });
  it("an offered execpolicy amendment stays optional and grants only the current command", async () => {
    await scenario("amendment", async (adapter, run, home) => {
      run.approve = async (request) => {
        expect(request.choices.map((choice) => choice.scope)).toEqual(["once", "once"]);
        return { choice_id: "accept" };
      };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("accept");
    }, true);
  });
  it("the reserved local execution environment still requires one exact human approval", async () => {
    await scenario("local-environment", async (adapter, run, home) => {
      run.approve = async (request) => {
        expect(request.workspace).toBe(run.workspace);
        expect(request.choices.map((choice) => choice.scope)).toEqual(["once", "once"]);
        return { choice_id: "accept" };
      };
      expect(await adapter.run(run)).toMatchObject({ status: "completed", worker_stop: "confirmed" });
      expect(await readFile(join(home, "fixture-decision"), "utf8")).toBe("accept");
    }, true);
  });
  it("network policy proposals remain unsupported", async () => {
    await scenario("network-amendment", async (adapter, run) => expect(await adapter.run(run)).toMatchObject({ status: "failed", error: { code: "CODEX_APPROVAL_UNSUPPORTED" } }), true);
  });
  it("owner cancellation interrupts the turn and observes the actual peer close", async () => {
    await scenario("cancel", async (adapter, run, _home, controller) => {
      run.onEvent = async () => { controller.abort(new Error("Owner cancelled the fixture")); };
      expect(await adapter.run(run)).toMatchObject({ status: "cancelled", worker_stop: "confirmed" });
    });
  });
});
