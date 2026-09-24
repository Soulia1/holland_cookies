/**
 * The read mirror (backend/mirror.js) must be invisible except for speed.
 *
 * Every read endpoint it serves is asked the same questions twice — once from
 * the mirror and once with READ_MIRROR=off, which sends the same code down the
 * Firestore path it replaced — and the answers must be identical. A mirror that
 * is fast and subtly different is a dashboard that lies about the takings.
 *
 * The rest proves the two ways it stays current: this process's own writes are
 * visible on the very next read, and a write made anywhere else (the console, a
 * seed script) arrives through the listener without anybody asking.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-mirror';
process.env.ADMIN_KEY = 'mirror-fixture-admin-key-0123456789abcdefgh';
process.env.JWT_SECRET = 'mirror-fixture-session-0123456789abcdefgh';
process.env.BREVO_API_KEY = '';
process.env.MAIL_TRANSPORT = 'disabled';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { default: app } = await import('../server.js');
const fsdb = await import('../firestore.js');
const { live, syncAll, status } = await import('../mirror.js');
const { buildOrderSearchIndex, payloadSearchShape, queryOrders } = await import('../../shared/orderSearch.mjs');

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
  return { status: response.status, data, headers: response.headers };
}

const place = (fields) => request('/api/orders', {
  method: 'POST',
  admin: false,
  body: { idempotencyKey: randomUUID(), items: [{ productId: 'plain', qty: 1 }], fulfilment: 'pickup', ...fields },
});

/** The same request with the mirror on and off. */
async function bothWays(route) {
  process.env.READ_MIRROR = 'off';
  const direct = await request(route);
  delete process.env.READ_MIRROR;
  assert.ok(live('orders'), 'the orders mirror should be serving');
  const mirrored = await request(route);
  assert.equal(direct.status, 200, `${route}: ${JSON.stringify(direct.data)}`);
  assert.equal(mirrored.status, 200, `${route}: ${JSON.stringify(mirrored.data)}`);
  return { direct: direct.data, mirrored: mirrored.data };
}

async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const placed = [];

before(async () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /, 'refusing to run against a real Firestore project');
  for (const name of ['orders', 'orderIdempotency', 'customers', 'products', 'categories', 'promos',
    'rateLimits', 'auditEvents', 'counters', 'settings']) {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }

  const product = (fields) => ({
    categoryId: 'cookies', nameAr: '', description: '', descriptionAr: '', note: '', noteAr: '',
    image: '', available: true, discountEnabled: false, discountType: 'percent', discountValue: 0,
    sort: 0, isBundle: false, bundleType: 'fixed', components: [], groups: [], ...fields,
  });
  await Promise.all([
    fsdb.collections.categories().doc('cookies').set({ name: 'Cookies', nameAr: 'كوكيز', sort: 0, visible: true, group: 'cookies' }),
    fsdb.collections.categories().doc('hidden').set({ name: 'Hidden', nameAr: '', sort: 1, visible: false, group: 'cookies' }),
    fsdb.collections.products().doc('plain').set(product({ name: 'Plain', price: 100 })),
    fsdb.collections.products().doc('lotus').set(product({ name: 'Lotus Cookie', price: 120, sort: 1 })),
    fsdb.orderCounterDoc().set({ value: 1000 }),
    fsdb.settingsDoc().set({
      deliveryFee: 40, freeDeliveryOver: 0, acceptingOrders: true,
      areas: [{ id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر' }],
    }),
  ]);
  await syncAll();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/admin/session', { method: 'POST', body: { key: process.env.ADMIN_KEY } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const people = [
    { firstName: 'Noha', lastName: 'Ibrahim', phone: '01016521650', email: 'noha@example.com' },
    { firstName: 'أحمد', lastName: 'سالم', phone: '01122334455' },
    { firstName: 'Dina', phone: '01233445566', fulfilment: 'delivery', area: 'nasr-city', address: '1 Street' },
    { firstName: 'Omar', phone: '01544332211', items: [{ productId: 'lotus', qty: 3 }] },
    { firstName: 'Noha', lastName: 'Ibrahim', phone: '01016521650', items: [{ productId: 'lotus', qty: 1 }, { productId: 'plain', qty: 2 }] },
    { firstName: 'Pat', phone: '01000000001', fulfilment: 'delivery', area: 'nasr-city', address: '2 Street' },
  ];
  for (const person of people) {
    const response = await place(person);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    placed.push(response.data.order.reference);
  }
  const move = (reference, next) => request(`/api/orders/${reference}/status`, { method: 'PATCH', body: { status: next } });
  assert.equal((await move(placed[0], 'confirmed')).status, 200);
  assert.equal((await move(placed[1], 'cancelled')).status, 200);
  for (const next of ['confirmed', 'baking', 'in_transit', 'completed']) assert.equal((await move(placed[3], next)).status, 200);
  assert.equal((await request(`/api/orders/${placed[3]}/payment`, { method: 'PATCH', body: { paymentStatus: 'paid' } })).status, 200);
  assert.equal((await request('/api/admin/promos', {
    method: 'POST', body: { code: 'MIRROR5', type: 'percent', value: 5 },
  })).status, 201);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsdb.close().catch(() => {});
});

test('every mirrored read answers exactly as Firestore does', async () => {
  const routes = [
    '/api/menu',
    '/api/admin/settings',
    '/api/admin/promos',
    '/api/menu/admin/products',
    '/api/menu/admin/categories',
    '/api/orders',
    '/api/orders?perPage=2&page=2',
    '/api/orders?status=confirmed',
    '/api/orders?fulfilment=delivery',
    '/api/orders?status=ordered&fulfilment=pickup',
    '/api/orders?q=noha',
    '/api/orders?q=noha&perPage=1&page=2',
    '/api/orders?q=nasr',
    '/api/orders?q=zzz-nothing',
    `/api/orders/${placed[3]}`,
    '/api/orders/stats',
    '/api/orders/stats?days=14&topDays=7',
    '/api/admin/users',
    '/api/admin/customers',
    '/api/admin/customers?q=noha',
    '/api/admin/customers/01016521650',
  ];
  for (const route of routes) {
    const { direct, mirrored } = await bothWays(route);
    assert.deepEqual(mirrored, direct, route);
  }
});

test('the mirror actually holds the data it is serving', () => {
  const held = status();
  assert.equal(held.orders.ready, true);
  assert.equal(held.orders.documents, placed.length);
  assert.equal(held.products.documents, 2);
  assert.equal(held.categories.documents, 2);
  assert.equal(held.promos.documents, 1);
  assert.equal(held.customers.documents, 5);
  assert.equal(held.settings.documents, 1);
});

test('search finds an order however its name or number was typed', async () => {
  const hits = async (q) => (await request(`/api/orders?q=${encodeURIComponent(q)}`)).data.orders.map((o) => o.reference);
  // Written with a hamza, searched without one.
  assert.deepEqual(await hits('احمد'), [placed[1]]);
  // A phone read off a delivery note, with spaces, and on an Arabic keyboard.
  assert.deepEqual(await hits('010 1652 1650'), [placed[4], placed[0]]);
  assert.deepEqual(await hits('٠١٠١٦٥٢١٦٥٠'), [placed[4], placed[0]]);
  // An exact reference outranks everything else.
  assert.equal((await hits(placed[2]))[0], placed[2]);
  // Item names are searchable too.
  assert.deepEqual((await hits('lotus')).sort(), [placed[3], placed[4]].sort());
});

test('the order book answers every search exactly as the server does', async () => {
  const { direct, mirrored } = await bothWays('/api/orders/book');
  assert.deepEqual(mirrored, direct);
  assert.equal(mirrored.complete, true);
  assert.equal(mirrored.total, placed.length);
  // Every order, newest first: the list, unpaged.
  assert.deepEqual(mirrored.orders, (await request('/api/orders?perPage=100')).data.orders);

  // The dashboard runs queryOrders over the book in the browser. It must land on
  // the same rows, in the same order, with the same count, as the server.
  const indexes = new Map();
  const indexOf = (row) => {
    if (!indexes.has(row)) indexes.set(row, buildOrderSearchIndex(payloadSearchShape(row)));
    return indexes.get(row);
  };
  const queries = [
    {}, { perPage: 2, page: 2 }, { status: 'confirmed' }, { fulfilment: 'delivery' },
    { status: 'ordered', fulfilment: 'pickup' }, { q: 'noha' }, { q: 'noha', perPage: 1, page: 2 },
    { q: 'nasr' }, { q: 'zzz-nothing' }, { q: 'احمد' }, { q: '010 1652 1650' }, { q: '٠١٠١٦٥٢١٦٥٠' },
    { q: 'lotus' }, { q: placed[2] }, { q: 'hc-10' }, { q: 'paid' }, { q: 'Ibrahim', status: 'confirmed' },
  ];
  for (const query of queries) {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const server = (await request(`/api/orders?${params}`)).data;
    const local = queryOrders(mirrored.orders, query, indexOf);
    const label = JSON.stringify(query);
    assert.deepEqual(local.rows.map((o) => o.reference), server.orders.map((o) => o.reference), label);
    assert.equal(local.total, server.total, label);
    assert.equal(local.pages, server.pages, label);
  }
});

test('an unchanged order book costs a bodiless 304, a changed one does not', async () => {
  const first = await request('/api/orders/book');
  const tag = first.headers.get('etag');
  assert.match(tag, /^"[^"]+"$/);
  const revalidate = (headers) => fetch(`${base}/api/orders/book`, {
    headers: { 'x-requested-with': 'Holland', cookie, 'if-none-match': tag, ...headers },
  });
  const unchanged = await revalidate();
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  // A browser sends its own If-None-Match with Cache-Control: no-cache; still a 304.
  assert.equal((await revalidate({ 'cache-control': 'no-cache' })).status, 304);

  assert.equal((await request(`/api/orders/${placed[0]}/status`, { method: 'PATCH', body: { status: 'baking' } })).status, 200);
  const changed = await revalidate();
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), tag);
  const book = await changed.json();
  assert.equal(book.orders.find((order) => order.reference === placed[0]).status, 'baking');

  // Admin only, like the list it replaces.
  assert.equal((await request('/api/orders/book', { admin: false })).status, 401);
});

test("this process's own writes are visible on the very next read", async () => {
  const response = await place({ firstName: 'Fresh', phone: '01099887766' });
  assert.equal(response.status, 201);
  const reference = response.data.order.reference;
  placed.push(reference);

  // No waiting, no retry: the order is in the list the moment it was created…
  const list = await request('/api/orders?perPage=1');
  assert.equal(list.data.orders[0].reference, reference);
  assert.equal((await request('/api/admin/customers/01099887766')).status, 200);

  // …and a status change shows on the next read.
  assert.equal((await request(`/api/orders/${reference}/status`, { method: 'PATCH', body: { status: 'confirmed' } })).status, 200);
  assert.equal((await request(`/api/orders/${reference}`)).data.order.status, 'confirmed');
  const confirmed = await request('/api/orders?status=confirmed');
  assert.ok(confirmed.data.orders.some((order) => order.reference === reference));

  // Menu edits likewise.
  assert.equal((await request('/api/menu/admin/products/plain', { method: 'PATCH', body: { price: 105 } })).status, 200);
  const menu = await request('/api/menu', { admin: false });
  assert.equal(menu.data.categories[0].items.find((item) => item.id === 'plain').price, 105);

  // And the promo's redemption count after an order uses it.
  assert.equal((await place({ firstName: 'Promo', phone: '01099887767', promoCode: 'MIRROR5' })).status, 201);
  const promos = await request('/api/admin/promos');
  assert.equal(promos.data.promos.find((promo) => promo.code === 'MIRROR5').usedCount, 1);
});

test('a change made outside the app arrives through the listener', async () => {
  // As if typed into the Firebase console: nothing in this process is told.
  await fsdb.collections.products().doc('lotus').update({ name: 'Lotus Biscoff' });
  await until(async () => {
    const menu = await request('/api/menu', { admin: false });
    return menu.data.categories[0].items.some((item) => item.name === 'Lotus Biscoff');
  }, 'the console edit to reach the menu');

  await fsdb.collections.orders().doc(placed[2]).delete();
  await until(async () => (await request(`/api/orders/${placed[2]}`)).status === 404, 'the deleted order to leave');

  // After all that, the mirror still agrees with Firestore on everything.
  for (const route of ['/api/menu', '/api/orders', '/api/orders/stats', '/api/admin/users']) {
    const { direct, mirrored } = await bothWays(route);
    assert.deepEqual(mirrored, direct, route);
  }
});
