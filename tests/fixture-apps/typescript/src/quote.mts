export const MAX_UNIT_CENTS = 1_000_000;
export const MAX_QUANTITY = 1_000;
export const MAX_DISCOUNT_BPS = 10_000;

export interface Order {
  readonly unitCents: number;
  readonly quantity: number;
  readonly discountBps: number;
}

export interface Quote {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

function parseBounded(value: string, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new RangeError("expected unsigned decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new RangeError("integer out of range");
  }
  return parsed;
}

export function parseOrder(args: readonly string[]): Order {
  if (args.length !== 3) {
    throw new RangeError("expected unit_cents quantity discount_bps");
  }
  return {
    unitCents: parseBounded(args[0]!, MAX_UNIT_CENTS),
    quantity: parseBounded(args[1]!, MAX_QUANTITY),
    discountBps: parseBounded(args[2]!, MAX_DISCOUNT_BPS),
  };
}

export function calculateQuote(order: Order): Quote {
  const subtotalCents = order.unitCents * order.quantity;
  const discountCents = Math.floor(subtotalCents * order.discountBps / 10_000);
  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
