from dataclasses import dataclass

MAX_UNIT_CENTS: int
MAX_QUANTITY: int
MAX_DISCOUNT_BPS: int

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

def parse_order(args: list[str]) -> Order: ...
def calculate_quote(order: Order) -> Quote: ...
