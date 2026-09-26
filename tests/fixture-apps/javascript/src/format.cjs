exports.formatQuote = function formatQuote(quote) {
  return `subtotal_cents=${quote.subtotalCents}\ndiscount_cents=${quote.discountCents}\ntotal_cents=${quote.totalCents}`;
};
