export const UNIT_PRICE_CENTS = 1250;
export const DELIVERY_CENTS = 500;

export function quoteOrder(rawQuantity, includeDelivery) {
  if (!/^(0|[1-9][0-9]*)$/.test(rawQuantity)) {
    return { error: "Enter a whole-number quantity." };
  }
  const quantity = Number(rawQuantity);
  if (!Number.isSafeInteger(quantity) || quantity > 20) {
    return { error: "Quantity must be between 0 and 20." };
  }
  const merchandiseCents = quantity * UNIT_PRICE_CENTS;
  const deliveryCents = includeDelivery && quantity > 0 ? DELIVERY_CENTS : 0;
  return { quantity, merchandiseCents, deliveryCents, totalCents: merchandiseCents + deliveryCents };
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
