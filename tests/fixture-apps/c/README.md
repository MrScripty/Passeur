# L09 C quote fixture

This package-free C11 console app accepts `quantity unit_cents discount_bps`.
Quantity is 0–1000, unit cents is 0–1000000, and discount basis points is
0–10000. The discount is truncated toward zero from the integer subtotal.
Invalid input exits 2 and writes a fixed diagnostic to stderr.

Qualified locally with GCC 13.3.0 (`gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1)`).
From the repository root, build and run in a disposable output directory:

```sh
build_dir=$(mktemp -d)
gcc -std=c11 -Wall -Wextra -Werror -pedantic \
  tests/fixture-apps/c/main.c tests/fixture-apps/c/quote.c \
  -o "$build_dir/quote-c"
"$build_dir/quote-c" 2 1250 1000
# subtotal_cents=2500 discount_cents=250 total_cents=2250
"$build_dir/quote-c" 0 1250 1000
# subtotal_cents=0 discount_cents=0 total_cents=0
"$build_dir/quote-c" 1000 1000000 0
# subtotal_cents=1000000000 discount_cents=0 total_cents=1000000000
"$build_dir/quote-c" 1000 1000000 10000
# subtotal_cents=1000000000 discount_cents=1000000000 total_cents=0
rm -rf "$build_dir"
```

Run the baseline functional cases with `sh tests/fixture-apps/c/test.sh`.
`quote.h` is the C dialect `.h` route; parser callers must select C explicitly
for this otherwise ambiguous suffix. The test builds outside this directory.
