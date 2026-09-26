import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("Svelte server render verifies each quantity and delivery vector", () => {
  for (const [quantity, delivery, expected] of [
    ["2", "true", "normal: svelte5=$30.00\n"],
    ["0", "false", "zero: svelte5=$0.00\n"],
    ["21", "false", "invalid: svelte5=Quantity must be between 0 and 20.\n"]
  ]) {
    assert.equal(execFileSync(process.execPath, ["scripts/render.mjs", quantity, delivery], {
      encoding: "utf8"
    }), expected);
  }
});
