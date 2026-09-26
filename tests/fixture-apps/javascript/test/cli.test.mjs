import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = fileURLToPath(new URL("../src/main.js", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

test("normal quote", () => {
  const result = run(["1250", "3", "1000"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "subtotal_cents=3750\ndiscount_cents=375\ntotal_cents=3375\n");
});

test("zero quantity", () => {
  const result = run(["1250", "0", "1000"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "subtotal_cents=0\ndiscount_cents=0\ntotal_cents=0\n");
});

test("invalid quantity", () => {
  const result = run(["1250", "-1", "1000"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "error: expected unsigned decimal integer\n");
});

test("maximum valid input", () => {
  const result = run(["1000000", "1000", "0"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "subtotal_cents=1000000000\ndiscount_cents=0\ntotal_cents=1000000000\n");
});
