import { createServer } from "vite";
import { render } from "svelte/server";

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
    id: "invalid", expectedHtml: "Quantity must be between 0 and 20.",
    value: "Quantity must be between 0 and 20.", requiresAlert: true
  }]
]);
const selected = cases.get(JSON.stringify(input));
if (!selected) {
  throw new Error(`Unknown quantity/delivery vector: ${JSON.stringify(input)}`);
}
const [initialQuantity, deliveryFlag] = input;
const initialDelivery = deliveryFlag === "true";

const server = await createServer({
  configFile: "vite.config.js",
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom"
});

try {
  const { default: App } = await server.ssrLoadModule("/src/App.svelte");
  const html = render(App, { props: {
    initialQuantity,
    initialDelivery
  } }).body;
  if (!html.includes(selected.expectedHtml)) {
    throw new Error(`Svelte render omitted ${JSON.stringify(selected.expectedHtml)}`);
  }
  if (selected.requiresAlert && !html.includes('role="alert"')) {
    throw new Error("Svelte invalid render omitted alert marker");
  }
  process.stdout.write(`${selected.id}: svelte5=${selected.value}\n`);
} finally {
  await server.close();
}
