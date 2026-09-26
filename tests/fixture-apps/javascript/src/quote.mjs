export const MAX_UNIT_CENTS = 1_000_000;
export const MAX_QUANTITY = 1_000;
export const MAX_DISCOUNT_BPS = 10_000;

function parseBounded(value, maximum) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new RangeError("expected unsigned decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new RangeError("integer out of range");
  }
  return parsed;
}

export function parseOrder(args) {
  if (args.length !== 3) {
    throw new RangeError("expected unit_cents quantity discount_bps");
  }
  return {
    unitCents: parseBounded(args[0], MAX_UNIT_CENTS),
    quantity: parseBounded(args[1], MAX_QUANTITY),
    discountBps: parseBounded(args[2], MAX_DISCOUNT_BPS),
  };
}

export function calculateQuote({ unitCents, quantity, discountBps }) {
  const subtotalCents = unitCents * quantity;
  const discountCents = Math.floor(subtotalCents * discountBps / 10_000);
  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
