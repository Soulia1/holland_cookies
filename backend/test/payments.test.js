/**
 * Online payment, through the real routes against a Firestore emulator.
 *
 * The property that matters: an order becomes paid only through a transaction
 * signed with the merchant's HMAC secret, for exactly the amount the server
 * priced, naming that order. Everything here is either that path working or an
 * attempt to get around it.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-payments';
process.env.ADMIN_KEY = 'payments-fixture-admin-0123456789abcdefghij';
process.env.JWT_SECRET = 'payments-fixture-session-0123456789abcdefgh';
process.env.BREVO_API_KEY = '';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.PAYMENTS_ONLINE = 'mock';
process.env.PAYMOB_HMAC_SECRET = 'payments-fixture-hmac-secret-0123456789';

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { default: app } = await import('../server.js');
const fsdb = await import('../firestore.js');
const paymob = await import('../paymob.js');
const { syncAll } = await import('../mirror.js');
const { validateEnvironment } = await import('../config.js');

let server;
let base;
let cookie = '';
const attempts = new Map();
const PHONE = '01012345678';

async function request(route, { method = 'GET', body, admin = false, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'x-requested-with': 'Holland',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(admin && cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data, headers: response.headers };
}

const place = async (extra = {}) => {
  const result = await request('/api/orders', {
  method: 'POST',
  body: {
    idempotencyKey: randomUUID(),
    items: [{ productId: 'plain', qty: 2 }],
    firstName: 'Fixture',
    phone: PHONE,
    email: 'fixture@example.com',
    fulfilment: 'pickup',
    paymentMethod: 'online',
    ...extra,
  },
  });
  if (result.data.order) {
    const doc = await stored(result.data.order.reference);
    if (doc.paymob?.specialReference) attempts.set(result.data.order.reference, doc.paymob.specialReference);
  }
  return result;
};

/** A webhook body for an order, signed the way Paymob signs it. */
function callback(merchantOrderId, { amountCents = 20000, success = true, secret, ...extra } = {}) {
  const obj = {
    id: 9001, pending: false, amount_cents: amountCents, success,
    is_auth: false, is_capture: false, is_standalone_payment: true, is_voided: false,
    is_refunded: false, is_3d_secure: true, integration_id: 42, has_parent_transaction: false,
    created_at: '2026-09-22T10:00:00.000000', currency: 'EGP', error_occured: false, owner: 7,
    order: { id: attempts.get(paymob.referenceFrom(merchantOrderId)) ?? 555, merchant_order_id: merchantOrderId },
    source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
    ...extra,
  };
  const valueOf = (field) => field.split('.').reduce((value, key) => value?.[key], obj);
  return { obj, hmac: paymob.signTransaction(valueOf, secret ?? process.env.PAYMOB_HMAC_SECRET) };
}

const postWebhook = ({ obj, hmac }) => fetch(`${base}/api/payments/paymob/webhook?hmac=${hmac}`, {
  // As Paymob sends it: no Origin, no X-Requested-With.
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'TRANSACTION', obj }),
});

const stored = async (reference) => (await fsdb.collections.orders().doc(reference).get()).data();

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
  const login = await request('/api/admin/session', { method: 'POST', body: { key: process.env.ADMIN_KEY } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

beforeEach(async () => {
  process.env.PAYMENTS_ONLINE = 'mock';
  delete process.env.PAYMOB_CARD_INTEGRATION_ID;
  delete process.env.PAYMOB_WALLET_INTEGRATION_ID;
  attempts.clear();
  await wipe(['orders', 'orderIdempotency', 'customers', 'products', 'categories',
    'rateLimits', 'auditEvents', 'counters', 'settings', 'mailLog']);
  await fsdb.collections.categories().doc('cookies').set({ name: 'Cookies', sort: 0, visible: true, group: 'cookies' });
  await fsdb.collections.products().doc('plain').set({
    categoryId: 'cookies', name: 'Plain', nameAr: '', price: 100, available: true, sort: 0,
    discountEnabled: false, discountType: 'percent', discountValue: 0, isBundle: false,
    bundleType: 'fixed', components: [], groups: [],
  });
  await syncAll();
});

after(async () => {
  server?.close();
  await fsdb.close?.().catch(() => {});
});

// ------------------------------------------------------------- signatures ----

test('wallet availability needs an explicit distinct wallet gateway; all IDs are deduplicated', () => {
  const env = { PAYMENTS_ONLINE: 'paymob', PAYMOB_SECRET_KEY: 'fixture', PAYMOB_PUBLIC_KEY: 'fixture', PAYMOB_HMAC_SECRET: 'fixture', PAYMOB_INTEGRATION_IDS: '111,111,222' };
  assert.equal(paymob.walletPaymentEnabled(env), false);
  assert.deepEqual(paymob.methodsFor('wallet', env), []);
  env.PAYMOB_CARD_INTEGRATION_ID = '111';
  env.PAYMOB_WALLET_INTEGRATION_ID = '111';
  assert.equal(paymob.walletPaymentEnabled(env), false);
  env.PAYMOB_WALLET_INTEGRATION_ID = '222';
  assert.equal(paymob.walletPaymentEnabled(env), true);
  assert.deepEqual(paymob.integrationIds(env), [111, 222]);
});

test('signed wallet settlement records the actual method even after a card preference', async () => {
  const { order } = (await place({ paymentMethod: 'card' })).data;
  const signed = callback(`${order.reference}-wallet`, { source_data: { type: 'wallet', sub_type: 'Vodafone Cash', pan: PHONE } });
  assert.equal((await postWebhook(signed)).status, 200);
  const paid = await stored(order.reference);
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.onlineMethod, 'wallet');
  assert.equal(paid.paymob.lastMethod, 'wallet');
  assert.equal((await postWebhook(signed)).status, 200);
});

test('a signed transaction verifies, and any edited field or other key does not', () => {
  const { obj, hmac } = callback('HC-1-abc');
  assert.equal(paymob.verifyCallback(obj, hmac), true);
  assert.equal(paymob.verifyCallback({ ...obj, amount_cents: 1 }, hmac), false);
  assert.equal(paymob.verifyCallback({ ...obj, success: false }, hmac), false);
  assert.equal(paymob.verifyCallback(obj, callback('HC-1-abc', { secret: 'another-secret-entirely-0123' }).hmac), false);
  assert.equal(paymob.verifyCallback(obj, 'not-hex'), false);
  assert.equal(paymob.verifyCallback(obj, undefined), false);
});

test('the order reference is read off an attempt suffix, and nothing else passes', () => {
  assert.equal(paymob.referenceFrom('HC-12-a1b2c3d4'), 'HC-12');
  assert.equal(paymob.referenceFrom('hc-12'), 'HC-12');
  assert.equal(paymob.referenceFrom('HC-12/../x'), null);
  assert.equal(paymob.referenceFrom(''), null);
});

test('production refuses the mock, and Paymob without all four keys', () => {
  const prod = {
    NODE_ENV: 'production',
    ADMIN_KEY: 'a'.repeat(40), JWT_SECRET: 'b'.repeat(40), APP_ORIGIN: 'https://shop.test',
    ADMIN_HOSTNAME: 'admin.shop.test', DEPLOYMENT_MODE: 'single-instance',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'p-test', client_email: 'x@p-test.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(120)}\n-----END PRIVATE KEY-----\n`,
    }),
  };
  assert.throws(() => validateEnvironment({ ...prod, PAYMENTS_ONLINE: 'mock' }), /PAYMENTS_ONLINE/);
  assert.throws(() => validateEnvironment({ ...prod, PAYMENTS_ONLINE: 'paymob', PAYMOB_SECRET_KEY: 's'.repeat(30) }),
    /PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET, PAYMOB_INTEGRATION_IDS/);
  const configured = { ...prod, PAYMENTS_ONLINE: 'paymob', PAYMOB_SECRET_KEY: 's'.repeat(30),
    PAYMOB_PUBLIC_KEY: 'p'.repeat(20), PAYMOB_HMAC_SECRET: 'h'.repeat(20), PAYMOB_INTEGRATION_IDS: '42' };
  assert.throws(() => validateEnvironment(configured), /PAYMOB_API_KEY/);
  assert.doesNotThrow(() => validateEnvironment({ ...configured, PAYMOB_API_KEY: 'k'.repeat(40) }));
});

// ------------------------------------------------------------------ flow ----

test('an online order is saved unpaid and comes back with a popup to open', async () => {
  const placed = await place();
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.equal(placed.data.order.paymentMethod, 'online');
  assert.equal(placed.data.order.paymentStatus, 'unpaid');
  assert.match(placed.data.payment.checkoutUrl, /\/api\/payments\/mock\/checkout\?ref=HC-\d+-[a-f0-9]{8}&amount_cents=20000&method=all$/);
  const doc = await stored(placed.data.order.reference);
  assert.equal(doc.paymob.references.length, 1);
});

test('the return page pays the order once, and a replay changes nothing', async () => {
  const { order, payment } = (await place()).data;
  const checkout = await fetch(new URL(payment.checkoutUrl.replace(/^https?:\/\/[^/]+/, base)));
  assert.equal(checkout.status, 200);
  assert.match(checkout.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const payLink = /class="pay" href="([^"]+)"/.exec(await checkout.text())[1].replaceAll('&amp;', '&');

  const first = await fetch(base + payLink, { redirect: 'manual' });
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location'), /\/checkout\?payment_return=HC-/);
  assert.equal((await stored(order.reference)).paymentStatus, 'paid');

  const status = await request(`/api/payments/status/${order.reference}?phone=${PHONE}`);
  assert.deepEqual(status.data, { paymentStatus: 'paid', status: 'ordered', paymentOutcome: 'paid' });

  await fetch(base + payLink, { redirect: 'manual' });
  const audits = await fsdb.collections.auditEvents().where('resource', '==', order.reference).get();
  assert.equal(audits.size, 1, 'a replayed return must not record a second payment');
});

test('a declined card leaves the order unpaid, and "try again" opens a new session', async () => {
  const { order } = (await place()).data;
  const query = paymob.mockResultQuery({ specialReference: attempts.get(order.reference), amountCents: 20000, success: false });
  const declined = await fetch(`${base}/api/payments/paymob/return?${query}`, { redirect: 'manual' });
  assert.equal(declined.status, 303);
  assert.match(declined.headers.get('location'), /payment_result=declined/);
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');

  const retry = await request('/api/payments/session', { method: 'POST', body: { reference: order.reference, phone: PHONE } });
  assert.equal(retry.status, 200);
  assert.equal((await stored(order.reference)).paymob.references.length, 2);
});

test('the webhook pays the order, needs no browser headers, and is idempotent', async () => {
  const { order } = (await place()).data;
  const signed = callback(`${order.reference}-deadbeef`);
  assert.equal((await postWebhook(signed)).status, 200);
  assert.equal((await stored(order.reference)).paymentStatus, 'paid');
  assert.equal((await stored(order.reference)).paymentRef, '9001');
  assert.equal((await postWebhook(signed)).status, 200);
});

// --------------------------------------------------------------- attacks ----

test('a forged webhook is refused and pays nothing', async () => {
  const { order } = (await place()).data;
  const forged = callback(`${order.reference}-deadbeef`, { secret: 'attacker-guess-0123456789abcdef' });
  assert.equal((await postWebhook(forged)).status, 401);
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');
});

test('a signed payment for the wrong amount does not pay the order', async () => {
  const { order } = (await place()).data;
  assert.equal((await postWebhook(callback(`${order.reference}-x1`, { amountCents: 100 }))).status, 200);
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');
});

test('a refund or void transaction never marks an order paid', async () => {
  const { order } = (await place()).data;
  await postWebhook(callback(`${order.reference}-x1`, { has_parent_transaction: true, is_refunded: true }));
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');
});

test('a cash order cannot be paid by a transaction, nor an online one by the cash control', async () => {
  const cash = (await place({ paymentMethod: 'cash' })).data.order;
  await postWebhook(callback(`${cash.reference}-x1`));
  assert.equal((await stored(cash.reference)).paymentStatus, 'unpaid');

  const online = (await place()).data.order;
  await fsdb.collections.orders().doc(online.reference).update({ status: 'completed' });
  await syncAll();
  const marked = await request(`/api/orders/${online.reference}/payment`, {
    method: 'PATCH', body: { paymentStatus: 'paid' }, admin: true,
  });
  assert.equal(marked.status, 409);
});

test('status and "try again" need the phone the order was placed with', async () => {
  const { order } = (await place()).data;
  assert.equal((await request(`/api/payments/status/${order.reference}?phone=01099999999`)).status, 404);
  const retry = await request('/api/payments/session', { method: 'POST', body: { reference: order.reference, phone: '01099999999' } });
  assert.equal(retry.status, 404);
});

test('online payment is refused while switched off, and needs an email', async () => {
  process.env.PAYMENTS_ONLINE = '';
  const off = await place();
  assert.equal(off.status, 400);
  assert.equal(off.data.error, 'PAYMENT_UNAVAILABLE');
  assert.equal((await request('/api/admin/settings')).data.settings.onlinePaymentEnabled, false);

  process.env.PAYMENTS_ONLINE = 'mock';
  const noEmail = await place({ email: '' });
  assert.equal(noEmail.status, 400);
  assert.ok(noEmail.data.fields.email);
});

test('with Paymob configured, the intention carries the server-priced amount', async () => {
  Object.assign(process.env, {
    PAYMENTS_ONLINE: 'paymob', PAYMOB_SECRET_KEY: 'egy_sk_test_fixture_0123456789',
    PAYMOB_PUBLIC_KEY: 'egy_pk_test_fixture', PAYMOB_INTEGRATION_IDS: '111, 222',
  });
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://accept.paymob.com/')) return realFetch(url, init);
    sent = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: 'pi_test_1', client_secret: 'egy_csk_test_1', intention_order_id: 777 }), { status: 201 });
  };
  try {
    // A price written into the payload is stripped; the server's is sent.
    const placed = await place({ paymentMethod: 'card', items: [{ productId: 'plain', qty: 3 }] });
    assert.equal(placed.status, 201, JSON.stringify(placed.data));
    assert.equal(sent.url, 'https://accept.paymob.com/v1/intention/');
    assert.equal(sent.headers.Authorization, 'Token egy_sk_test_fixture_0123456789');
    assert.equal(sent.body.amount, 30000);
    assert.equal(sent.body.items.reduce((sum, item) => sum + item.amount * item.quantity, 0), 30000);
    assert.deepEqual(sent.body.payment_methods, [111, 222]);
    assert.equal(sent.body.billing_data.phone_number, '+201012345678');
    assert.match(sent.body.special_reference, new RegExp(`^${placed.data.order.reference}-`));
    assert.equal(placed.data.payment.checkoutUrl,
      'https://eg.checkout.paymob.com/?publicKey=egy_pk_test_fixture&clientSecret=egy_csk_test_1');
    assert.deepEqual((await stored(placed.data.order.reference)).paymob.orderIds, ['777']);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_IDS']) delete process.env[key];
  }
});

test('when Paymob is down the order still stands, and says the popup failed', async () => {
  Object.assign(process.env, {
    PAYMENTS_ONLINE: 'paymob', PAYMOB_SECRET_KEY: 'egy_sk_test_fixture_0123456789',
    PAYMOB_PUBLIC_KEY: 'egy_pk_test_fixture', PAYMOB_INTEGRATION_IDS: '111',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://accept.paymob.com/')
    ? new Response('{"detail":"nope"}', { status: 500 }) : realFetch(url, init));
  try {
    const placed = await place();
    assert.equal(placed.status, 201);
    assert.equal(placed.data.payment, null);
    assert.equal((await stored(placed.data.order.reference)).paymentStatus, 'unpaid');
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_INTEGRATION_IDS']) delete process.env[key];
  }
});

test('an unsigned merchant reference cannot redirect a signed payment to another order', async () => {
  const first = (await place()).data.order;
  const second = (await place()).data.order;
  const signed = callback(`${first.reference}-x1`);
  signed.obj.order.merchant_order_id = `${second.reference}-forged`;
  assert.equal((await postWebhook(signed)).status, 200);
  assert.equal((await stored(first.reference)).paymentStatus, 'paid');
  assert.equal((await stored(second.reference)).paymentStatus, 'unpaid');
});

test('real redirect verifies the result but only a webhook can mark the order paid', async () => {
  const { order } = (await place()).data;
  const query = paymob.mockResultQuery({ specialReference: attempts.get(order.reference), amountCents: 20000, success: true });
  process.env.PAYMENTS_ONLINE = 'paymob';
  const response = await fetch(`${base}/api/payments/paymob/return?${query}`, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');
  process.env.PAYMENTS_ONLINE = 'mock';
  await postWebhook(callback(`${order.reference}-x1`));
  assert.equal((await stored(order.reference)).paymentStatus, 'paid');
});

test('a successful auth-only transaction does not authorize baking', async () => {
  const { order } = (await place()).data;
  await postWebhook(callback(`${order.reference}-x1`, { is_auth: true }));
  assert.equal((await stored(order.reference)).paymentStatus, 'unpaid');
  const moved = await request(`/api/orders/${order.reference}/status`, { method: 'PATCH', admin: true, body: { status: 'confirmed' } });
  assert.equal(moved.status, 409);
});

test('partial refunds use API totals, tolerate retries, and appear in the dashboard', async () => {
  const { order } = (await place()).data;
  const signed = callback(`${order.reference}-x1`);
  await postWebhook(signed);
  process.env.PAYMOB_API_KEY = 'fixture-api-key-0123456789';
  const realFetch = globalThis.fetch;
  let refunded = 5000;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/auth/tokens')) return Response.json({ token: 'fixture-token' });
    if (String(url).endsWith('/api/acceptance/transactions/9001')) {
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      return Response.json({ ...signed.obj, is_refunded: true, refunded_amount_cents: refunded });
    }
    return realFetch(url, init);
  };
  try {
    const refund = callback(`${order.reference}-x1`, { is_refunded: true, refunded_amount_cents: 19999 });
    assert.equal((await postWebhook(refund)).status, 200);
    assert.equal((await stored(order.reference)).paymob.refundedCents, 5000);
    assert.equal((await stored(order.reference)).paymentStatus, 'paid');
    assert.equal((await postWebhook(refund)).status, 200);
    const detail = await request(`/api/orders/${order.reference}`, { admin: true });
    assert.equal(detail.data.order.refundedAmount, 50);
    assert.equal(detail.data.order.remainingAmount, 150);
    for (const readMode of ['', 'off']) {
      process.env.READ_MIRROR = readMode;
      const stats = await request('/api/orders/stats', { admin: true });
      assert.equal(stats.status, 200);
      assert.equal(stats.data.totals.paidRevenue, 150);
      assert.equal(stats.data.totals.pendingValue, 0, 'a partial refund is not unpaid checkout debt');
    }
    delete process.env.READ_MIRROR;
    refunded = 20000;
    assert.equal((await postWebhook(refund)).status, 200);
    assert.equal((await stored(order.reference)).paymentStatus, 'refunded');
    await postWebhook(signed);
    assert.equal((await stored(order.reference)).paymentStatus, 'refunded');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PAYMOB_API_KEY;
    delete process.env.READ_MIRROR;
  }
});

test('an unmatched signed callback asks for retry instead of silently losing a payment', async () => {
  const signed = callback('HC-999-x1');
  assert.equal((await postWebhook(signed)).status, 503);
});

test('online receipts and bakery alerts wait for settlement and deduplicate webhook retries', async () => {
  process.env.MAIL_TRANSPORT = 'brevo';
  process.env.BREVO_API_KEY = 'fixture-mail-key';
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.brevo.com/')) {
      sent.push(JSON.parse(init.body));
      return Response.json({ messageId: `fixture-${sent.length}` }, { status: 201 });
    }
    return realFetch(url, init);
  };
  try {
    const { order } = (await place()).data;
    assert.equal(sent.length, 0, 'unpaid online checkout must not send a receipt');
    const signed = callback(`${order.reference}-x1`);
    await postWebhook(signed);
    for (let i = 0; i < 40 && sent.length !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 2);
    assert.ok(sent.some((mail) => mail.textContent.includes('Paid online through Paymob.')));
    assert.ok(sent.every((mail) => !mail.textContent.includes('Payment is cash')));
    await postWebhook(signed);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sent.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    process.env.MAIL_TRANSPORT = 'disabled';
    process.env.BREVO_API_KEY = '';
  }
});
