# Holland Cookies

Storefront page for Holland Cookies — cookie pies baked to order in Cairo.

The visual design comes from the Google Stitch project *Artisan Cookie Atelier*.
The frontend motion engineering is adapted from `cs_code_scooby` — its animation
architecture and hard-won mobile Safari lessons, none of its brand or backend.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # production build to dist/
npm run preview      # serve the build on :4173
```

## Checks

```sh
npm run typecheck    # tsc --noEmit
npm run test:webkit  # Playwright, iPhone 13 + desktop WebKit
```

`test:webkit` builds nothing on its own — run `npm run build` first, since it
serves `dist/` through `vite preview`.

## Layout

```
src/
  lib/motion/   tokens, capability detection, CSS-variable publication
  lib/          splash controller, scroll reveal, mount-on-first-open
  sections/     TopBar, Hero, MenuGrid, Craft, Visit, Footer
  components/   PanDetail (the product dialog)
  data/         the menu, as plain data
e2e/            splash lifecycle + storefront interaction specs
docs/           motion audit and parity report
```

## Two rules worth knowing before editing

**`src/lib/motion/tokens.ts` is the only file that may contain a motion number.**
Import the token, never the literal. `transitionFor()` and `travelFor()` are the
only supported way to get a transition or a distance — that is what makes it
impossible for a component to forget `prefers-reduced-motion`.

**`src/lib/splash.ts` is the only thing that removes the boot splash.** It will
not remove it until the browser has actually *painted* it. That is not a
stylistic choice: without the paint gate the loader is removed ~20ms before
first contentful paint on WebKit and is never seen at all, intermittently, on
the same device. `docs/FRONTEND_PARITY_REPORT.md` §15 has the detail, and
`?splashdebug=1` dumps the lifecycle to `window.__splashEvents`.
