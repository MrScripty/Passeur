# L05 Lua quote app

Source target: Lua 5.4 standalone interpreter and standard library only.
The local Lua toolchain has not been qualified. Run these commands from this
directory in a disposable copy, with no network access:

```sh
lua -v
lua test.lua
lua main.lua 1200 2 500
```

The sample command should print exactly:

```text
subtotal_cents=2400 discount_cents=120 total_cents=2280
```

Arguments are decimal integer unit price in cents (0..100000), quantity
(1..100), and discount in basis points (0..10000). Discount rounds down to
whole cents. Invalid input writes an error to stderr and exits with code 2.
`test.lua` should print `ok` after normal, zero, rounding, and invalid cases.
Lua has no separate build step for this source app.
