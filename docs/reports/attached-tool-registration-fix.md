# Attached-tool registration correction: implementation and evidence

Date: September 20, 2026. Subject: a source patch against Passeur `68c3e455ec35061c04b13a27d1ca9e438ec81f95` (`feat: add registered agent adapters`). Standards authority: MrScripty/Coding-Standards `366c1d90a24bbfb50973f62b155a5f3396c0f107`. Incident: Pumas-Library `d436ee6d09b07eafd2fe6ec259c4e3d9a648dbf5`, TIPC-I10.

Status: source correction implemented; focused evidence passed; dependency-backed registration and actual-host acceptance pending. This does not mark either parent implementation plan Accepted or resolve the operational Pumas blocker.

## Findings and owned correction

The incident records old mutable `dist/` commands, four-tool allowlists, live host children and unavailable model tools. Source had already acquired discoverable startup. Deployment drift is recorded evidence; attributing the missing catalog specifically to optional startup grace remains an untested host-side hypothesis. The fixed source cannot replace a running process or edit the user's installed configuration by itself.

Passeur's existing registration contract did not represent `required`. Its renderer omitted the field, its updater could erase a manually set policy, and its inspector could not report the distinction. The current official Codex MCP reference describes a 1000 ms optional-server initial catalog grace and per-server required startup. Current upstream `codex mcp get --json` omits the required field, so requiring that field in every response would create another compatibility failure.

This correction adds explicit `--required`/`--optional` CLI choices. No choice means preserve the existing boolean; a new entry remains optional. The existing registration writer resolves the choice while holding its configuration-writer lease, writes it using the existing TOML serializer, preserves operator approval/denial settings, and verifies that the written bytes remained unchanged through inspection. A contradictory reported value fails; an omitted field is `not_reported`. Output keeps actual host attachment `not_run`.

The small `src/codex/startup-policy.ts` module belongs to the existing caller-registration concern. It shares only flag selection, prior-value validation and inspection evidence semantics. Keeping this dependency-free policy out of the TOML/SDK module preserves CLI bootstrap independence. Removing it would either duplicate that policy or introduce third-party runtime dependencies into currently independent help/argument paths. No scheduler, agent, repository, lease, task, resource or approval authority moves.

Existing startup and installed-acceptance documentation is updated, with a linked host repair procedure and usage-skill guidance. It explicitly permits offline build/install/registration work before missing tools are restored, while retaining operator authority, safe owner handover and separate host evidence.

## Exact write set

Production: `src/codex/config.ts`, `src/codex/startup-policy.ts` (new), `src/cli.ts`.

Verification: `tsconfig.native.json`, `tests/native/codex-startup-policy.test.mjs` (new), `tests/unit/codex-config.test.ts`, `tests/integration/cli-startup-policy.test.ts` (new).

Documentation: `docs/startup-and-installation.md`, `docs/installed-acceptance.md`, `docs/compatibility.md`, `.agents/skills/passeur-bridge/references/setup.md`, `docs/troubleshooting/attached-tools.md` (new), and this report.

No dependency/lockfile changes, data migration, model inference, remote commit/push, personal-configuration write, process termination on the user's machine, or Pumas/Tuldok edit was performed. Existing protocol/result/profile versions are unchanged. The operator-facing registration result adds startup-policy evidence without relabeling existing transport checks as host acceptance.

## Executed evidence

The container had Node 22.16.0, Git 2.47.3 and TypeScript 5.8.3. The selected native compilation used the installed Node declarations 25.1.0. These are not the repository's pinned TypeScript 5.9.3 / Node declarations 24.7.2 combination.

| Check | Outcome and proof boundary |
| --- | --- |
| Baseline identity | All eight existing files in the write set matched GitHub blob hashes at the subject revision before editing. New files are explicitly additions. Available source was reconstructed from the supplied archives; this is not a claim of a complete cloned checkout. |
| Selected native TypeScript compilation | Passed with `tsc -p tsconfig.native.json --typeRoots <installed-ts-node>/node_modules/@types --noEmitOnError`. Actual native modules compiled; no substitute dependency modules were injected. |
| Native suite | 28 tests passed: 13 new startup-policy tests and 15 existing native protocol/process tests. These establish their own deterministic/process contracts, not Codex's tool-catalog behavior. |
| CLI help/argument paths | Four cases passed against the actual modified CLI after syntax transpilation: documented flags, mutually exclusive choices, rejection on `serve`, and rejection of policy flags on `configure` without registration. This is runtime argument-path evidence, not complete application typechecking. |
| Changed TypeScript syntax | Checked with the available TypeScript transpiler; no syntax diagnostics. Does not establish dependency or SDK type compatibility. |
| Patch application | Unified patch checked/applied in a disposable copy of the verified write-set baseline; resulting file bytes checked against the payload. See packaged application result. This is not full application acceptance. |

The native TAP log and CLI observations are included under the ZIP's `verification/` directory.

## Added evidence requiring the pinned environment

Eight additional Vitest registration scenarios cover selected-server/global policy preservation, re-registration and explicit reversal, legacy adoption, malformed values, actual inspector projections, durable evidence reporting, successful-inspector/concurrent-edit conflict, and per-server approval/denial preservation. The repository-native CLI integration test contains the four CLI scenarios above against the normally built `dist/` artifact. These dependency-backed test files have not run here.

The container could not resolve registry.npmjs.org and did not have the pinned TOML, Zod, MCP and Vitest packages. Consequently, full `npm ci`, `npm run check`, `npm test`, and installed-artifact acceptance were not completed. Do not replace those gates with the native subset or the transpiler observations.

Required next checks in the complete authorized checkout:

```sh
npm ci
npm run check
npm test
npm run build:runtime -- --source "$PWD" --output "$PWD/.passeur-build"
```

Review/commit the material patch before a clean production runtime build. Use the installed artifact and [host repair procedure](../troubleshooting/attached-tools.md). Successful status calls through the actual host for both `passeur_pumas` and `passeur_tuldok`, matching the new build and recorded project bindings, are the decisive attachment evidence. A current provider/inference failure or another plan prerequisite remains a separate blocker. Independent review and full registered-agent acceptance are still required by their owning plans.

## Sources and uncertainty

- [Pumas incident commit](https://github.com/MrScripty/Pumas-Library/commit/d436ee6d09b07eafd2fe6ec259c4e3d9a648dbf5).
- [Passeur registration baseline](https://github.com/MrScripty/Passeur/blob/68c3e455ec35061c04b13a27d1ca9e438ec81f95/src/codex/config.ts).
- [Codex MCP reference](https://developers.openai.com/codex/mcp/) and [configuration reference](https://developers.openai.com/codex/config-reference/), checked September 20, 2026. Their current documentation redirects to ChatGPT Learn.
- [Codex get-json source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs), observed blob `7c01fb96cbca0cc2980138b3657f0d2cc4234f5a`. The installed CLI version must be observed separately; repository `main` is not a statement about the user's binary.

A required server can still fail to initialize, have filtered tools, or encounter another host-environment problem. This patch makes a selected registration policy expressible, preserved and observable. It does not make successful model-tool exposure a consequence of writing one field.
