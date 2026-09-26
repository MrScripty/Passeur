#include "quote.hpp"

#include "limits.hxx"
#include "pricing.h"

namespace fixture {

std::int64_t discount_cents(std::int64_t subtotal_cents,
                            std::int64_t discount_bps) {
    return subtotal_cents * discount_bps / max_discount_bps;
}

bool calculate_quote(const QuoteInput &input, Quote &result) {
    if (input.quantity < 0 || input.quantity > max_quantity ||
        input.unit_cents < 0 || input.unit_cents > max_unit_cents ||
        input.discount_bps < 0 || input.discount_bps > max_discount_bps) {
        return false;
    }

    result.subtotal_cents = input.quantity * input.unit_cents;
    result.discount_cents = discount_cents(result.subtotal_cents,
                                           input.discount_bps);
    result.total_cents = result.subtotal_cents - result.discount_cents;
    return true;
}

} // namespace fixture
