# Lean production report — Holland Cookies

Commit audited: `44e415c` ("Fill in the remaining menu photography"), branch
`main`. All numbers below are measured on this machine, not estimated. See
[`LEAN_BASELINE.md`](./LEAN_BASELINE.md) for the full before-state and
[`DEPENDENCY_AUDIT.md`](./DEPENDENCY_AUDIT.md) for the per-package table.

## Headline finding

**The application code was already lean.** This is a hand-built React+Vite+
Express+SQLite storefront, not a generated scaffold — no cron jobs, no
Redis, no duplicate DB pools, no `console.log` spam, no TODO/mock debris, a
fully separate admin bundle the customer never downloads, and code-split
lazy routes already in place with a documented rationale (`vite.config.ts`,
`src/index.css:1289`). The optimization work that existed to do was real but
narrow: two unused runtime dependencies, one orphaned duplicate admin
component tree, 19 superseded image files, an oversized favicon, and — the
single largest win — devDependencies shipping into the production container
because nothing pruned them after the build.

## Changes made

| # | Change | Evidence it was dead/wasteful | Verified by |
|---|---|---|---|
| 1 | Removed `bcryptjs`, `jsonwebtoken` from `dependencies` | Zero `import`/`require` anywhere in the repo (grep across `src/`, `backend/`, `dashboard-src/`, `shared/`). Auth uses `node:crypto` (`scrypt`, `timingSafeEqual`, `createHmac`) exclusively. | `npm uninstall` removed 14 packages (2 direct + 12 transitive: `jws`, 7× `lodash.*`, `ms`, `semver`); full test suite unchanged after |
| 2 | Deleted 19 files in `public/img/menu/ai/` (480,714 bytes exact) | Filenames exactly match item ids that migrated from `GENERATED` (AI stand-in) to `PHOTOGRAPHED` (real photo) in `src/data/menuImages.ts` — the code references were already removed, the files were not. Confirmed zero references anywhere (source, `dist/`, docs) beyond one substring false-positive (`tagine-vanilla-nutella` inside the *different*, still-used `tagine-vanilla-nutella-coffee.webp`), checked manually. | Exact-filename cross-reference script; rebuild + full test suite after |
| 3 | Deleted `dashboard-src/src/components/{ProductDialog,ProductFields,ImagePicker}.tsx` + `dashboard-src/src/lib/productForm.ts` (1,048 lines) | An entire duplicate admin "edit product" implementation, never imported by any live page. The actual `Menu.tsx` builds its own dialog inline from `@/components/menu-ui` + `ui/dialog` (comment: *"Deliberately Holland's own layout rather than the card grid..."*) — this was the superseded alternate design. | `grep` for each of the 4 filenames across the entire repo found zero references outside their own mutual chain; no dynamic `import()` of any of them; `tsc --noEmit` clean after deletion |
| 4 | Favicon: `index.html` and `dashboard-src/index.html` now point at `/img/logo.webp` (36 KB) instead of `/img/logo.jpg` (140 KB) | `logo.jpg` is documented in `docs/cut-logo.py` and `TopBar.tsx` as *the raw screenshot* — a white card, rounded corners, and a leaf watermark baked in — that `cut-logo.py` cuts the real transparent mark from. The transparent `logo.webp` is the same logo, already used everywhere else on the page. No new crop or visual decision was made — this points the favicon at an asset the site was already shipping. | Manual verification the file exists and is the intended mark |
| 5 | Added `"build:deploy": "npm run build && npm prune --omit=dev"`; `railway.json`'s `buildCommand` now points at it instead of `npm run build` | Nixpacks has one image; there was no step to drop devDependencies after the build needed them. `vite`, `tailwindcss`, `typescript`, `@playwright/test`, `vitest`, `jsdom`, the `@testing-library/*` packages, and their transitive trees were shipping into the runtime container unused. | **Measured, not assumed**: `npm prune --omit=dev` shrank `node_modules` 238M → 106M on this exact repo. Ran the *exact* `build:deploy` command fresh, then `npm start` against the pruned result: `/api/health`, `/api/ready`, `/`, and `/dashboard` all responded correctly. Local `npm run build` is untouched — devDependencies still install normally for development. |

## What was investigated and found already correct (no change needed)

- **Background work / idle CPU** (spec §4–7): the entire `backend/` directory
  has exactly one `setTimeout` (a `.unref()`'d shutdown watchdog) and zero
  `setInterval`, cron, `worker_threads`, `child_process`, WebSocket, or file
  watchers. There is nothing to gate behind a feature flag because there is
  no background work.
- **DB connections** (§8): one shared `better-sqlite3` handle, confirmed the
  only `new Database(...)` call in the repo.
- **Redis** (§9, §71): not a dependency; not applicable.
- **Admin bundle isolation** (§29, §103–104): already a fully separate Vite
  app/build (`dashboard-src/` → `dist-dashboard/`), served only under
  `/dashboard`. The customer's `dist/` bundle contains zero admin code —
  confirmed by measuring the two builds independently.
- **Route/code splitting** (§28, §31): `CartDrawer`, `PanDetail`,
  `TrackPage`, `MenuItemDetail`, `AccountPage`, and `CheckoutPage` are
  already separate lazy chunks; `framer-motion` is already split into its
  own chunk specifically kept off the first-paint critical path
  (`vite.config.ts` comment), and the team had already independently
  hand-rolled a CSS-only alternative elsewhere for the same reason
  (`src/index.css:1289`, the category-indicator).
- **Icon tree-shaking** (§25): all `lucide-react` imports are named
  (`import { X } from 'lucide-react'`), zero `import * as Icons`. Also: the
  storefront never imports `lucide-react` at all — it's dashboard-only, so
  the bundle-shaking question is moot for the customer bundle.
- **`zod` leaking into the client bundle** (§32): checked directly —
  `grep -c "ZodError"` across every `dist/assets/*.js` chunk returns 0. It's
  backend-only, as intended.
- **Shadcn/Radix catalog bloat** (§24): only 4 UI primitives exist in
  `dashboard-src/src/components/ui/` (`button`, `card`, `dialog`,
  `dropdown-menu`), matching the 3 `@radix-ui/*` dependencies exactly — no
  copied-but-unused component catalog to prune.
- **Fonts** (§40): both Google Fonts `<link>` tags already scope to exactly
  the weights used in CSS (e.g. `Cairo:wght@400;600;700;800`, not the full
  family), with `preconnect` hints and `display=swap` already in place.
- **Middleware ordering / cost on static assets** (§63–64): `helmet`/`cors`/
  `compression` are the only global middleware; rate limiting,
  `originGuard`, and body validation are scoped to `/api` only. A static
  homepage request never touches the database or the rate limiter.
- **Health check cost** (§94): `/api/health` (what Railway polls) does zero
  DB work; `/api/ready` does one trivial `SELECT 1`.
- **Deliberately-kept "unused" assets**: 6 files in `public/img/menu/` that
  pattern-matched as orphaned by the same cross-reference method as finding
  #2 turned out to be explicitly documented in `menuImages.ts` as
  intentionally unlabeled photographs held for future menu items ("no
  printed item names them unambiguously"). Not deleted — correctly
  distinguishing "looks unused" from "proven dead" (spec §15, §37).

## Explicitly out of scope / not touched, with reasons

- **`aptPkgs = ["python3", "build-essential"]` in `nixpacks.toml`** —
  `better-sqlite3@13.0.3` ships prebuilt binaries for every platform
  (`node_modules/better-sqlite3/prebuilds/*.node`, including
  `linux-x64.node`) and has **no** install/postinstall script — it never
  invokes `node-gyp` on its own. This strongly suggests the apt packages
  (installed to allow a native compile) are no longer necessary and are
  adding real build-time and image weight for nothing. **Not removed**: I
  have no way to run an actual Nixpacks/Railway Linux build locally (no
  `nixpacks` CLI, and installing one purely to verify this would be adding
  tooling for a single check), and this project's Railway deployment was
  crashed and only just repaired earlier today — I was not willing to risk
  a second outage on an unverified build-config change. Flagged as a
  worthwhile, low-effort experiment on the *next* deploy: remove the line,
  watch the build succeed or fail, revert if it fails.
- **Pre-existing security test failure** — `tests/security/security.test.js`,
  the "validation: malformed JSON..." test, already fails on the original
  commit (`GET /api/menu/admin/products/..%2Fsecrets` returns 404 where the
  test expects 400). Confirmed via `git diff` that neither `backend/config.js`
  nor any admin route file is part of this session's changes. Not fixed —
  it's a routing/validation correctness bug, not a weight issue, and outside
  this pass's mandate.
- **Playwright commerce/account/receipt suite (`playwright.commerce.config.ts`)
  cannot run at all**, before or after this pass — its harness
  (`backend/test/e2e-server.js`) sets `HTTPS_ORIGIN='false'` and
  `MAIL_TRANSPORT='console'`, both of which `backend/config.js`'s current
  schema rejects (it only accepts the literal `'true'`/`'brevo'` or the
  variable being entirely absent), and an `ADMIN_KEY`/`JWT_SECRET` containing
  the banned `e2e-` substring. This is a **pre-existing** incompatibility
  between the test harness and a later tightening of `config.js`
  (commit `0f8bba1`, from earlier in this engagement) — confirmed via `git
  diff` that neither file is touched here. Fixing it correctly would mean
  touching `mailer.js`'s production mail-gating logic (a security control,
  not a weight concern), so I did not attempt it inside this pass.
- **`qs` and `@vitest/mocker` moderate `npm audit` findings** — pre-existing,
  transitive (`qs` via `express`→`body-parser`; already unreachable in this
  app because `server.js` sets `query parser: 'simple'`), and
  `@vitest/mocker` is dev-only. Clearing either requires a major version
  bump, which is a separate upgrade decision, not a lean-production cleanup.
- **No Dockerfile/`.dockerignore`, no CI workflow** — this project deploys
  via Railway + Nixpacks directly from git, with no `.github/workflows`.
  Sections of the source spec about multi-stage Docker builds and CI
  pipeline ordering don't apply; inventing a CI pipeline was out of scope
  for a resource-weight pass and not requested.

## Before / after

| Metric | Before | After | Change |
|---|---|---|---|
| Runtime dependencies | 22 | 20 | −2 |
| devDependencies | 13 | 13 | 0 (correctly dev-only already) |
| Resolved packages (package-lock.json) | 392 | 378 | −14 |
| `node_modules` (dev install) | 238M | 233M | −5M |
| `node_modules` (after `npm prune --omit=dev`, i.e. what Railway now ships) | 238M (never pruned before) | 106M → **101M** after dep removal too | **−137M / ~58%** off the shipped container's `node_modules` |
| Storefront initial JS (index + motion + entry) | 443.27 kB raw / 141.98 kB gzip | unchanged | 0 (no dead frontend JS existed) |
| Dashboard JS bundle | 436.05 kB raw / 135.79 kB gzip | 436.05 kB raw / 135.79 kB gzip | 0 (the removed 1,048 lines were never reachable from the entry point, so Rollup already excluded them — the win is source/typecheck/audit weight, not shipped bytes) |
| Dashboard CSS | 51.66 kB raw / 10.27 kB gzip | 50.31 kB raw / 10.07 kB gzip | −1.35 kB raw (Tailwind's content scan had picked up class names from the dead files) |
| `public/` static assets | 7.1M | 6.6M | −480,714 bytes exact |
| Dead source lines removed | — | — | 1,048 lines, 4 files |
| Background timers/jobs found | 0 | 0 | Already zero — nothing to gate |
| DB connections | 1 shared | 1 shared | Already correct |
| Build duration (`npm run build`) | ~12.3s | ~10s (typical run) | No meaningful change — build was never slow |
| Idle RAM/CPU | Not separately re-benchmarked | — | No server-side code path changed (only manifests and static assets), and the removed dependencies were never `require`'d, so there is no runtime code-path difference to benchmark. Correctness was verified functionally instead: `npm start` against the fully-pruned `node_modules` served `/api/health`, `/api/ready`, `/`, and `/dashboard` correctly. |

## Test results (before vs. after every change, run repeatedly through this session)

| Suite | Before | After |
|---|---|---|
| `vitest run` | 41/41 passed | 41/41 passed |
| `node --test backend/test/*.test.js` | 23/23 passed | 23/23 passed |
| `node --test tests/security/*.test.js` | 14/15 passed (1 pre-existing, unrelated failure) | 14/15 passed (same failure, unchanged) |
| `npm run typecheck` | clean | clean |
| Playwright WebKit (`storefront`, `splash-lifecycle`, `menu`, `bilingual-cart`) | 3 failed / 112 passed / 7 skipped — reproduced identically on the unmodified commit via `git stash` (external `fonts.googleapis.com` fetch failing as a 500 in this sandboxed network) | Same 3 pre-existing failures, same 112 passing — confirmed via direct stash-based A/B comparison, not assumed |
| Playwright commerce/account/receipt | Cannot run (pre-existing harness/config incompatibility, unrelated files) | Same — not touched |
| Fresh `npm install` + `npm run build:deploy` + `npm start` smoke test | N/A (didn't exist before) | `/api/health`, `/api/ready`, `/`, `/dashboard` all correct against the pruned artifact |

## Remaining opportunities (not applied, for the record)

1. **Try removing `aptPkgs` from `nixpacks.toml`** on the next deploy — likely
   removes an unnecessary `python3`/`build-essential` install from the build
   phase now that `better-sqlite3` ships prebuilt binaries. Cheap to test,
   cheap to revert; not applied here because it's unverifiable without a
   live Railway build.
2. **Fix the commerce E2E harness** (`backend/test/e2e-server.js`) to match
   the current `config.js` schema, so that suite can run again. Separate,
   non-trivial task — touches `mailer.js`'s production gating logic.
2. **Fix the pre-existing `..%2Fsecrets` validation gap** (404 instead of
   400) in the admin route path handling — a real, if minor, correctness
   issue independent of this pass.
3. **A proper favicon crop** — `/img/logo.webp` is a landscape wordmark
   (577×303), not a square icon. It's now the *correct, smaller* asset
   instead of the raw screenshot, but a dedicated square icon (via
   `docs/cut-logo.py`-style tooling) would look better in a browser tab.
   Not attempted here since it's a new visual-design decision (a crop that
   doesn't exist yet), not a pure weight optimization, and the spec is
   explicit that visual changes need separate approval.

## Files changed this pass

```
 dashboard-src/index.html                           |  favicon → logo.webp
 dashboard-src/src/components/ImagePicker.tsx        | deleted (150 lines)
 dashboard-src/src/components/ProductDialog.tsx      | deleted (427 lines)
 dashboard-src/src/components/ProductFields.tsx      | deleted (305 lines)
 dashboard-src/src/lib/productForm.ts                | deleted (166 lines)
 index.html                                          |  favicon → logo.webp
 package.json                                        |  −bcryptjs, −jsonwebtoken, +build:deploy script
 package-lock.json                                   |  regenerated
 public/img/menu/ai/*.webp (19 files)                | deleted (480,714 bytes)
 railway.json                                        |  buildCommand → npm run build:deploy
 docs/LEAN_BASELINE.md                               | new
 docs/DEPENDENCY_AUDIT.md                            | new
 docs/LEAN_OPTIMIZATION_REPORT.md                    | new (this file)
```

**Not pushed or deployed.** Everything above is committed locally on `main`
only, per instruction. The `build:deploy` / `railway.json` change has been
tested end-to-end locally (build → prune → start → smoke test) but never
against an actual Railway/Nixpacks Linux build — recommend watching the next
deploy's build logs before considering it fully proven in production.
