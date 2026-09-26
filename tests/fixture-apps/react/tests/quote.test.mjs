import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { quoteOrder } from "../src/quote.js";
import JsxQuote from "../dist/server/QuoteForm-jsx.js";
import TsxQuote from "../dist/server/QuoteForm-tsx.js";

test("integer quote handles ordinary, zero, delivery and invalid quantities", () => {
  assert.deepEqual(quoteOrder("2", false), {
    quantity: 2, merchandiseCents: 2500, deliveryCents: 0, totalCents: 2500
  });
  assert.deepEqual(quoteOrder("2", true), {
    quantity: 2, merchandiseCents: 2500, deliveryCents: 500, totalCents: 3000
  });
  assert.equal(quoteOrder("0", false).totalCents, 0);
  assert.equal(quoteOrder("21", false).error, "Quantity must be between 0 and 20.");
  assert.equal(quoteOrder("1.5", false).error, "Enter a whole-number quantity.");
});

test("real React renderer produces the initial quote in both dialects", () => {
  for (const Component of [JsxQuote, TsxQuote]) {
    const html = renderToString(createElement(Component));
    assert.match(html, /Quantity/);
    assert.match(html, /Total:/);
    assert.match(html, /\$25\.00/);
    assert.match(renderToString(createElement(Component, {
      initialQuantity: "2", initialDelivery: true
    })), /Total: <output>\$30\.00<\/output>/);
    assert.match(renderToString(createElement(Component, {
      initialQuantity: "0", initialDelivery: false
    })), /Total: <output>\$0\.00<\/output>/);
    assert.match(renderToString(createElement(Component, {
      initialQuantity: "21", initialDelivery: false
    })), /role="alert">Quantity must be between 0 and 20\.<\/p>/);
  }
});

test("React renderer emits the exact line for each quantity and delivery vector", () => {
  for (const [quantity, delivery, expected] of [
    ["2", "true", "normal: jsx=$30.00 tsx=$30.00\n"],
    ["0", "false", "zero: jsx=$0.00 tsx=$0.00\n"],
    ["21", "false", "invalid: jsx=Quantity must be between 0 and 20. tsx=Quantity must be between 0 and 20.\n"]
  ]) {
    assert.equal(execFileSync(process.execPath, ["scripts/render.mjs", quantity, delivery], {
      encoding: "utf8"
    }), expected);
  }
});
