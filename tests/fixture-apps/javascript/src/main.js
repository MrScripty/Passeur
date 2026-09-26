import { calculateQuote, parseOrder } from "./quote.mjs";
import { formatQuote } from "./format.cjs";

try {
  const order = parseOrder(process.argv.slice(2));
  console.log(formatQuote(calculateQuote(order)));
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 2;
}
