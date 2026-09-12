# Firestore Schema — Holland Cookie

The authoritative description of the database. One datastore, one source of
truth: there is no second production store, no JSON fallback, and no hardcoded
catalogue anywhere in the running system.

Collection names are declared once, in `backend/firestore.js`, and referenced
through helper functions rather than string literals — Firestore creates
collections implicitly on first write, so a misspelled name never errors, it
just reads back nothing forever.

## Conventions

- **Field names are camelCase and identical to the API shape.** SQLite used
  snake_case columns and every route carried a hand-written mapping table
  (`{ categoryId: 'category_id', … }`) repeated in four places. Firestore has no
  column names to satisfy, so the mapping was deleted.
- **Natural keys are document ids** wherever one exists. This turns what were
  UNIQUE constraints into something Firestore can actually enforce, and turns a
  lookup into a direct `get()` instead of a query.
- **`.create()` rather than `.set()`** on anything that must not already exist.
  `set` silently overwrites, which is how "that id is taken" becomes "your
  colleague's category just vanished".
- **Money** is a number rounded to piastres by `shared/pricing.mjs`. See
  *Known limitations* below.
- **Timestamps** are Firestore `Timestamp`s written with `serverTimestamp()`,
  serialised to ISO strings at the API boundary.

---

## Collections

### `categories/{categoryId}`

Document id is the human-authored slug (`plain-cookies`), validated to
`^[a-z0-9-]+$` at the route.

| Field | Type | Notes |
|---|---|---|
| `name` | string | English display name |
| `nameAr` | string | Arabic; `''` falls back to English in the UI |
| `sort` | number | Positional, owned by `src/data/menu.ts` |
| `visible` | boolean | **Load-bearing.** A hidden category takes its products off the menu *and* makes them unorderable server-side |
| `createdAt` / `updatedAt` | Timestamp | |

### `products/{productId}`

Document id is the slug (`plain-vanilla`).

| Field | Type | Notes |
|---|---|---|
| `categoryId` | string | Reference to `categories`. **Not a foreign key** — see *Known limitations* |
| `name`, `nameAr` | string | |
| `description`, `descriptionAr` | string | |
| `note`, `noteAr` | string | |
| `price` | number | The **regular** price. Never overwritten by a discount |
| `image` | string | Path only, validated against `^/img/…\.(jpg\|png\|webp\|avif)$` |
| `discountEnabled` | boolean | |
| `discountType` | `'percent' \| 'fixed'` | |
| `discountValue` | number | |
| `available` | boolean | Sold out when false; enforced in the order transaction |
| `sort` | number | |
| `createdAt` / `updatedAt` | Timestamp | |

**Three discount fields and no stored sale price.** The selling price is always
derived by `effectivePrice()`, so turning a discount off restores the original
exactly, with nothing to clean up and no stale "was" price outliving the
promotion that set it.

Writable fields are a closed list in `repo/catalogue.js` (`PRODUCT_WRITABLE`).
That list is the mass-assignment guard: a field added to the route schema later
does not silently become writable.

### `orders/{reference}`

Document id **is** the reference (`HC-1001`). Allocated from a counter inside the
order transaction, so uniqueness is enforced by `.create()` failing.

| Field | Type | Notes |
|---|---|---|
| `reference` | string | Same as the doc id, duplicated for convenience |
| `seq` | number | The counter value. **Orders are ordered by this, not `createdAt`** — two orders in the same millisecond would otherwise have no stable order, and pagination over an unstable sort silently skips and repeats rows |
| `customerPhone` | string | Normalised, links to `customers` |
| `profileId` | string \| null | The proved email, set only by `claimProfile` |
| `firstName`, `lastName`, `phone`, `email` | string | Snapshot at order time |
| `fulfilment` | `'delivery' \| 'pickup'` | |
| `area`, `address`, `building`, `floor`, `apartment`, `landmark`, `notes` | string | |
| `lang` | `'en' \| 'ar'` | |
| `subtotal`, `discount`, `delivery`, `total` | number | **Every figure computed server-side.** Nothing a browser sent is stored here |
| `promoCode` | string | |
| `status` | enum | `ordered \| confirmed \| baking \| in_transit \| completed \| cancelled` |
| `paymentMethod` | `'cash'` | Cash on delivery only; the transaction rejects anything else |
| `paymentStatus` | `unpaid \| paid \| refunded` | Separate from `status` by design |
| `paymentRef` | string | Reserved; empty with no provider integrated |
| `items` | array\<OrderItem\> | See below |
| `history` | array\<StatusEntry\> | See below |
| `createdAt` / `updatedAt` | Timestamp | |

**`items` and `history` are arrays on the order, not subcollections.** This is
the most consequential modelling decision in the migration:

- It makes an order atomic *by construction*. §52 of the launch brief asks for
  protection against "order created but order items missing". With three
  collections that is a real failure mode you defend against with a transaction.
  With one document it is not expressible.
- Reading an order is one read instead of 1 + N. The dashboard list shows 25
  orders with their lines: 26 queries became 1.
- It lets `assertNewOrder` check the lines sum to the subtotal — a check SQLite
  could not perform because it spanned two tables. This is the one invariant
  that is **stronger** after the migration.

`OrderItem`: `{ productId, name, nameAr, note, unitPrice, qty, lineTotal }` —
the name and price are **copied onto the line**, so renaming or repricing a
cookie next month does not rewrite last month's receipts.

`StatusEntry`: `{ status, note, at }`.

### `customers/{phone}`

Document id is the normalised phone (`01XXXXXXXXX`). Created by placing an order.
Nobody proves they own a phone number — this is a label on an order, not an
identity.

| Field | Type | Notes |
|---|---|---|
| `firstName`, `lastName`, `email` | string | An empty email on a later order never erases one captured earlier |
| `ordersCount` | number | Incremented in the order transaction |
| `totalSpent` | number | |
| `createdAt` / `updatedAt` | Timestamp | |

### `profiles/{email}`

Document id is the lowercased, **proved** email address. An account, created on
first successful one-time-code sign-in.

| Field | Type | Notes |
|---|---|---|
| `fullName`, `phone`, `defaultArea`, `defaultAddress` | string | Backfilled from the most recent order on first sign-in |
| `createdAt` / `updatedAt` | Timestamp | |

The email is **not** a writable field (`PROFILE_WRITABLE` in `repo/people.js`).
Changing it would move the account to an address nobody has demonstrated they
control.

### `promos/{CODE}`

Document id is the **uppercased** code, so `welcome10` and `WELCOME10` are the
same document and case normalisation is enforced by the storage layer rather
than remembered at each call site.

| Field | Type | Notes |
|---|---|---|
| `type` | `'percent' \| 'fixed'` | |
| `value` | number | Percent must be < 100 |
| `minSubtotal` | number | |
| `maxUses` | number | 0 means unlimited |
| `usedCount` | number | **Not admin-writable.** A redemption ledger, incremented only inside the order transaction |
| `active` | boolean | |
| `expiresAt` | ISO string \| null | |
| `createdAt` | Timestamp | |

### `settings/shop`

A single document. Was one row with `CHECK (id = 1)`.

| Field | Type |
|---|---|
| `deliveryFee`, `freeDeliveryOver` | number |
| `acceptingOrders` | boolean |
| `areas` | array\<{ id, name, nameAr }\> |
| `updatedAt` | Timestamp |

A missing document reads as the defaults (open, free delivery, no area
restriction) rather than taking the shop down.

### `counters/orders`

`{ value: number }`. Order references are allocated from this rather than derived
from a document id, so they stay contiguous and readable over the phone.

### `orderIdempotency/{key}`

`{ requestHash, orderRef, createdAt }`. The hash binds the key to the *whole*
request, so the same key cannot be reused for a different basket.

### `sessions/{tokenHash}`

`{ kind: 'admin'|'customer', subject, expiresAt, createdAt }`.

The token is never stored — only an HMAC of it. A read of this collection is not
a list of working credentials. **Expiry is enforced on read, not by a sweeper**:
a sweeper that fails leaves sessions valid forever, a read-time check cannot fail
open.

### `otpCodes/{email}`

`{ codeHash, codeSalt, expiresAt, attempts, lastSentAt, sentHour, hourStart, sentDay, dayStart }`.

The code itself is never stored — only a scrypt hash with a per-row salt. The row
is retained after consumption so signing in cannot reset the per-address send
quota.

### `rateLimits/{hmacKey}`

`{ hits, resetAt }`. Keys are HMAC'd before becoming document ids: the raw key is
a client IP, which does not need to sit in a database in the clear to count
requests. Only the **strict** limiter classes live here — see `backend/security.js`
for why the public read limiter deliberately does not.

### `auditEvents/{autoId}`

`{ actor, action, resource, requestId, createdAt }`. Append-only by discipline:
`.create()` on a fresh auto-id document is the only write path, and there is no
update or delete path anywhere in `backend/`.

---

## Known limitations, stated rather than discovered later

These are the real costs of moving off SQLite. None is a bug; each is a
guarantee that got weaker and needs to be known.

### 1. Invariants are no longer enforced by the storage engine

SQLite enforced the order invariants with triggers and CHECK constraints —
`orders_insert_guard`, `orders_update_guard`, `items_insert_guard`, and the
append-only pair on `audit_events`. No code path could get around them: not a
buggy route, not a migration script, not somebody at a REPL.

Firestore has no equivalent, and security rules cannot substitute because the
Admin SDK bypasses them entirely. Those invariants now live in
`backend/invariants.js` and are asserted **inside the same transaction that
performs the write**, immediately before it, so a violating document is never
committed.

**Residual risk:** this protects only writes that go through the application. A
console edit or an ad-hoc Admin SDK script will not consult it. Mitigation is
operational — restrict service-account access, and never write to production
from a REPL.

### 2. There are no foreign keys

`products.categoryId` is a reference by convention. SQLite had
`ON DELETE RESTRICT`, which is why deleting a non-empty category failed. That
check is now explicit in `repo/catalogue.js` `deleteCategory()` and must stay
there — without it, deleting a category orphans its products into a catalogue
that renders nothing.

### 3. Substring search is a bounded scan

Firestore has no substring operator. Order and customer search read documents and
filter in memory, capped at `SEARCH_SCAN_CAP` (5,000) and `REPORTING_CAP`
(20,000). This is not a regression — a leading-wildcard `LIKE` could not use a
SQLite index either — but the cost moved from a page cache to a read quota.
**Beyond those caps, search needs a real index.** The place to add one is
`repo/orders.js` / `repo/people.js`.

### 4. `byArea` and `topProducts` changed meaning

In SQLite they were all-time aggregates sitting next to a windowed chart. They
are now computed over the same window as the rest of the overview. Deliberate:
reading every order on every dashboard load is what §95/§119 say not to do, and
"top products this month" beside "orders this month" is the more coherent
reading. `days` is in the response, so the window is not a secret.

### 5. Money is a float, not integer minor units

`shared/pricing.mjs` rounds every derived figure to two decimals through
`money()`, and the invariants compare with a 0.011 tolerance. This is unchanged
from the SQLite implementation and is *adequate* — every figure that reaches the
database has been rounded, and the order total is re-derived and checked against
its parts before the write.

It is nonetheless not what §9 of the brief prefers. Integer piastres would be
strictly better. It was **not** changed in this pass because `shared/pricing.mjs`
is imported by the storefront, the dashboard and the server alike, and a
representation change there touches every price display in the product at the
same time as a database migration. Doing both at once multiplies the risk of
exactly the failure the shared module exists to prevent. **Recommended as the
next discrete piece of work**, with the module's own test suite as the contract.

### 6. Composite indexes are unverified locally

The Firestore emulator does **not** enforce composite index requirements — it
answers any query. `firestore.indexes.json` was derived by reading every query in
`backend/repo/`, but the local suite cannot prove it is complete. A missing entry
passes every test here and fails on the first real request against a real
project. **This must be verified against staging before launch** and is recorded
as an open blocker in `PRE_LAUNCH_REPORT.md`.
