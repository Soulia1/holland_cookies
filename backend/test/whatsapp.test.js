/**
 * The bakery's WhatsApp alert, end to end against a stubbed CallMeBot.
 *
 * Only the provider is stubbed. These drive the real order route and a real
 * (emulated) Firestore and assert on the exact request that would have left the
 * server, because a test that mocked the sender would only prove the mock sends.
 *
 * What is pinned, each one a way this kind of feature goes wrong:
 *
 *   - It works with email switched off, which is how the shop launches.
 *   - One order is one message, even on a replayed submission.
 *   - A refusing provider — including CallMeBot's habit of answering a bad key
 *     with a 200 and an HTML page — never fails the order.
 *   - The customer's name, phone and address are not put in a GET URL.
 *   - Nothing is sent, or attempted, until both settings are present.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-whatsapp';
process.env.ADMIN_KEY = 'wa-suite-admin-0123456789abcdefghijkl';
process.env.JWT_SECRET = 'wa-suite-session-0123456789abcdefghijk';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.BREVO_API_KEY = '';

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const fsdb = await import('../firestore.js');
const { syncAll } = await import('../mirror.js');
const { default: app } = await import('../server.js');
const { normalizeWhatsappPhone, whatsappConfigured } = await import('../whatsapp.js');

let server; let base;
const realFetch = globalThis.fetch;
/** Every request CallMeBot would have received, as parsed URLs. */
let calls = [];

function stubCallMeBot({ status = 200, body = 'Message queued.' } = {}) {
  process.env.WHATSAPP_PHONE = '+20 12 10004315';
  process.env.CALLMEBOT_APIKEY = 'wa-suite-key-1234';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.callmebot.com')) {
      calls.push(new URL(String(url)));
      return new Response(body, { status });
    }
    return realFetch(url, init);
  };
}

function unstub() {
  globalThis.fetch = realFetch;
  delete process.env.WHATSAPP_PHONE;
  delete process.env.CALLMEBOT_APIKEY;
}

async function request(route, { method = 'GET', body } = {}) {
  const response = await realFetch(base + route, {
    method,
    headers: {
      'x-requested-with': 'Holland',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
  await fsdb.orderCounterDoc().set({ value: 7000 });
  await fsdb.settingsDoc().set({
    deliveryFee: 40, freeDeliveryOver: 0, acceptingOrders: true,
    areas: [{ id: 'nasr-city', name: 'Nasr City', city: 'Cairo', fee: null }],
  });
  await syncAll();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  calls = [];
  await wipe(['rateLimits']);
});

after(async () => {
  unstub();
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test('a new order reaches the owner on WhatsApp, with email switched off', async (t) => {
  stubCallMeBot();
  t.after(unstub);

  const placed = await request('/api/orders', { method: 'POST', body: order() });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  await settle();

  assert.equal(calls.length, 1, 'exactly one alert');
  const url = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.callmebot.com/whatsapp.php');
  assert.equal(url.searchParams.get('phone'), '+201210004315', 'the number is normalised');
  assert.equal(url.searchParams.get('apikey'), 'wa-suite-key-1234');

  const text = url.searchParams.get('text');
  assert.match(text, /^Online Orders \(HC\)\n/);
  assert.match(text, new RegExp(`New order ${placed.data.order.reference}`));
  assert.match(text, /2 x Chocolate Cookie/);
  assert.match(text, /Total: 240\.00 EGP \(cash\)/);
  assert.match(text, /Delivery/);
  assert.match(text, /\/orders\/[A-Za-z0-9-]+$/, 'ends with the dashboard link');
});

test('the customer\'s name, phone and address are never put in the URL', async (t) => {
  stubCallMeBot();
  t.after(unstub);

  await request('/api/orders', { method: 'POST', body: order() });
  await settle();

  assert.equal(calls.length, 1);
  const whole = decodeURIComponent(calls[0].toString());
  for (const private_ of ['Salma', 'Hassan', '01000000001', 'customer@example.test', 'Abbas']) {
    assert.ok(!whole.includes(private_), `${private_} must not travel in a GET URL`);
  }
});

test('a replayed submission does not alert the owner twice', async (t) => {
  stubCallMeBot();
  t.after(unstub);

  const body = order();
  assert.equal((await request('/api/orders', { method: 'POST', body })).status, 201);
  await settle();
  const replay = await request('/api/orders', { method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  await settle();
  assert.equal(calls.length, 1, 'one order, one message');
});

test('the order survives a provider that fails, whether by status or by a 200 error page', async (t) => {
  t.after(unstub);
  for (const failing of [
    { status: 500, body: 'oops' },
    { status: 200, body: '<html>ERROR: APIKey is invalid</html>' },
  ]) {
    stubCallMeBot(failing);
    const placed = await request('/api/orders', { method: 'POST', body: order() });
    assert.equal(placed.status, 201, 'a failed alert must not fail the order');
    await settle();
    assert.equal(calls.length, 1, 'it was attempted');
    // The claim is released, so a later genuine attempt can still deliver.
    const claim = await fsdb.collections.mailLog().doc(`whatsapp:${placed.data.order.reference}`).get();
    assert.equal(claim.exists, false, 'a failed send must not leave a claim behind');
    calls = [];
  }
});

test('an unreachable provider is a logged code, not a leaked key', async (t) => {
  stubCallMeBot();
  t.after(unstub);
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.callmebot.com')) {
      throw new TypeError(`fetch failed for ${url}`);
    }
    return realFetch(url, init);
  };
  const logged = [];
  const info = console.info;
  console.info = (line) => { logged.push(String(line)); };
  try {
    const placed = await request('/api/orders', { method: 'POST', body: order() });
    assert.equal(placed.status, 201);
    await settle();
  } finally {
    console.info = info;
  }
  const failure = logged.find((line) => line.includes('whatsapp_alert_failed'));
  assert.ok(failure, 'the failure is logged');
  assert.match(failure, /WHATSAPP_UNREACHABLE/);
  assert.ok(!logged.join('\n').includes('wa-suite-key-1234'), 'the API key never reaches the log');
});

test('nothing is attempted until both settings are present', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.callmebot.com')) calls.push(new URL(String(url)));
    return realFetch(url, init);
  };
  try {
    delete process.env.WHATSAPP_PHONE;
    delete process.env.CALLMEBOT_APIKEY;
    assert.equal(whatsappConfigured(), false);

    process.env.WHATSAPP_PHONE = '+201210004315';
    assert.equal(whatsappConfigured(), false, 'a phone with no key is still off');
    delete process.env.WHATSAPP_PHONE;
    process.env.CALLMEBOT_APIKEY = 'wa-suite-key-1234';
    assert.equal(whatsappConfigured(), false, 'a key with no phone is still off');
    process.env.WHATSAPP_PHONE = 'not a number';
    assert.equal(whatsappConfigured(), false, 'a malformed number is off, not a bad request');

    const placed = await request('/api/orders', { method: 'POST', body: order() });
    assert.equal(placed.status, 201);
    await settle();
    assert.equal(calls.length, 0);
  } finally {
    unstub();
  }
});

test('the number is accepted the way people write it', () => {
  for (const written of ['+201210004315', '+20 12 10004315', '201210004315', '+20-12-1000-4315', '(+20) 1210004315']) {
    assert.equal(normalizeWhatsappPhone(written), '+201210004315', written);
  }
  // A local number with its leading zero has no country code and could be
  // anyone's, so it is refused rather than guessed at.
  for (const bad of ['01210004315', '', 'abc', '+0201210004315', '12345']) {
    assert.equal(normalizeWhatsappPhone(bad), '', bad);
  }
});
