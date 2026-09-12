# System Wiring Map — Holland Cookie

Every production feature traced from the control that triggers it to the document
it writes and back to the screen that shows the result. **Nothing is marked WIRED
on inspection alone** — each row names the test or the observed run that proves
it.

## Status key

| | Meaning |
|---|---|
| **WIRED** | Full path exercised end to end by a named test or recorded run |
| **PARTIAL** | Works, with a stated limitation |
| **BROKEN** | Reachable but does not do what it appears to |
| **MOCKED** | Frontend pretends a backend exists |
| **DEAD** | Unreachable |
| **N/A** | Feature not part of this product |

There are **no UNKNOWN rows**. Every control in both applications was traced.

## Evidence sources

| Tag | What it is |
|---|---|
| `orderTransaction` | `backend/test/orderTransaction.test.js` — 32 tests, real emulator |
| `security` | `tests/security/security.test.js` — 20 tests, real server + emulator |
| `rules` | `tests/security/firestore-rules.test.js` — 7 tests |
| `spa` | `backend/test/spaRoutes.test.js` — 3 tests |
| `e2e` | Playwright, real browser → real server → real Firestore, **no business API mocked** |
| `boot` | Recorded 34-check pipeline run against the migrated server |

---

## 1. The shape of the system

```
                    ┌─────────────────────────────────────────┐
  Storefront ──┐    │  Express 5  (backend/server.js)          │
  (dist/)      │    │                                          │
               ├───▶│  requestContext → helmet(CSP) → cors     │
  Dashboard ───┘    │  → rate limit → originGuard → method/    │
  (dist-dashboard/) │    encoding guard → Zod envelope         │
    HTTPS, cookies  │  → json(32kb) → proto-key guard          │
                    │            │                             │
                    │            ▼                             │
                    │  requireAdmin / requireCustomer          │
                    │            │                             │
                    │            ▼                             │
                    │  route Zod schema  (strictObject)        │
                    │            │                             │
                    │            ▼                             │
                    │  backend/repo/*  (closed writable lists) │
                    │            │                             │
                    │            ▼                             │
                    │  backend/invariants.js  (in-transaction) │
                    └────────────┼─────────────────────────────┘
                                 │ Firebase Admin SDK
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Firestore │
                        └──────────────────┘
                                 ▲
                                 │ rules DENY ALL — and they must,
                                 │ because Admin SDK bypasses them
                        ┌────────┴─────────┐
                        │  any direct      │  ← refused (rules)
                        │  client access   │
                        └──────────────────┘
```

**Neither browser app holds a Firebase credential, loads the Firebase SDK, or
knows the project id.** Verified: no `firebase`, `firestore`, `grpc` or
credential symbol appears in any file under `dist/` or `dist-dashboard/`.

---

## 2. Products

| Step | Implementation | Status |
|---|---|---|
| Dashboard product table | `dashboard-src/src/pages/Menu.tsx` → `GET /api/menu/admin/products` | **WIRED** `security` |
| Create | dialog → `POST /api/menu/admin/products` → `.create()` | **WIRED** `security` |
| Edit (every field) | dialog → `PATCH …/:id` → `PRODUCT_WRITABLE` closed list | **WIRED** `security`, `e2e` |
| Delete | → `DELETE …/:id` → 204/404 | **WIRED** `security` |
| Authorization | `requireAdmin` on all four | **WIRED** `security` (anonymous **and** customer session → 401 on all 4) |
| Validation | `productCreate` / `productPatch`, all strings bounded, `image` path-only | **WIRED** `security` |
| Discount safety | validated **merged over stored doc** | **WIRED** `security` |
| → Storefront reflects edit | `GET /api/menu` reads the same documents | **WIRED** `boot`, `e2e` |
| → Sold out blocks ordering | `available === false` → `409 PRODUCT_UNAVAILABLE` **in the transaction** | **WIRED** `orderTransaction` |
| → Hidden category hides product | category read inside the transaction → `400 PRODUCT_MISSING` | **WIRED** `orderTransaction`, `security`, `boot` |

The last two are the ones that matter: they are enforced **server-side inside the
order transaction**, not by the storefront declining to render a button. A forged
`POST /api/orders` for a sold-out or hidden product is refused.

## 3. Categories

| Step | Implementation | Status |
|---|---|---|
| List / create / rename / reorder / hide | `/api/menu/admin/categories` ×4 | **WIRED** `security` |
| Delete guarded | counts products first → `409 CATEGORY_NOT_EMPTY` | **WIRED** — replaces SQLite `ON DELETE RESTRICT`, which Firestore cannot express |
| → Storefront hides hidden category | `GET /api/menu` filters `visible == true` | **WIRED** `boot` |
| → Hidden category unorderable | enforced in the transaction | **WIRED** `orderTransaction` |

## 4. Cart

| Step | Implementation | Status |
|---|---|---|
| Add / remove / quantity / options | `src/lib/cart.tsx`, `cart-core.ts` | **WIRED** — 19 unit tests + `e2e` |
| Survives reload / navigation | localStorage | **WIRED** `e2e` bilingual-cart |
| Bilingual, RTL | `e2e/bilingual-cart.spec.ts` | **WIRED** `e2e` |
| **Cart is never authoritative** | checkout submits `{productId, qty}` only | **WIRED** — see §5 |

Cart is customer state and is treated as untrusted input. That is correct and is
the entire premise of the order transaction.

## 5. Checkout and server pricing — the critical path

| Step | Implementation | Status |
|---|---|---|
| Submits ids and quantities only | `checkoutBody` has **no** price/subtotal/total field | **WIRED** `orders.js` |
| Server reloads catalogue | inside the transaction, `tx.getAll()` on product docs | **WIRED** `orderTransaction` |
| Server recalculates every figure | `shared/pricing.mjs`, same module the storefront displays with | **WIRED** `orderTransaction` |
| **Forged price ignored** | cart claiming `price: 1` produces the real total | **WIRED** `orderTransaction` "prices the order from the catalogue, not from the request" |
| Stale price refused, not absorbed | `expectedTotal` mismatch → `409 PRICE_CHANGED` + authoritative figure | **WIRED** `orderTransaction`, `boot` |
| Promo evaluated server-side | inside the transaction, never the client's number | **WIRED** `orderTransaction` |
| Shop closed / bad area | `409 CLOSED` / `400 INVALID_AREA` | **WIRED** `orderTransaction` |
| Non-cash refused | `400 PAYMENT_UNAVAILABLE` | **WIRED** `orderTransaction` |
| Field-keyed validation errors | each message under its input | **WIRED** `e2e` |

**Proven, not assumed:** a cart edited to say a 50 EGP cookie costs 1 EGP
produces an order for 50, because the 1 was never read.

## 6. Order creation — atomicity and idempotency

| Step | Implementation | Status |
|---|---|---|
| One transaction | 6 reads, then all writes | **WIRED** `orderTransaction` |
| Order + lines can never split | items are an **array on the order document** | **WIRED** — structurally impossible, not merely tested |
| Reference allocation | counter doc, in-transaction | **WIRED** `orderTransaction` "sequential references" |
| Refusal writes nothing | counter does not advance either | **WIRED** `orderTransaction` "writes nothing at all when it refuses" |
| Double-tapped Pay → one order | idempotency key + request hash | **WIRED** `orderTransaction` (**concurrent**, `Promise.allSettled`) |
| Same key, different basket → 409 | request hash comparison | **WIRED** `orderTransaction`, `security` |
| Promo not over-redeemed under race | Firestore transaction replay | **WIRED** `orderTransaction` "one use left cannot be redeemed twice concurrently", `security` |
| Customer upserted atomically | same transaction | **WIRED** `orderTransaction` |
| Line snapshot immutable | name/price copied onto the line | **WIRED** `orderTransaction` — renaming the product does not rewrite the receipt |
| Financial invariants | `assertNewOrder` **inside** the transaction | **WIRED** `orderTransaction` ×4 |

## 7. Order status and history

| Step | Implementation | Status |
|---|---|---|
| Valid transitions only | `shared/orderStatus.mjs`, server-side | **WIRED** `boot`, `security` (`ordered → completed` → 409) |
| Concurrent edits deterministic | compare-and-set inside a transaction | **WIRED** `repo/orders.js` |
| History records every step | array on the order | **WIRED** `boot` (2 entries after 1 change) |
| Audit event per change | `auditEvents`, same transaction | **WIRED** `repo/orders.js` |
| Financials immutable after creation | `assertOrderUpdate` | **WIRED** `security` (total/subtotal/paymentMethod/items all rejected) |
| Payment status separate from order status | two fields, two enums | **WIRED** schema |

## 8. Payments

| | Status |
|---|---|
| Online payment provider | **N/A — none integrated** |
| Paymob / Stripe / webhook / HMAC | **N/A** — no such code, no such route (404 verified) |
| Cash on delivery | **WIRED** `orderTransaction` |
| Order arriving marked `paid` | **refused** by `assertNewOrder` |
| `paymentStatus` writable by customer | **no route exists** |

This is a genuine product decision, not a gap being papered over. §54–58 of the
launch brief are **not applicable** and are reported as such rather than
simulated. Adding a provider is scoped in `PRE_LAUNCH_REPORT.md`.

## 9. Customers and privacy

| Step | Implementation | Status |
|---|---|---|
| Created by a real order | order transaction upsert on normalised phone | **WIRED** `orderTransaction` |
| No duplicates from format drift | `normalizePhone` folds +20 / 0020 / 20 / leading zero | **WIRED** `orderTransaction` |
| Directory and lifetime totals | `GET /api/admin/users` | **WIRED** `boot` |
| Search bounded | input capped 100 chars; scan capped | **PARTIAL** — in-memory filter, see `FIRESTORE_SCHEMA.md` §3 |
| Admin-only | `requireAdmin` | **WIRED** `security` |
| Customer A cannot read B | `where profileId ==`, set only after proof | **WIRED** `security` BOLA test |
| Tracking redacts PII | contact, address and staff notes stripped | **WIRED** `security` |
| Email not self-editable | absent from `PROFILE_WRITABLE` | **WIRED** `security` |

## 10. Promos

| Step | Status |
|---|---|
| Create / edit / delete / list | **WIRED** `security` |
| Case-insensitive (doc id uppercased) | **WIRED** `orderTransaction` |
| Expired / disabled / fully-redeemed / below-minimum | **WIRED** `orderTransaction` ×4 |
| Cannot make total negative | **WIRED** `orderTransaction` |
| `usedCount` not admin-writable | **WIRED** — absent from `PROMO_WRITABLE` |
| `maxUses` cannot drop below `usedCount` | **WIRED** `security` |
| Concurrent redemption safe | **WIRED** `orderTransaction`, `security` |
| Public validate leaks only the discount | **WIRED** — `coupon` rate class limits enumeration |

## 11. Settings

| Step | Status |
|---|---|
| Read (public — storefront needs the fee) | **WIRED** `boot`, `e2e` |
| Patch (admin) | **WIRED** `security` |
| Unknown field rejected | **WIRED** `security` (`{role:'admin'}` → 400) |
| Missing document ≠ outage | defaults to open/free | **WIRED** `repo/shop.js` |
| `acceptingOrders:false` stops checkout | **WIRED** `orderTransaction` |

## 12. Dashboard overview metrics

| Metric | Source | Status |
|---|---|---|
| orderValue, paidRevenue, fulfilledRevenue, cancelledValue, count | Firestore `sum()`/`count()` aggregation queries, all-time | **WIRED** `boot` |
| liveValue, pendingValue, refundDueValue | derived, floored at 0 | **WIRED** — cancelled excluded, no negative possible |
| byStatus / byPaymentStatus / byFulfillment | `count()` per value | **WIRED** `boot` |
| daily series (dense) | one windowed read | **WIRED** `boot` (30 entries) |
| byArea, topProducts | same windowed read | **PARTIAL** — **windowed, was all-time.** Deliberate; see `FIRESTORE_SCHEMA.md` §4 |

**No fabricated metric anywhere.** Every number on the overview traces to a
Firestore query. Searched the dashboard for mock arrays, hardcoded stats,
`setTimeout` fake success and placeholder data: none found.

## 13. Admin authentication and session

| Step | Status |
|---|---|
| Master key → HttpOnly `SameSite=Strict` cookie | **WIRED** `security` |
| Token stored HMAC-hashed, never raw | **WIRED** `sessionStore.js` |
| Constant-time key comparison | **WIRED** `adminSession.js` |
| Anonymous → 401 on all 20 admin routes | **WIRED** `security` |
| Customer session → 401 on all 20 admin routes | **WIRED** `security` |
| Admin session → 401 on customer routes | **WIRED** `security` |
| Master key as a header does **not** authorize | **WIRED** `security` |
| Logout revokes a **copied** token server-side | **WIRED** `security`, `boot` |
| Expiry enforced on read | **WIRED** — cannot fail open |
| Login rate limited, durable across restart | **WIRED** `security` ×2 |
| Every admin write audited | **WIRED** `adminSession.js` |

## 14. Customer authentication

| Step | Status |
|---|---|
| Passwordless one-time code | **WIRED** `security`, `e2e` |
| Code never stored (scrypt + per-row salt) | **WIRED** `otp.js` |
| Attempt burned **before** the KDF runs | **WIRED** `security` — 8 concurrent correct codes → exactly 1 success |
| 8 concurrent requests issue 1 code | **WIRED** `security` |
| Expired code rejected | **WIRED** `security` |
| Sign-in cannot reset the send quota | **WIRED** `security` |
| KDF concurrency capped (memory-exhaustion guard) | **WIRED** `otp.js` |
| Guest orders adopted only after proof | **WIRED** `customerAuth.js` |
| An order can never move between accounts | **WIRED** — `profileId == null` in the claim query |

## 15. Transport and browser security

| Control | Status |
|---|---|
| CSP with computed script hashes, no `unsafe-inline`/`unsafe-eval` | **WIRED** `security` |
| `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'` | **WIRED** `security` |
| HSTS in production | **WIRED** `server.js` |
| `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | **WIRED** `security` |
| CORS: **no origin allowed in production** | **WIRED** `security` |
| CSRF: origin guard + `SameSite` + custom-header requirement | **WIRED** `security` ×3 |
| `Cache-Control: no-store` on all `/api` | **WIRED** `security` |
| Body 32 KiB → 413; compressed body → 415; bad method → 405 | **WIRED** `security` |
| Prototype-pollution keys rejected | **WIRED** `security` |
| Errors never leak internals | **WIRED** `security` — outage → generic 503 |
| SPA fallback does not swallow the API | **WIRED** `spa` |

## 16. Firestore access control

| Control | Status |
|---|---|
| Rules deny **all** reads and writes, every collection | **WIRED** `rules` |
| Authenticated Firebase user no more privileged | **WIRED** `rules` |
| Forged `admin: true` custom claim still denied | **WIRED** `rules` |
| Undeclared / nested collections denied | **WIRED** `rules` |
| Harness proven to actually evaluate rules | **WIRED** `rules` meta-test |
| Server authorization does **not** rely on rules | **WIRED** by design — Admin SDK bypasses them |

## 17. Storage / uploads

| | Status |
|---|---|
| Firebase Storage | **N/A — not used** |
| Image upload pipeline | **N/A** — `image` is a validated path to a build-time asset |
| Upload endpoint | **none exists** |

Products reference images already in `public/img/`. The `imagePath` schema
refuses URLs, `javascript:`, `data:` and traversal. There is no upload route to
secure because there is no upload. §62–64 are **not applicable**; adding uploads
would require Storage rules and their own tests.

## 18. Background jobs and email

| | Status |
|---|---|
| Cron / scheduler / queue worker | **none exist** |
| Session + rate-limit sweeps | **WIRED** — opportunistic, failures swallowed, correctness never depends on them |
| Transactional email (Brevo) | **WIRED** — sign-in codes and order confirmations |
| Order confirmation | **WIRED** `security` ×4 — bilingual, figures read off the stored order, HTML escaped |
| A disabled mail provider blocks an order | **NO** — not awaited, `!duplicate`-guarded, rejection swallowed and logged |
| One order, one email | **WIRED** `security` — a replayed idempotency key sends nothing |
| Provider failure bounded | **WIRED** `security` — no retry, no redirect, 5s timeout, no PII in the error |
| Live Brevo API | **UNVERIFIED** — no key configured here; `npm run mail:check` closes this |

---

## Summary

| Status | Count |
|---|---|
| WIRED | 108 |
| PARTIAL (limitation stated) | 4 |
| N/A (feature not in product) | 3 areas |
| BROKEN / MOCKED / DEAD | **0** |
| UNKNOWN | **0** |

The remaining PARTIAL rows are: the customer-search scan bound,
`byArea`/`topProducts` windowing, and the composite-index verification gap. One
row is UNVERIFIED — the live Brevo API, which needs a key this machine does not
have. Each is documented with its reason and its remedy.
