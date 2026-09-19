import { describe, expect, it } from "vitest";
import { DelegateRequestSchema } from "../../src/contracts/index.js";

const valid = { schema_version: 1, request_key: "review-1", mode: "review", objective: "Review the parser", context: "Focus on boundary handling", acceptance_criteria: ["Report concrete findings"] } as const;

describe("DelegateRequestSchema", () => {
  it("accepts the bounded review contract", () => { expect(DelegateRequestSchema.parse(valid)).toEqual(valid); });
  it("rejects unknown fields and traversal", () => {
    expect(() => DelegateRequestSchema.parse({ ...valid, surprise: true })).toThrow();
    expect(() => DelegateRequestSchema.parse({ ...valid, context_files: ["../secret"] })).toThrow();
  });
  it("requires a base commit for implementation", () => { expect(() => DelegateRequestSchema.parse({ ...valid, mode: "implement" })).toThrow(/base_commit/); });
});
