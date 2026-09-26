# L08 C# quote fixture

This package-free .NET console app accepts `quantity unit_cents discount_bps`.
Quantity is 0–1000, unit cents is 0–1000000, and discount basis points is
0–10000. The discount is truncated from the integer subtotal. Invalid input
exits 2 with a fixed stderr diagnostic.

Qualified locally with .NET SDK 10.0.111, MSBuild 18.0.11, and .NET runtime
10.0.11 on Linux x64. The installed `net10.0` reference pack is required;
`NuGet.Config` clears remote package sources. From the repository root:

```sh
build_dir=$(mktemp -d)
export DOTNET_CLI_HOME="$build_dir/cli" NUGET_PACKAGES="$build_dir/packages"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false DOTNET_NOLOGO=1
dotnet restore tests/fixture-apps/csharp/QuoteFixture.csproj \
  --configfile tests/fixture-apps/csharp/NuGet.Config \
  -p:BaseIntermediateOutputPath="$build_dir/obj/" \
  -p:MSBuildProjectExtensionsPath="$build_dir/obj/" --verbosity quiet
dotnet build tests/fixture-apps/csharp/QuoteFixture.csproj \
  --configuration Release --no-restore --output "$build_dir/bin" \
  -p:BaseIntermediateOutputPath="$build_dir/obj/" \
  -p:MSBuildProjectExtensionsPath="$build_dir/obj/" --verbosity quiet
dotnet "$build_dir/bin/QuoteFixture.dll" 2 1250 1000
# subtotal_cents=2500 discount_cents=250 total_cents=2250
dotnet "$build_dir/bin/QuoteFixture.dll" 0 1250 1000
# subtotal_cents=0 discount_cents=0 total_cents=0
dotnet "$build_dir/bin/QuoteFixture.dll" 1000 1000000 0
# subtotal_cents=1000000000 discount_cents=0 total_cents=1000000000
dotnet "$build_dir/bin/QuoteFixture.dll" 1000 1000000 10000
# subtotal_cents=1000000000 discount_cents=1000000000 total_cents=0
rm -rf "$build_dir"
```

Run the baseline functional cases with `sh tests/fixture-apps/csharp/test.sh`.
Restore and build intermediates are directed outside the pristine fixture.
