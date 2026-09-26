# L10 C++ quote fixture

This package-free C++17 console app accepts `quantity unit_cents discount_bps`.
Quantity is 0–1000, unit cents is 0–1000000, and discount basis points is
0–10000. The discount is truncated from the integer subtotal. Invalid input
exits 2 with a fixed stderr diagnostic.

Qualified locally with G++ 13.3.0 (`g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1)`).
From the repository root, build and run outside the pristine fixture:

```sh
build_dir=$(mktemp -d)
g++ -std=c++17 -Wall -Wextra -Werror -pedantic \
  tests/fixture-apps/cpp/main.cc tests/fixture-apps/cpp/quote.cpp \
  tests/fixture-apps/cpp/format.cxx -o "$build_dir/quote-cpp"
"$build_dir/quote-cpp" 2 1250 1000
# subtotal_cents=2500 discount_cents=250 total_cents=2250
"$build_dir/quote-cpp" 0 1250 1000
# subtotal_cents=0 discount_cents=0 total_cents=0
"$build_dir/quote-cpp" 1000 1000000 0
# subtotal_cents=1000000000 discount_cents=0 total_cents=1000000000
"$build_dir/quote-cpp" 1000 1000000 10000
# subtotal_cents=1000000000 discount_cents=1000000000 total_cents=0
rm -rf "$build_dir"
```

Run the baseline functional cases with `sh tests/fixture-apps/cpp/test.sh`.
The `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, and `.hxx` aliases have real C++
source. `pricing.h` requires the explicit C++ dialect override for the
ambiguous `.h` route. The test builds outside this directory.
