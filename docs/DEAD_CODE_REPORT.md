# Dead Code Report — Holland Cookie

Every removal in the pre-launch pass, with the evidence that made it safe.

**Nothing here was removed because a tool said so.** Each entry names how it was
proven unreachable, and every removal was followed by the full test suite,
including the security regression suite — §89 of the brief is explicit that
cleanup must not quietly delete an auth check, a validator or a rate limiter.

## Method

Four independent passes, because no single one is sufficient:

1. **Import-graph walk** — a real file walk over `src`, `dashboard-src`,
   `backend`, `shared`, `scripts`, `e2e`, `tests` and the config files, matching
   `from '…'`, `require('…')`, `import('…')`, config keys and npm-script
   references. (The first attempt at this shelled out to `grep` with nested
   quoting and reported *every* dependency as unused — a reminder that a tool
   saying "unused" is a hypothesis, not a finding.)
2. **Route inspection** — every mounted path enumerated and cross-referenced
   against `src/lib/api.ts` and `dashboard-src/src/lib/api.ts`.
3. **Bundle analysis** — grepping the built `dist/` and `dist-dashboard/` output
   for symbols that should not be there.
4. **Manual tracing** of anything the first three disagreed about.

---

## Removed

| File / package | Type | Why dead | How verified | Removed | Tests after |
|---|---|---|---|---|---|
| `backend/db.js` (393 lines) | **LEGACY / DUPLICATE IMPLEMENTATION** | The entire SQLite data layer — connection, pragmas, and five `user_version` migration steps. Superseded by `backend/firestore.js`. Keeping it would have meant two production database implementations in one tree, which is exactly the accident §79 warns about. | Grepped every `from './db.js'` / `from '../db.js'` importer and rewrote each; final grep returns zero non-comment references. | ✅ | 100 pass |
| `scripts/update-server.mjs` (92) | **DANGEROUS OLD SCRIPT** | A one-shot codemod that `fs.writeFileSync`s a hardcoded, SQLite-era `backend/server.js` over the real one. | Referenced by no npm script, no CI, no doc, no other file. | ✅ | 100 pass |
| `scripts/update-otp.mjs` (66) | **DANGEROUS OLD SCRIPT** | Same shape: overwrites `backend/otp.js` with a hardcoded SQLite version. | As above. | ✅ | 100 pass |
| `scripts/update-boundaries.mjs` (65) | **DANGEROUS OLD SCRIPT** | Rewrites `backend/customerAuth.js` **and mutates all four route files** — injecting an import line and string-replacing `z.object(` → `z.strictObject(`. | As above. | ✅ | 100 pass |
| `better-sqlite3` | **UNUSED DEPENDENCY** | The only consumer was `backend/db.js`. A native module with a compile step, dragged into every container build. | Import-graph walk: zero consumers after the migration. | ✅ | 100 pass |

**616 lines of source and one native dependency removed.**

### Why the three `update-*.mjs` scripts were the most important removal

They were not merely dead. They were **actively dangerous**, and their danger had
grown rather than decayed: each one hardcodes a complete pre-migration source
file and writes it over the current one. Running any of them today — out of
curiosity, or because a future contributor sees `scripts/` and assumes the
contents are useful — would have silently reverted the entire Firestore migration
to SQLite, in files that still looked plausible.

They also explain a cosmetic oddity in the four route files at baseline: each
began with a bare `import { validateParams, … }` line sitting *above* the file's
own doc comment. That was `update-boundaries.mjs` prepending it. The rewritten
routes no longer carry it.

---

## Examined and deliberately KEPT

§77 is explicit that infrastructure is not dead merely because React never
imports it. Everything below was flagged by the automated pass and kept after
tracing.

| Item | Flagged as | Actually |
|---|---|---|
| `dotenv` | unused | `import 'dotenv/config'` in `server.js` — a **side-effect import** with no binding, which a naive `from 'x'` matcher misses. |
| `typescript` | unused | Provides `tsc`, used by `npm run typecheck`. |
| `firebase-tools` | unused | Provides the `firebase` binary used by four npm scripts. |
| `jsdom` | unused | Requested by a **pragma**, not an import: `// @vitest-environment jsdom` at the top of `src/lib/langDirection.test.tsx`. |
| `@testing-library/dom` | unused | A declared **peer dependency** of `@testing-library/react`. |
| `@types/node`, `@types/react`, `@types/react-dom` | unused | Consumed by the compiler, never imported. |
| `firestore.rules`, `firestore.indexes.json` | not imported | Infrastructure. Deployed, not bundled. |
| `firebase.json`, `.firebaserc` | not imported | Emulator and project configuration. |
| `e2e/`, `tests/` | not imported by the app | Tests. |
| `docs/` | not imported | Documentation, including the threat model and attack surface. |
| `nixpacks.toml`, `railway.json` | not imported | Deployment configuration. |
| `Menu_images/` | not referenced by code | Business originals — the photographed source the menu crops came from. Not shipped (outside `public/`), and not the runtime's to delete. |

The four dependency false-positives are the reason this section exists. An
automated pass would have removed `dotenv`, `jsdom` and three `@types` packages
and broken the server boot, the DOM test and the typecheck — each in a way that
looks like an unrelated failure later.

---

## Examined and found NOT dead

| Suspected | Finding |
|---|---|
| Unused shadcn/Radix components (§85) | `dashboard-src/src/components/ui/` contains `dialog`, `dropdown-menu`, `button` — all three imported. No unused component collection was copied in. |
| Duplicate libraries (§84) | One HTTP layer (`fetch` + a thin `api.ts` per app), one validation library (`zod`), one router (`wouter`), one animation library (`framer-motion`), one icon set (`lucide-react`). No duplicates to consolidate. |
| Unused assets (§86) | Every file in `public/img/` is referenced from `src/` or `src/data/menuImages.ts`. The 19 superseded AI stand-in images were already removed at `8d5597d`, before this pass. |
| Legacy payment code (§78) | **None exists.** No payment provider was ever integrated. `/api/payments` and `/api/webhook` return 404, asserted by the security suite. |
| Legacy auth (§81) | **One** admin auth path. No `ADMIN_KEY` header fallback survives — the security suite asserts the master key sent as `x-admin-key` does **not** authorize. |
| Legacy dashboards (§80) | One dashboard. The orphaned duplicate product-edit dialog was already removed at `0bae584`. |
| Orphan API routes (§82) | All 36 endpoints have a consumer in one of the two frontends, the test suites, or are health probes. |
| Debug code (§88) | No `debugger`, no dev bypass, no seed endpoint, no mock admin. `DISABLE_ADMIN_AUTH` exists only as a variable the production config validator **refuses to let you enable**. |

---

## Fixed rather than removed

Three things were dead in the sense that mattered most — they never ran — but the
right response was to wire them up, not delete them.

| Item | Was | Now |
|---|---|---|
| `tests/security/security.test.js` (139 lines) | **Orphaned.** Matched no npm script; `test:backend` globbed only `backend/test/*.test.js`. Had never executed, and contained a stale assertion that was silently failing. | Ported to Firestore, expanded to 17 tests, wired into `npm run test:security` and `npm run test:all`. |
| `npm run test:e2e` | **Broken.** No `playwright.config.ts` existed, so bare `playwright test` fell through to `vite.config.ts` and died with *"Vitest failed to access its internal state"*. | A real `playwright.config.ts` covering all seven spec files. |
| Chromium E2E coverage | **Absent.** Both existing configs pinned `browserName: "webkit"`. | Every project runs on Chromium and WebKit. |

A test suite that cannot be run is worse than no test suite, because it is
counted. Deleting these would have been the wrong call in all three cases.

---

## Post-removal verification (§89)

The full suite was re-run after every removal:

```
vitest run                 41 passed
node --test backend/test/  35 passed
node --test tests/security/ 24 passed   ← includes 7 Firestore rules tests
                          ─────────────
                          100 passed, 0 failed, 0 skipped
```

Specifically re-confirmed present and working after cleanup, because these are
what §89 warns can vanish silently:

- `requireAdmin` on all 20 admin routes — anonymous **and** customer sessions denied
- Every Zod schema, including the merged-discount and unknown-field cases
- All nine rate-limit classes, including the durable ones
- Every security header, including CSP with computed script hashes
- The origin guard (CSRF) on all three of its refusal paths
- Firestore rules denying every collection to every caller

Plus, addressed in the same pass:

- Production dependency advisories: **3 moderate → 0** (`uuid` and `qs` pinned
  via `overrides`; the `uuid` chain reached production through
  `firebase-admin → @google-cloud/storage → gaxios`).
