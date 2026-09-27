import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { immutablePeerEnvelope, MAX_PEER_DELIVERY_ENVELOPE_BYTES, peerDeliveryEnvelopeBytes,
  peerDeliverySizingEnvelope, type PeerDeliverySource } from "../../src/contracts/peer-delivery.js";
import { MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES, MAX_MUSE_PEER_DELIVERY_PROMPT_BYTES,
  peerDeliveryPrompt, peerDeliveryPromptBytes } from "../../src/agents/report-format.js";

function source(content: string): PeerDeliverySource {
  return { source_work_id: "11111111-1111-4111-8111-111111111111", source_work_revision: 1,
    case_id: "22222222-2222-4222-8222-222222222222", case_revision: 1, case_generation: 1,
    evidence_id: "a".repeat(64), evidence_revision: 1,
    evidence_digest: createHash("sha256").update(content).digest("hex"),
    idempotency_key: "k".repeat(128), content };
}

describe("complete peer delivery byte budget", () => {
  it("counts a complete envelope after nested JSON escaping", () => {
    const content = JSON.stringify({ text: "\\".repeat(8_000) });
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(16_384);
    const candidate = source(content);
    const sizing = peerDeliverySizingEnvelope(candidate, "/work");
    expect(peerDeliveryEnvelopeBytes(candidate, "/work")).toBe(Buffer.byteLength(JSON.stringify(sizing), "utf8"));
    expect(peerDeliveryEnvelopeBytes(candidate, "/work")).toBeGreaterThan(MAX_PEER_DELIVERY_ENVELOPE_BYTES);
    expect(() => immutablePeerEnvelope(sizing)).toThrow();
  });

  it("sizes actual Muse and Codex text, including instructions, metadata, and escaped content", () => {
    const empty = JSON.stringify({ text: "" });
    const content = JSON.stringify({ text: "x".repeat(16_384 - Buffer.byteLength(empty, "utf8")) });
    expect(Buffer.byteLength(content, "utf8")).toBe(16_384);
    const envelope = immutablePeerEnvelope(peerDeliverySizingEnvelope(source(content), "/work"));
    expect(peerDeliveryEnvelopeBytes(source(content), "/work")).toBeLessThanOrEqual(MAX_PEER_DELIVERY_ENVELOPE_BYTES);
    for (const consumer of ["codex", "muse"] as const) {
      const prompt = peerDeliveryPrompt(envelope, consumer);
      expect(peerDeliveryPromptBytes(envelope, consumer)).toBe(Buffer.byteLength(prompt, "utf8"));
      expect(prompt).toContain(envelope.idempotency_key);
      expect(prompt).toContain("Finish each turn with PASSEUR_MESSAGE");
      expect(peerDeliveryPromptBytes(envelope, consumer)).toBeLessThanOrEqual(
        consumer === "codex" ? MAX_CODEX_PEER_DELIVERY_PROMPT_BYTES : MAX_MUSE_PEER_DELIVERY_PROMPT_BYTES);
    }
  });
});
