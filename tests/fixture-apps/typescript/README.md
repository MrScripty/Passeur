# L02 TypeScript quote fixture

Qualified locally with Node.js `v24.12.0` and TypeScript `5.9.3` on Linux. The fixture is self-contained: `src/node-shim.d.ts` declares the small Node API surface it uses, so it does not require `@types/node`. No install or network access is needed for this qualification; TypeScript is a build tool and no runtime package is required.

From the repository root, create a fresh temporary directory outside this fixture and replace `<output-dir>` in these exact commands:

```
./node_modules/.bin/tsc -p tests/fixture-apps/typescript/tsconfig.json --outDir <output-dir>
node --test <output-dir>/test/cli.test.mjs
node <output-dir>/src/main.js 1250 3 1000
```

The sample prints `subtotal_cents=3750`, `discount_cents=375`, and `total_cents=3375` on separate lines. Arguments are `unit_cents quantity discount_bps`; each must be an unsigned decimal integer. Maximums are 1,000,000 cents, 1,000 units, and 10,000 basis points. Discount uses integer floor division. Invalid input exits 2. The `.ts` entrypoint imports an `.mts` model and `.cts` formatter, exercising all three declared routes. Build products belong in `<output-dir>`, never in the pristine fixture. Edited parser variants and expected extraction results live outside this directory.
