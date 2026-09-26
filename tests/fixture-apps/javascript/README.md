# L03 JavaScript quote fixture

Qualified locally with Node.js `v24.12.0` on Linux. This app uses only Node built-ins and has no install or build step.

From the repository root:

```
node --test tests/fixture-apps/javascript/test/cli.test.mjs
node tests/fixture-apps/javascript/src/main.js 1250 3 1000
```

The sample prints `subtotal_cents=3750`, `discount_cents=375`, and `total_cents=3375` on separate lines. Arguments are `unit_cents quantity discount_bps`; each must be an unsigned decimal integer. Maximums are 1,000,000 cents, 1,000 units, and 10,000 basis points. Discount uses integer floor division. Invalid input exits 2. The pristine app includes `.js`, `.mjs`, and `.cjs` routes. Parser edited variants and expected extraction results live outside this directory.
