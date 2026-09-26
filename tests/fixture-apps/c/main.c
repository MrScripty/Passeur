#include "quote.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

static int parse_integer(const char *text, int64_t *value) {
    const char *cursor = text;
    char *end;
    long long parsed;

    if (text[0] == '\0') {
        return 0;
    }
    for (; *cursor != '\0'; ++cursor) {
        if (*cursor < '0' || *cursor > '9') {
            return 0;
        }
    }
    errno = 0;
    parsed = strtoll(text, &end, 10);
    if (errno != 0 || *end != '\0') {
        return 0;
    }
    *value = (int64_t)parsed;
    return 1;
}

int main(int argc, char **argv) {
    int64_t quantity, unit_cents, discount_bps;
    Quote quote;

    if (argc != 4) {
        fputs("error: expected quantity unit_cents discount_bps\n", stderr);
        return 2;
    }
    if (!parse_integer(argv[1], &quantity) ||
        !parse_integer(argv[2], &unit_cents) ||
        !parse_integer(argv[3], &discount_bps) ||
        !calculate_quote(quantity, unit_cents, discount_bps, &quote)) {
        fputs("error: invalid quote input\n", stderr);
        return 2;
    }
    printf("subtotal_cents=%" PRId64 " discount_cents=%" PRId64
           " total_cents=%" PRId64 "\n",
           quote.subtotal_cents, quote.discount_cents, quote.total_cents);
    return 0;
}
