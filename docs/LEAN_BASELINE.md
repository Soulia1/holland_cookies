# Lean production baseline — Holland Cookies

Measured 2026-09-11 on commit `44e415c`, before any optimization changes, on this
machine (`D:\Web\holland_cookies`, Node v24.14.1, Windows).

## Architecture (confirmed, not assumed)

This is **not** a TanStack Start / Nitro / Redis application. It is:

- **Storefront**: React 19 + Vite 7 SPA, client-routed with `wouter`, built to `dist/`.
- **Admin dashboard**: a *second, fully separate* React + Vite SPA in
  `dashboard-src/`, built to `dist-dashboard/`, served only under `/dashboard`.
  Two builds, one Express server, one origin — the customer never fetches a
  byte of admin code. This isolation (spec sections 29/104) already existed.
- **Backend**: a single Express 5 process (`backend/server.js`, 97 lines),
  SQLite via `better-sqlite3` through one shared connection (`backend/db.js`).
- **No Redis, no queues, no worker processes, no Docker.** Deployment is
  Railway + Nixpacks (`railway.json` + `nixpacks.toml`), not a Dockerfile.
- **No CI configured** (`.github/workflows` does not exist).

Sections of the original audit spec that assume Redis, TanStack routing,
Nitro output, or Docker multi-stage builds are **not applicable** here and are
noted as such in the final report rather than forced onto this stack.

## SOURCE

| Metric | Value |
|---|---|
| Tracked files (git) | 320 |
| TS/TSX files | 94 |
| JS/JSX files | 20 |
| Runtime dependencies | 22 |
| devDependencies | 13 |
| Resolved packages (package-lock.json) | 392 |
| Installed packages (node_modules top-level) | 228 |
| node_modules size (full, incl. devDeps) | 238M |
| node_modules size (`npm prune --omit=dev`) | 106M |
| Working tree excl. node_modules/.git (incl. gitignored local artifacts) | 90M |
| True git repository size (`git count-objects -vH`) | 13.36 MiB |
| `tools/flow-out/` (gitignored AI-render intermediates, local only) | 68M |
| `public/` (shipped static assets) | 7.1M |
| `Menu_images/` (source photography, not shipped — see note) | 3.5M |

## BUILD

| Metric | Value |
|---|---|
| Production build duration (`npm run build`, both apps) | ~12.3s wall (2.73s storefront + 3.90s dashboard vite) |
| Storefront (`dist/`) total | 6.6M |
| Dashboard (`dist-dashboard/`) total | 484K |
| Storefront initial-route JS (index + motion + app entry) | 269.81 + 135.35 + 38.11 = 443.27 kB raw / ~142 kB gzip |
| Storefront lazy route chunks (Cart/Pan/Track/MenuDetail/Account/Checkout) | 2.84 / 3.48 / 4.86 / 6.43 / 8.31 / 14.27 kB — already code-split |
| Storefront CSS | 101.77 kB raw / 19.68 kB gzip |
| Dashboard bundle (single chunk, never sent to customers) | 436.05 kB raw / 135.79 kB gzip |
| Dashboard CSS | 51.66 kB raw / 10.27 kB gzip |
| Largest static asset | `public/img/logo.jpg` used as favicon: 140 KB for a browser tab icon |

## RUNTIME (backend/server.js audit, not guessed)

| Question | Finding |
|---|---|
| `setInterval` / cron / scheduler anywhere in `backend/` | **None found.** |
| Background workers / `worker_threads` / `child_process` | **None found.** |
| WebSocket / SSE / file watchers | **None found.** |
| `setTimeout` calls | **One**, in the graceful-shutdown path (`server.js:93`), `.unref()`'d — cannot keep the process alive by itself. |
| DB connections | **One** shared `better-sqlite3` handle (`backend/db.js`), confirmed the only `new Database(...)` call in the repo. |
| Redis clients | **N/A — no Redis dependency exists.** |
| Startup work | Opens the DB handle, reads two `index.html` files once to compute CSP script hashes, binds the port. No migrations-on-boot, no seeding-on-boot (seed is a separate explicit `npm run seed`), no test/dev tooling invoked. |
| Global middleware before static assets | Only `compression`, `helmet`, `cors` — all header-only/cheap. Rate limiting, `originGuard`, and body validation are scoped to `/api` only; static asset and homepage requests never touch the DB or the rate limiter. |
| Health check cost | `/api/health` (used by Railway) does zero DB work. `/api/ready` does one trivial `SELECT 1`. |

**Conclusion of the runtime audit: the web process was already quiet at idle.**
There is no background work to gate behind an `ENABLE_BACKGROUND_JOBS` flag
because there is no background work.

## Known pre-existing issue (not introduced by this pass)

`tests/security/security.test.js`, the "validation: malformed JSON..." test,
already failed before any change in this session:

```
GET /api/menu/admin/products/..%2Fsecrets  → expected 400, got 404
```

This is a pre-existing gap in how that admin route rejects an encoded
path-traversal segment (falls through to the router's 404 instead of an
explicit 400). It is unrelated to dependency/asset weight and is **not fixed
by this pass** — flagged here as the honest baseline, and re-verified
unchanged (not newly broken) after every change below.
