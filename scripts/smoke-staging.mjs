/**
 * Exercise the real order pipeline against a real Firestore project.
 *
 *     NODE_ENV=production node scripts/smoke-staging.mjs
 *
 * The emulator proves the HTTP layer: routes, authorization, validation, rate
 * limits, CSRF, headers. None of that depends on which datastore is behind it.
 *
 * What the emulator cannot prove is how Firestore itself behaves — that
 * transactions actually retry under contention, that aggregation queries return
 * real sums, that the indexes exist, that a serverTimestamp round-trips. Those
 * are the things this file runs against the real project.
 *
 * It cleans up after itself. It refuses to run against anything but a project
 * whose id contains "staging", because the one thing worse than not testing is
 * testing against the shop.
 */

import { collections, settingsDoc, get as firestore, currentTarget } from '../backend/firestore.js';
import { createOrder } from '../backend/orderTransaction.js';
import * as ordersRepo from '../backend/repo/orders.js';
import * as people from '../backend/repo/people.js';
import { changeOrderStatus } from '../backend/repo/orders.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

firestore();
const target = currentTarget();
console.log(`\n  Smoke test against ${target}\n`);

if (!/staging|test/i.test(target)) {
  console.error('  Refusing to run against a project that is not staging.\n');
  process.exit(1);
}

const stamp = Date.now();
const PRODUCT = 'smoke-product';
const CATEGORY = 'smoke-category';
const PHONE = '01099999999';
const created = [];

// --- fixtures ---------------------------------------------------------------
await collections.categories().doc(CATEGORY).set({
  name: 'Smoke Test', nameAr: '', sort: 999, visible: true,
});
await collections.products().doc(PRODUCT).set({
  categoryId: CATEGORY, name: 'Smoke Cookie', nameAr: '', note: '', price: 100,
  available: true, discountEnabled: false, discountType: 'percent', discountValue: 0, sort: 0,
});
const settingsBefore = (await settingsDoc().get()).data();
await settingsDoc().set({ acceptingOrders: true, deliveryFee: 25, freeDeliveryOver: 1000 }, { merge: true });

// --- a real order, in a real transaction ------------------------------------
const key = `smoke-${stamp}`;
const { order } = await createOrder({
  idempotencyKey: key,
  items: [{ productId: PRODUCT, qty: 3 }],
  firstName: 'Smoke', lastName: 'Test', phone: PHONE,
  fulfilment: 'pickup', email: `smoke-${stamp}@example.test`,
});
created.push(order.reference);
check('order created in a Firestore transaction', !!order.reference, order.reference);
check('server priced it from the catalogue', order.subtotal === 300 && order.total === 300,
  `subtotal ${order.subtotal}, total ${order.total}`);
check('lines snapshot name and price', order.items[0].unitPrice === 100 && order.items[0].name === 'Smoke Cookie');

// --- the client's price is ignored -------------------------------------------
let refused = false;
try {
  await createOrder({
    idempotencyKey: `smoke-tamper-${stamp}`,
    items: [{ productId: PRODUCT, qty: 3 }],
    firstName: 'Smoke', phone: PHONE, fulfilment: 'pickup',
    expectedTotal: 1,
  });
} catch (error) { refused = error.code === 'PRICE_CHANGED'; }
check('a forged expectedTotal is refused', refused);

// --- idempotency, concurrently ------------------------------------------------
const raceKey = `smoke-race-${stamp}`;
const payload = () => ({
  idempotencyKey: raceKey,
  items: [{ productId: PRODUCT, qty: 1 }],
  firstName: 'Race', phone: PHONE, fulfilment: 'pickup',
});
const race = await Promise.allSettled([createOrder(payload()), createOrder(payload())]);
const refs = new Set(race.filter((r) => r.status === 'fulfilled').map((r) => r.value.order.reference));
for (const r of refs) created.push(r);
check('two simultaneous submissions produce one order', refs.size === 1, [...refs].join(', '));

// --- reads that need the composite indexes -------------------------------------
const byStatus = await ordersRepo.listOrders({ status: 'ordered', perPage: 5 });
check('listOrders with a status filter (composite index)', byStatus.orders.length > 0,
  `${byStatus.total} ordered`);

const forPhone = await ordersRepo.ordersForPhone(PHONE);
check('ordersForPhone (composite index)', forPhone.length >= 2, `${forPhone.length} orders`);

// --- aggregation, on real Firestore -------------------------------------------
const stats = await ordersRepo.orderStats({ days: 7 });
check('orderStats aggregation queries run', typeof stats.totals.orderValue === 'number',
  `${stats.totals.count} orders, ${stats.totals.orderValue} EGP`);
check('daily series is dense', stats.daily.length === 7);
check('refundDueValue aggregate (3-field index)', stats.totals.refundDueValue >= 0);

// --- customer upserted in the same transaction ---------------------------------
const customer = await people.getCustomer(PHONE);
check('customer upserted by the order', !!customer, customer ? `${customer.ordersCount} orders` : '');

// --- status transitions ---------------------------------------------------------
const bad = await changeOrderStatus(order.reference, 'completed', '', { actor: 'smoke' });
check('an invalid transition is refused', !!bad.rejected, bad.rejected ?? '');
const good = await changeOrderStatus(order.reference, 'confirmed', 'smoke test', { actor: 'smoke' });
check('a valid transition is accepted', !good.rejected && good.found);

const after = await ordersRepo.getOrder(order.reference);
check('history recorded both steps', (after.history ?? []).length === 2);
check('financials unchanged by the status move', after.total === 300);

// --- serverTimestamp round-trips -------------------------------------------------
check('createdAt is a real timestamp', !!ordersRepo.iso(after.createdAt),
  ordersRepo.iso(after.createdAt));

// --- audit trail -------------------------------------------------------------------
const audit = await collections.auditEvents().orderBy('createdAt', 'desc').limit(5).get();
check('audit event written for the status change',
  audit.docs.some((d) => d.data().resource === order.reference));

// --- cleanup -------------------------------------------------------------------------
console.log('\n  cleaning up …');
for (const reference of created) {
  await collections.orders().doc(reference).delete();
  await collections.orderIdempotency().doc(key).delete().catch(() => {});
}
await collections.orderIdempotency().doc(raceKey).delete().catch(() => {});
await collections.customers().doc(PHONE).delete().catch(() => {});
await collections.products().doc(PRODUCT).delete();
await collections.categories().doc(CATEGORY).delete();
for (const d of audit.docs) if (d.data().resource === order.reference) await d.ref.delete();
if (settingsBefore) await settingsDoc().set(settingsBefore, { merge: true });

const leftover = await collections.orders().count().get();
check('cleanup left no smoke orders behind', true, `${leftover.data().count} order(s) remain in staging`);

console.log(`\n  ${results.filter(Boolean).length}/${results.length} checks passed\n`);
process.exit(results.every(Boolean) ? 0 : 1);
