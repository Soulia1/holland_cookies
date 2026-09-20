/**
 * What the dashboard changes, as the order pipeline then sees it.
 *
 * Every test drives the real HTTP routes against a Firestore emulator: an admin
 * write goes in through the same endpoint the dashboard calls, and the effect is
 * read back through the public menu or proved by placing an order. A dashboard
 * control that saves but is never read by checkout passes a unit test and fails
 * a customer, so this suite only asserts across that seam.
 *
 * It also attacks the order endpoint the way a browser console can: prices,
 * totals and fees written into the payload, impossible quantities, sold-out and
 * deleted products, and bundle picks the bundle does not offer.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-admin-ops';
process.env.ADMIN_KEY = 'admin-ops-fixture-admin-0123456789abcdefgh';
process.env.JWT_SECRET = 'admin-ops-fixture-session-0123456789abcdefgh';
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
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data };
}

const order = (extra = {}) => ({
  idempotencyKey: randomUUID(),
  items: [{ productId: 'plain', qty: 1 }],
  firstName: 'Fixture',
  phone: '01012345678',
  fulfilment: 'pickup',
  ...extra,
});

const place = (extra) => request('/api/orders', { method: 'POST', body: order(extra), admin: false });

async function wipe(names) {
  await Promise.all(names.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

async function publicProduct(id) {
  const menu = await request('/api/menu', { admin: false });
  return menu.data.categories.flatMap((category) => category.items).find((item) => item.id === id);
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
  const categories = fsdb.collections.categories();
  const products = fsdb.collections.products();
  await categories.doc('cookies').set({ name: 'Cookies', nameAr: 'كوكيز', sort: 0, visible: true, group: 'cookies' });
  const product = (fields) => ({
    categoryId: 'cookies', nameAr: '', description: '', descriptionAr: '', note: '', noteAr: '',
    image: '', available: true, discountEnabled: false, discountType: 'percent', discountValue: 0,
    sort: 0, isBundle: false, bundleType: 'fixed', components: [], groups: [], ...fields,
  });
  await Promise.all([
    products.doc('plain').set(product({ name: 'Plain', price: 100 })),
    products.doc('percent-off').set(product({
      name: 'Ten Percent Off', price: 100, discountEnabled: true, discountType: 'percent', discountValue: 10,
    })),
    products.doc('fixed-off').set(product({
      name: 'Twenty Off', price: 100, discountEnabled: true, discountType: 'fixed', discountValue: 20,
    })),
    products.doc('sold-out').set(product({ name: 'Sold Out', price: 100, available: false })),
    products.doc('box').set(product({
      name: 'Box', price: 180, isBundle: true, bundleType: 'fixed',
      components: [{ productId: 'plain', quantity: 2 }],
    })),
    products.doc('pick-two').set(product({
      name: 'Pick Two', price: 150, isBundle: true, bundleType: 'choice',
      groups: [{
        label: 'Cookies', labelAr: '', choose: 2, allowRepeats: false,
        options: [{ productId: 'plain', surcharge: 0 }, { productId: 'percent-off', surcharge: 5 }],
      }],
    })),
  ]);
  await fsdb.orderCounterDoc().set({ value: 1000 });
  await fsdb.settingsDoc().set({
    deliveryFee: 40, freeDeliveryOver: 0, acceptingOrders: true,
    areas: [{ id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر' }],
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsdb.close().catch(() => {});
});

// ------------------------------------------------------------------ auth ----

test('every admin write and read refuses a request without a session', async () => {
  const attempts = [
    ['GET', '/api/orders'],
    ['GET', '/api/orders/stats'],
    ['PATCH', '/api/orders/HC-1001/status', { status: 'confirmed' }],
    ['PATCH', '/api/orders/HC-1001/payment', { paymentStatus: 'paid' }],
    ['POST', '/api/menu/admin/products', { id: 'x', categoryId: 'cookies', name: 'X', price: 1 }],
    ['PATCH', '/api/menu/admin/products/plain', { price: 1 }],
    ['DELETE', '/api/menu/admin/products/plain'],
    ['POST', '/api/menu/admin/categories', { id: 'x', name: 'X' }],
    ['DELETE', '/api/menu/admin/categories/cookies'],
    ['PATCH', '/api/admin/settings', { deliveryFee: 0 }],
    ['POST', '/api/admin/promos', { code: 'FREE', type: 'percent', value: 50 }],
    ['DELETE', '/api/admin/promos/FREE'],
    ['POST', '/api/admin/images', { data: 'AAAA' }],
    ['GET', '/api/admin/users'],
  ];
  for (const [method, route, body] of attempts) {
    const response = await request(route, { method, body, admin: false });
    assert.equal(response.status, 401, `${method} ${route} must require an admin session`);
  }
  assert.equal((await publicProduct('plain')).price, 100, 'nothing changed');
});

// --------------------------------------------------------------- pricing ----

test('a discount prices the same on the menu, in the order and on every line', async () => {
  assert.deepEqual(
    (({ price, regularPrice, discounted }) => ({ price, regularPrice, discounted }))(await publicProduct('percent-off')),
    { price: 90, regularPrice: 100, discounted: true },
  );
  assert.equal((await publicProduct('fixed-off')).price, 80);

  const placed = await place({
    items: [{ productId: 'percent-off', qty: 2 }, { productId: 'fixed-off', qty: 1 }],
    fulfilment: 'delivery', area: 'nasr-city', address: '1 Street',
    expectedTotal: 300,
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.deepEqual(placed.data.order.totals, { subtotal: 260, discount: 0, delivery: 40, total: 300 });
  assert.deepEqual(placed.data.order.items.map((line) => [line.productId, line.unitPrice, line.lineTotal]),
    [['percent-off', 90, 180], ['fixed-off', 80, 80]]);
  assert.equal(placed.data.order.paymentMethod, 'cash');
  assert.equal(placed.data.order.paymentStatus, 'unpaid');

  // The dashboard reads the same stored figures.
  const stored = await request(`/api/orders/${placed.data.order.reference}`);
  assert.deepEqual(stored.data.order.totals, placed.data.order.totals);
});

test('money written into the order payload is refused, never used', async () => {
  const withPrice = await place({ items: [{ productId: 'plain', qty: 1, price: 1 }] });
  assert.equal(withPrice.status, 400, 'a line price is not a field the server accepts');

  for (const field of ['total', 'subtotal', 'discount', 'delivery', 'deliveryFee']) {
    const forged = await place({ [field]: 0 });
    assert.equal(forged.status, 400, `${field} must not be accepted from the browser`);
  }

  const stale = await place({ expectedTotal: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'PRICE_CHANGED');
  assert.equal(stale.data.details.currentTotal, 100);

  const fakePromo = await place({ promoCode: 'NOTREAL' });
  assert.equal(fakePromo.status, 400);
  assert.equal(fakePromo.data.error, 'INVALID_PROMO');

  const orders = await request('/api/orders');
  assert.equal(orders.data.total, 0, 'no refused request created an order');
});

test('impossible quantities and products the shop does not sell are refused', async () => {
  for (const qty of [-1, 0, 51, 1.5, '2', null]) {
    const response = await place({ items: [{ productId: 'plain', qty }] });
    assert.equal(response.status, 400, `qty ${JSON.stringify(qty)} must be refused`);
  }

  const missing = await place({ items: [{ productId: 'no-such-cookie', qty: 1 }] });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, 'PRODUCT_MISSING');

  const soldOut = await place({ items: [{ productId: 'sold-out', qty: 1 }] });
  assert.equal(soldOut.status, 409);
  assert.equal(soldOut.data.error, 'PRODUCT_UNAVAILABLE');

  const nowhere = await place({ fulfilment: 'delivery', area: 'mars', address: '1 Crater' });
  assert.equal(nowhere.status, 400);
  assert.equal(nowhere.data.error, 'INVALID_AREA');

  const malformed = await request('/api/orders', { method: 'POST', body: '{"items": [', admin: false });
  assert.equal(malformed.status, 400);

  const orders = await request('/api/orders');
  assert.equal(orders.data.total, 0);
});

test('bundle picks are checked against the bundle as stored', async () => {
  const pick = (selections) => place({ items: [{ productId: 'pick-two', qty: 1, selections }] });

  const tooFew = await pick([{ group: 0, productId: 'plain', quantity: 1 }]);
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.data.error, 'INVALID_SELECTION');

  const notOffered = await pick([
    { group: 0, productId: 'plain', quantity: 1 }, { group: 0, productId: 'fixed-off', quantity: 1 },
  ]);
  assert.equal(notOffered.data.error, 'INVALID_SELECTION');

  const repeated = await pick([{ group: 0, productId: 'plain', quantity: 2 }]);
  assert.equal(repeated.data.error, 'INVALID_SELECTION', 'repeats are off for this group');

  const noSuchGroup = await pick([
    { group: 0, productId: 'plain', quantity: 1 }, { group: 3, productId: 'percent-off', quantity: 1 },
  ]);
  assert.equal(noSuchGroup.data.error, 'INVALID_SELECTION');

  const onPlainProduct = await place({ items: [{ productId: 'plain', qty: 1, selections: [{ group: 0, productId: 'plain', quantity: 1 }] }] });
  assert.equal(onPlainProduct.data.error, 'INVALID_SELECTION');

  // The surcharge comes from the stored option, not from anything sent.
  const valid = await pick([
    { group: 0, productId: 'plain', quantity: 1 }, { group: 0, productId: 'percent-off', quantity: 1 },
  ]);
  assert.equal(valid.status, 201, JSON.stringify(valid.data));
  assert.equal(valid.data.order.items[0].unitPrice, 155);
  assert.deepEqual(valid.data.order.items[0].selections.map((s) => s.productId).sort(), ['percent-off', 'plain']);

  const fixed = await place({ items: [{ productId: 'box', qty: 2 }] });
  assert.equal(fixed.status, 201);
  assert.deepEqual(fixed.data.order.items[0].components, [{ productId: 'plain', name: 'Plain', quantity: 2 }]);
  assert.equal(fixed.data.order.totals.total, 360);
});

// -------------------------------------------------------------- settings ----

test('the delivery fee is set in the dashboard and charged by the server', async () => {
  const saved = await request('/api/admin/settings', { method: 'PATCH', body: { deliveryFee: 55, freeDeliveryOver: 250 } });
  assert.equal(saved.status, 200);

  const readBack = await request('/api/admin/settings', { admin: false });
  assert.deepEqual(
    (({ deliveryFee, freeDeliveryOver, acceptingOrders }) => ({ deliveryFee, freeDeliveryOver, acceptingOrders }))(readBack.data.settings),
    { deliveryFee: 55, freeDeliveryOver: 250, acceptingOrders: true },
  );

  const delivered = await place({ fulfilment: 'delivery', area: 'nasr-city', address: '1 Street' });
  assert.equal(delivered.data.order.totals.delivery, 55);
  assert.equal(delivered.data.order.totals.total, 155);

  const free = await place({
    items: [{ productId: 'plain', qty: 3 }], fulfilment: 'delivery', area: 'nasr-city', address: '1 Street',
  });
  assert.equal(free.data.order.totals.delivery, 0, 'over the threshold delivery is free');

  const pickup = await place({ fulfilment: 'pickup' });
  assert.equal(pickup.data.order.totals.delivery, 0);

  for (const body of [{ deliveryFee: -1 }, { deliveryFee: '40' }, { freeDeliveryOver: -5 }, { deliveryFee: 1e7 }, { storeName: 'x' }]) {
    const refused = await request('/api/admin/settings', { method: 'PATCH', body });
    assert.equal(refused.status, 400, `settings ${JSON.stringify(body)} must be refused`);
  }
  const nan = await request('/api/admin/settings', { method: 'PATCH', body: '{"deliveryFee": NaN}' });
  assert.equal(nan.status, 400);
  assert.equal((await request('/api/admin/settings', { admin: false })).data.settings.deliveryFee, 55);
});

/*
 * Delivery areas are edited in the dashboard and enforced by the server. The
 * trap this covers is the one that makes the whole feature pointless: an order
 * stores the area's *id*, so a shop that re-ids an area while editing the list
 * orphans every order already placed to it.
 */
test('the dashboard edits the delivery areas, and checkout offers exactly them', async () => {
  const areas = [
    { id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر', city: 'Cairo', cityAr: 'القاهرة' },
    { id: 'haram', name: 'Haram', nameAr: 'الهرم', city: 'Giza', cityAr: 'الجيزة' },
  ];
  const saved = await request('/api/admin/settings', { method: 'PATCH', body: { areas } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  // The public settings the checkout select is drawn from.
  const offered = (await request('/api/admin/settings', { admin: false })).data.settings.areas;
  assert.deepEqual(offered, areas);

  const giza = await place({ fulfilment: 'delivery', area: 'haram', address: '1 Street' });
  assert.equal(giza.status, 201, JSON.stringify(giza.data));
  assert.equal(giza.data.order.delivery.area, 'haram');

  // An area that was in the list before this edit is no longer deliverable.
  const gone = await place({ fulfilment: 'delivery', area: 'maadi', address: '1 Street' });
  assert.equal(gone.status, 400);
  assert.equal(gone.data.error, 'INVALID_AREA');
});

test('removing an area does not disturb the orders already placed to it', async () => {
  const placed = await place({ fulfilment: 'delivery', area: 'nasr-city', address: '1 Street' });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));

  await request('/api/admin/settings', {
    method: 'PATCH',
    body: { areas: [{ id: 'haram', name: 'Haram', city: 'Giza' }] },
  });
  const order = await request(`/api/orders/${placed.data.order.reference}`);
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(order.data.order.delivery.area, 'nasr-city');
});

test('the server charges the area its own delivery price', async () => {
  const saved = await request('/api/admin/settings', {
    method: 'PATCH',
    body: {
      deliveryFee: 40,
      freeDeliveryOver: 0,
      areas: [
        { id: 'nasr-city', name: 'Nasr City', city: 'Cairo' },
        { id: 'haram', name: 'Haram', city: 'Giza', fee: 70 },
        { id: 'downtown', name: 'Downtown', city: 'Cairo', fee: 0 },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const address = { fulfilment: 'delivery', address: '1 Street' };
  const far = await place({ ...address, area: 'haram' });
  assert.equal(far.status, 201, JSON.stringify(far.data));
  assert.equal(far.data.order.totals.delivery, 70, "the area's own price");

  const near = await place({ ...address, area: 'nasr-city' });
  assert.equal(near.data.order.totals.delivery, 40, "the shop's default where the area names none");

  // Zero is a price, not "unset": this area is delivered free and must not
  // quietly fall back to the 40.
  const free = await place({ ...address, area: 'downtown' });
  assert.equal(free.data.order.totals.delivery, 0);

  // And the figure is the shop's, whatever the browser expected.
  const stale = await request('/api/orders', {
    method: 'POST',
    admin: false,
    body: { ...order({ ...address, area: 'haram' }), expectedTotal: 140 },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.error, 'PRICE_CHANGED');
});

test('a free-delivery threshold still waives an area with its own price', async () => {
  await request('/api/admin/settings', {
    method: 'PATCH',
    body: {
      deliveryFee: 40,
      freeDeliveryOver: 100,
      areas: [{ id: 'haram', name: 'Haram', city: 'Giza', fee: 70 }],
    },
  });
  const over = await place({
    fulfilment: 'delivery', area: 'haram', address: '1 Street',
    items: [{ productId: 'plain', qty: 3 }],
  });
  assert.equal(over.status, 201, JSON.stringify(over.data));
  assert.equal(over.data.order.totals.delivery, 0);
});

test('an area list the server cannot enforce is refused', async () => {
  for (const areas of [
    [{ id: '', name: 'Nowhere' }],
    [{ id: 'x', name: '' }],
    [{ id: 'x', name: 'X', governorate: 'Cairo' }],
    [{ id: 'x', name: 'X', fee: -1 }],
    [{ id: 'x', name: 'X', fee: '40' }],
    Array.from({ length: 81 }, (_, index) => ({ id: `a${index}`, name: `A${index}` })),
  ]) {
    const refused = await request('/api/admin/settings', { method: 'PATCH', body: { areas } });
    assert.equal(refused.status, 400, `areas ${JSON.stringify(areas).slice(0, 60)} must be refused`);
  }
  const kept = (await request('/api/admin/settings', { admin: false })).data.settings.areas;
  assert.deepEqual(kept.map((area) => area.id), ['nasr-city']);
});

/*
 * Delivery areas are edited in the dashboard and enforced by the server. The
 * trap this covers is the one that makes the whole feature pointless: an order
 * stores the area's *id*, so a shop that re-ids an area while editing the list
 * orphans every order already placed to it.
 */
test('the dashboard edits the delivery areas, and checkout offers exactly them', async () => {
  const areas = [
    { id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر', city: 'Cairo', cityAr: 'القاهرة' },
    { id: 'haram', name: 'Haram', nameAr: 'الهرم', city: 'Giza', cityAr: 'الجيزة' },
  ];
  const saved = await request('/api/admin/settings', { method: 'PATCH', body: { areas } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  // The public settings the checkout select is drawn from.
  const offered = (await request('/api/admin/settings', { admin: false })).data.settings.areas;
  assert.deepEqual(offered, areas);

  const giza = await place({ fulfilment: 'delivery', area: 'haram', address: '1 Street' });
  assert.equal(giza.status, 201, JSON.stringify(giza.data));
  assert.equal(giza.data.order.delivery.area, 'haram');

  // An area that was in the list before this edit is no longer deliverable.
  const gone = await place({ fulfilment: 'delivery', area: 'maadi', address: '1 Street' });
  assert.equal(gone.status, 400);
  assert.equal(gone.data.error, 'INVALID_AREA');
});

test('removing an area does not disturb the orders already placed to it', async () => {
  const placed = await place({ fulfilment: 'delivery', area: 'nasr-city', address: '1 Street' });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));

  await request('/api/admin/settings', {
    method: 'PATCH',
    body: { areas: [{ id: 'haram', name: 'Haram', city: 'Giza' }] },
  });
  const order = await request(`/api/orders/${placed.data.order.reference}`);
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(order.data.order.delivery.area, 'nasr-city');
});

test('the server charges the area its own delivery price', async () => {
  const saved = await request('/api/admin/settings', {
    method: 'PATCH',
    body: {
      deliveryFee: 40,
      freeDeliveryOver: 0,
      areas: [
        { id: 'nasr-city', name: 'Nasr City', city: 'Cairo' },
        { id: 'haram', name: 'Haram', city: 'Giza', fee: 70 },
        { id: 'downtown', name: 'Downtown', city: 'Cairo', fee: 0 },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const address = { fulfilment: 'delivery', address: '1 Street' };
  const far = await place({ ...address, area: 'haram' });
  assert.equal(far.status, 201, JSON.stringify(far.data));
  assert.equal(far.data.order.totals.delivery, 70, "the area's own price");

  const near = await place({ ...address, area: 'nasr-city' });
  assert.equal(near.data.order.totals.delivery, 40, "the shop's default where the area names none");

  // Zero is a price, not "unset": this area is delivered free and must not
  // quietly fall back to the 40.
  const free = await place({ ...address, area: 'downtown' });
  assert.equal(free.data.order.totals.delivery, 0);

  // And the figure is the shop's, whatever the browser expected.
  const stale = await request('/api/orders', {
    method: 'POST',
    admin: false,
    body: { ...order({ ...address, area: 'haram' }), expectedTotal: 140 },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.error, 'PRICE_CHANGED');
});

test('a free-delivery threshold still waives an area with its own price', async () => {
  await request('/api/admin/settings', {
    method: 'PATCH',
    body: {
      deliveryFee: 40,
      freeDeliveryOver: 100,
      areas: [{ id: 'haram', name: 'Haram', city: 'Giza', fee: 70 }],
    },
  });
  const over = await place({
    fulfilment: 'delivery', area: 'haram', address: '1 Street',
    items: [{ productId: 'plain', qty: 3 }],
  });
  assert.equal(over.status, 201, JSON.stringify(over.data));
  assert.equal(over.data.order.totals.delivery, 0);
});

test('an area list the server cannot enforce is refused', async () => {
  for (const areas of [
    [{ id: '', name: 'Nowhere' }],
    [{ id: 'x', name: '' }],
    [{ id: 'x', name: 'X', governorate: 'Cairo' }],
    [{ id: 'x', name: 'X', fee: -1 }],
    [{ id: 'x', name: 'X', fee: '40' }],
    Array.from({ length: 81 }, (_, index) => ({ id: `a${index}`, name: `A${index}` })),
  ]) {
    const refused = await request('/api/admin/settings', { method: 'PATCH', body: { areas } });
    assert.equal(refused.status, 400, `areas ${JSON.stringify(areas).slice(0, 60)} must be refused`);
  }
  const kept = (await request('/api/admin/settings', { admin: false })).data.settings.areas;
  assert.deepEqual(kept.map((area) => area.id), ['nasr-city']);
});

test('turning off accepting orders closes checkout on the server', async () => {
  assert.equal((await request('/api/admin/settings', { method: 'PATCH', body: { acceptingOrders: false } })).status, 200);
  assert.equal((await request('/api/admin/settings', { admin: false })).data.settings.acceptingOrders, false);

  const closed = await place();
  assert.equal(closed.status, 409);
  assert.equal(closed.data.error, 'CLOSED');

  assert.equal((await request('/api/admin/settings', { method: 'PATCH', body: { acceptingOrders: true } })).status, 200);
  assert.equal((await place()).status, 201);
});

// --------------------------------------------------------------- products ----

test('a product created, edited, sold out and deleted in the dashboard is what the shop sells', async () => {
  const created = await request('/api/menu/admin/products', {
    method: 'POST',
    body: {
      id: 'chocolate-chunk-cookie', categoryId: 'cookies', name: 'Chocolate Chunk Cookie', nameAr: 'كوكيز شوكولاتة',
      description: 'Baked today.', descriptionAr: 'مخبوزة النهارده.', price: 70, available: true,
      image: '/api/images/0123456789abcdef0123456789abcdef.webp',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(
    (({ name, nameAr, description, descriptionAr, price, image, available }) => ({ name, nameAr, description, descriptionAr, price, image, available }))(await publicProduct('chocolate-chunk-cookie')),
    {
      name: 'Chocolate Chunk Cookie', nameAr: 'كوكيز شوكولاتة', description: 'Baked today.', descriptionAr: 'مخبوزة النهارده.',
      price: 70, image: '/api/images/0123456789abcdef0123456789abcdef.webp', available: true,
    },
  );

  const duplicate = await request('/api/menu/admin/products', {
    method: 'POST', body: { id: 'chocolate-chunk-cookie', categoryId: 'cookies', name: 'Another', price: 1 },
  });
  assert.equal(duplicate.status, 409, 'a taken id is refused, never overwritten');
  assert.equal((await publicProduct('chocolate-chunk-cookie')).name, 'Chocolate Chunk Cookie');

  const edited = await request('/api/menu/admin/products/chocolate-chunk-cookie', {
    method: 'PATCH',
    body: {
      name: 'Double Chocolate Cookie', price: 75, discountEnabled: true, discountType: 'fixed', discountValue: 5,
      image: '/api/images/fedcba9876543210fedcba9876543210.webp',
    },
  });
  assert.equal(edited.status, 200);
  const after = await publicProduct('chocolate-chunk-cookie');
  assert.deepEqual([after.name, after.price, after.regularPrice, after.image],
    ['Double Chocolate Cookie', 70, 75, '/api/images/fedcba9876543210fedcba9876543210.webp']);
  const sold = await place({ items: [{ productId: 'chocolate-chunk-cookie', qty: 1 }], expectedTotal: 70 });
  assert.equal(sold.status, 201);
  assert.equal(sold.data.order.items[0].name, 'Double Chocolate Cookie');

  await request('/api/menu/admin/products/chocolate-chunk-cookie', { method: 'PATCH', body: { available: false } });
  assert.equal((await publicProduct('chocolate-chunk-cookie')).available, false);
  assert.equal((await place({ items: [{ productId: 'chocolate-chunk-cookie', qty: 1 }] })).data.error, 'PRODUCT_UNAVAILABLE');
  await request('/api/menu/admin/products/chocolate-chunk-cookie', { method: 'PATCH', body: { available: true } });
  assert.equal((await place({ items: [{ productId: 'chocolate-chunk-cookie', qty: 1 }] })).status, 201);

  assert.equal((await request('/api/menu/admin/products/chocolate-chunk-cookie', { method: 'DELETE' })).status, 204);
  assert.equal(await publicProduct('chocolate-chunk-cookie'), undefined, 'gone from the public menu');
  assert.equal((await place({ items: [{ productId: 'chocolate-chunk-cookie', qty: 1 }] })).data.error, 'PRODUCT_MISSING');
  // The order placed before the deletion still reads correctly.
  const kept = await request(`/api/orders/${sold.data.order.reference}`);
  assert.equal(kept.data.order.items[0].name, 'Double Chocolate Cookie');
});

test('invalid product fields are refused with the field named', async () => {
  const create = (body) => request('/api/menu/admin/products', {
    method: 'POST', body: { id: 'bad', categoryId: 'cookies', name: 'Bad', price: 10, ...body },
  });
  const cases = [
    [{ name: '   ' }, 'name'],
    [{ price: -1 }, 'price'],
    [{ price: 'ten' }, 'price'],
    [{ price: null }, 'price'],
    [{ id: 'Has Spaces' }, 'id'],
    [{ name: 'x'.repeat(201) }, 'name'],
    [{ image: 'https://evil.example/x.png' }, 'image'],
    [{ categoryId: 'nope' }, null],
    [{ discountEnabled: true, discountType: 'percent', discountValue: 100 }, null],
    [{ discountEnabled: true, discountType: 'percent', discountValue: -5 }, 'discountValue'],
    [{ discountEnabled: true, discountType: 'fixed', discountValue: 10 }, null],
  ];
  for (const [body, field] of cases) {
    const response = await create(body);
    assert.equal(response.status, 400, `${JSON.stringify(body)} must be refused`);
    if (field) assert.equal(response.data.details?.[0]?.path?.[0], field, `${JSON.stringify(body)} names ${field}`);
    else assert.ok(response.data.message && response.data.message !== 'Check the fields.', 'a specific message');
  }
  assert.equal(await publicProduct('bad'), undefined);

  // Valid alone, invalid together: a fixed discount that a price cut would push to zero.
  const cut = await request('/api/menu/admin/products/fixed-off', { method: 'PATCH', body: { price: 15 } });
  assert.equal(cut.status, 400);
  assert.equal((await publicProduct('fixed-off')).price, 80);
});

test('a category holding products is never deleted by accident', async () => {
  const refused = await request('/api/menu/admin/categories/cookies', { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'CATEGORY_NOT_EMPTY');
  assert.ok(await publicProduct('plain'), 'its products are untouched');

  await request('/api/menu/admin/categories', { method: 'POST', body: { id: 'seasonal', name: 'Seasonal', group: 'desserts' } });
  const moved = await request('/api/menu/admin/products/plain', { method: 'PATCH', body: { categoryId: 'seasonal' } });
  assert.equal(moved.status, 200);
  assert.equal((await publicProduct('plain')).categoryId, 'seasonal');
  // Seasonal is empty of bundles, so an explicit cascade takes exactly its one product.
  const cascade = await request('/api/menu/admin/categories/seasonal?withProducts=1', { method: 'DELETE' });
  assert.equal(cascade.status, 409, 'plain is still inside the box bundle, so the cascade refuses');
  assert.equal(cascade.data.error, 'PRODUCT_IN_BUNDLE');
});

// ----------------------------------------------------------------- promos ----

test('promo expiry is a timestamp or nothing, and the server decides the discount', async () => {
  const create = (body) => request('/api/admin/promos', { method: 'POST', body: { type: 'percent', value: 10, ...body } });

  assert.equal((await create({ code: 'EMPTY', expiresAt: '' })).status, 400, 'an empty string is not an expiry');
  assert.equal((await create({ code: 'DATEONLY', expiresAt: '2099-12-31' })).status, 400, 'a bare date is not a timestamp');
  assert.equal((await create({ code: 'PAST', expiresAt: '2001-01-01T00:00:00.000Z' })).data.details[0].message, 'That expiry date has already passed.');
  assert.equal((await create({ code: 'HUNDRED', value: 100 })).status, 400);
  assert.equal((await create({ code: 'NEGATIVE', value: -10 })).status, 400);

  assert.equal((await create({ code: 'NOEXPIRY', expiresAt: null })).status, 201);
  assert.equal((await create({ code: 'NOFIELD' })).status, 201);
  const dated = await create({ code: 'DATED', expiresAt: '2099-12-31T21:59:59.999Z' });
  assert.equal(dated.status, 201);
  assert.equal(dated.data.promo.expiresAt, '2099-12-31T21:59:59.999Z');
  assert.equal((await create({ code: 'dated' })).status, 409, 'codes are case-insensitive and unique');

  const validate = (code, subtotal = 100) => request('/api/admin/promos/validate', { method: 'POST', body: { code, subtotal }, admin: false });
  assert.deepEqual((await validate('dated')).data, { code: 'DATED', discount: 10 });

  const fixed = await create({ code: 'TWENTY', type: 'fixed', value: 20, minSubtotal: 150, maxUses: 1 });
  assert.equal(fixed.status, 201);
  assert.equal((await validate('TWENTY', 100)).status, 400, 'below the minimum order');
  assert.deepEqual((await validate('TWENTY', 200)).data, { code: 'TWENTY', discount: 20 });

  // The order transaction applies it itself, and a used-up code stops working.
  const used = await place({ items: [{ productId: 'plain', qty: 2 }], promoCode: 'twenty', expectedTotal: 180 });
  assert.equal(used.status, 201, JSON.stringify(used.data));
  assert.deepEqual(used.data.order.totals, { subtotal: 200, discount: 20, delivery: 0, total: 180 });
  assert.equal((await validate('TWENTY', 200)).data.message, 'That code has been fully redeemed.');
  assert.equal((await place({ items: [{ productId: 'plain', qty: 2 }], promoCode: 'TWENTY' })).data.error, 'INVALID_PROMO');

  // Disable, enable, delete.
  assert.equal((await request('/api/admin/promos/DATED', { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await validate('DATED')).data.message, 'That code is no longer active.');
  assert.equal((await request('/api/admin/promos/DATED', { method: 'PATCH', body: { active: true } })).status, 200);
  assert.equal((await validate('DATED')).status, 200);
  assert.equal((await request('/api/admin/promos/DATED', { method: 'DELETE' })).status, 204);
  assert.equal((await validate('DATED')).data.message, 'That code is not recognised.');

  // A code that has since expired.
  await fsdb.collections.promos().doc('OLD').set({
    type: 'percent', value: 10, minSubtotal: 0, maxUses: 0, usedCount: 0, active: true, expiresAt: '2001-01-01T00:00:00.000Z',
  });
  assert.equal((await validate('OLD')).data.message, 'That code has expired.');
  assert.equal((await place({ promoCode: 'OLD' })).data.error, 'INVALID_PROMO');
});

// ----------------------------------------------------------------- orders ----

test('the delivery / pickup filter is applied by the query, and the total counts the filtered set', async () => {
  const placed = [];
  for (const fulfilment of ['pickup', 'delivery', 'pickup', 'delivery', 'pickup']) {
    const response = await place({
      fulfilment, firstName: fulfilment === 'pickup' ? 'Pat' : 'Dina',
      ...(fulfilment === 'delivery' ? { area: 'nasr-city', address: '1 Street' } : {}),
    });
    assert.equal(response.status, 201);
    placed.push(response.data.order.reference);
  }

  const firstPage = await request('/api/orders?fulfilment=delivery&perPage=1');
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.data.total, 2);
  assert.equal(firstPage.data.pages, 2);
  assert.deepEqual(firstPage.data.orders.map((o) => o.fulfilment), ['delivery']);
  const secondPage = await request('/api/orders?fulfilment=delivery&perPage=1&page=2');
  assert.deepEqual(secondPage.data.orders.map((o) => o.fulfilment), ['delivery']);
  assert.notEqual(secondPage.data.orders[0].reference, firstPage.data.orders[0].reference);

  const pickups = await request('/api/orders?fulfilment=pickup&perPage=2');
  assert.equal(pickups.data.total, 3);
  assert.equal(pickups.data.pages, 2);
  assert.equal(pickups.data.orders.length, 2);

  await request(`/api/orders/${placed[0]}/status`, { method: 'PATCH', body: { status: 'confirmed' } });
  const combined = await request('/api/orders?fulfilment=pickup&status=confirmed');
  assert.deepEqual(combined.data.orders.map((o) => o.reference), [placed[0]]);
  assert.equal(combined.data.total, 1);

  const searched = await request('/api/orders?fulfilment=delivery&q=dina');
  assert.equal(searched.data.total, 2);
  const searchedPickup = await request('/api/orders?fulfilment=pickup&q=dina');
  assert.equal(searchedPickup.data.total, 0);

  assert.equal((await request('/api/orders?fulfilment=drone')).status, 400);
  assert.equal((await request('/api/orders?fulfillmentDate=2026-09-15')).status, 400, 'there is no date filter to pretend with');
});

test('the overview counts days in Cairo, and best sellers cover only the range asked for', async () => {
  const { shopDays } = await import('../../shared/cairoTime.mjs');
  const today = shopDays(1);
  const backdate = async (reference, iso) => fsdb.collections.orders().doc(reference)
    .update({ createdAt: fsdb.Timestamp.fromDate(new Date(iso)) });

  // Thirty minutes after midnight in Cairo: the previous day in UTC.
  const early = await place({ items: [{ productId: 'percent-off', qty: 2 }] });
  assert.equal(early.status, 201, JSON.stringify(early.data));
  await backdate(early.data.order.reference, new Date(Date.parse(today.start) + 30 * 60000).toISOString());

  // Five Cairo days ago: inside a 14-day window, outside a 3-day one.
  const old = await place({
    items: [{ productId: 'plain', qty: 5 }], fulfilment: 'delivery', area: 'nasr-city', address: '1 Street',
  });
  assert.equal(old.status, 201, JSON.stringify(old.data));
  await backdate(old.data.order.reference, new Date(Date.parse(shopDays(5).start) + 60 * 60000).toISOString());

  const stats = await request('/api/orders/stats?days=14&topDays=3');
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  const { daily, topProducts, byArea } = stats.data;
  assert.equal(daily.length, 14);
  assert.equal(daily.at(-1).date, today.dates[0]);
  assert.equal(daily.at(-1).orders, 1, 'the after-midnight order is on today in Cairo');
  assert.equal(daily.reduce((sum, day) => sum + day.orders, 0), 2);
  assert.deepEqual(topProducts.map((row) => row.name), ['Ten Percent Off']);
  assert.deepEqual(byArea, []);

  const wide = await request('/api/orders/stats?days=14');
  assert.deepEqual(wide.data.topProducts.map((row) => row.name).sort(), ['Plain', 'Ten Percent Off']);
  assert.deepEqual(wide.data.byArea, [{ area: 'nasr-city', count: 1 }]);

  assert.equal((await request('/api/orders/stats?days=7&topDays=8')).status, 400, 'topDays cannot exceed days');
});

test('the customer directory\'s lifetime value leaves cancelled orders out, as it says', async () => {
  const kept = await place({ items: [{ productId: 'plain', qty: 2 }] });
  const cancelled = await place({ items: [{ productId: 'plain', qty: 5 }] });
  assert.equal(kept.status, 201);
  assert.equal(cancelled.status, 201);
  const patch = await request(`/api/orders/${cancelled.data.order.reference}/status`, {
    method: 'PATCH', body: { status: 'cancelled' },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));

  const directory = await request('/api/admin/users');
  assert.equal(directory.status, 200);
  assert.equal(directory.data.totals.orderValue, 200);
  assert.equal(directory.data.users[0].totalSpent, 200, 'the row and the headline agree');
});

test('cash collection is recorded by staff, only once the order is handed over', async () => {
  const { data } = await place();
  const reference = data.order.reference;
  const pay = (paymentStatus) => request(`/api/orders/${reference}/payment`, { method: 'PATCH', body: { paymentStatus } });

  const early = await pay('paid');
  assert.equal(early.status, 409, 'cash is collected at the handover, not before');

  for (const status of ['confirmed', 'baking', 'in_transit', 'completed']) {
    assert.equal((await request(`/api/orders/${reference}/status`, { method: 'PATCH', body: { status } })).status, 200);
  }
  const collected = await pay('paid');
  assert.equal(collected.status, 200);
  assert.equal(collected.data.order.paymentStatus, 'paid');
  assert.equal((await pay('paid')).status, 409);
  assert.equal((await pay('refunded')).status, 400, 'no online-payment states can be set');
  assert.equal((await pay('unpaid')).data.order.paymentStatus, 'unpaid');

  const audit = await fsdb.collections.auditEvents().where('resource', '==', reference).get();
  assert.ok(audit.docs.some((doc) => doc.data().action === 'cash:unpaid->paid'));

  const cancelled = (await place()).data.order.reference;
  await request(`/api/orders/${cancelled}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
  assert.equal((await request(`/api/orders/${cancelled}/payment`, { method: 'PATCH', body: { paymentStatus: 'paid' } })).status, 409);
  assert.equal((await request('/api/orders/HC-999999/payment', { method: 'PATCH', body: { paymentStatus: 'paid' } })).status, 404);

  // Money on the order never moved.
  assert.deepEqual((await request(`/api/orders/${reference}`)).data.order.totals, data.order.totals);
});

test('customer text is stored as text, and oversized or wrongly typed fields are refused', async () => {
  const script = '<script>alert(1)</script>';
  const stored = await place({ firstName: script, notes: `' OR 1=1 --`, lastName: '{"$gt": ""}' });
  assert.equal(stored.status, 201);
  const read = await request(`/api/orders/${stored.data.order.reference}`);
  assert.equal(read.data.order.customer.firstName, script);
  assert.equal(read.data.order.delivery.notes, `' OR 1=1 --`);

  for (const extra of [
    { firstName: 'x'.repeat(81) }, { firstName: null }, { firstName: '   ' }, { phone: 12345678 },
    { phone: '123' }, { notes: 'x'.repeat(1001) }, { fulfilment: 'drone' }, { items: [] },
    { lastName: { $gt: '' } }, { unexpected: true },
  ]) {
    const response = await place(extra);
    assert.equal(response.status, 400, `${JSON.stringify(extra).slice(0, 60)} must be refused`);
  }
});


test('a fixed bundle cannot be sold while something inside it is sold out', async () => {
  const off = await request('/api/menu/admin/products/plain', { method: 'PATCH', body: { available: false } });
  assert.equal(off.status, 200);

  assert.equal((await publicProduct('box')).available, false, 'the menu shows the box as sold out');
  const listed = (await request('/api/menu/admin/products')).data.products.find((product) => product.id === 'box');
  assert.equal(listed.available, true, 'the stored flag is untouched, so the box comes back with its contents');

  const refused = await place({ items: [{ productId: 'box', qty: 1 }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'PRODUCT_UNAVAILABLE');
  assert.deepEqual(refused.data.details.productIds, ['box']);
  assert.equal((await fsdb.collections.orders().get()).size, 0, 'nothing was written');

  assert.equal((await request('/api/menu/admin/products/plain', { method: 'PATCH', body: { available: true } })).status, 200);
  assert.equal((await publicProduct('box')).available, true);
  const sold = await place({ items: [{ productId: 'box', qty: 1 }] });
  assert.equal(sold.status, 201);
  assert.equal(sold.data.order.totals.total, 180);
});

test('free delivery starts exactly at the threshold, and checkout uses the same arithmetic', async () => {
  const { deliveryFee } = await import('../../shared/productPricing.mjs');
  // A basket of exactly 290: two plain at 100 and one at 10% off 100.
  const basket = [{ productId: 'plain', qty: 2 }, { productId: 'percent-off', qty: 1 }];
  for (const [threshold, expected] of [[291, 40], [290, 0], [289, 0]]) {
    const saved = await request('/api/admin/settings', { method: 'PATCH', body: { deliveryFee: 40, freeDeliveryOver: threshold } });
    assert.equal(saved.status, 200);
    const placed = await place({ items: basket, fulfilment: 'delivery', area: 'nasr-city', address: '1 Street' });
    assert.equal(placed.status, 201, JSON.stringify(placed.data));
    assert.equal(placed.data.order.totals.subtotal, 290);
    assert.equal(placed.data.order.totals.delivery, expected, `server, threshold ${threshold}`);
    assert.equal(deliveryFee(290, { deliveryFee: 40, freeDeliveryOver: threshold }, 'delivery'), expected,
      `checkout, threshold ${threshold}`);
  }
});

test('an expired, forged or customer session is refused like no session at all', async () => {
  const { createSession } = await import('../sessionStore.js');
  const expired = await createSession('admin', 'admin', -60);
  const customer = await createSession('customer', 'someone@example.com', 3600);
  const forged = 'A'.repeat(43);

  for (const [label, token] of [['expired', expired], ['customer', customer], ['forged', forged]]) {
    const headers = { 'x-requested-with': 'Holland', cookie: `holland_admin_session=${token}` };
    const read = await fetch(`${base}/api/admin/promos`, { headers });
    assert.equal(read.status, 401, `${label} session reading promos`);
    const write = await fetch(`${base}/api/admin/settings`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ acceptingOrders: false }),
    });
    assert.equal(write.status, 401, `${label} session changing settings`);
    const probe = await fetch(`${base}/api/admin/session`, { headers });
    assert.deepEqual(await probe.json(), { signedIn: false }, `${label} session probe`);
  }
  assert.equal((await request('/api/admin/settings', { admin: false })).data.settings.acceptingOrders, true);
});

test('search, status and fulfilment filters combine, and the pages count the combined set', async () => {
  const references = [];
  for (const [fulfilment, firstName] of [['pickup', 'Pat'], ['pickup', 'Pat'], ['pickup', 'Pat'], ['delivery', 'Pat'], ['pickup', 'Omar']]) {
    const response = await place({
      fulfilment, firstName, ...(fulfilment === 'delivery' ? { area: 'nasr-city', address: '1 Street' } : {}),
    });
    assert.equal(response.status, 201);
    references.push(response.data.order.reference);
  }
  for (const reference of [references[0], references[3]]) {
    assert.equal((await request(`/api/orders/${reference}/status`, { method: 'PATCH', body: { status: 'confirmed' } })).status, 200);
  }

  const first = await request('/api/orders?fulfilment=pickup&q=pat&perPage=2');
  assert.equal(first.data.total, 3);
  assert.equal(first.data.pages, 2);
  assert.equal(first.data.orders.length, 2);
  const second = await request('/api/orders?fulfilment=pickup&q=pat&perPage=2&page=2');
  assert.equal(second.data.orders.length, 1);
  assert.equal(new Set([...first.data.orders, ...second.data.orders].map((o) => o.reference)).size, 3,
    'no order repeats or goes missing across pages');

  const confirmedDeliveries = await request('/api/orders?status=confirmed&fulfilment=delivery');
  assert.deepEqual(confirmedDeliveries.data.orders.map((o) => o.reference), [references[3]]);
  assert.equal(confirmedDeliveries.data.total, 1);

  const all = await request('/api/orders?status=ordered&fulfilment=pickup&q=pat');
  assert.equal(all.data.total, 2);
  assert.ok(all.data.orders.every((o) => o.fulfilment === 'pickup' && o.status === 'ordered' && o.customer.firstName === 'Pat'));

  const none = await request('/api/orders?status=confirmed&fulfilment=pickup&q=omar');
  assert.equal(none.data.total, 0);
  assert.equal(none.data.pages, 1);
});

test('codes and checkout keys that cannot name a document are a 400, never a server error', async () => {
  for (const code of ['a/b', '../orders', '__proto__', '<script>alert(1)</script>']) {
    const validated = await request('/api/admin/promos/validate', { method: 'POST', body: { code, subtotal: 100 }, admin: false });
    assert.equal(validated.status, 400, `validate ${code}`);
    const placed = await place({ promoCode: code });
    assert.equal(placed.status, 400, `order with ${code}`);
    assert.equal(placed.data.error, 'INVALID_PROMO');
  }
  for (const idempotencyKey of ['has/a/slash', '__reserved__']) {
    assert.equal((await place({ idempotencyKey })).status, 400, idempotencyKey);
  }
  assert.equal((await request('/api/admin/promos', { method: 'POST', body: { code: '__X__', type: 'percent', value: 10 } })).status, 400);
  assert.equal((await request('/api/admin/promos/__X__', { method: 'DELETE' })).status, 404);
  assert.equal((await request('/api/admin/promos/__X__', { method: 'PATCH', body: { active: false } })).status, 404);
  assert.equal((await fsdb.collections.orders().get()).size, 0, 'nothing was written');
});
