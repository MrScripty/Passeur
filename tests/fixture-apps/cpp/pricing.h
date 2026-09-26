#ifndef FIXTURE_CPP_PRICING_H
#define FIXTURE_CPP_PRICING_H

#include <cstdint>

namespace fixture {

std::int64_t discount_cents(std::int64_t subtotal_cents,
                            std::int64_t discount_bps);

} // namespace fixture

#endif
