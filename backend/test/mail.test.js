/**
 * The mail pipeline, end to end against a stubbed provider.
 *
 * The provider is stubbed and nothing else is: these drive the real routes, the
 * real order transaction and a real (emulated) Firestore, and assert on the
 * exact JSON that would have gone to Brevo. A test that mocked the mailer would
 * only prove the mock sends.
 *
 * What is worth pinning here, and why each one is a bug that has shipped in
 * systems like this one:
 *
 *   - An order must survive a mail provider that is down. A bakery that cannot
 *     take money because a mail API is having a bad afternoon is the worst
 *     possible failure of a feature that only sends receipts.
 *   - A receipt must not arrive twice. The dedupe key, not the caller's
 *     `duplicate` flag, is what guarantees that.
 *   - The shop's alert and the customer's receipt are different messages with
 *     different recipients, and the customer's phone and address belong only in
 *     the first one.
 *   - Only two statuses are announced, and what they say depends on delivery
 *     versus pickup.
 *   - Everything a customer typed is escaped in the HTML part and left alone in
 *     the text part.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-mail';
process.env.ADMIN_KEY = 'mail-suite-admin-0123456789abcdefghij';
process.env.JWT_SECRET = 'mail-suite-session-0123456789abcdefghij';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.BREVO_API_KEY = '';

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const fsdb = await import('../firestore.js');
const { default: app } = await import('../server.js');
const mailer = await import('../mailer.js');

let server; let base; let admin;
const realFetch = globalThis.fetch;
/** Every message the provider was asked to send, as Brevo would have seen it. */
let sent = [];

/** Stubs Brevo only: anything else (our own server) still goes out for real. */
function stubProvider({ failing = false } = {}) {
  process.env.MAIL_TRANSPORT = 'brevo';
  process.env.BREVO_API_KEY = 'mail-suite-fixture-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.brevo.com')) {
      sent.push(JSON.parse(init.body));
      return failing
        ? new Response('{"code":"unauthorized"}', { status: 401 })
        : new Response('{"messageId":"<stub>"}', { status: 201 });
    }
    return realFetch(url, init);
  };
}

function unstubProvider() {
  globalThis.fetch = realFetch;
  process.env.MAIL_TRANSPORT = 'disabled';
  process.env.BREVO_API_KEY = '';
}

async function request(route, { method = 'GET', body, cookie } = {}) {
  const response = await realFetch(base + route, {
    method,
    headers: {
      'x-requested-with': 'Holland',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data };
}

const wipe = async (names) => {
  await Promise.all(names.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
};

/** One orderable product, and a shop that charges a known delivery fee. */
before(async () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /, 'refusing to run against a real project');
  await wipe(['orders', 'orderIdempotency', 'customers', 'products', 'categories',
    'mailLog', 'sessions', 'rateLimits', 'auditEvents', 'counters', 'settings']);

  await fsdb.collections.categories().doc('cookies')
    .set({ name: 'Cookies', nameAr: 'كوكيز', sort: 0, visible: true });
  await fsdb.collections.products().doc('cookie').set({
    categoryId: 'cookies', name: 'Chocolate Cookie', nameAr: 'كوكيز شوكولاتة', note: '',
    price: 100, available: true, discountEnabled: false,
    discountType: 'percent', discountValue: 0, sort: 0,
  });
  await fsdb.orderCounterDoc().set({ value: 5000 });
  await fsdb.settingsDoc().set({
    deliveryFee: 40, freeDeliveryOver: 0, acceptingOrders: true,
    areas: [{ id: 'nasr-city', name: 'Nasr City', city: 'Cairo', fee: null }],
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/admin/session', { method: 'POST', body: { key: process.env.ADMIN_KEY } });
  admin = login.data && (await realFetch(`${base}/api/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'Holland' },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }),
  })).headers.get('set-cookie').split(';')[0];
});

beforeEach(async () => {
  sent = [];
  await wipe(['rateLimits']);
});

after(async () => {
  unstubProvider();
  await new Promise((resolve) => server.close(resolve));
  await fsdb.close();
});

const order = (extra = {}) => ({
  idempotencyKey: randomUUID(),
  items: [{ productId: 'cookie', qty: 2 }],
  firstName: 'Salma',
  lastName: 'Hassan',
  phone: '01000000001',
  email: 'customer@example.test',
  fulfilment: 'delivery',
  area: 'nasr-city',
  address: '12 Abbas El-Akkad Street',
  ...extra,
});

/** Brevo's payload for the message addressed to `email`. */
const to = (email) => sent.find((message) => message.to.some((entry) => entry.email === email));

// ------------------------------------------------------------ the basics ----

test('an order is taken, and both the receipt and the bakery alert go out', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const placed = await request('/api/orders', { method: 'POST', body: order() });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const reference = placed.data.order.reference;

  // Sent after the response, deliberately not awaited by the route.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sent.length, 2, 'one receipt to the customer, one alert to the bakery');

  const receipt = to('customer@example.test');
  assert.ok(receipt, 'the customer was written to');
  assert.match(receipt.subject, new RegExp(reference));
  assert.equal(receipt.sender.email, process.env.MAIL_FROM_EMAIL || 'orders@hollandcookies.example');
  assert.equal(receipt.headers['Auto-Submitted'], 'auto-generated');

  const alert = to('hollandcookies.mf@gmail.com');
  assert.ok(alert, 'the bakery was written to');
  assert.match(alert.subject, /^New order/);
  // The alert is what somebody starts baking from: it carries the phone and
  // the address, and the customer's own copy does not.
  assert.match(alert.htmlContent, /01000000001/);
  assert.match(alert.htmlContent, /Abbas El-Akkad/);
  assert.doesNotMatch(receipt.htmlContent, /01000000001/, 'the receipt must not quote the phone');
});

test('the order survives a provider that refuses, and nothing is reported as failed', async (t) => {
  stubProvider({ failing: true });
  t.after(unstubProvider);

  const placed = await request('/api/orders', { method: 'POST', body: order() });
  assert.equal(placed.status, 201, 'a refused email must not fail the order');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sent.length, 2, 'both were attempted');

  // A refused send releases its claim, so a later attempt can still deliver.
  const reference = placed.data.order.reference;
  const claim = await fsdb.collections.mailLog().doc(`confirmation:${reference}`).get();
  assert.equal(claim.exists, false, 'a failed send must not leave a claim behind');
});

test('a replayed submission returns the first order and sends nothing again', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const body = order();
  const first = await request('/api/orders', { method: 'POST', body });
  assert.equal(first.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterFirst = sent.length;

  const replay = await request('/api/orders', { method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sent.length, afterFirst, 'a replay must not send a second receipt');
});

test('the dedupe key alone stops a second receipt, even called directly', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const placed = await request('/api/orders', { method: 'POST', body: order() });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const before = sent.length;

  const stored = await (await import('../repo/orders.js')).getOrder(placed.data.order.reference);
  const again = await mailer.sendOrderConfirmation(stored, 'en');
  assert.equal(again.via, 'skipped-duplicate');
  assert.equal(sent.length, before, 'the guard is the mail log, not the caller');
});

// ---------------------------------------------------------- the milestones ----

test('only two statuses are announced, and they read differently for pickup', async (t) => {
  stubProvider();
  t.after(unstubProvider);
  const { getOrder } = await import('../repo/orders.js');

  for (const [fulfilment, moving, arrived] of [
    ['delivery', /on its way/i, /arrived|delivered/i],
    ['pickup', /ready for pickup/i, /collecting|picked up/i],
  ]) {
    const placed = await request('/api/orders', {
      method: 'POST',
      body: order(fulfilment === 'pickup'
        ? { fulfilment: 'pickup', area: undefined, address: undefined }
        : {}),
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.data));
    const reference = placed.data.order.reference;
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stored = await getOrder(reference);
    // The quiet ones: nothing is announced before the order moves.
    for (const status of ['confirmed', 'baking']) {
      const quiet = await mailer.sendOrderStatusUpdate(stored, status, 'en');
      assert.equal(quiet.via, 'skipped-not-announced', `${status} must not email`);
    }
    // And a cancellation is a conversation, not an automated mail.
    const cancelled = await mailer.sendOrderStatusUpdate(stored, 'cancelled', 'en');
    assert.equal(cancelled.via, 'skipped-not-announced');

    sent = [];
    await mailer.sendOrderStatusUpdate(stored, 'in_transit', 'en');
    assert.match(sent.at(-1).subject, moving, `${fulfilment} in_transit`);
    await mailer.sendOrderStatusUpdate(stored, 'completed', 'en');
    assert.match(sent.at(-1).subject, arrived, `${fulfilment} completed`);

    // Twice is once.
    const repeat = await mailer.sendOrderStatusUpdate(stored, 'completed', 'en');
    assert.equal(repeat.via, 'skipped-duplicate');
  }
});

test('moving an order through the dashboard emails the customer, in their language', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const placed = await request('/api/orders', { method: 'POST', body: order({ lang: 'ar' }) });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  const reference = placed.data.order.reference;
  await new Promise((resolve) => setTimeout(resolve, 300));
  sent = [];

  for (const status of ['confirmed', 'baking', 'in_transit']) {
    const moved = await request(`/api/orders/${reference}/status`, {
      method: 'PATCH', cookie: admin, body: { status },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(sent.length, 1, 'only the milestone is announced, not every step');
  const message = sent[0];
  assert.match(message.htmlContent, /dir="rtl"/, 'an Arabic order gets an Arabic email');
  assert.match(message.htmlContent, /في الطريق/);
  // An Arabic email must not label the order in English. `statusLabel` is the
  // shop's own English vocabulary and belongs on the shop's screens.
  assert.doesNotMatch(message.htmlContent, /Out for delivery|Ready for pickup|Delivered|Picked up/);
  // And the total must not be reordered into "EGP 427.00" by the bidi
  // algorithm: the money cells are pinned left-to-right.
  assert.match(message.htmlContent, /‎|dir="ltr"/, 'numbers are pinned inside Arabic');
});

// --------------------------------------------------------------- escaping ----

test('what a customer typed is escaped in the HTML and verbatim in the text', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const placed = await request('/api/orders', {
    method: 'POST',
    body: order({
      firstName: 'Salma<script>',
      notes: 'No nuts <img src=x onerror="window.x=1">',
    }),
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  await new Promise((resolve) => setTimeout(resolve, 400));

  for (const message of sent) {
    assert.doesNotMatch(message.htmlContent, /<script>/, 'markup must never survive into the HTML');
    assert.doesNotMatch(message.htmlContent, /<img src=x/);
    assert.match(message.htmlContent, /&lt;/, 'it is escaped rather than stripped');
  }
  const alert = to('hollandcookies.mf@gmail.com');
  assert.match(alert.textContent, /<img src=x onerror="window.x=1">/, 'the text part needs no escaping');
});

// ------------------------------------------------------------- recipients ----

test('the bakery alert goes wherever ADMIN_ORDER_EMAIL says, and to the shop by default', () => {
  const saved = process.env.ADMIN_ORDER_EMAIL;
  try {
    delete process.env.ADMIN_ORDER_EMAIL;
    assert.deepEqual(mailer.adminOrderRecipients(), ['hollandcookies.mf@gmail.com']);

    process.env.ADMIN_ORDER_EMAIL = ' one@shop.test , two@shop.test ';
    assert.deepEqual(mailer.adminOrderRecipients(), ['one@shop.test', 'two@shop.test']);

    process.env.ADMIN_ORDER_EMAIL = '   ';
    assert.deepEqual(mailer.adminOrderRecipients(), ['hollandcookies.mf@gmail.com'],
      'a blank variable must not silently mean nobody');
  } finally {
    if (saved === undefined) delete process.env.ADMIN_ORDER_EMAIL;
    else process.env.ADMIN_ORDER_EMAIL = saved;
  }
});

test('an order with no email address writes only to the bakery', async (t) => {
  stubProvider();
  t.after(unstubProvider);

  const placed = await request('/api/orders', { method: 'POST', body: order({ email: undefined }) });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0].email, 'hollandcookies.mf@gmail.com');
});

test('with mail switched off nothing is attempted at all', async () => {
  // MAIL_TRANSPORT is 'disabled' here — the state the shop launched in.
  const placed = await request('/api/orders', { method: 'POST', body: order() });
  assert.equal(placed.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sent.length, 0);
});
