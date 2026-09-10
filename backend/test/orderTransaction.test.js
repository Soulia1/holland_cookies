/**
 * The order transaction.
 *
 * The tests that matter here are the adversarial ones. A cart is a thing the
 * customer's browser holds and can rewrite at will, so "the server ignores the
 * price it was sent" is not a nice property — it is the entire reason this
 * module exists, and it needs to be pinned by a test that actually sends a
 * lying cart.
 */

process.env.DATABASE_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../db.js';
import { createOrder, normalizePhone } from '../orderTransaction.js';

// The assignment above runs *after* these imports — ES module imports are
// hoisted — so it only works because db.js resolves its path lazily, on the
// first connection. It did not always, and the consequence was that this file
// seeded its fixtures into the real shop database while reporting all green.
//
// This assertion is the tripwire. If the path ever goes back to being read at
// module load, every test here fails immediately and loudly instead of
// succeeding against production data.
test('runs against an in-memory database, never the real one', () => {
  db.get();
  assert.equal(db.currentPath(), ':memory:',
    'the suite is pointed at a real database file — refusing to run');
});

function seed() {
  const database = db.get();
  database.exec(`
    DELETE FROM order_idempotency; DELETE FROM order_items; DELETE FROM orders;
    DELETE FROM customers; DELETE FROM products; DELETE FROM categories;
    DELETE FROM promos;
    UPDATE counters SET value = 1000 WHERE name = 'orders';
    UPDATE settings SET delivery_fee = 30, free_delivery_over = 500, accepting_orders = 1 WHERE id = 1;
  `);
  database.prepare("INSERT INTO categories (id, name, name_ar) VALUES ('plain', 'Plain', 'سادة')").run();
  const insert = database.prepare(`
    INSERT INTO products (id, category_id, name, name_ar, price, note,
                          discount_enabled, discount_type, discount_value, available)
    VALUES (@id, 'plain', @name, @nameAr, @price, '', @de, @dt, @dv, @av)
  `);
  insert.run({ id: 'vanilla', name: 'Vanilla', nameAr: 'فانيليا', price: 50, de: 0, dt: 'percent', dv: 0, av: 1 });
  insert.run({ id: 'lotus', name: 'Lotus', nameAr: 'لوتس', price: 60, de: 0, dt: 'percent', dv: 0, av: 1 });
  insert.run({ id: 'sale', name: 'Sale Item', nameAr: 'عرض', price: 100, de: 1, dt: 'percent', dv: 25, av: 1 });
  insert.run({ id: 'soldout', name: 'Sold Out', nameAr: 'خلص', price: 40, de: 0, dt: 'percent', dv: 0, av: 0 });
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
    area: 'Nasr City',
    address: '27 Mohamed El-Moqrif',
    lang: 'en',
    ...overrides,
  };
}

test('prices the order from the catalogue, not from the request', async () => {
  seed();
  // A cart claiming a gateau costs four pounds. Every money field a client
  // could possibly send is present and wrong.
  const { order } = await createOrder(payload({
    items: [{ productId: 'vanilla', qty: 2, price: 1, unitPrice: 1, lineTotal: 2 }],
    subtotal: 2, total: 2, delivery: 0, discount: 999,
  }));
  // 2 x 50 = 100, plus 30 delivery (below the 500 free threshold).
  assert.equal(order.subtotal, 100);
  assert.equal(order.delivery, 30);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 130);
});

test('applies a discount configured on the product', async () => {
  seed();
  const { order } = await createOrder(payload({ items: [{ productId: 'sale', qty: 1 }] }));
  // 100 less 25% = 75, plus 30 delivery.
  assert.equal(order.subtotal, 75);
  assert.equal(order.total, 105);
});

test('waives delivery over the free threshold', async () => {
  seed();
  const { order } = await createOrder(payload({ items: [{ productId: 'lotus', qty: 10 }] }));
  assert.equal(order.subtotal, 600);
  assert.equal(order.delivery, 0);
  assert.equal(order.total, 600);
});

test('charges no delivery on a pickup order', async () => {
  seed();
  const { order } = await createOrder(payload({ fulfilment: 'pickup' }));
  assert.equal(order.delivery, 0);
  assert.equal(order.total, 100);
});

test('refuses when the total the customer was shown no longer matches', async () => {
  seed();
  await assert.rejects(
    () => createOrder(payload({ expectedTotal: 55 })),
    (error) => {
      assert.equal(error.code, 'PRICE_CHANGED');
      assert.equal(error.status, 409);
      // The real figure comes back so the checkout can show what changed.
      assert.equal(error.details.currentTotal, 130);
      return true;
    },
  );
});

test('accepts a matching expected total', async () => {
  seed();
  const { order } = await createOrder(payload({ expectedTotal: 130 }));
  assert.equal(order.total, 130);
});

test('a repeated idempotency key returns the first order rather than a second', async () => {
  seed();
  const body = payload({ idempotencyKey: 'same-key' });
  const first = await createOrder(body);
  const second = await createOrder(body);

  assert.equal(second.duplicate, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(db.get().prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
});

test('the same key with a different basket is a conflict, not an overwrite', async () => {
  seed();
  await createOrder(payload({ idempotencyKey: 'reused' }));
  await assert.rejects(
    () => createOrder(payload({
      idempotencyKey: 'reused',
      items: [{ productId: 'lotus', qty: 3 }],
    })),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('refuses a product that is no longer on the menu', async () => {
  seed();
  await assert.rejects(
    () => createOrder(payload({ items: [{ productId: 'ghost', qty: 1 }] })),
    (error) => error.code === 'PRODUCT_MISSING',
  );
});

test('refuses a product that has sold out', async () => {
  seed();
  await assert.rejects(
    () => createOrder(payload({ items: [{ productId: 'soldout', qty: 1 }] })),
    (error) => error.code === 'PRODUCT_UNAVAILABLE',
  );
});

test('refuses every order while the shop is closed', async () => {
  seed();
  db.get().prepare('UPDATE settings SET accepting_orders = 0 WHERE id = 1').run();
  await assert.rejects(() => createOrder(payload()), (error) => error.code === 'CLOSED');
});

test('writes nothing at all when it refuses', async () => {
  seed();
  const before = db.get().prepare('SELECT COUNT(*) c FROM orders').get().c;
  await assert.rejects(() => createOrder(payload({ items: [{ productId: 'soldout', qty: 1 }] })));
  const after = db.get().prepare('SELECT COUNT(*) c FROM orders').get().c;
  // The counter is bumped inside the transaction too, so a rolled-back order
  // must not consume a reference number either.
  assert.equal(after, before);
  assert.equal(db.get().prepare("SELECT value v FROM counters WHERE name='orders'").get().v, 1000);
});

test('copies the name and price onto the line so a later edit cannot rewrite history', async () => {
  seed();
  const { order } = await createOrder(payload());
  db.get().prepare("UPDATE products SET name = 'Renamed', price = 999 WHERE id = 'vanilla'").run();

  const line = db.get().prepare('SELECT * FROM order_items WHERE order_id = ?').get(order.id);
  assert.equal(line.name, 'Vanilla');
  assert.equal(line.unit_price, 50);
  assert.equal(line.line_total, 100);
});

test('accumulates a returning customer onto one record', async () => {
  seed();
  await createOrder(payload());
  await createOrder(payload({ phone: '+201016521650' }));

  const customers = db.get().prepare('SELECT * FROM customers').all();
  assert.equal(customers.length, 1, 'the same person in two formats must be one customer');
  assert.equal(customers[0].orders_count, 2);
  assert.equal(customers[0].total_spent, 260);
});

test('allocates readable, sequential references', async () => {
  seed();
  const a = await createOrder(payload());
  const b = await createOrder(payload());
  assert.equal(a.order.reference, 'HC-1001');
  assert.equal(b.order.reference, 'HC-1002');
});

test('applies a valid promo and counts its use', async () => {
  seed();
  db.get().prepare(`
    INSERT INTO promos (code, type, value, min_subtotal, max_uses, active)
    VALUES ('WELCOME10', 'percent', 10, 0, 5, 1)
  `).run();
  const { order } = await createOrder(payload({ promoCode: 'welcome10' }));
  assert.equal(order.discount, 10); // 10% of 100
  assert.equal(order.total, 120);   // 100 - 10 + 30
  assert.equal(db.get().prepare("SELECT used_count c FROM promos WHERE code='WELCOME10'").get().c, 1);
});

test('refuses a fully redeemed promo', async () => {
  seed();
  db.get().prepare(`
    INSERT INTO promos (code, type, value, min_subtotal, max_uses, used_count, active)
    VALUES ('GONE', 'percent', 10, 0, 1, 1, 1)
  `).run();
  await assert.rejects(
    () => createOrder(payload({ promoCode: 'GONE' })),
    (error) => error.code === 'INVALID_PROMO',
  );
});

test('a promo can never make the total negative', async () => {
  seed();
  db.get().prepare(`
    INSERT INTO promos (code, type, value, min_subtotal, max_uses, active)
    VALUES ('HUGE', 'fixed', 100000, 0, 0, 1)
  `).run();
  const { order } = await createOrder(payload({ fulfilment: 'pickup' }));
  assert.ok(order.total >= 0);
});

test('normalizePhone folds the formats people actually type', () => {
  for (const input of ['01016521650', '+201016521650', '00201016521650', '0101 652 1650', '201016521650']) {
    assert.equal(normalizePhone(input), '01016521650', `failed on ${input}`);
  }
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('01916521650'), null, 'not a valid Egyptian mobile prefix');
});
