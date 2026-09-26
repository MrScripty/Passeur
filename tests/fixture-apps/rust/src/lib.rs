pub const MAX_UNIT_CENTS: u64 = 1_000_000;
pub const MAX_QUANTITY: u64 = 1_000;
pub const MAX_DISCOUNT_BPS: u64 = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub struct Quote {
    pub subtotal_cents: u64,
    pub discount_cents: u64,
    pub total_cents: u64,
}

pub fn parse_order(args: &[String]) -> Result<(u64, u64, u64), &'static str> {
    if args.len() != 3 {
        return Err("expected unit_cents quantity discount_bps");
    }
    let unit = parse_bounded(&args[0], MAX_UNIT_CENTS)?;
    let quantity = parse_bounded(&args[1], MAX_QUANTITY)?;
    let discount = parse_bounded(&args[2], MAX_DISCOUNT_BPS)?;
    Ok((unit, quantity, discount))
}

fn parse_bounded(value: &str, maximum: u64) -> Result<u64, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("expected unsigned decimal integer");
    }
    let parsed = value.parse::<u64>().map_err(|_| "integer out of range")?;
    if parsed > maximum {
        return Err("integer out of range");
    }
    Ok(parsed)
}

pub fn calculate_quote(
    unit_cents: u64,
    quantity: u64,
    discount_bps: u64,
) -> Result<Quote, &'static str> {
    if unit_cents > MAX_UNIT_CENTS || quantity > MAX_QUANTITY || discount_bps > MAX_DISCOUNT_BPS {
        return Err("integer out of range");
    }
    let subtotal_cents = unit_cents
        .checked_mul(quantity)
        .ok_or("quote arithmetic overflow")?;
    let discount_cents = subtotal_cents
        .checked_mul(discount_bps)
        .ok_or("quote arithmetic overflow")?
        / 10_000;
    let total_cents = subtotal_cents
        .checked_sub(discount_cents)
        .ok_or("quote arithmetic underflow")?;
    Ok(Quote {
        subtotal_cents,
        discount_cents,
        total_cents,
    })
}

pub fn format_quote(quote: &Quote) -> String {
    format!(
        "subtotal_cents={}\ndiscount_cents={}\ntotal_cents={}",
        quote.subtotal_cents, quote.discount_cents, quote.total_cents
    )
}

#[cfg(test)]
mod tests {
    use super::{MAX_DISCOUNT_BPS, MAX_QUANTITY, MAX_UNIT_CENTS, Quote, calculate_quote};

    #[test]
    fn direct_call_rejects_values_that_could_overflow_or_underflow() {
        assert_eq!(calculate_quote(u64::MAX, 2, 0), Err("integer out of range"));
        assert_eq!(calculate_quote(1, u64::MAX, 0), Err("integer out of range"));
        assert_eq!(calculate_quote(1, 1, u64::MAX), Err("integer out of range"));
        assert_eq!(calculate_quote(1, 1, 10_001), Err("integer out of range"));
    }

    #[test]
    fn direct_call_accepts_maximums_without_overflow_or_underflow() {
        assert_eq!(
            calculate_quote(MAX_UNIT_CENTS, MAX_QUANTITY, MAX_DISCOUNT_BPS),
            Ok(Quote {
                subtotal_cents: 1_000_000_000,
                discount_cents: 1_000_000_000,
                total_cents: 0,
            })
        );
    }
}
