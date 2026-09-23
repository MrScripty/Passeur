import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_PARTIES, MAX_REGIONS, MAX_NOTE_BYTES } from "../contracts/coordination-control.js";
import { COORDINATION_PAGE_BYTES, COORDINATION_VIEW_BYTES, COORDINATION_SERVICE_VERSION, type CoordinationEndpoint } from "../contracts/coordination-service.js";
import { diagnosticInfo } from "../core/errors.js";
import { toolPayload } from "../core/result.js";
import { coordinationToolDescriptions, decodeCoordinationToolArguments, invokeCoordinationTool, type CoordinationToolName } from "./coordination-operations.js";

// These shapes project the existing decoder. Its UTF-8 byte, identity, uniqueness and cross-field rules remain authoritative.
const version = z.literal(COORDINATION_SERVICE_VERSION);
const operationKey = z.string().describe("Stable operation key. Reuse it only for the same command; at most 256 UTF-8 bytes.");
const entity = z.string().describe("Lowercase UUID returned by Passeur, not an execution permission.");
const parent = z.string().describe("64-hex parent identity from passeur_coordination; never a credential.");
const oid = z.string().describe("Exact full lowercase Git commit OID (40 or 64 hex digits), not a branch name.");
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const people = z.array(parent).max(MAX_PARTIES);
const subject = z.object({ kind: z.enum(["work", "case"]), id: entity }).strict();
const selector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work"), id: entity }).strict(),
  z.object({ kind: z.literal("note"), id: entity }).strict(),
  z.object({ kind: z.literal("case"), id: entity }).strict(),
  z.object({ kind: z.literal("overlaps"), id: entity }).strict(),
  z.object({ kind: z.literal("receipt"), operation_key: operationKey }).strict(),
]);
const read = z.object({ schema_version: version, kind: z.literal("read"), selector,
  offset: z.number().int().min(0).max(COORDINATION_VIEW_BYTES), limit: z.number().int().min(4).max(COORDINATION_PAGE_BYTES),
  expected_hash: z.string().nullable().describe("null for an initial page; the returned hash for continuation. Re-read from zero if the view changed."),
}).strict();
const information = z.discriminatedUnion("kind", [
  z.object({ schema_version: version, kind: z.literal("identity") }).strict(),
  z.object({ schema_version: version, kind: z.literal("status") }).strict(), read,
]);
const work = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register_external_work"), operation_key: operationKey, input_oid: oid,
    intent: z.string().describe("Parent-authored intent, up to 4096 UTF-8 bytes. Not a machine-inferred explanation."),
    areas: z.array(z.object({ kind: z.enum(["file", "subtree"]), path: z.string().describe("Repository-relative component path.") }).strict()).max(MAX_REGIONS),
    readers: people.describe("Other parent identities explicitly permitted to read this work; omit the owner from this list."),
  }).strict(),
  z.object({ kind: z.literal("share_work"), operation_key: operationKey, work_id: entity, expected_revision: revision, readers: people }).strict(),
  z.object({ kind: z.literal("close_work"), operation_key: operationKey, work_id: entity, expected_revision: revision }).strict(),
]);
const notes = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("post_note"), operation_key: operationKey, subject,
    note_kind: z.enum(["intent", "question", "statement", "agreement_proposal", "resolution_update"]),
    text: z.string().min(1).max(MAX_NOTE_BYTES).describe("Attributed text, also bounded by configured note_bytes. Not instructions or permission."),
    parties: people.describe("An agreement names its exact nonempty set of required acknowledgers. Other note kinds require an empty list."),
  }).strict(),
  z.object({ kind: z.literal("ack_note"), operation_key: operationKey, note_id: entity }).strict(),
  z.object({ kind: z.literal("withdraw_note"), operation_key: operationKey, note_id: entity }).strict(),
]);
const caseFields = { operation_key: operationKey, case_id: entity, expected_revision: revision, generation: revision };
const reconciliation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claim_target"), operation_key: operationKey,
    target: z.string().describe("Full direct local branch ref, such as refs/heads/main."), members: people,
  }).strict(),
  z.object({ kind: z.literal("select_inputs"), ...caseFields, target_oid: oid,
    inputs: z.array(z.object({ work_id: entity, commit_oid: oid }).strict()).max(MAX_REGIONS),
  }).strict(),
  z.object({ kind: z.literal("begin_external_integration"), ...caseFields }).strict(),
  z.object({ kind: z.literal("record_external_settlement"), ...caseFields }).strict(),
  z.object({ kind: z.literal("release_case"), ...caseFields }).strict(),
  z.object({ kind: z.literal("transfer_case"), ...caseFields, new_lead: parent }).strict(),
]);
function command<T extends z.ZodType>(schema: T) {
  return z.object({ schema_version: version, kind: z.literal("command"), command: schema }).strict();
}
function input<T extends z.ZodType>(name: CoordinationToolName, request: T) {
  return z.object({ request }).strict().superRefine((value, context) => {
    try { decodeCoordinationToolArguments(name, value); }
    catch (error) { context.addIssue({ code: "custom", message: diagnosticInfo(error).message }); }
  });
}
export const CoordinationInfoInputSchema = input("passeur_coordination", information);
export const CoordinationWorkInputSchema = input("passeur_work", command(work));
export const CoordinationNotesInputSchema = input("passeur_notes", command(notes));
export const CoordinationReconciliationInputSchema = input("passeur_reconciliation", command(reconciliation));

/** Registration is inert: no connection, initialization, source inspection, or provider lookup occurs here. */
export function registerCoordinationTools(mcp: McpServer, frontend: CoordinationEndpoint, lifecycle: AbortSignal): void {
  const call = async (name: CoordinationToolName, value: unknown, signal: AbortSignal) => {
    try { return toolPayload(await invokeCoordinationTool(name, value, frontend, AbortSignal.any([signal, lifecycle]))); }
    catch (error) {
      const detail = diagnosticInfo(error);
      return toolPayload({ error: { code: detail.code, message: detail.message, ...(detail.next_action ? { next_action: detail.next_action } : {}) } }, true);
    }
  };
  mcp.registerTool("passeur_coordination", { description: coordinationToolDescriptions.passeur_coordination,
    inputSchema: CoordinationInfoInputSchema, annotations: { readOnlyHint: true } }, (value, extra) => call("passeur_coordination", value, extra.signal));
  mcp.registerTool("passeur_work", { description: coordinationToolDescriptions.passeur_work,
    inputSchema: CoordinationWorkInputSchema }, (value, extra) => call("passeur_work", value, extra.signal));
  mcp.registerTool("passeur_notes", { description: coordinationToolDescriptions.passeur_notes,
    inputSchema: CoordinationNotesInputSchema }, (value, extra) => call("passeur_notes", value, extra.signal));
  mcp.registerTool("passeur_reconciliation", { description: coordinationToolDescriptions.passeur_reconciliation,
    inputSchema: CoordinationReconciliationInputSchema }, (value, extra) => call("passeur_reconciliation", value, extra.signal));
}
