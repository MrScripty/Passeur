#include "quote.h"

int calculate_quote(int64_t quantity, int64_t unit_cents,
                    int64_t discount_bps, Quote *result) {
    if (result == 0 || quantity < 0 || quantity > 1000 ||
        unit_cents < 0 || unit_cents > 1000000 ||
        discount_bps < 0 || discount_bps > 10000) {
        return 0;
    }

    result->subtotal_cents = quantity * unit_cents;
    result->discount_cents = result->subtotal_cents * discount_bps / 10000;
    result->total_cents = result->subtotal_cents - result->discount_cents;
    return 1;
}
