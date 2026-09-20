import { expect, it } from "vitest";
import { baseResult, resultReceipt, toolPayload } from "../../src/core/result.js";
import { fixture } from "../fixtures/bridge.js";
it("bounds receipt projection without changing retained evidence or undercounting commits", async () => {
  const f = await fixture();
  try {
    const result = baseResult(crypto.randomUUID(), f.request("large"), f.snapshot(f.request("large")));
    result.worker_stop = "unconfirmed"; result.summary = "x".repeat(100_000);
    result.blockers = Array.from({ length: 50 }, () => "failure ".repeat(1000));
    result.delivery.commits = Array.from({ length: 1000 }, (_v, i) => i.toString(16).padStart(40, "0"));
    const receipt = resultReceipt(result);
    expect(receipt.worker_stop).toBe("unconfirmed"); expect(receipt.task_id).toBe(result.task_id);
    expect(receipt.delivery).toMatchObject({ commit_count: 1000 });
    expect(result.delivery.commits).toHaveLength(1000); expect(result.summary).toHaveLength(100_000);
    const payload = toolPayload({ schema_version: 3, results: Array.from({ length: 8 }, () => receipt) });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(24_576);
    expect("structuredContent" in payload).toBe(false);
  } finally { await f.dispose(); }
});
