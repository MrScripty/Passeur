# L11 Odin quote app

Source target: Odin `dev-2026-09` and its `core` library. The local Odin
toolchain has not been qualified. Run from this directory in a disposable
copy; Odin's compiler outputs belong only to that copy:

```sh
odin version
odin build . -out:quote
./quote 1200 2 500
odin run . -- --self-test
odin run . -- 1200 2 500
```

The self-test should print `ok`. The sample run should print exactly:

```text
subtotal_cents=2400 discount_cents=120 total_cents=2280
```

Arguments are decimal integer unit cents (0..100000), quantity (1..100),
and discount basis points (0..10000). Discount rounds down to whole cents.
Invalid input writes an error to stderr and exits with code 2. The app has
two source modules in one `main` package and uses no external dependencies.
