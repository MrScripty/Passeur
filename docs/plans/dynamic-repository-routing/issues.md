# Dynamic repository routing issues

| ID | Finding | Owner | Disposition |
| --- | --- | --- | --- |
| DR-I01 | Full dependency-backed verification cannot run in the current execution environment: shell network is unavailable, the dependency cache is absent, and no repository Actions run is available. | V1 verification environment | Block acceptance; run the exact locked checks on the branch. Do not infer pass/fail. |
| DR-I02 | A global registration cannot encode arbitrary repository-specific custom profile paths without creating a new repository→profile authority. | CLI/registration composition | Preserve explicit `--profile` or `--expected-repository-id` as an intentionally pinned registration. No registry added. |
| DR-I03 | Dynamic routing could bypass single-state-root safety if dynamic and pinned registrations used different namespaces. | Codex registration config | Repaired with structural Passeur-binding classification and symmetric state conflict checks; focused tests added. |
| DR-I04 | Existing default profile files used path-derived legacy IDs and could disappear from lookup after switching to repository IDs. | Repository binding | Repaired with canonical main-worktree legacy fallback and repository-ID precedence; integration test added. |
| DR-I05 | Actual Codex host routing depends on the host supplying its project cwd when stdio server cwd is absent. | V1 real-host verification | Current Codex source supports the required fallback; real installed-host behavior remains DR-A6 and blocks acceptance. |
