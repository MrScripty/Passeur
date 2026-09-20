import { expect, it } from "vitest";
import { baseResult, compactResult, resultReceipt, toolPayload } from "../../src/core/result.js";
import { fixture } from "../fixtures/bridge.js";
it("bounds actual serialized tool payloads and preserves critical identities", async () => {
  const f = await fixture();
  try {
    const result = baseResult(crypto.randomUUID(), f.request("large"), f.profile);
    result.worker_stop = "unconfirmed"; result.summary = "x".repeat(100_000);
    result.blockers = Array.from({ length: 50 }, () => "failure ".repeat(1000));
    const compact = compactResult(result);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(24_576);
    expect(compact.worker_stop).toBe("unconfirmed"); expect(compact.task_id).toBe(result.task_id);
    const payload = toolPayload({ schema_version: 2, results: Array.from({ length: 8 }, () => resultReceipt(compact)) });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(24_576);
    expect("structuredContent" in payload).toBe(false);
  } finally { await f.dispose(); }
});
