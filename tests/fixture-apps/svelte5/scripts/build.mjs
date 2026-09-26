import { readFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requiredPackages = {
  svelte: "5.19.8",
  vite: "6.2.6",
  "@sveltejs/vite-plugin-svelte": "5.0.3"
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

const { build } = await import("vite");
await build({ configFile: "vite.config.js" });
