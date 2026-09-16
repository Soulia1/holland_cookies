/**
 * The order transaction.
 *
 * The tests that matter here are the adversarial ones. A cart is a thing the
 * customer's browser holds and can rewrite at will, so "the server ignores the
 * price it was sent" is not a nice property — it is the entire reason this
 * module exists, and it needs to be pinned by a test that actually sends a
 * lying cart.
 *
 * These run against the Firestore emulator, never a real project. That is not
 * left to convention: `backend/firestore.js` refuses to connect a non-production
 * process to a real project at all, and the first test below asserts which
 * datastore we actually attached to before anything writes.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-ordertx';
process.env.JWT_SECRET = 'order-transaction-suite-0123456789abcdef';

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsdb from '../firestore.js';
import { createOrder, normalizePhone, evaluatePromo } from '../orderTransaction.js';
import { assertNewOrder, InvariantError } from '../invariants.js';

/**
 * The tripwire.
 *
 * The SQLite predecessor of this suite once wrote its fixtures into the real
 * shop database and reported all green, because the path was resolved at module
 * load and the test set it afterwards. Same shape of accident, new database:
 * this asserts the connection actually went to an emulator before any fixture
 * is written.
 */
test('runs against the emulator, never a real project', () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /,
    'the suite is pointed at a real Firestore project — refusing to run');
});

const COLLECTIONS = ['orders', 'orderIdempotency', 'customers', 'products', 'categories', 'promos'];

async function wipe() {
  await Promise.all(COLLECTIONS.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

async function seed() {
  await wipe();
  await fsdb.collections.categories().doc('plain')
    .set({ name: 'Plain', nameAr: 'سادة', sort: 0, visible: true });

  const product = (id, name, nameAr, price, extra = {}) => fsdb.collections.products().doc(id).set({
    categoryId: 'plain', name, nameAr, price, note: '',
    discountEnabled: false, discountType: 'percent', discountValue: 0,
    available: true, sort: 0, ...extra,
  });

  await Promise.all([
    product('vanilla', 'Vanilla', 'فانيليا', 50),
    product('lotus', 'Lotus', 'لوتس', 60),
    product('sale', 'Sale Item', 'عرض', 100, { discountEnabled: true, discountValue: 25 }),
    product('soldout', 'Sold Out', 'خلص', 40, { available: false }),
    fsdb.orderCounterDoc().set({ value: 1000 }),
    fsdb.settingsDoc().set({
      deliveryFee: 30, freeDeliveryOver: 500, acceptingOrders: true, areas: [],
    }),
  ]);
}

function payload(overrides = {}) {
  return {
    idempotencyKey: `key-${Math.random()}`,
    items: [{ productId: 'vanilla', qty: 2 }],
    firstName: 'Noha',
    lastName: 'Ibrahim',
    phone: '01016521650',
    email: 'noha@example.com',
    fulfilment: 'delivery',
    area: 'nasr-city',
    address: '12 Some Street',
    ...overrides,
  };
}

const countOrders = async () => (await fsdb.collections.orders().count().get()).data().count;

before(seed);
beforeEach(seed);
after(async () => { await wipe(); await fsdb.close(); });

// ------------------------------------------------------------- pricing ----

test('prices the order from the catalogue, not from the request', async () => {
  // The cart lies: it claims the vanilla cookies cost a pound each. The server
  // never reads that field — it is not even in the schema — and prices from the
  // catalogue, where they are fifty.
  const { order } = await createOrder(payload({
    items: [{ productId: 'vanilla', qty: 2, price: 1, unitPrice: 1, lineTotal: 2 }],
  }));
  assert.equal(order.subtotal, 100);
  assert.equal(order.items[0].unitPrice, 50);
  assert.equal(order.total, 130); // 100 + 30 delivery
});

test('an order placed while signed in belongs to that account straight away', async () => {
  const signedIn = await createOrder(payload({ email: '' }), { profileId: 'noha@example.com' });
  const stored = (await fsdb.collections.orders().doc(signedIn.order.reference).get()).data();
  assert.equal(stored.profileId, 'noha@example.com', 'no email typed at checkout, still in their history');

  const guest = await createOrder(payload());
  assert.equal((await fsdb.collections.orders().doc(guest.order.reference).get()).data().profileId, null);
});

test('applies a discount configured on the product', async () => {
  const { order } = await createOrder(payload({ items: [{ productId: 'sale', qty: 1 }] }));
  assert.equal(order.items[0].unitPrice, 75);
  assert.equal(order.subtotal, 75);
});

test('waives delivery over the free threshold', async () => {
  const { order } = await createOrder(payload({ items: [{ productId: 'vanilla', qty: 12 }] }));
  assert.equal(order.subtotal, 600);
  assert.equal(order.delivery, 0);
  assert.equal(order.total, 600);
});

test('charges no delivery on a pickup order', async () => {
  const { order } = await createOrder(payload({ fulfilment: 'pickup', area: '', address: '' }));
  assert.equal(order.delivery, 0);
  assert.equal(order.total, 100);
});

// ------------------------------------------------- stale-price refusal ----

test('refuses when the total the customer was shown no longer matches', async () => {
  await assert.rejects(
    () => createOrder(payload({ expectedTotal: 5 })),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'PRICE_CHANGED');
      // The authoritative figure comes back so the checkout can show what changed.
      assert.equal(error.details.currentTotal, 130);
      return true;
    },
  );
});

test('accepts a matching expected total', async () => {
  const { order } = await createOrder(payload({ expectedTotal: 130 }));
  assert.equal(order.total, 130);
});

// ----------------------------------------------------------- idempotency ----

test('a repeated idempotency key returns the first order rather than a second', async () => {
  const key = 'repeat-me-please';
  const first = await createOrder(payload({ idempotencyKey: key }));
  const second = await createOrder(payload({ idempotencyKey: key }));
  assert.equal(second.duplicate, true);
  assert.equal(second.order.reference, first.order.reference);
  assert.equal(await countOrders(), 1);
});

test('the same key with a different basket is a conflict, not an overwrite', async () => {
  const key = 'same-key-different-cart';
  await createOrder(payload({ idempotencyKey: key }));
  await assert.rejects(
    () => createOrder(payload({ idempotencyKey: key, items: [{ productId: 'lotus', qty: 9 }] })),
    (error) => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await countOrders(), 1);
});

/**
 * Two identical submissions racing, which is what a double-tapped Pay button
 * actually produces — not two sequential calls, but two in flight at once.
 */
test('two simultaneous submissions of one key produce exactly one order', async () => {
  const key = 'double-tapped-pay-button';
  const results = await Promise.allSettled([
    createOrder(payload({ idempotencyKey: key })),
    createOrder(payload({ idempotencyKey: key })),
  ]);
  const created = results.filter((r) => r.status === 'fulfilled' && !r.value.duplicate);
  assert.equal(await countOrders(), 1, 'exactly one order must exist');
  assert.ok(created.length <= 1, 'at most one call may report having created it');
});

// ------------------------------------------------------ catalogue truth ----

test('refuses a product that is no longer on the menu', async () => {
  await assert.rejects(
    () => createOrder(payload({ items: [{ productId: 'ghost', qty: 1 }] })),
    (error) => error.status === 400 && error.code === 'PRODUCT_MISSING',
  );
});

test('refuses a product that has sold out', async () => {
  await assert.rejects(
    () => createOrder(payload({ items: [{ productId: 'soldout', qty: 1 }] })),
    (error) => error.status === 409 && error.code === 'PRODUCT_UNAVAILABLE',
  );
});

test('refuses a product whose category has been hidden', async () => {
  await fsdb.collections.categories().doc('plain').update({ visible: false });
  await assert.rejects(
    () => createOrder(payload()),
    (error) => error.status === 400 && error.code === 'PRODUCT_MISSING',
  );
});

test('refuses every order while the shop is closed', async () => {
  await fsdb.settingsDoc().update({ acceptingOrders: false });
  await assert.rejects(() => createOrder(payload()), (error) => error.code === 'CLOSED');
});

test('refuses a non-cash payment method', async () => {
  await assert.rejects(
    () => createOrder(payload({ paymentMethod: 'card' })),
    (error) => error.status === 400 && error.code === 'PAYMENT_UNAVAILABLE',
  );
});

test('writes nothing at all when it refuses', async () => {
  const before = await countOrders();
  await assert.rejects(() => createOrder(payload({ items: [{ productId: 'soldout', qty: 1 }] })));
  assert.equal(await countOrders(), before);
  // The reference counter must not have advanced either: a refused order that
  // burns a number leaves a permanent gap in the sequence.
  assert.equal((await fsdb.orderCounterDoc().get()).data().value, 1000);
});

// ------------------------------------------------------------- snapshot ----

test('copies the name and price onto the line so a later edit cannot rewrite history', async () => {
  const { order } = await createOrder(payload());
  await fsdb.collections.products().doc('vanilla').update({ name: 'Renamed', price: 999 });
  const stored = await fsdb.collections.orders().doc(order.reference).get();
  const line = stored.data().items[0];
  assert.equal(line.name, 'Vanilla');
  assert.equal(line.unitPrice, 50);
});

// ------------------------------------------------------------ customers ----

test('accumulates a returning customer onto one record', async () => {
  await createOrder(payload());
  await createOrder(payload());
  const customers = await fsdb.collections.customers().get();
  assert.equal(customers.size, 1);
  const customer = customers.docs[0].data();
  assert.equal(customer.ordersCount, 2);
  assert.equal(customer.totalSpent, 260);
});

test('allocates readable, sequential references', async () => {
  const first = await createOrder(payload());
  const second = await createOrder(payload());
  assert.equal(first.order.reference, 'HC-1001');
  assert.equal(second.order.reference, 'HC-1002');
});

// ---------------------------------------------------------------- promos ----

async function promo(fields) {
  await fsdb.collections.promos().doc(fields.code).set({
    type: 'percent', value: 10, minSubtotal: 0, maxUses: 0, usedCount: 0,
    active: true, expiresAt: null, ...fields,
  });
}

test('applies a valid promo and counts its use', async () => {
  await promo({ code: 'WELCOME10' });
  const { order } = await createOrder(payload({ promoCode: 'WELCOME10' }));
  assert.equal(order.discount, 10);
  assert.equal(order.total, 120);
  const stored = await fsdb.collections.promos().doc('WELCOME10').get();
  assert.equal(stored.data().usedCount, 1);
});

test('promo codes are case insensitive', async () => {
  await promo({ code: 'WELCOME10' });
  const { order } = await createOrder(payload({ promoCode: 'welcome10' }));
  assert.equal(order.discount, 10);
});

test('refuses a fully redeemed promo', async () => {
  await promo({ code: 'SPENT', maxUses: 1, usedCount: 1 });
  await assert.rejects(
    () => createOrder(payload({ promoCode: 'SPENT' })),
    (error) => error.code === 'INVALID_PROMO',
  );
});

test('refuses an expired promo', async () => {
  await promo({ code: 'OLD', expiresAt: new Date(Date.now() - 86400000).toISOString() });
  await assert.rejects(
    () => createOrder(payload({ promoCode: 'OLD' })),
    (error) => error.code === 'INVALID_PROMO',
  );
});

test('refuses a promo below its minimum subtotal', async () => {
  await promo({ code: 'BIGSPEND', minSubtotal: 5000 });
  await assert.rejects(
    () => createOrder(payload({ promoCode: 'BIGSPEND' })),
    (error) => error.code === 'INVALID_PROMO',
  );
});

test('a promo can never make the total negative', async () => {
  await promo({ code: 'HUGE', type: 'fixed', value: 100000 });
  const { order } = await createOrder(payload({ promoCode: 'HUGE' }));
  assert.equal(order.discount, 100);
  assert.equal(order.subtotal, 100);
  assert.ok(order.total >= 0);
});

/**
 * A limited promo under concurrent redemption.
 *
 * Firestore replays a transaction whose reads were invalidated by a concurrent
 * commit, which is exactly what has to happen here: the loser must re-read the
 * incremented usedCount and then correctly refuse, rather than both callers
 * seeing usedCount = 0 and both spending the single use.
 */
test('a promo with one use left cannot be redeemed twice concurrently', async () => {
  await promo({ code: 'LASTONE', maxUses: 1, usedCount: 0 });
  const results = await Promise.allSettled([
    createOrder(payload({ idempotencyKey: 'race-a', promoCode: 'LASTONE' })),
    createOrder(payload({ idempotencyKey: 'race-b', promoCode: 'LASTONE' })),
  ]);
  const redeemed = results.filter((r) => r.status === 'fulfilled');
  assert.equal(redeemed.length, 1, 'exactly one checkout may redeem the last use');
  const stored = await fsdb.collections.promos().doc('LASTONE').get();
  assert.equal(stored.data().usedCount, 1, 'the code must not be over-redeemed');
});

test('evaluatePromo rejects an unknown code without touching the database', () => {
  assert.equal(evaluatePromo(null, 100).valid, false);
});

// ------------------------------------------------------------ invariants ----

/**
 * The checks that used to be SQLite triggers.
 *
 * These are unit tests on the assertion itself rather than attempts to write a
 * bad order through the API, because the API cannot produce one — the point of
 * the invariants is to be the layer that catches a *future* bug in the pricing
 * code, so they are tested directly.
 */
test('invariants reject an order whose total does not match its parts', () => {
  assert.throws(() => assertNewOrder({
    subtotal: 100, discount: 0, delivery: 30, total: 50,
    status: 'ordered', paymentStatus: 'unpaid', paymentMethod: 'cash',
    items: [{ productId: 'x', qty: 1, unitPrice: 100, lineTotal: 100 }],
  }), InvariantError);
});

test('invariants reject a discount larger than the subtotal', () => {
  assert.throws(() => assertNewOrder({
    subtotal: 100, discount: 150, delivery: 0, total: -50,
    status: 'ordered', paymentStatus: 'unpaid', paymentMethod: 'cash',
    items: [{ productId: 'x', qty: 1, unitPrice: 100, lineTotal: 100 }],
  }), InvariantError);
});

test('invariants reject an order that arrives already marked paid', () => {
  assert.throws(() => assertNewOrder({
    subtotal: 100, discount: 0, delivery: 0, total: 100,
    status: 'ordered', paymentStatus: 'paid', paymentMethod: 'cash',
    items: [{ productId: 'x', qty: 1, unitPrice: 100, lineTotal: 100 }],
  }), InvariantError);
});

test('invariants reject lines that do not sum to the subtotal', () => {
  assert.throws(() => assertNewOrder({
    subtotal: 999, discount: 0, delivery: 0, total: 999,
    status: 'ordered', paymentStatus: 'unpaid', paymentMethod: 'cash',
    items: [{ productId: 'x', qty: 1, unitPrice: 100, lineTotal: 100 }],
  }), InvariantError);
});

// ----------------------------------------------------------------- phone ----

test('normalizePhone folds the formats people actually type', () => {
  for (const input of ['01016521650', '+201016521650', '00201016521650', '201016521650', '0101 652 1650']) {
    assert.equal(normalizePhone(input), '01016521650', input);
  }
  assert.equal(normalizePhone('nonsense'), null);
  assert.equal(normalizePhone('0991234567'), null);
});
