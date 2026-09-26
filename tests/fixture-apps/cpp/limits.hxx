#ifndef FIXTURE_CPP_LIMITS_HXX
#define FIXTURE_CPP_LIMITS_HXX

#include <cstdint>

namespace fixture {

constexpr std::int64_t max_quantity = 1000;
constexpr std::int64_t max_unit_cents = 1000000;
constexpr std::int64_t max_discount_bps = 10000;

} // namespace fixture

#endif
