# L12 Svelte 5 quote fixture

The browser entry mounts a real `App.svelte` component. Its quote logic lives
in `src/quote.svelte.ts`; its reactive delivery selection and money formatter
live in `src/delivery.svelte.js`. The initial two notebooks at 1,250 cents each
render a `$25.00` total. Changing quantity or toggling delivery updates the
quote; delivery costs 500 cents for a nonzero order. Invalid quantities show
an error instead of a total.

Requires Node.js 20 or newer, Svelte 5.19.8, Vite 6.2.6,
`@sveltejs/vite-plugin-svelte` 5.0.3, and TypeScript 5.9.3. The fixture's
`package.json` pins these fixture-only dependencies. Provision them before
running the commands below; the commands themselves do not download packages.

From this directory:

```sh
npm run build
npm run render -- 2 true
npm run render -- 0 false
npm run render -- 21 false
npm test
npm run dev
```

The browser page is `http://127.0.0.1:4174/`. The build invokes Vite with the
Svelte plugin. `npm run render -- <quantity> <delivery>` (where delivery is
`true` or `false`) compiles through the plugin and renders through
`svelte/server`; it checks the HTML quote and emits one exact line:
`normal: svelte5=$30.00`, `zero: svelte5=$0.00`, or
`invalid: svelte5=Quantity must be between 0 and 20.`.
A missing declared package makes the build exit 127; an installed package
failure or build error exits nonzero otherwise. Browser interaction and package-version qualification require
the declared dependencies and a browser-capable environment.
