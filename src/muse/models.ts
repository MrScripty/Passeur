import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type MuseModel = { model_id: string; display_label?: string; description?: string | null; visibility?: string; is_current?: boolean; is_default?: boolean; release_date?: string; display_order?: number | null };

export async function discoverMuseModels(dataRoot = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share")): Promise<MuseModel[]> {
  const catalogRoot = join(dataRoot, "muse", "model-catalog");
  const models = new Map<string, MuseModel>();
  let names: string[];
  try { names = await readdir(catalogRoot); } catch { return []; }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const catalog = JSON.parse(await readFile(join(catalogRoot, name), "utf8")) as { rows?: MuseModel[] };
      for (const model of catalog.rows ?? []) if (model.visibility !== "hidden" && model.model_id) models.set(model.model_id, model);
    } catch {}
  }
  return [...models.values()].sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)) || Number(Boolean(b.is_current)) - Number(Boolean(a.is_current)) || (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) || (b.release_date ?? "").localeCompare(a.release_date ?? "") || a.model_id.localeCompare(b.model_id));
}
