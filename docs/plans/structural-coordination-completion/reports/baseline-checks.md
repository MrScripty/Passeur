# R0-S1 baseline checks — September 22, 2026

Subject: `2de20c756a375c726311767cd78b968c1161fdad`, with no tracked source edits before the checks. This record is a new execution of the current checkout, separate from F9's historical integration report.

| Command / path | Observed result | Claim limit |
|---|---|---|
| `npm run check` | Exit 0, pinned TypeScript 5.9.3 project check | Current pre-feature source only |
| `npm test` in default sandbox | Exit 1 during core tests: 18 file-level passes, 14 file-level failures; direct failing-file run showed `listen EPERM` on Unix sockets under `/tmp` before assertions | Sandbox cannot run the service/socket tests; not a product verdict |
| `npm test` with approved socket-capable execution | Exit 0: 475 core, 40 native, 100 configured frontend/integration tests; build and core/native compilers ran as part of the script | F9 baseline only; no new native structural parser, installed report or SC01–SC17 objective acceptance |
| `git diff --check` | Exit 0 before documentation edits | Formatting only |
| `npm ls --depth=0 --offline` | Exit 0; direct package pins resolved | Does not prove parser package availability |

No tests were weakened, skipped or replaced with sparse-mirror results. The initial failed invocation is retained as evidence of the sandbox boundary. The successful full run used the same repository and package closure with local socket permission; no dependency installation was performed.
