/**
 * The database.
 *
 * Cloud Firestore through the Firebase Admin SDK. This replaced a SQLite file
 * (`better-sqlite3`) in the pre-launch migration; the shape of the data and the
 * guarantees the order pipeline needs are unchanged, but three things about
 * Firestore had to be designed around rather than ported:
 *
 *  1. There are no CHECK constraints and no triggers. SQLite was enforcing the
 *     order invariants — total = subtotal - discount + delivery, discount never
 *     exceeding subtotal, quantities within bounds, financials immutable after
 *     insert, audit rows append-only — down in the storage engine, where no code
 *     path could get around them. Firestore cannot do that. Those invariants now
 *     live in `backend/invariants.js` and are asserted inside the same
 *     transaction that writes the document, so the write and its check cannot be
 *     separated. That is weaker than a trigger and it is the real cost of this
 *     migration; it is written down here so nobody has to rediscover it.
 *
 *  2. There is no GROUP BY and no SUM. The dashboard's statistics were SQL
 *     aggregates over the whole orders table. See `backend/repo/orders.js` for
 *     how that is answered now, and why it is a bounded indexed range query
 *     rather than a collection scan.
 *
 *  3. Transactions are read-then-write over a network. `orderTransaction.js`
 *     was already written as one atomic block, so it survived the move, but
 *     every read it needs must now happen before its first write.
 *
 * Everything goes through this module rather than calling `getFirestore()`
 * directly, so there is one place the app is initialised, one place the emulator
 * is wired in, and one place that decides whether the process is allowed to talk
 * to a real project at all.
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

let firestore = null;
let describedTarget = null;

/**
 * Where the data lives, and the refusal to guess.
 *
 * A test suite that quietly connects to the production project instead of the
 * emulator is the failure this function exists to make impossible. The rule is
 * blunt: outside production, an emulator host is *required*. If NODE_ENV is not
 * `production` and FIRESTORE_EMULATOR_HOST is unset, this throws rather than
 * falling back to real credentials — because the fallback is silent, and the
 * damage (fixtures written into the live shop, a seed script overwriting real
 * orders) is only discovered afterwards.
 *
 * That exact class of accident has already happened once in this repository's
 * history against SQLite: the old `db.js` resolved its path at module load, so a
 * test that set `DATABASE_PATH=':memory:'` after the import wrote its fixtures
 * into the real shop database instead. The tests passed the whole time. This is
 * the same bug's shape, moved to a new database, and refused up front.
 */
function resolveTarget() {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  const production = process.env.NODE_ENV === 'production';

  if (emulator) {
    if (production) {
      throw new Error(
        'FIRESTORE_EMULATOR_HOST is set while NODE_ENV=production. Refusing to '
        + 'run a production process against an emulator.',
      );
    }
    return {
      kind: 'emulator',
      host: emulator,
      projectId: process.env.GCLOUD_PROJECT || 'holland-cookie-test',
    };
  }

  if (!production) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set and NODE_ENV is not production. '
      + 'Refusing to connect a non-production process to a real Firestore '
      + 'project. Start the emulator (npm run emulators) first.',
    );
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Production Firestore requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL '
      + 'and FIREBASE_PRIVATE_KEY.',
    );
  }
  return {
    kind: 'production',
    projectId,
    // Newlines survive an environment variable as the two characters \ and n.
    credential: { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') },
  };
}

function connect() {
  if (firestore) return firestore;

  const target = resolveTarget();
  describedTarget = target.kind === 'emulator'
    ? `emulator ${target.host} (${target.projectId})`
    : `project ${target.projectId}`;

  const app = getApps()[0] ?? initializeApp(
    target.kind === 'emulator'
      ? { projectId: target.projectId }
      : { credential: cert(target.credential), projectId: target.projectId },
  );

  firestore = getFirestore(app);
  // Undefined is how an optional field is absent in JavaScript; without this
  // every writer has to strip its own keys before every write.
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

/** The Firestore handle, connected on first use. */
export function get() {
  return connect();
}

/** Which database this process actually attached to. Null until first use. */
export function currentTarget() {
  return describedTarget;
}

/** Drop the handle. Used by tests between suites; the server never calls it. */
export async function close() {
  if (!firestore) return;
  const handle = firestore;
  firestore = null;
  describedTarget = null;
  await handle.terminate();
}

/**
 * The collections, named in one place.
 *
 * Referenced through these helpers rather than by string literal at each call
 * site, so a rename is one edit and a typo is a missing function rather than a
 * silently-empty query against a collection that does not exist. Firestore
 * creates collections implicitly on first write, which means a misspelled name
 * never errors — it just reads back nothing, forever.
 */
export const collections = {
  categories: () => get().collection('categories'),
  products: () => get().collection('products'),
  customers: () => get().collection('customers'),
  orders: () => get().collection('orders'),
  promos: () => get().collection('promos'),
  settings: () => get().collection('settings'),
  profiles: () => get().collection('profiles'),
  otpCodes: () => get().collection('otpCodes'),
  sessions: () => get().collection('sessions'),
  rateLimits: () => get().collection('rateLimits'),
  auditEvents: () => get().collection('auditEvents'),
  counters: () => get().collection('counters'),
  orderIdempotency: () => get().collection('orderIdempotency'),
};

/** The single settings document. One row in SQLite, one document here. */
export const settingsDoc = () => collections.settings().doc('shop');

/** The order-reference counter. */
export const orderCounterDoc = () => collections.counters().doc('orders');

/**
 * Is this error the database being unreachable, rather than our bug?
 *
 * It decides between a 503 and a 500, which matters for more than tidiness: a
 * 503 tells a load balancer to take the instance out and a client that it is
 * worth retrying, and a 500 tells both the opposite. Getting this wrong in
 * either direction is a real outage behaviour, not a cosmetic one.
 *
 * These are gRPC status codes, which is what the Firestore client surfaces.
 * Replaces the old `error.code?.startsWith('SQLITE')` check, which was the same
 * question asked of a different driver.
 */
const OUTAGE_CODES = new Set([
  4,  // DEADLINE_EXCEEDED
  8,  // RESOURCE_EXHAUSTED — quota, which is an outage from the caller's side
  10, // ABORTED — transaction contention that exhausted its retries
  13, // INTERNAL
  14, // UNAVAILABLE
]);

export function isDatastoreOutage(error) {
  return !!error && (OUTAGE_CODES.has(error.code) || error.code === 'ECONNREFUSED');
}

export { FieldValue, Timestamp };
export default { get, close, currentTarget, collections, isDatastoreOutage };
