#!/bin/sh
set -eu

build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
DOTNET_CLI_HOME="$build_dir/cli"
NUGET_PACKAGES="$build_dir/packages"
DOTNET_CLI_TELEMETRY_OPTOUT=1
DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
DOTNET_GENERATE_ASPNET_CERTIFICATE=false
DOTNET_NOLOGO=1
export DOTNET_CLI_HOME NUGET_PACKAGES DOTNET_CLI_TELEMETRY_OPTOUT DOTNET_SKIP_FIRST_TIME_EXPERIENCE DOTNET_GENERATE_ASPNET_CERTIFICATE DOTNET_NOLOGO

dotnet restore tests/fixture-apps/csharp/QuoteFixture.csproj \
    --configfile tests/fixture-apps/csharp/NuGet.Config \
    -p:BaseIntermediateOutputPath="$build_dir/obj/" \
    -p:MSBuildProjectExtensionsPath="$build_dir/obj/" \
    --verbosity quiet
dotnet build tests/fixture-apps/csharp/QuoteFixture.csproj \
    --configuration Release --no-restore --output "$build_dir/bin" \
    -p:BaseIntermediateOutputPath="$build_dir/obj/" \
    -p:MSBuildProjectExtensionsPath="$build_dir/obj/" \
    --verbosity quiet

expect_quote() {
    expected=$1
    shift
    actual=$(dotnet "$build_dir/bin/QuoteFixture.dll" "$@")
    if [ "$actual" != "$expected" ]; then
        printf 'FAIL: expected "%s", got "%s"\n' "$expected" "$actual" >&2
        exit 1
    fi
}

expect_invalid() {
    expected=$1
    shift
    set +e
    actual=$(dotnet "$build_dir/bin/QuoteFixture.dll" "$@" 2>&1)
    status=$?
    set -e
    if [ "$status" -ne 2 ] || [ "$actual" != "$expected" ]; then
        printf 'FAIL: invalid case exited %s with "%s"\n' "$status" "$actual" >&2
        exit 1
    fi
}

expect_quote 'subtotal_cents=2500 discount_cents=250 total_cents=2250' 2 1250 1000
expect_quote 'subtotal_cents=0 discount_cents=0 total_cents=0' 0 1250 1000
expect_quote 'subtotal_cents=1000000000 discount_cents=0 total_cents=1000000000' 1000 1000000 0
expect_quote 'subtotal_cents=1000000000 discount_cents=1000000000 total_cents=0' 1000 1000000 10000
expect_invalid 'error: invalid quote input' -1 1250 1000
expect_invalid 'error: invalid quote input' 1001 1250 1000
expect_invalid 'error: invalid quote input' 2 1000001 1000
expect_invalid 'error: invalid quote input' 2 1250 10001
expect_invalid 'error: invalid quote input' abc 1250 1000
expect_invalid 'error: invalid quote input' 1.5 1250 1000
expect_invalid 'error: invalid quote input' ' 2' 1250 1000
expect_invalid 'error: invalid quote input' 999999999999999999999999 1250 1000
expect_invalid 'error: expected quantity unit_cents discount_bps' 2 1250
printf 'C# fixture: 13 cases passed\n'
