import type { Quote } from "./quote.mjs";

export function formatQuote(quote: Quote): string {
  return `subtotal_cents=${quote.subtotalCents}\ndiscount_cents=${quote.discountCents}\ntotal_cents=${quote.totalCents}`;
}
