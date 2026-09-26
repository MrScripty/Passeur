#ifndef FIXTURE_QUOTE_H
#define FIXTURE_QUOTE_H

#include <stdint.h>

typedef struct {
    int64_t subtotal_cents;
    int64_t discount_cents;
    int64_t total_cents;
} Quote;

int calculate_quote(int64_t quantity, int64_t unit_cents,
                    int64_t discount_bps, Quote *result);

#endif
