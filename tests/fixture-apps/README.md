# Autonomous peer-overlap fixture applications

This directory contains the small, offline fixture applications used by the
autonomous peer-overlap qualification. `manifest.json` is an integrator-owned
baseline: every file in each fixture root is listed with its SHA-256 digest,
builds and runs use bounded argv arrays, and qualification copies the fixture
before producing build outputs.

Run the qualifier from the repository root:

```text
node scripts/qualify-fixture-apps.mjs
```

The qualifier admits only local toolchains, sets offline environment guards,
runs each command inside bubblewrap with network namespaces and PID/IPC
namespaces disabled from the host, a private temporary root with selected
read-only runtime mounts plus copy-local writes, keeps Node and .NET state in
its temporary copy, and verifies that both the fixture and independent oracle
trees are unchanged. A row is `passed` only
when its build and all three independently-authored functional cases match
exact stdout, stderr, and exit status. A missing executable is `blocked`.
Rows whose dependency probe returns their manifest-declared
`blocked_exit_code` are also `blocked`; that declaration is build-only and
bounded to one exact nonzero exit code.

Current local evidence is expected to pass L01–L04 and L08–L10. L05–L07 and
L11 require Lua, Kotlin, Zig, and Odin toolchains that are not installed in
the qualification environment. L12 and L13 require their declared Svelte or
React packages; their offline dependency probes therefore record blocked
evidence without installing packages. These rows are not accepted as
qualified until the required toolchains or packages are deliberately made
available and the same manifest run passes.

The protection suite verifies that a build cannot reach a host loopback
listener or pathname socket, read host PIDs, or write the protected source
tree. It also enforces aggregate CPU/RSS budgets across the descendant tree
and resolves existing repository packages from the copied app mount. If
bubblewrap or procfs accounting is unavailable, qualification is blocked or
failed rather than treated as unisolated success.

Parser and overlap expectations are independently authored under
`tests/oracles/fixture-apps/`; they do not reuse application source files.
