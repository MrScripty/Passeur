# Running Passeur process, missing callable tools

## Recorded incident and evidence boundary

Pumas-Library commit [`d436ee6d09b07eafd2fe6ec259c4e3d9a648dbf5`](https://github.com/MrScripty/Pumas-Library/commit/d436ee6d09b07eafd2fe6ec259c4e3d9a648dbf5) records TIPC-I10: `passeur_pumas` and `passeur_tuldok` processes existed, but their task tools were absent from the model's callable inventory. Their registrations still selected old mutable `dist/` output with four-tool allowlists; source had advanced to `49724a8`. The old CLI did not implement the new version/status surface. A duplicate Pumas process failed on repository-lease contention. The recorded user session was not inspected again by this source patch.

A process or held lease proves neither successful MCP initialization/listing nor host-to-model catalog delivery. In the old executable, acquiring the lease happened before the MCP transport was ready. The current source exposes discovery before preparation. These facts make stale deployment independently actionable; they do not prove which host-side step omitted the tools.

The [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp/) describes an optional-server initial catalog grace (default 1000 ms), distinct from `startup_timeout_sec`. Required servers use their startup timeouts; failed required initialization blocks host startup/resume. This is a plausible explanation for the recorded pattern, not a reproduced diagnosis of that machine. Repair the stale deployment and test the narrowly selected per-server policy rather than declaring the hypothesis proven.

## Operator-authorized repair

This procedure needs ordinary terminal access, not the absent Passeur tools. Obtain authority for dependency provisioning, installation and the two named configuration edits. This procedure does not authorize inference, permission broadening, lock removal or killing processes. Do not modify Pumas/Tuldok product files to work around the tooling failure.

### 1. Capture the actual configured bindings

From the respective project contexts, retain redacted output of:

```sh
codex --version
codex mcp get passeur_pumas --json
codex mcp get passeur_tuldok --json
```

Read the selected configuration file and any applicable project/managed overrides. Record each entry's exact Node command, CLI path, arguments, working directory, profile, state root, tool filters and server name. Inspect the actual executable's `--version` through the same Node binary. An old usage banner is not a build-identity record. Omission of `required` from `mcp get` does not establish that the configured value is false: the current upstream [get-json implementation](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs) does not emit that field.

Keep live-owner observations separate from catalog observations. Do not clear the lock or start a competing coordinator to acquire it. The old-runtime duplicate-probe failure is contention, not proof of an orphan lock.

### 2. Build and install the reviewed source offline

Apply/review this correction in Passeur's complete checkout, preserve unrelated work, run the selected tests, and commit through its normal workflow. In the authorized dependency environment:

```sh
npm ci
npm run check
npm test
npm run build:runtime -- --source "$PWD" --output "$PWD/.passeur-build"
```

Select the exact candidate path returned by the build. Use the [installation procedure](../startup-and-installation.md) to install that candidate into the existing approved runtime root. Normal candidates require clean Git inputs. Do not treat `--allow-dirty` or a development registration as production acceptance. A source pull/rebuild neither replaces an installed artifact nor upgrades a running process.

### 3. Hand over normally and update the existing names

After checking that no product task is active, exit the affected Codex host through its normal lifecycle and confirm its known Passeur owners drained. Leave unknown processes and resources untouched. Do this before readiness probes or resuming product execution. Registration itself need not take the repository lease.

Invoke the newly installed CLI, preserving each original project/profile/state binding. Replace the variables below with the recorded absolute paths; keep each project's recorded state root, even when the two roots happen to be equal:

```sh
node "$INSTALLED_RUNTIME/dist/src/cli.js" register-codex \
  --project "$PUMAS_PROJECT" --profile "$PUMAS_PROFILE" \
  --state-root "$PUMAS_STATE_ROOT" --server-name passeur_pumas --required

node "$INSTALLED_RUNTIME/dist/src/cli.js" register-codex \
  --project "$TULDOK_PROJECT" --profile "$TULDOK_PROFILE" \
  --state-root "$TULDOK_STATE_ROOT" --server-name passeur_tuldok --required
```

Use the correct Node binary and `--config-path`/CODEX_HOME when applicable. Existing unmanaged entries or legacy incomplete bindings may require `--adopt-unmanaged` and the exact reviewed `--replace-binding` fingerprint. The helper reports those conditions; do not invent a fingerprint, create duplicate server names, or choose another state namespace. Adoption can reformat TOML and remove comments; retain its backup.

The current allowlist contains seven neutral tools and four legacy Muse tools. Re-registration refreshes that list without removing explicit approval/denial policy. An intentional deny conflicting with the requested catalog must be resolved explicitly; this correction does not silently remove it.

The effective narrow TOML change is `required = true` inside each EXISTING named server table. It does not change global `mcp_optional_startup_grace_ms`. Required startup is a conscious reliability tradeoff: if a required server cannot initialize, Codex will not proceed normally. Use `--optional` to reverse that choice when appropriate; omission on later registration preserves it.

Capture `startup_policy.required`, the written file, configuration/transport results and exact build ID. `inspection.status: not_reported` is an honest limit when Codex omits the field; the complete installed-host claim remains unverified. The direct probe is non-inference diagnostics only. It cannot attach tools to an existing model turn and must not be used for task delegation outside the host's approval path.

### 4. Verify a fresh actual host

Start a genuinely fresh Codex host/session after registration. Confirm both named connections and use the host's normal discovery mechanism to locate their tools if it exposes tools lazily. Actually invoke `passeur_status` from each named connection through the host; retain the returned build/binding IDs and ensure they match the newly installed artifact and intended projects. A connected-server display or standalone `listTools` alone is insufficient.

With explicit preparation authority, invoke `passeur_prepare` for each project and record ready/held authority or the real typed failure. No model inference is needed for the attachment/readiness gate. Preserve any remaining provider qualification requirements before fresh product task keys.

If callable tools are still absent, retain the exact Codex version, resolved settings, fresh-host startup errors/logs, direct catalog result and actual host callable-tool evidence. Classify the remaining failure as unresolved host catalog delivery, schema conversion, filtering or environment behavior according to observed evidence. Do not keep repeating session restarts without changed evidence, assume that `required` universally guarantees model exposure, disable approvals, or delete locks.

### 5. Close only the claim actually demonstrated

The Pumas plan owner can resolve TIPC-I10 only after the actual host calls work for BOTH recorded servers and the correct runtime/binding is confirmed. Link the receipt and restore the governed plan lifecycle explicitly before dispatch. If preparation, runtime compatibility or another plan prerequisite remains blocked, retain that separate blocker. Do not claim live Muse/Codex worker, billing, signing, native-sandbox or full registered-agent acceptance from this diagnostic procedure.
