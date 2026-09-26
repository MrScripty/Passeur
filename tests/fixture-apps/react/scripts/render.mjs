import { createElement } from "react";
import { renderToString } from "react-dom/server";
import JsxQuote from "../dist/server/QuoteForm-jsx.js";
import TsxQuote from "../dist/server/QuoteForm-tsx.js";

const input = process.argv.slice(2);
if (input.length !== 2) {
  throw new Error("Expected quantity and delivery flag arguments");
}
const cases = new Map([
  [JSON.stringify(["2", "true"]), {
    id: "normal", expectedHtml: "Total: <output>$30.00</output>", value: "$30.00"
  }],
  [JSON.stringify(["0", "false"]), {
    id: "zero", expectedHtml: "Total: <output>$0.00</output>", value: "$0.00"
  }],
  [JSON.stringify(["21", "false"]), {
    id: "invalid", expectedHtml: '<p role="alert">Quantity must be between 0 and 20.</p>',
    value: "Quantity must be between 0 and 20."
  }]
]);
const selected = cases.get(JSON.stringify(input));
if (!selected) {
  throw new Error(`Unknown quantity/delivery vector: ${JSON.stringify(input)}`);
}
const [initialQuantity, deliveryFlag] = input;
const initialDelivery = deliveryFlag === "true";

const verified = [];
for (const [dialect, Component] of [["jsx", JsxQuote], ["tsx", TsxQuote]]) {
  const html = renderToString(createElement(Component, {
    initialQuantity,
    initialDelivery
  }));
  if (!html.includes(selected.expectedHtml)) {
    throw new Error(`${dialect} render omitted ${JSON.stringify(selected.expectedHtml)}`);
  }
  verified.push(`${dialect}=${selected.value}`);
}
process.stdout.write(`${selected.id}: ${verified.join(" ")}\n`);
