import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverMuseModels } from "../../src/muse/models.js";

describe("Muse model discovery", () => {
  it("returns visible catalog models with the default first", async () => {
    const root = await mkdtemp(join(tmpdir(), "passeur-models-")); const catalogs = join(root, "muse", "model-catalog"); await mkdir(catalogs, { recursive: true });
    await writeFile(join(catalogs, "models.json"), JSON.stringify({ rows: [{ model_id: "older", visibility: "visible", release_date: "2026-01-01" }, { model_id: "hidden", visibility: "hidden", is_default: true }, { model_id: "preferred", visibility: "visible", is_default: true, description: "preferred model" }] }));
    await expect(discoverMuseModels(root)).resolves.toEqual([expect.objectContaining({ model_id: "preferred" }), expect.objectContaining({ model_id: "older" })]);
  });
});
