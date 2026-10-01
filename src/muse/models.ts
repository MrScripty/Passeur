import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError, safeText } from "../core/errors.js";
import { throwIfAborted, withAbort } from "../core/async.js";

const MAX_MODELS = 1024;
const MAX_PAGE_MODELS = 2;
const CATALOG_TIMEOUT_MS = 15_000;
const text = z.string().max(512).refine(value => Buffer.byteLength(value) <= 512);
const identifier = z.string().min(1).max(256).refine(value => Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value));
const tokenLimit = z.number().int().nonnegative().safe().nullable();
const decimalCost = z.string().max(512).regex(/^[0-9]+(?:\.[0-9]+)?$/);
const cost = z.object({ cached: decimalCost, input: decimalCost, output: decimalCost, currency: identifier.nullable() }).nullable();
const row = z.object({ modelId: identifier, displayLabel: text, description: z.string().max(1024).refine(value => Buffer.byteLength(value) <= 1024).nullable(),
  isDefault: z.boolean(), releaseDate: text.nullable(), contextLimit: tokenLimit, outputLimit: tokenLimit, cost });
const catalog = z.object({ models: z.array(row).max(MAX_MODELS), source: identifier, providerId: identifier, profileId: identifier.nullable() });
export type MuseModel = { model_id: string; display_label: string; description: string | null; is_default: boolean; release_date: string | null; context_limit: number | null; output_limit: number | null; cost: z.infer<typeof cost> };
export type MuseModelCatalog = { source: string; provider_id: string; profile_id: string | null; models: MuseModel[]; catalog_sha256: string };
export const MuseModelsRequestSchema = z.object({ offset: z.number().int().nonnegative().max(MAX_MODELS).default(0),
  limit: z.number().int().min(1).max(MAX_PAGE_MODELS).default(MAX_PAGE_MODELS), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(r => r.offset === 0 || r.expected_sha256 !== undefined, "Continuation requires expected_sha256");

/** A session-free MSP query. Discovery owns and closes only its short-lived host. */
export async function discoverMuseModels(options: { museBin?: string; signal?: AbortSignal } = {}): Promise<MuseModelCatalog> {
  const signal = AbortSignal.any([AbortSignal.timeout(CATALOG_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  throwIfAborted(signal);
  const { spawnMspConnection } = await import("@muse-code/sdk");
  throwIfAborted(signal);
  const host = spawnMspConnection({ command: options.museBin ?? "muse", args: ["serve", "--no-session-log"], connection: { frameLimitBytes: 2 * 1024 * 1024 }, shutdownTimeoutMs: 1000 });
  try {
    const ready = await withAbort(host.initialize({ clientInfo: { name: "passeur_model_catalog", version: "1" } }), signal);
    const result = await withAbort(ready.connection.request("model/list", {}), signal);
    const parsed = catalog.safeParse(result);
    if (!parsed.success) throw new BridgeError("MODEL_CATALOG_INVALID", "Muse returned an unsupported or oversized model catalog");
    const value = parsed.data;
    if (new Set(value.models.map(m => m.modelId)).size !== value.models.length)
      throw new BridgeError("MODEL_CATALOG_INVALID", "Muse returned duplicate model identifiers");
    const models = value.models.map(m => ({ model_id: m.modelId, display_label: safeText(m.displayLabel, 512),
      description: m.description === null ? null : safeText(m.description, 1024), is_default: m.isDefault, context_limit: m.contextLimit, output_limit: m.outputLimit,
      cost: m.cost === null ? null : { cached: m.cost.cached, input: m.cost.input, output: m.cost.output, currency: m.cost.currency === null ? null : safeText(m.cost.currency, 512) }, release_date: m.releaseDate === null ? null : safeText(m.releaseDate, 512) }));
    const snapshot = { source: safeText(value.source, 512), provider_id: safeText(value.providerId, 512),
      profile_id: value.profileId === null ? null : safeText(value.profileId, 512), models };
    return { ...snapshot, catalog_sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(signal.aborted ? "MODEL_CATALOG_CANCELLED" : "MODEL_CATALOG_UNAVAILABLE",
      signal.aborted ? "Muse model discovery ended before completion" : "Muse model discovery failed; check the Muse executable and catalog configuration", { cause: error });
  } finally {
    try { await host.close(); }
    catch (cause) { throw new BridgeError("MODEL_CATALOG_CLOSE_FAILED", "The owned Muse catalog host could not be closed", { cause }); }
  }
}
export function museModelsPage(value: MuseModelCatalog, request: z.infer<typeof MuseModelsRequestSchema>) {
  if (request.expected_sha256 && request.expected_sha256 !== value.catalog_sha256)
    throw new BridgeError("MODEL_CATALOG_REFRESH_REQUIRED", "Muse's model catalog changed; refresh from offset zero");
  if (request.offset > value.models.length)
    throw new BridgeError("MODEL_CATALOG_OFFSET_INVALID", "Muse model catalog offset is beyond the current catalog");
  const models = value.models.slice(request.offset, request.offset + request.limit);
  const next = request.offset + models.length;
  return { schema_version: 1, source: value.source, provider_id: value.provider_id, profile_id: value.profile_id,
    catalog_sha256: value.catalog_sha256, models, offset: request.offset, total: value.models.length,
    next_offset: next < value.models.length ? next : null };
}
