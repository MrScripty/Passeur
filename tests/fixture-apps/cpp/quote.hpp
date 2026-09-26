#ifndef FIXTURE_CPP_QUOTE_HPP
#define FIXTURE_CPP_QUOTE_HPP

#include <cstdint>

namespace fixture {

struct QuoteInput {
    std::int64_t quantity;
    std::int64_t unit_cents;
    std::int64_t discount_bps;
};

struct Quote {
    std::int64_t subtotal_cents;
    std::int64_t discount_cents;
    std::int64_t total_cents;
};

bool calculate_quote(const QuoteInput &input, Quote &result);

} // namespace fixture

#endif
