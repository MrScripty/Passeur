# L07 Zig quote app

Source target: Zig 0.13.0 with its standard library. The local Zig toolchain
has not been qualified. Run from this directory in a disposable copy:

```sh
zig version
zig test quote.zig
zig build-exe main.zig -femit-bin=quote
./quote 1200 2 500
zig run main.zig -- 1200 2 500
```

The sample run should print exactly:

```text
subtotal_cents=2400 discount_cents=120 total_cents=2280
```

Arguments are decimal integer unit cents (0..100000), quantity (1..100),
and discount basis points (0..10000). Discount rounds down to whole cents.
Invalid input writes an error to stderr and exits with code 2. `zig test`
exercises normal, zero, rounding, and invalid cases. `zig run` compiles into
the Zig cache, so run it only in a disposable copy.
