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

To qualify the Svelte and React rows, first provision their exact declared
packages into a disposable directory. The committed lockfiles live outside
the protected fixture trees in `tests/fixture-dependency-locks/`. This example
uses an isolated npm home, configuration, and cache; only the preparation step
needs registry access. Do not copy the generated `node_modules` into the repo.

```bash
fixture_deps=$(mktemp -d /tmp/passeur-fixture-deps-XXXXXXXX)
mkdir -p "$fixture_deps/home" "$fixture_deps/npm-cache"
touch "$fixture_deps/user.npmrc" "$fixture_deps/global.npmrc"
for app in svelte5 react; do
  mkdir -p "$fixture_deps/$app"
  cp tests/fixture-apps/$app/package.json "$fixture_deps/$app/package.json"
  cp tests/fixture-dependency-locks/$app/package-lock.json "$fixture_deps/$app/package-lock.json"
  env HOME="$fixture_deps/home" npm ci --ignore-scripts --no-audit --no-fund \
    --userconfig "$fixture_deps/user.npmrc" \
    --globalconfig "$fixture_deps/global.npmrc" \
    --cache "$fixture_deps/npm-cache" --prefix "$fixture_deps/$app"
done
node scripts/qualify-fixture-apps.mjs --offline-dependency-root "$fixture_deps"
```

The qualifier requires each disposable lockfile to match the repository-pinned
lock byte for byte, validates its exact root package versions and package
integrities, then replays `npm ci --offline --ignore-scripts` from a copy-local
cache inside the network-isolated sandbox. The cache and installed packages
remain under the disposable directory; the qualifier deletes its own copies.
An absent or different lock is an error. With no provision root, the frontend
rows retain their explicit blocked dependency result.

For Linux x86-64 native toolchains, an optional disposable tool root can
qualify the otherwise unavailable Lua, Kotlin, Zig, and Odin rows. Download
the official archives to `/tmp`, verify the vendor-published SHA-256 values,
then extract or build them there. The qualifier mounts this root read-only and
keeps all compiler caches and fixture outputs in its own disposable copies.
Odin uses its official compiler and Zig's bundled Clang frontend for linking.
The wrapper named `clang` only dispatches to `zig cc`; it does not interpret
Odin source.

```bash
native_root=$(mktemp -d /tmp/passeur-native-tools-XXXXXXXX)
curl -fL https://www.lua.org/ftp/lua-5.4.9.tar.gz -o "$native_root/lua-5.4.9.tar.gz"
curl -fL https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz -o "$native_root/zig-linux-x86_64-0.13.0.tar.xz"
curl -fL https://github.com/JetBrains/kotlin/releases/download/v2.2.21/kotlin-compiler-2.2.21.zip -o "$native_root/kotlin-compiler-2.2.21.zip"
curl -fL https://github.com/odin-lang/Odin/releases/download/dev-2026-09/odin-linux-amd64-dev-2026-09.tar.gz -o "$native_root/odin-linux-amd64-dev-2026-09.tar.gz"
(
  cd "$native_root"
  printf '%s\n' \
    '2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6  lua-5.4.9.tar.gz' \
    'd45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea  zig-linux-x86_64-0.13.0.tar.xz' \
    'a623871f1cd9c938946948b70ef9170879f0758043885bbd30c32f024e511714  kotlin-compiler-2.2.21.zip' \
    '167c3e1d7056419dad2e04bb3bd98715b7ff286d4c125f3c5a5ee337c6254283  odin-linux-amd64-dev-2026-09.tar.gz' | sha256sum -c -
)
tar -xzf "$native_root/lua-5.4.9.tar.gz" -C "$native_root"
make -C "$native_root/lua-5.4.9" linux
tar -xJf "$native_root/zig-linux-x86_64-0.13.0.tar.xz" -C "$native_root"
unzip -q "$native_root/kotlin-compiler-2.2.21.zip" -d "$native_root"
tar -xzf "$native_root/odin-linux-amd64-dev-2026-09.tar.gz" -C "$native_root"
mkdir -p "$native_root/bin"
printf '#!/bin/sh\nexec "%s/lua-5.4.9/src/lua" "$@"\n' "$native_root" > "$native_root/bin/lua"
printf '#!/bin/sh\nexec "%s/kotlinc/bin/kotlinc" "$@"\n' "$native_root" > "$native_root/bin/kotlinc"
printf '#!/bin/sh\nexec "%s/zig-linux-x86_64-0.13.0/zig" "$@"\n' "$native_root" > "$native_root/bin/zig"
printf '#!/bin/sh\nexec "%s/odin-linux-amd64-nightly+2026-09-01/odin" "$@"\n' "$native_root" > "$native_root/bin/odin"
printf '#!/bin/sh\nexec "%s/zig-linux-x86_64-0.13.0/zig" cc "$@"\n' "$native_root" > "$native_root/bin/clang"
chmod +x "$native_root/bin/"*
node scripts/qualify-fixture-apps.mjs \
  --offline-dependency-root "$fixture_deps" --offline-native-root "$native_root"
```

The four checksums come from [Lua's download area](https://www.lua.org/ftp/),
[Zig's release index](https://ziglang.org/download/index.json), and the
[Kotlin](https://github.com/JetBrains/kotlin/releases/tag/v2.2.21) and
[Odin](https://github.com/odin-lang/Odin/releases/tag/dev-2026-09) release
assets. The host JDK 17 remains a separately required toolchain: its real
installation and security configuration are mounted read-only for Kotlin.
Without a provisioned native root, unavailable toolchains remain blocked.

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

Current local evidence without provisioning passes L01–L04 and L08–L10.
With both isolated provision roots above, all thirteen rows pass their
manifest builds and three functional cases. A missing toolchain or dependency
remains blocked without the corresponding provision root.

The protection suite verifies that a build cannot reach a host loopback
listener or pathname socket, read host PIDs, or write the protected source
tree. It also enforces aggregate CPU/RSS budgets across the descendant tree
and resolves the copied TypeScript compiler and provisioned frontend packages
from each disposable app. If
bubblewrap or procfs accounting is unavailable, qualification is blocked or
failed rather than treated as unisolated success.

Parser and overlap expectations are independently authored under
`tests/oracles/fixture-apps/`; they do not reuse application source files.
