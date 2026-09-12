# Pre-Launch Baseline — Holland Cookie

Frozen before any modification in the pre-launch production readiness pass.

## Repository state at freeze

| Field | Value |
|---|---|
| Branch | `main` |
| Commit | `f77b545d2f842d316a0489243c0ae964ced0a0a6` |
| Subject | `docs(lean): record baseline, dependency audit, and before/after report` |
| Working tree | **clean** — no uncommitted work was mixed into this pass |
| Remote | `origin https://github.com/Soulia1/holland_cookies.git` |
| Date frozen | 2026-09-12 |

Last 20 commits recorded via `git log --oneline -20`; the tree was verified clean
with `git status --porcelain` returning empty output before the first edit.

## Actual architecture at freeze

The brief for this pass assumed Firebase/Firestore + Paymob. **Neither was
present at `f77b545`.** What the repository actually contained:

| Layer | Reality at freeze |
|---|---|
| Persistence | **SQLite** via `better-sqlite3` ^13.0.3, single file, WAL mode |
| Schema management | 5 hand-rolled migration steps keyed on `PRAGMA user_version` (`backend/db.js`) |
| Server | Express 5 (`backend/server.js`, 97 lines) |
| Storefront | React 19 + Vite + wouter, built to `dist/` |
| Dashboard | Separate React 19 + Vite app, built to `dist-dashboard/`, served at `/dashboard` |
| Admin auth | Shared master key → HttpOnly `SameSite=Strict` session cookie; token stored HMAC-hashed in `sessions` table |
| Customer auth | Passwordless email OTP (scrypt-hashed codes) → 30-day session cookie |
| Payment | **None integrated.** Cash on delivery only; `orderTransaction.js:104` rejects any non-cash method with `PAYMENT_UNAVAILABLE` |
| Firebase artifacts | **Absent** — no `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `.firebaserc`; no Firebase package installed |

`backend/db.js:4-12` documents the SQLite choice deliberately, citing the absence
of a Google Cloud service account.

### Direction chosen for this pass

The Firebase/Paymob mismatch was raised before any code was touched. The decision
taken was:

- **Migrate persistence to Firestore.** (confirmed)
- **Cash on delivery only — no Paymob.** (confirmed)

Sections of the brief covering payment providers, webhooks, and HMAC callback
verification (§54–58, §78) are therefore **not applicable** and are reported as
such rather than simulated.

## Test baseline (measured at freeze, before any modification)

Commands run exactly as the repository defines them.

| Suite | Command | Result |
|---|---|---|
| Unit (frontend/shared) | `npx vitest run` | **41 passed**, 5 files, 0 failed |
| Backend integration | `node --test backend/test/*.test.js` | **23 passed**, 0 failed |
| **Total wired tests** | | **64 passed, 0 failed** |

### Suites that exist but do NOT run

| Suite | Lines | Status at freeze |
|---|---|---|
| `tests/security/security.test.js` | 139 | **Orphaned.** Matched by no npm script — `test:backend` globs only `backend/test/*.test.js`. Never executed in this repository. |
| `e2e/*.spec.ts` (7 files) | 2,318 | Playwright; require a built app + running server. Not part of `npm test`. |

Running the orphaned security suite manually for the first time:

```
node --test tests/security/security.test.js
→ tests 15 | pass 14 | fail 1
```

**Pre-existing failure**, present at `f77b545` and not introduced by this pass:

- `security.test.js:49` — asserts `GET /api/menu/admin/products/..%2Fsecrets`
  returns **400**; it actually returns **404**.
  Assessed as a *stale assertion, not a vulnerability*: the encoded traversal
  fails to match the `:id` route and falls through to the API 404 handler, so the
  request is still rejected and reaches nothing. The expectation predates
  Express 5 path handling.

This is the honest starting line: **64 passing, 1 failing, 1 suite of 139 lines
and 7 e2e specs totalling 2,318 lines not wired into any command.**

## Database file inventory at freeze

`data/` contained live and scratch SQLite files (`holland.db`, `e2e.db`,
`holland-lean-test2.db`, plus `-shm`/`-wal` siblings). These are gitignored
runtime artifacts, not source.

## Notes carried into the pass

1. The security suite must be wired into a command, not left orphaned (§127 — no
   false green).
2. The backend enforces `DEPLOYMENT_MODE=single-instance` in production config
   (`backend/config.js`), which is what makes the SQLite-backed rate limiter
   sound today; this constraint must be re-evaluated after the Firestore move.
3. Order financial invariants are currently enforced by **SQLite triggers**
   (`orders_insert_guard`, `orders_update_guard`, `items_insert_guard`,
   `audit_no_update`, `audit_no_delete`). Firestore has no equivalent, so these
   invariants must be re-homed into server-side code and rules, or they are lost
   in the migration. Tracked as a first-class migration risk.
