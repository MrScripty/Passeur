# L13 React quote fixture

This isolated app contains a JSX component (`src/QuoteForm.jsx`), a TSX component
(`src/QuoteForm.tsx`), and a JSX-bearing `.js` child (`src/LineItem.js`).
Both pages start with two notebooks at 1,250 cents each and no delivery:
the rendered total is `$25.00`. Editing quantity or checking “Add delivery”
updates the quote; delivery adds 500 cents only for nonzero quantity. Invalid
or over-limit quantities show an error instead of a total.

Requires Node.js 20 or newer, React and ReactDOM 19.0.0, esbuild 0.25.12,
TypeScript 5.9.3 and the listed React type packages. The fixture's `package.json`
pins these packages; they are fixture-only and are not Passeur runtime dependencies.
Dependencies must be provisioned before these commands are run. No command below
downloads packages.

From this directory:

```sh
npm run build
npm run render -- 2 true
npm run render -- 0 false
npm run render -- 21 false
npm test
python3 -m http.server 4173 --bind 127.0.0.1
```

The browser pages are `http://127.0.0.1:4173/jsx.html` and
`http://127.0.0.1:4173/tsx.html`. The build bundles real React browser entries;
the render command takes quantity and delivery arguments (`true` or `false`),
uses `react-dom/server` for both JSX and TSX, and checks the rendered quote.
It emits one exact line per input vector:
`normal: jsx=$30.00 tsx=$30.00`, `zero: jsx=$0.00 tsx=$0.00`, or
`invalid: jsx=Quantity must be between 0 and 20. tsx=Quantity must be between 0 and 20.`.
The build script
configures the `.js` loader as JSX to compile `LineItem.js`. A missing declared
package makes the build exit 127; an installed package failure or build error
exits nonzero otherwise. Browser interaction and package-version qualification require
the declared dependencies and a browser-capable environment.
