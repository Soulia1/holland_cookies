/**
 * Options: a product's list of things the customer picks exactly one of.
 *
 * Driven through the real routes against the emulator — the dashboard saves the
 * list, the public menu shows it, and checkout accepts only one of its entries.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-choices';
process.env.ADMIN_KEY = 'choices-fixture-admin-0123456789abcdefghij';
process.env.JWT_SECRET = 'choices-fixture-session-0123456789abcdefghij';
process.env.BREVO_API_KEY = '';
process.env.MAIL_TRANSPORT = 'disabled';

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { default: app } = await import('../server.js');
const fsdb = await import('../firestore.js');

let server;
let base;
let cookie = '';

async function request(route, { method = 'GET', body, admin = true } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'x-requested-with': 'Holland',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(admin && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data };
}

const VANILLA = 'Vanilla, Nutella filling';
const CHOCOLATE = 'Chocolate, white Nutella filling';

const place = (items) => request('/api/orders', {
  method: 'POST',
  admin: false,
  body: { idempotencyKey: randomUUID(), items, firstName: 'Fixture', phone: '01012345678', fulfilment: 'pickup' },
});

const saveOptions = (choices) => request('/api/menu/admin/products/scoop', { method: 'PATCH', body: { choices } });

async function menuProduct(id) {
  const menu = await request('/api/menu', { admin: false });
  return menu.data.categories.flatMap((category) => category.items).find((item) => item.id === id);
}

async function wipe(names) {
  await Promise.all(names.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

before(async () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /, 'refusing to run against a real Firestore project');

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/admin/session`, {
    method: 'POST',
    headers: { 'x-requested-with': 'Holland', 'content-type': 'application/json' },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

beforeEach(async () => {
  await wipe(['orders', 'orderIdempotency', 'customers', 'products', 'categories', 'promos',
    'rateLimits', 'auditEvents', 'counters', 'settings']);
  const product = (fields) => ({
    categoryId: 'scoops', nameAr: '', description: '', descriptionAr: '', note: 'Foil tray', noteAr: '',
    image: '', available: true, discountEnabled: false, discountType: 'percent', discountValue: 0,
    sort: 0, isBundle: false, bundleType: 'fixed', components: [], groups: [], ...fields,
  });
  await Promise.all([
    fsdb.collections.categories().doc('scoops')
      .set({ name: 'Scoops', nameAr: '', sort: 0, visible: true, group: 'cookies' }),
    fsdb.collections.products().doc('scoop').set(product({ name: 'Cookie scoops', price: 300 })),
    fsdb.collections.products().doc('plain').set(product({ name: 'Plain', price: 50 })),
    fsdb.orderCounterDoc().set({ value: 1000 }),
    fsdb.settingsDoc().set({ deliveryFee: 0, freeDeliveryOver: 0, acceptingOrders: true, areas: [] }),
  ]);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsdb.close().catch(() => {});
});

test('options saved in the dashboard reach the public menu, and can be emptied', async () => {
  const saved = await saveOptions([{ name: ` ${VANILLA} `, nameAr: 'فانيليا' }, { name: CHOCOLATE }]);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const expected = [{ name: VANILLA, nameAr: 'فانيليا' }, { name: CHOCOLATE }];
  assert.deepEqual(saved.data.product.choices, expected);
  assert.deepEqual((await menuProduct('scoop')).choices, expected);

  const cleared = await saveOptions([]);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.deepEqual((await menuProduct('scoop')).choices, []);
});

test('an unrelated edit leaves the options alone', async () => {
  await saveOptions([{ name: VANILLA }]);
  const renamed = await request('/api/menu/admin/products/scoop', { method: 'PATCH', body: { price: 320 } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.deepEqual((await menuProduct('scoop')).choices, [{ name: VANILLA }]);
});

test('the dashboard cannot save blank or duplicate options, or options on a bundle', async () => {
  const twice = await saveOptions([{ name: VANILLA }, { name: VANILLA.toUpperCase() }]);
  assert.equal(twice.status, 400);
  assert.match(twice.data.message, /different name/);

  const blank = await saveOptions([{ name: '   ' }]);
  assert.equal(blank.status, 400);

  await saveOptions([{ name: VANILLA }]);
  const bundle = await request('/api/menu/admin/products/scoop', {
    method: 'PATCH',
    body: { isBundle: true, bundleType: 'fixed', components: [{ productId: 'plain', quantity: 1 }] },
  });
  assert.equal(bundle.status, 400);
  assert.match(bundle.data.message, /cannot also have options/);
});

test('a new product can be created with options', async () => {
  const created = await request('/api/menu/admin/products', {
    method: 'POST',
    body: { id: 'shake', categoryId: 'scoops', name: 'Shake', price: 80, choices: [{ name: 'Small' }, { name: 'Large' }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual((await menuProduct('shake')).choices, [{ name: 'Small' }, { name: 'Large' }]);
});

test('checkout records the option picked, and each option is its own line', async () => {
  await saveOptions([{ name: VANILLA, nameAr: 'فانيليا' }, { name: CHOCOLATE }]);
  const placed = await place([
    { productId: 'scoop', qty: 2, choice: VANILLA },
    { productId: 'scoop', qty: 1, choice: CHOCOLATE },
  ]);
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const lines = placed.data.order.items;
  assert.deepEqual(
    lines.map((line) => [line.name, line.choice.name, line.qty, line.lineTotal]),
    [['Cookie scoops', VANILLA, 2, 600], ['Cookie scoops', CHOCOLATE, 1, 300]],
  );
  assert.equal(lines[0].choice.nameAr, 'فانيليا');
  assert.equal(placed.data.order.totals.total, 900);
});

test('checkout refuses a missing, unknown or unexpected option, and writes nothing', async () => {
  await saveOptions([{ name: VANILLA }]);
  for (const items of [
    [{ productId: 'scoop', qty: 1 }],
    [{ productId: 'scoop', qty: 1, choice: 'Lotus' }],
    [{ productId: 'plain', qty: 1, choice: VANILLA }],
  ]) {
    const refused = await place(items);
    assert.equal(refused.status, 400, JSON.stringify(refused.data));
    assert.equal(refused.data.error, 'INVALID_CHOICE');
  }
  assert.equal((await fsdb.collections.orders().count().get()).data().count, 0);
});
