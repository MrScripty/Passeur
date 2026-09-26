# L04 Python quote fixture

Qualified locally with Python `3.12.3` on Linux. Standard library only; no install or build step.

From the repository root:

```
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/fixture-apps/python -p test_quote.py
PYTHONDONTWRITEBYTECODE=1 python3 tests/fixture-apps/python/main.py 1250 3 1000
```

The sample prints `subtotal_cents=3750`, `discount_cents=375`, and `total_cents=3375` on separate lines. Arguments are `unit_cents quantity discount_bps`; each must be an unsigned ASCII decimal integer. Maximums are 1,000,000 cents, 1,000 units, and 10,000 basis points. Discount uses integer floor division. Invalid input exits 2. `quote.pyi` is route material matching the public model and functions in `quote.py`; it is not a separate executable. Use `PYTHONDONTWRITEBYTECODE=1` to keep the pristine app free of `__pycache__` output. Edited parser variants and expected extraction results live outside this directory.
