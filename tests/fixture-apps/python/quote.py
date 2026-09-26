from dataclasses import dataclass

MAX_UNIT_CENTS = 1_000_000
MAX_QUANTITY = 1_000
MAX_DISCOUNT_BPS = 10_000


@dataclass(frozen=True)
class Order:
    unit_cents: int
    quantity: int
    discount_bps: int


@dataclass(frozen=True)
class Quote:
    subtotal_cents: int
    discount_cents: int
    total_cents: int


def _parse_bounded(value: str, maximum: int) -> int:
    if not value or not value.isascii() or not value.isdecimal():
        raise ValueError("expected unsigned decimal integer")
    parsed = int(value)
    if parsed > maximum:
        raise ValueError("integer out of range")
    return parsed


def parse_order(args: list[str]) -> Order:
    if len(args) != 3:
        raise ValueError("expected unit_cents quantity discount_bps")
    return Order(
        unit_cents=_parse_bounded(args[0], MAX_UNIT_CENTS),
        quantity=_parse_bounded(args[1], MAX_QUANTITY),
        discount_bps=_parse_bounded(args[2], MAX_DISCOUNT_BPS),
    )


def calculate_quote(order: Order) -> Quote:
    subtotal = order.unit_cents * order.quantity
    discount = subtotal * order.discount_bps // 10_000
    return Quote(subtotal, discount, subtotal - discount)
