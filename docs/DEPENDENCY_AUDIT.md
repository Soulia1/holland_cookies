# Dependency audit — Holland Cookies

Every entry in `package.json` at commit `44e415c`, classified by actual grep
evidence (import sites), not by assumption. "Import locations" counts are
`grep -rl` hits across `src/`, `backend/`, `dashboard-src/`, `shared/`
(excluding `node_modules`).

## Runtime (`dependencies`)

| Package | Type | Why present | Import locations | In production bundle? | Verdict | Evidence |
|---|---|---|---|---|---|---|
| `@radix-ui/react-dialog` | Runtime | Admin dialog primitive | 4 (dashboard-src) | Dashboard only, never storefront | Keep | Used by `dashboard-src/src/components/ui/dialog.tsx` and dialogs built on it |
| `@radix-ui/react-dropdown-menu` | Runtime | Admin dropdown | 1 (dashboard-src) | Dashboard only | Keep | `ui/dropdown-menu.tsx` |
| `@radix-ui/react-slot` | Runtime | `asChild` pattern for `Button` | 1 (dashboard-src) | Dashboard only | Keep | `ui/button.tsx` |
| `bcryptjs` | Declared, never imported | — | **0** | No | **Removed** | Auth (`backend/adminSession.js`, `customerAuth.js`, `otp.js`) uses `node:crypto` (`scrypt`, `timingSafeEqual`, `createHmac`) exclusively. Zero import of `bcryptjs` anywhere. |
| `better-sqlite3` | Runtime | The database | 1 (`backend/db.js`) | Server only | Keep | Single shared connection, confirmed the only `new Database(...)` call in the repo |
| `class-variance-authority` | Runtime | Dashboard `ui/button.tsx` variants | 1 (dashboard-src) | Dashboard only | Keep | |
| `clsx` | Runtime | Class merging | 1 (dashboard-src) | Dashboard only | Keep | |
| `compression` | Runtime | Response gzip | 1 (`server.js`) | Server only | Keep | |
| `cookie-parser` | Runtime | Session cookies | 1 (`server.js`) | Server only | Keep | |
| `cors` | Runtime | CORS policy | 1 (`server.js`) | Server only | Keep | |
| `dotenv` | Runtime | Loads `.env` in dev/local | 1 (`server.js`) | Server only | Keep | |
| `express` | Runtime | The HTTP server | 6 files | Server only | Keep | |
| `express-rate-limit` | Runtime | Rate limiting (`backend/security.js`) | 1 | Server only | Keep | |
| `framer-motion` | Runtime | Modal/detail animation, split into its own lazy chunk | 3 (`MenuItemDetail`, `PanDetail`, motion tokens) | Storefront, **already isolated to a separate chunk**, not eagerly loaded on first paint (`vite.config.ts` manualChunks) | Keep | Team already documented and avoided this cost elsewhere (`src/index.css:1289`, the category-indicator comment) — this is deliberate, not oversight |
| `helmet` | Runtime | Security headers, CSP | 1 (`server.js`) | Server only | Keep | Non-negotiable per spec §65 |
| `jsonwebtoken` | Declared, never imported | — | **0** | No | **Removed** | Sessions are opaque HMAC-signed tokens via `backend/sessionStore.js` (`node:crypto`), not JWTs. Zero import anywhere. Removing it also dropped 12 transitive packages (`jws`, 7× `lodash.*`, `ms`, `semver`). |
| `lucide-react` | Runtime | Icons | 17 files, **all in `dashboard-src/`, zero in storefront** | Dashboard only | Keep | All imports are named (`import { X } from 'lucide-react'`), already tree-shakeable — no `import * as Icons` pattern anywhere |
| `react` / `react-dom` | Runtime | The framework | 50 / 2 | Both apps | Keep | |
| `tailwind-merge` | Runtime | Dashboard class merging | 1 (dashboard-src) | Dashboard only | Keep | |
| `wouter` | Runtime | Storefront router | 8 | Storefront | Keep | |
| `zod` | Runtime | Server-side request validation | 6 backend files, **0 frontend** | Server only, confirmed absent from every `dist/assets/*.js` (`grep -c "ZodError"` = 0 in all chunks) | Keep | Correctly never reaches the client bundle |

## Dev (`devDependencies`)

All 13 (`@playwright/test`, `@tailwindcss/vite`, `@testing-library/dom`,
`@testing-library/react`, `@types/node`, `@types/react`, `@types/react-dom`,
`@vitejs/plugin-react`, `jsdom`, `tailwindcss`, `typescript`, `vite`,
`vitest`) are genuinely build/test-only — none are imported by
`backend/server.js` or any file that ships to production. Correctly
classified already; nothing to move.

**But they were shipping to the production container anyway** — see
"Production install" below.

## Production install (the real finding, not a `package.json` misclassification)

`nixpacks.toml` runs `npm ci --include=dev` (needed because `vite`,
`tailwindcss`, `typescript` are devDependencies but the *build* needs them,
and Railway sets `NODE_ENV=production`, which would otherwise make `npm ci`
skip devDependencies before the build ever runs). There was no step
afterward to drop devDependencies once the build was done, and Nixpacks
builds a single image — the same `node_modules` that built the app is the
one that runs it.

Measured on this machine: **238M → 106M** (`npm prune --omit=dev`, before
touching any other dependency) — devDependencies were roughly **55% of the
shipped `node_modules`**, none of it reachable from `node backend/server.js`.

Fixed by adding `"build:deploy": "npm run build && npm prune --omit=dev"` and
pointing `railway.json`'s `buildCommand` at it instead of `npm run build`
(left untouched, so local `npm run build` still leaves your dev tools
installed). Verified locally end-to-end: fresh `npm run build:deploy`, then
`npm start` against the pruned `node_modules` — `/api/health`, `/api/ready`,
`/`, and `/dashboard` all respond correctly.

## Transitive vulnerabilities (pre-existing, not touched)

`npm audit` reports 3 moderate findings, none introduced or fixed by this
pass:

- `qs` (via `express@5.2.1` → `body-parser`) — a required transitive
  dependency of Express itself, not independently removable. `server.js`
  already sets `app.set('query parser','simple')`, which avoids Express's
  extended (`qs`-based) query parsing — the vulnerable path is already
  unused by this app's own configuration.
- `@vitest/mocker` (via `vitest`) — devDependency only, never in the
  production runtime graph.

Both would require a major-version bump (`express@5`→newer patch line once
available, or `vitest@5`) to clear, which is a dependency-upgrade decision
outside this audit's mandate (spec §124: don't rewrite/upgrade without being
asked). Flagged for awareness, not silently fixed.

## Not applicable to this codebase

The audit spec assumes Redis, TanStack routing, and a Nitro/Docker
deployment. None of that exists here:

- No `redis`/`ioredis` dependency anywhere — sections on Redis client
  consolidation, pub/sub, and cache layers are N/A.
- No Dockerfile, no `.dockerignore` needed — deployment is Railway +
  Nixpacks only.
- No TanStack Start/Router — routing is `wouter`; there is no generated
  `routeTree.gen.ts` to protect.
