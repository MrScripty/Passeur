#include "format.hh"
#include "quote.hpp"

#include <charconv>
#include <cstdint>
#include <iostream>
#include <string_view>
#include <system_error>

namespace {

bool parse_integer(std::string_view text, std::int64_t &value) {
    if (text.empty()) {
        return false;
    }
    const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
    return result.ec == std::errc{} && result.ptr == text.data() + text.size();
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 4) {
        std::cerr << "error: expected quantity unit_cents discount_bps\n";
        return 2;
    }

    fixture::QuoteInput input{};
    fixture::Quote quote{};
    if (!parse_integer(argv[1], input.quantity) ||
        !parse_integer(argv[2], input.unit_cents) ||
        !parse_integer(argv[3], input.discount_bps) ||
        !fixture::calculate_quote(input, quote)) {
        std::cerr << "error: invalid quote input\n";
        return 2;
    }
    std::cout << fixture::format_quote(quote) << '\n';
    return 0;
}
