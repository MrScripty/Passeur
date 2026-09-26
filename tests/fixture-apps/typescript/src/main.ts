import { calculateQuote, parseOrder } from "./quote.mjs";
import formatter from "./format.cjs";
import process from "node:process";

try {
  const order = parseOrder(process.argv.slice(2));
  console.log(formatter.formatQuote(calculateQuote(order)));
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 2;
}
