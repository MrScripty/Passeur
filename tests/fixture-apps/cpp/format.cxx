#include "format.hh"

namespace fixture {

std::string format_quote(const Quote &quote) {
    return "subtotal_cents=" + std::to_string(quote.subtotal_cents) +
           " discount_cents=" + std::to_string(quote.discount_cents) +
           " total_cents=" + std::to_string(quote.total_cents);
}

} // namespace fixture
