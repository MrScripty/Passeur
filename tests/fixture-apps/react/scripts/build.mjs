import { readFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requiredPackages = {
  react: "19.0.0",
  "react-dom": "19.0.0",
  esbuild: "0.25.12"
};

function installedPackageDirectory(name) {
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) return null;
  }
}

for (const [name, expectedVersion] of Object.entries(requiredPackages)) {
  const directory = installedPackageDirectory(name);
  if (directory === null) {
    console.error(`Required package is absent: ${name}`);
    process.exit(127);
  }

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch (error) {
    console.error(`Required package metadata is invalid: ${name}: ${error.message}`);
    process.exit(1);
  }
  if (metadata?.name !== name || metadata?.version !== expectedVersion) {
    console.error(`Required package ${name} must be ${expectedVersion}; found ${JSON.stringify(metadata?.name)}@${JSON.stringify(metadata?.version)}`);
    process.exit(1);
  }
  try {
    import.meta.resolve(name);
  } catch (error) {
    console.error(`Required package cannot be resolved: ${name}: ${error.message}`);
    process.exit(1);
  }
}

const { build } = await import("esbuild");

const common = {
  entryPoints: ["src/main-jsx.jsx", "src/main-tsx.tsx"],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  logLevel: "warning"
};

await build({ ...common, platform: "browser", outdir: "dist/browser" });
for (const suffix of ["jsx", "tsx"]) {
  await build({
    ...common,
    entryPoints: [`src/QuoteForm.${suffix}`],
    platform: "node",
    packages: "external",
    outfile: `dist/server/QuoteForm-${suffix}.js`
  });
}
