# Disaster Recovery — Holland Cookie

What to do when the data is wrong, gone, or being written to by something it
should not be.

**Status: this document is a written plan, not a verified one.** No backup has
been taken, no restore has been rehearsed, and no schedule has been configured,
because doing any of those requires a real Firebase project and a service
account that do not exist yet. Every command below is correct for the
architecture as built and is **untested against a live project**. Rehearsing the
restore is a launch blocker, tracked in `PRE_LAUNCH_REPORT.md`.

## What is actually irreplaceable

Not everything in Firestore matters equally, and knowing the difference is what
makes a fast recovery possible.

| Collection | If lost | Recoverable from |
|---|---|---|
| `orders` | **Catastrophic.** The order book. Money owed, food to bake, addresses to deliver to. | Backups only |
| `customers` | **Severe.** Contact history and lifetime value. | Partially rebuildable from `orders` |
| `profiles` | Moderate. Accounts and their order links. | Re-provable by customers signing in again |
| `promos` | Moderate. `usedCount` is a real ledger. | Backups; codes themselves are re-creatable |
| `counters/orders` | **Dangerous if reset.** Would re-issue references that already belong to real orders. | Recompute: `max(seq) + 1` over `orders` |
| `settings/shop` | Minor. One document. | Re-enter by hand, or re-seed |
| `categories`, `products` | Minor. | `node backend/seed.js` rebuilds from `src/data/menu.ts` |
| `sessions`, `rateLimits`, `otpCodes` | **None.** Everyone signs in again. | Discard deliberately |
| `auditEvents` | Moderate — it is the record of who changed what. | Backups only; append-only, never rewrite |

The practical consequence: a restore should **never** blindly replace everything.
Restoring `sessions` from a backup resurrects tokens that were deliberately
revoked. Restoring `counters` to a stale value hands out duplicate references.

## Backups

Firestore's managed export writes to a Cloud Storage bucket. Set up once:

```bash
# One bucket, same region as the database, with a lifecycle rule.
gcloud storage buckets create gs://holland-cookie-backups \
  --location=europe-west1 --uniform-bucket-level-access

# 60 days of retention, then delete.
gcloud storage buckets update gs://holland-cookie-backups \
  --lifecycle-file=lifecycle.json
```

Daily scheduled export:

```bash
gcloud firestore backups schedules create \
  --database='(default)' \
  --recurrence=daily \
  --retention=30d
```

**Recommended cadence:** daily automatic, plus a manual export immediately before
any schema change or bulk edit:

```bash
gcloud firestore export gs://holland-cookie-backups/pre-change-$(date +%Y%m%dT%H%M) \
  --database='(default)'
```

A manual export before a risky change is worth more than the schedule, because it
is the one you will actually want and the one whose timing you control.

### Point-in-time recovery

Enable PITR, which keeps 7 days of continuous history and covers the case the
daily export cannot: a bad write at 14:05 discovered at 14:20.

```bash
gcloud firestore databases update --database='(default)' \
  --enable-pitr
```

## Restore

### Full restore into a *new* database, never over the live one

```bash
# Restore to a side database first. Never import over production.
gcloud firestore databases create --database=restore-check --location=europe-west1

gcloud firestore import gs://holland-cookie-backups/<TIMESTAMP> \
  --database=restore-check
```

Then point a local server at it and check before promoting anything:

```bash
FIREBASE_PROJECT_ID=holland-cookie-prod \
FIRESTORE_DATABASE=restore-check \
NODE_ENV=production npm start
```

Importing directly over the live database is the mistake that turns a bad day
into an unrecoverable one: the import is not transactional across collections, so
a failure halfway leaves a mixture of two epochs with no way back.

### Selective restore

The usual real case: one collection is wrong, the rest is fine.

```bash
gcloud firestore import gs://holland-cookie-backups/<TIMESTAMP> \
  --collection-ids=orders,customers \
  --database=restore-check
```

Then copy only what is needed, and **recompute the counter afterwards**:

```js
// After restoring orders, the counter must not be older than the order book.
const snap = await collections.orders().orderBy('seq', 'desc').limit(1).get();
const highest = snap.empty ? 1000 : snap.docs[0].data().seq;
await orderCounterDoc().set({ value: highest });
```

Skipping this reissues `HC-1042` to a second, different order — two receipts,
one number, and no way to tell them apart over the phone.

## Rollback of a bad deployment

The application is stateless; the database is not. Those roll back differently.

**Code:** redeploy the previous image. Nothing in the app holds state.

**Data:** a deployment does not migrate Firestore — there is no migration runner
and the schema is additive by convention — so a code rollback is safe on its own
*unless* the bad release wrote malformed documents. Check before rolling forward
again:

```js
// Orders whose stored total disagrees with their own parts.
const bad = (await collections.orders().get()).docs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(o => Math.abs(o.total - (o.subtotal - o.discount + o.delivery)) > 0.011);
```

`assertNewOrder` should make this impossible. If it returns rows, the invariant
was bypassed — that is a bug worth finding, not just repairing.

## Data migration recovery

There is deliberately **no automatic migration runner**. The SQLite predecessor
had one (`PRAGMA user_version` with five ordered steps) and it ran on every boot;
Firestore's schema is additive and unenforced, so the equivalent is a one-off
script run deliberately.

Rules for any migration script, learned from the two mistakes already recorded in
this repository's history:

1. **Export first.** `gcloud firestore export` before it runs, every time.
2. **Dry run.** Print what would change; run it, read it, then run for real.
3. **Idempotent.** It will be run twice, because somebody will not be sure it
   finished.
4. **Never against production from a laptop.** Staging first — see §115/§116 of
   the launch brief.
5. **Refuse to run against the wrong target.** `backend/firestore.js` already
   refuses to connect a non-production process to a real project; a migration
   script should assert the project id it expects.

## Compromise

If a service account key leaks:

```bash
# 1. Revoke the key immediately — this is the only step that stops the bleeding.
gcloud iam service-accounts keys delete <KEY_ID> \
  --iam-account=<SA>@holland-cookie-prod.iam.gserviceaccount.com

# 2. Issue a new one, update the deployment secret, redeploy.
```

Then rotate `ADMIN_KEY` and `JWT_SECRET`. Rotating `JWT_SECRET` invalidates every
session in existence — both admin and customer — because the stored token hashes
no longer match. That is the desired behaviour, and it is why the two secrets are
required to be independent (`backend/config.js` refuses to boot if they are
equal).

Deleting a leaked secret from the current commit is **not** sufficient — it
remains in git history. Rotate.

## Recovery objectives

Stated as targets, not as measurements — nothing here has been timed.

| | Target |
|---|---|
| RPO (data loss) | ≤ 24h from daily export; ≤ minutes with PITR enabled |
| RTO (time to serve) | ≤ 1h for a code rollback; ≤ 4h for a full data restore |

## Before launch

- [ ] Create the staging and production Firebase projects
- [ ] Create the backup bucket with a lifecycle rule
- [ ] Enable PITR
- [ ] Configure the daily export schedule
- [ ] **Rehearse a full restore into a side database and time it** — an untested
      backup is a belief, not a backup
- [ ] Rehearse the counter recomputation after a restore
- [ ] Record who holds the service account key and where
