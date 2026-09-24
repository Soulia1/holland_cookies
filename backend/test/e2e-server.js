/**
 * The server the end-to-end commerce suite runs against.
 *
 * A separate entry point rather than a flag on `server.js`, because the one
 * thing it must guarantee is that the suite cannot touch the real shop data,
 * and the safest way to guarantee that is to pin the datastore here — before
 * anything imports it — rather than hope for it from the environment.
 *
 * Everything else is the real server: the real routes, the real order
 * transaction, the real validation, the real Firestore client. A test double
 * would prove the double works.
 */

// The emulator, pinned before any import that could connect. `firestore.js`
// additionally refuses to attach a non-production process to a real project, so
// this is belt and braces rather than the only line of defence.
//
// ALLOW_REAL_FIRESTORE overrides that, deliberately, so the same suite can be
// run against a real staging project — which is the only way to exercise the
// HTTP layer against real Firestore. It is opt-in, it must name the project, and
// `firestore.js` refuses anything that looks like production. Without it, the
// emulator is used and nothing can reach real data.
if (process.env.ALLOW_REAL_FIRESTORE) {
  delete process.env.FIRESTORE_EMULATOR_HOST;
  console.warn(`[holland] e2e running against REAL project ${process.env.ALLOW_REAL_FIRESTORE}`);
} else {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  process.env.GCLOUD_PROJECT = 'holland-cookie-e2e';
}

process.env.PORT = '3100';
// The shop is 127.0.0.1 and the dashboard is localhost: two origins with separate
// cookie jars, as in production, and both resolve with no DNS or hosts-file help.
process.env.ADMIN_HOSTNAME = 'localhost';
process.env.ADMIN_KEY = 'e2e-admin-key-0123456789abcdefghijkl';
process.env.JWT_SECRET = 'e2e-jwt-secret-0123456789abcdefghijkl';
// Deliberately NOT 'production'. The production config validator now requires a
// real service account, and `firestore.js` refuses an emulator host while
// NODE_ENV=production — correctly, since a production process pointed at an
// emulator would take orders into a database that evaporates. The suite
// therefore runs as 'test' and switches on the production *behaviours* it
// actually wants to exercise, individually and explicitly, below.
process.env.NODE_ENV = 'test';
// Sign-in codes are printed to this process's stdout rather than emailed —
// there is no mail provider in a test run, and the account suite reads them
// back out of the log. Named explicitly so production can never fall into it.
process.env.MAIL_TRANSPORT = 'console';
// A key in a developer's .env would otherwise win over the console transport and
// send real mail to the suite's fake addresses. Empty rather than deleted, so
// dotenv, which never overwrites a variable that exists, cannot bring it back.
process.env.BREVO_API_KEY = '';

const fsdb = await import('../firestore.js');

/**
 * A fresh dataset per run, so order references start from a known number and
 * one run cannot see another's orders.
 *
 * This is the emulator equivalent of deleting the SQLite file. It deletes every
 * document in the collections the suite touches; `firestore.js` has already
 * guaranteed we are talking to an emulator, so there is no path by which this
 * can run against real data.
 */
const COLLECTIONS = [
  'orders', 'orderIdempotency', 'customers', 'products', 'categories', 'promos',
  'profiles', 'otpCodes', 'sessions', 'rateLimits', 'auditEvents', 'counters', 'settings',
  // Cleared with `counters`, never without it: the mail log is keyed by order
  // reference, so restarting the reference counter while keeping the log would
  // make every send look like a duplicate and quietly send nothing.
  'mailLog',
];

/**
 * What this harness is allowed to wipe.
 *
 * An emulator, always — it is disposable by definition. A real project only when
 * it was named explicitly through ALLOW_REAL_FIRESTORE, which `firestore.js`
 * has already refused if it looked like production.
 *
 * Written as a positive list rather than a negative one. The previous version
 * read `!currentTarget() && !String(...).startsWith('emulator')`, which is a
 * double negative around a short-circuit and evaluated to `false` on the very
 * first call — so it never actually guarded anything.
 */
fsdb.get();
const target = fsdb.currentTarget();
const disposable = target.startsWith('emulator')
  || (process.env.ALLOW_REAL_FIRESTORE && target.includes(process.env.ALLOW_REAL_FIRESTORE));
if (!disposable) {
  throw new Error(`Refusing to reset ${target}: not an emulator and not an explicitly named staging project`);
}
console.warn(`[holland] e2e harness will reset: ${target}`);

for (const name of COLLECTIONS) {
  const snapshot = await fsdb.get().collection(name).get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
}

const { seed } = await import('../seed.js');
await seed();

// Predictable delivery pricing, and one promo code the suite can rely on.
await fsdb.settingsDoc().set({
  deliveryFee: 40, freeDeliveryOver: 600, acceptingOrders: true,
}, { merge: true });
await fsdb.collections.promos().doc('E2E10').set({
  type: 'percent', value: 10, minSubtotal: 0, maxUses: 0, usedCount: 0,
  active: true, expiresAt: null,
});

/**
 * Start the listener explicitly.
 *
 * `server.js` boots itself on import unless NODE_ENV is 'test' — and 'test' is
 * exactly what this harness has to be, because the production config validator
 * now demands a real service account and `firestore.js` refuses an emulator host
 * under NODE_ENV=production. So the app is imported for its routes and the
 * listener is opened here.
 *
 * The one production behaviour the suite genuinely needs is the SPA fallback
 * serving the built `dist`, and that is not gated on NODE_ENV. What it must NOT
 * inherit from production is `Secure` cookies and `upgrade-insecure-requests`,
 * both of which would break a suite served over plain http on localhost — so
 * running as 'test' is correct rather than merely convenient.
 */
const { default: app } = await import('../server.js');

// The API reads live mirrors of these collections. Fill them from the fixtures
// just written, before the first request, as production boot would.
const { syncAll } = await import('../mirror.js');
await syncAll();

const port = Number(process.env.PORT) || 3100;
const listener = app.listen(port, '127.0.0.1', () => {
  console.info(JSON.stringify({ event: 'e2e-server-started', port, datastore: fsdb.currentTarget() }));
});
/**
 * Keep the durable rate-limit counters clear for the duration of the run.
 *
 * The strict limiter classes are Firestore-backed on purpose — a login or
 * checkout limit that forgets on restart is not a limit. That durability is
 * correct in production and actively hostile to an end-to-end suite: the
 * `checkout` class allows 20 orders per ten minutes per IP, and the browser
 * matrix places well over that from 127.0.0.1 in a single run. Past the
 * threshold the suite stops testing checkout and starts testing the rate
 * limiter, which fails dozens of unrelated assertions with a 429.
 *
 * So the counters are swept here rather than the limits being loosened. The
 * limits themselves stay exactly as production has them, and they are still
 * properly exercised — `tests/security/security.test.js` drives each class to
 * its threshold deliberately and asserts the 429 and its Retry-After.
 *
 * Test-harness only. This file is never imported by the server.
 */
const sweep = setInterval(() => {
  fsdb.collections.rateLimits().limit(500).get()
    .then((snapshot) => Promise.all(snapshot.docs.map((doc) => doc.ref.delete())))
    .catch(() => {});
}, 2000);
sweep.unref();

const stop = () => {
  clearInterval(sweep);
  listener.close(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
