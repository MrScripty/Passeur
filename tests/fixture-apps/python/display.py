from quote import Quote


def format_quote(quote: Quote) -> str:
    return (
        f"subtotal_cents={quote.subtotal_cents}\n"
        f"discount_cents={quote.discount_cents}\n"
        f"total_cents={quote.total_cents}"
    )
