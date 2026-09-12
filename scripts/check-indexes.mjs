/**
 * Run every query that needs a composite index against a REAL Firestore.
 *
 *     NODE_ENV=production node scripts/check-indexes.mjs
 *
 * This is the check the emulator cannot perform. The Firestore emulator answers
 * any query, indexed or not, so a missing entry in firestore.indexes.json passes
 * the entire local test suite and then throws FAILED_PRECONDITION on the first
 * real request — which, for a shop, is the first customer rather than the
 * deploy.
 *
 * Each query below mirrors one in backend/repo/. If a query is added there and
 * not here, this file stops being a proof; that coupling is the point of listing
 * them explicitly rather than generating them.
 *
 * Firestore puts a "create this index" console URL in the FAILED_PRECONDITION
 * message, so a failure here tells you exactly what to add.
 */

import { collections, Timestamp, get as firestore } from '../backend/firestore.js';
import { AggregateField } from 'firebase-admin/firestore';

const orders = () => collections.orders();
const results = [];

async function probe(label, source, run) {
  try {
    await run();
    console.log(`  ok       ${label}`);
    results.push({ label, ok: true });
  } catch (error) {
    const missing = error.code === 9 || /FAILED_PRECONDITION|requires an index/i.test(error.message ?? '');
    const url = (error.message ?? '').match(/https:\/\/console\.firebase\.google\.com\S+/)?.[0];
    console.log(`  ${missing ? 'NO INDEX' : 'ERROR   '} ${label}`);
    console.log(`           source: ${source}`);
    if (url) console.log(`           create: ${url}`);
    else console.log(`           ${(error.message ?? '').split('\n')[0].slice(0, 160)}`);
    results.push({ label, ok: false, missing, url });
  }
}

console.log(`\n  Checking composite indexes against ${(firestore(), (await import('../backend/firestore.js')).currentTarget())}\n`);

await probe(
  'orders where status == ? order by seq desc',
  'repo/orders.js listOrders()',
  () => orders().where('status', '==', 'ordered').orderBy('seq', 'desc').limit(1).get(),
);

await probe(
  'orders where phone == ? order by seq desc',
  'repo/orders.js ordersForPhone()',
  () => orders().where('phone', '==', '01000000000').orderBy('seq', 'desc').limit(1).get(),
);

await probe(
  'orders where profileId == ? order by seq desc',
  'repo/orders.js ordersForProfile()',
  () => orders().where('profileId', '==', 'someone@example.test').orderBy('seq', 'desc').limit(1).get(),
);

await probe(
  'orders where email == ? and profileId == null order by seq desc',
  'customerAuth.js claimProfile()',
  () => orders().where('email', '==', 'someone@example.test')
    .where('profileId', '==', null).orderBy('seq', 'desc').limit(1).get(),
);

// An equality filter plus a sum() is a COMPOSITE index, because the summed field
// has to be in the index alongside the filter. It does not look like one, which
// is exactly how the three below were missed on the first pass — the emulator
// answered all of them, and so did a check that only probed the two-filter case.
await probe(
  'orders where status == ? SUM(total)',
  'repo/orders.js orderStats() fulfilledRevenue / cancelledValue',
  () => orders().where('status', '==', 'completed')
    .aggregate({ value: AggregateField.sum('total'), count: AggregateField.count() }).get(),
);

await probe(
  'orders where paymentStatus == ? SUM(total)',
  'repo/orders.js orderStats() paidRevenue',
  () => orders().where('paymentStatus', '==', 'paid')
    .aggregate({ value: AggregateField.sum('total'), count: AggregateField.count() }).get(),
);

await probe(
  'orders SUM(total) unfiltered',
  'repo/orders.js orderStats() orderValue',
  () => orders().aggregate({ value: AggregateField.sum('total'), count: AggregateField.count() }).get(),
);

await probe(
  'orders where status == cancelled and paymentStatus == paid SUM(total)',
  'repo/orders.js orderStats() refundDueValue',
  () => orders().where('status', '==', 'cancelled').where('paymentStatus', '==', 'paid')
    .aggregate({ value: AggregateField.sum('total'), count: AggregateField.count() }).get(),
);

for (const [field, value] of [['status', 'ordered'], ['paymentStatus', 'unpaid'], ['fulfilment', 'delivery']]) {
  await probe(
    `orders where ${field} == ? COUNT()`,
    'repo/orders.js orderStats() group counts',
    () => orders().where(field, '==', value).count().get(),
  );
}

// Single-field and range queries below need no composite index, but a typo in a
// field name shows up here as an empty result rather than an error, so they are
// exercised to prove they at least execute.
await probe(
  'orders where createdAt >= ? (windowed stats read)',
  'repo/orders.js orderStats() daily window',
  () => orders().where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 86400000)).limit(1).get(),
);

await probe(
  'orders order by seq desc (list + reporting)',
  'repo/orders.js listOrders() / listAllOrdersForReporting()',
  () => orders().orderBy('seq', 'desc').limit(1).get(),
);

await probe(
  'products where categoryId == ?',
  'repo/catalogue.js deleteCategory()',
  () => collections.products().where('categoryId', '==', 'cookie-pans').limit(1).get(),
);

await probe(
  'categories where visible == true',
  'repo/catalogue.js listCategories()',
  () => collections.categories().where('visible', '==', true).limit(1).get(),
);

await probe(
  'sessions where expiresAt <= ?',
  'repo/system.js purgeExpiredSessions()',
  () => collections.sessions().where('expiresAt', '<=', Timestamp.now()).limit(1).get(),
);

await probe(
  'rateLimits where resetAt <= ?',
  'repo/system.js purgeExpiredRateLimits()',
  () => collections.rateLimits().where('resetAt', '<=', Timestamp.now()).limit(1).get(),
);

await probe(
  'auditEvents order by createdAt desc',
  'repo/system.js recentAuditEvents()',
  () => collections.auditEvents().orderBy('createdAt', 'desc').limit(1).get(),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} queries ran.`);
if (failed.length) {
  console.log(`  ${failed.filter((f) => f.missing).length} missing index(es). Deploy firestore.indexes.json, or use the URLs above.\n`);
  process.exit(1);
}
console.log('  Every production query has the index it needs.\n');
process.exit(0);
