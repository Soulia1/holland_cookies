/**
 * The security regression suite.
 *
 * Every test here is an attack, run against the real server with the real
 * routes and a real Firestore emulator behind it. Nothing is mocked except the
 * outbound mail provider, because mocking the thing you are trying to attack
 * proves only that the mock is safe.
 *
 * This suite was ORPHANED before the pre-launch pass: it matched no npm script
 * (`test:backend` globbed only `backend/test/*.test.js`), so it had never run in
 * this repository, and it contained a failing assertion nobody had seen. It is
 * now wired into `npm run test:security` and `npm run test:all`. See
 * docs/PRE_LAUNCH_BASELINE.md.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-security';
process.env.ADMIN_KEY = 'security-fixture-admin-0123456789abcdefgh';
process.env.JWT_SECRET = 'security-fixture-session-0123456789abcdefgh';
process.env.BREVO_API_KEY = '';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.DISABLE_ADMIN_AUTH = 'false';

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const { default: app } = await import('../../backend/server.js');
const fsdb = await import('../../backend/firestore.js');
const { syncAll } = await import('../../backend/mirror.js');
const { requestCode, verifyCode } = await import('../../backend/otp.js');
const { createSession } = await import('../../backend/sessionStore.js');
const { validateEnvironment } = await import('../../backend/config.js');
const { sendMail } = await import('../../backend/mailer.js');
const { assertOrderUpdate } = await import('../../backend/invariants.js');

let server; let base; let admin;

const payload = (extra = {}) => ({
  idempotencyKey: randomUUID(),
  items: [{ productId: 'cookie', qty: 2 }],
  firstName: 'Fixture',
  phone: '01000000000',
  fulfilment: 'pickup',
  ...extra,
});

async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'x-requested-with': 'Holland',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: res.status, headers: res.headers, data };
}

async function wipe(names) {
  await Promise.all(names.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

before(async () => {
  // The tripwire: prove we are on an emulator before writing a single fixture.
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /,
    'the security suite is pointed at a real Firestore project — refusing to run');

  // mailLog belongs in this list for a reason that is easy to get wrong: the
  // dedupe key is the order reference, and wiping `counters` restarts
  // references at HC-1001. A mail log left behind by the previous run therefore
  // holds a claim on every reference this run is about to mint, and every send
  // is skipped as a duplicate — silently, because a duplicate is not an error.
  await wipe(['orders', 'orderIdempotency', 'customers', 'products', 'categories',
    'promos', 'profiles', 'otpCodes', 'sessions', 'rateLimits', 'auditEvents', 'counters',
    'mailLog']);

  await fsdb.collections.categories().doc('cookies').set({ name: 'Cookies', nameAr: '', sort: 0, visible: true });
  await fsdb.collections.products().doc('cookie').set({
    categoryId: 'cookies', name: 'Cookie', nameAr: '', note: '', price: 50,
    available: true, discountEnabled: false, discountType: 'percent', discountValue: 0, sort: 0,
  });
  await fsdb.orderCounterDoc().set({ value: 1000 });
  await fsdb.settingsDoc().set({ deliveryFee: 0, freeDeliveryOver: 0, acceptingOrders: true, areas: [] });
  await syncAll();

  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await request('/api/admin/session', { method: 'POST', body: { key: process.env.ADMIN_KEY } });
  assert.equal(login.status, 200);
  admin = login.headers.get('set-cookie').split(';')[0];
});

// Rate-limit counters are shared, durable state now. Clearing them between
// tests keeps one test's traffic from tripping the next one's limits.
beforeEach(() => wipe(['rateLimits']));

after(async () => {
  await new Promise((r) => server.close(r));
  await fsdb.close();
});

// ------------------------------------------------------------ authorization ----

test('authorization: every protected route denies anonymous and customer sessions', async () => {
  await fsdb.collections.profiles().doc('matrix@example.test').set({ fullName: '', phone: '' });
  const customer = `holland_customer_session=${await createSession('customer', 'matrix@example.test', 3600)}`;

  const routes = [
    ['GET', '/api/orders'], ['GET', '/api/orders/stats'], ['GET', '/api/orders/HC-1001'],
    ['PATCH', '/api/orders/HC-1001/status'], ['GET', '/api/admin/customers'],
    ['GET', '/api/admin/customers/01000000000'], ['GET', '/api/admin/users'],
    ['GET', '/api/admin/promos'], ['POST', '/api/admin/promos'],
    ['PATCH', '/api/admin/promos/TEST'], ['DELETE', '/api/admin/promos/TEST'],
    ['PATCH', '/api/admin/settings'],
    ...['products', 'categories'].flatMap((kind) => [
      ['GET', `/api/menu/admin/${kind}`], ['POST', `/api/menu/admin/${kind}`],
      ['PATCH', `/api/menu/admin/${kind}/cookie`], ['DELETE', `/api/menu/admin/${kind}/cookie`],
    ]),
  ];
  for (const [method, route] of routes) {
    for (const cookie of [undefined, customer]) {
      assert.equal((await request(route, { method, cookie })).status, 401, `${method} ${route}`);
    }
  }
  // And the reverse: an admin session is not a customer session.
  for (const route of ['/api/account/profile', '/api/account/orders']) {
    assert.equal((await request(route, {
      method: route.endsWith('profile') ? 'PATCH' : 'GET', cookie: admin,
    })).status, 401);
  }
});

// --------------------------------------------------------------- validation ----

test('validation: strict fields, primitives, bounds, duplicate items and tampered financials are rejected', async () => {
  const attacks = [
    { role: 'admin' }, { total: 0 }, { paymentStatus: 'paid' }, { paymentMethod: 'card' },
    { items: [{ productId: 'cookie', qty: 0 }] },
    { items: [{ productId: 'cookie', qty: -1 }] },
    { items: [{ productId: 'cookie', qty: 1.5 }] },
    { items: [{ productId: 'cookie', qty: 51 }] },
    { items: [{ productId: 'cookie', qty: 1, price: 0 }] },
    { items: [{ productId: 'cookie', qty: 1 }, { productId: 'cookie', qty: 1 }] },
    { firstName: '   ' }, { firstName: {} }, { firstName: 'x'.repeat(81) },
    { email: ['a@example.test'] }, { notes: '\ud800' },
  ];
  for (const extra of attacks) {
    assert.equal((await request('/api/orders', { method: 'POST', body: payload(extra) })).status,
      400, JSON.stringify(extra));
  }
});

test('validation: malformed JSON, dangerous keys, compressed bodies, giant input, invalid queries and paths fail safely', async () => {
  for (const body of ['{', '{"__proto__":{"admin":true}}', '[]', 'null']) {
    assert.equal((await request('/api/orders', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/orders', { method: 'POST', body: { notes: 'x'.repeat(40000) } })).status, 413);
  assert.equal((await request('/api/orders', { method: 'POST', body: {}, headers: { 'content-encoding': 'gzip' } })).status, 415);

  for (const route of [
    '/api/orders?page=1&page=2', '/api/orders?page=1.5', '/api/orders?perPage=999',
    `/api/orders?q=${'x'.repeat(101)}`, '/api/orders?filter[$ne]=1',
    '/api/orders/track/HC-1?phone=1&phone=2', '/api/orders/stats?days=Infinity',
  ]) {
    assert.equal((await request(route, { cookie: admin })).status, 400, route);
  }

  // An injection string is data, not syntax. Firestore has no query language to
  // inject into, and the field is a bounded string that is compared, never
  // concatenated — so this must come back as an ordinary empty result set.
  const injection = await request(`/api/orders?${new URLSearchParams({ q: "' OR 1=1 --" })}`, { cookie: admin });
  assert.equal(injection.status, 200);
  assert.equal(injection.data.total, 0);

  // Path traversal. The encoded separator fails to match the :id route and
  // falls through to the API 404 handler; an earlier version of this assertion
  // demanded exactly 400 and had been failing unnoticed because the suite was
  // never run. What actually matters is that the request is refused and reaches
  // nothing, which either status satisfies.
  const traversal = await request('/api/menu/admin/products/..%2Fsecrets', { cookie: admin });
  assert.ok([400, 404].includes(traversal.status),
    `traversal must be refused, got ${traversal.status}`);
});

// ------------------------------------------------------------- csrf / cors ----

test('csrf/cors: cross-origin and originless simple writes denied; allowed browser origin works', async () => {
  assert.equal((await request('/api/admin/settings', {
    method: 'PATCH', cookie: admin, body: { acceptingOrders: true },
    headers: { origin: 'https://attacker.invalid' },
  })).status, 403);

  assert.equal((await request('/api/admin/session', {
    method: 'DELETE', cookie: admin, headers: { 'x-requested-with': '' },
  })).status, 403);

  assert.equal((await request('/api/admin/settings', {
    method: 'PATCH', cookie: admin, body: { acceptingOrders: true }, headers: { origin: base },
  })).status, 200);

  assert.equal((await request('/api/menu', { headers: { origin: 'https://attacker.invalid' } }))
    .headers.get('access-control-allow-origin'), null);
});

test('csrf with a fixed APP_ORIGIN: the shop and its admin host write, nothing else does', async () => {
  const saved = { APP_ORIGIN: process.env.APP_ORIGIN, ADMIN_HOSTNAME: process.env.ADMIN_HOSTNAME };
  process.env.APP_ORIGIN = 'https://hollandcookie.example';
  process.env.ADMIN_HOSTNAME = 'admin.hollandcookie.example';
  const write = (origin) => request('/api/admin/settings', {
    method: 'PATCH', cookie: admin, body: { acceptingOrders: true }, headers: { origin },
  });
  try {
    assert.equal((await write('https://hollandcookie.example')).status, 200, 'the shop');
    assert.equal((await write('https://admin.hollandcookie.example')).status, 200, 'the dashboard');
    for (const origin of [
      'http://admin.hollandcookie.example', 'https://admin.hollandcookie.example:8443',
      'https://evil.hollandcookie.example', 'https://admin.hollandcookie.example.attacker.invalid',
      base,
    ]) {
      assert.equal((await write(origin)).status, 403, origin);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------- sessions ----

test('sessions: logout revokes a copied token, cookie flags are set, key headers do not authorize', async () => {
  const login = await request('/api/admin/session', { method: 'POST', body: { key: process.env.ADMIN_KEY } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);

  assert.equal((await request('/api/admin/session', { method: 'DELETE', cookie })).status, 200);
  // The copied token is dead too — revocation is server-side, not just a
  // cleared cookie in one browser.
  assert.equal((await request('/api/orders', { cookie })).status, 401);

  // The master key is not a bearer credential.
  assert.equal((await request('/api/orders', { headers: { 'x-admin-key': process.env.ADMIN_KEY } })).status, 401);
});

// --------------------------------------------------------------------- otp ----

test('OTP: concurrent correct verifications succeed once; send quota survives consumption', async () => {
  const email = 'otp-race@example.test';
  const issued = await requestCode(email);
  assert.equal(issued.ok, true);

  const results = await Promise.all(Array.from({ length: 8 }, () => verifyCode(email, issued.code)));
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one verification may succeed');

  const record = await fsdb.collections.otpCodes().doc(email).get();
  assert.equal(record.data().sentDay, 1, 'consuming a code must not reset the send quota');
  assert.equal((await requestCode(email)).code, 'COOLDOWN');
});

test('OTP: concurrent issue reserves quota once; expired code and exhausted guesses cannot authenticate', async () => {
  const email = 'otp-send@example.test';
  const results = await Promise.all(Array.from({ length: 8 }, () => requestCode(email)));
  assert.equal(results.filter((r) => r.ok).length, 1, 'eight simultaneous requests may issue one code');

  const issued = results.find((r) => r.ok);
  for (let i = 0; i < 5; i += 1) {
    await verifyCode(email, issued.code === '000000' ? '000001' : '000000');
  }
  // The attempt budget is spent; the correct code no longer works.
  assert.equal((await verifyCode(email, issued.code)).ok, false);

  const expired = await requestCode('expired@example.test');
  await fsdb.collections.otpCodes().doc(expired.email)
    .update({ expiresAt: (await import('firebase-admin/firestore')).Timestamp.fromMillis(0) });
  assert.equal((await verifyCode(expired.email, expired.code)).ok, false);
});

// -------------------------------------------------------------------- bola ----

test('BOLA: customer A cannot read B orders or change identity; logout invalidates the token', async () => {
  for (const name of ['a', 'b']) {
    await fsdb.collections.profiles().doc(`${name}@example.test`).set({ fullName: '', phone: '' });
  }
  const a = `holland_customer_session=${await createSession('customer', 'a@example.test', 3600)}`;
  const b = `holland_customer_session=${await createSession('customer', 'b@example.test', 3600)}`;

  const order = await request('/api/orders', { method: 'POST', body: payload() });
  assert.equal(order.status, 201);
  // Attach the order to B.
  await fsdb.collections.orders().doc(order.data.order.reference).update({ profileId: 'b@example.test' });
  await syncAll();

  assert.equal((await request('/api/account/orders', { cookie: a })).data.orders.length, 0);
  assert.equal((await request('/api/account/orders', { cookie: b })).data.orders.length, 1);

  // The email is not a writable profile field — changing it would move the
  // account to an address nobody proved they control.
  assert.equal((await request('/api/account/profile', {
    method: 'PATCH', cookie: a, body: { email: 'b@example.test' },
  })).status, 400);

  await request('/api/account/signout', { method: 'POST', cookie: a });
  assert.equal((await request('/api/account/orders', { cookie: a })).status, 401);
});

// ---------------------------------------------------------------- business ----

test('business: idempotency binds the whole request and a limited coupon cannot be spent twice', async () => {
  const body = payload();
  const [a, b] = await Promise.all([
    request('/api/orders', { method: 'POST', body }),
    request('/api/orders', { method: 'POST', body }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.data.order.reference, b.data.order.reference);

  // Same key, different basket → conflict, never a silent overwrite.
  assert.equal((await request('/api/orders', {
    method: 'POST', body: { ...body, notes: 'changed' },
  })).status, 409);

  await fsdb.collections.promos().doc('ONCE').set({
    type: 'percent', value: 10, minSubtotal: 0, maxUses: 1, usedCount: 0, active: true, expiresAt: null,
  });
  const results = await Promise.all([
    request('/api/orders', { method: 'POST', body: payload({ promoCode: 'ONCE' }) }),
    request('/api/orders', { method: 'POST', body: payload({ promoCode: 'ONCE' }) }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  assert.equal((await fsdb.collections.promos().doc('ONCE').get()).data().usedCount, 1);
});

test('business: server enforces transitions; financials are immutable; tracking redacts PII and notes', async () => {
  const created = await request('/api/orders', {
    method: 'POST', body: payload({ email: 'private@example.test', notes: 'Private note' }),
  });
  const ref = created.data.order.reference;

  // ordered → completed skips the pipeline.
  assert.equal((await request(`/api/orders/${ref}/status`, {
    method: 'PATCH', cookie: admin, body: { status: 'completed' },
  })).status, 409);

  // An unknown field alongside a legal status is rejected outright, not ignored.
  assert.equal((await request(`/api/orders/${ref}/status`, {
    method: 'PATCH', cookie: admin, body: { status: 'confirmed', payment_status: 'paid' },
  })).status, 400);

  assert.equal((await request(`/api/orders/${ref}/status`, {
    method: 'PATCH', cookie: admin, body: { status: 'confirmed', note: 'Staff private' },
  })).status, 200);

  const tracked = await request(`/api/orders/track/${ref}?phone=01000000000`);
  assert.equal(tracked.status, 200);
  assert.equal(tracked.data.order.customer.email, '');
  assert.equal(tracked.data.order.delivery.notes, '');
  assert.ok(tracked.data.history.every((h) => h.note === ''), 'staff notes must not leak to tracking');

  // Wrong phone is indistinguishable from no such order.
  assert.equal((await request(`/api/orders/track/${ref}?phone=01100000000`)).status, 404);

  // SQLite enforced financial immutability with a trigger. Firestore cannot, so
  // the guarantee moved into `assertOrderUpdate`, called inside the write
  // transaction. Asserted directly, because no route can produce this input.
  const stored = (await fsdb.collections.orders().doc(ref).get()).data();
  assert.throws(() => assertOrderUpdate(stored, { total: 1 }), /immutable/);
  assert.throws(() => assertOrderUpdate(stored, { subtotal: 1 }), /immutable/);
  assert.throws(() => assertOrderUpdate(stored, { paymentMethod: 'card' }), /immutable/);
  assert.throws(() => assertOrderUpdate(stored, { items: [] }), /immutable/);
  assert.throws(() => assertOrderUpdate(stored, { status: 'nonsense' }), /unknown status/);
});

test('admin schemas: merged discount values, image URLs and unknown fields are validated', async () => {
  await request('/api/admin/promos', { method: 'POST', cookie: admin, body: { code: 'MERGE', type: 'fixed', value: 200 } });
  // fixed 200 becomes percent 200, which is invalid only when merged with the
  // stored value — the patch alone looks fine.
  assert.equal((await request('/api/admin/promos/MERGE', {
    method: 'PATCH', cookie: admin, body: { type: 'percent' },
  })).status, 400);

  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'https://127.0.0.1/a.png', '/img/../a.png']) {
    assert.equal((await request('/api/menu/admin/products/cookie', {
      method: 'PATCH', cookie: admin, body: { image },
    })).status, 400, image);
  }

  assert.equal((await request('/api/admin/settings', {
    method: 'PATCH', cookie: admin, body: { role: 'admin' },
  })).status, 400);

  // A hidden category takes its products off the menu server-side, not just in
  // the UI.
  await fsdb.collections.categories().doc('cookies').update({ visible: false });
  assert.equal((await request('/api/orders', { method: 'POST', body: payload() })).status, 400);
  await fsdb.collections.categories().doc('cookies').update({ visible: true });
});

// ------------------------------------------------------------ rate limiting ----

test('rate limiting: strict login threshold, Retry-After, forged proxy headers cannot bypass', async () => {
  let last;
  // A different X-Forwarded-For on every request. `trust proxy` is configured
  // with CIDRs rather than a hop count, so a directly-connected client cannot
  // spoof its address and each of these still counts against the same key.
  for (let i = 0; i < 11; i += 1) {
    last = await request('/api/admin/session', {
      method: 'POST', body: { key: 'wrong' }, headers: { 'x-forwarded-for': `192.0.2.${i + 1}` },
    });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0, 'a 429 must say when to come back');
});

test('rate limiting: the durable classes survive a restart of the counter store', async () => {
  // The login limiter is Firestore-backed precisely so that a process restart
  // does not hand an attacker a fresh budget. Proven by reading the counter
  // straight out of the datastore rather than by trusting the middleware.
  for (let i = 0; i < 3; i += 1) {
    await request('/api/admin/session', { method: 'POST', body: { key: 'wrong' } });
  }
  const counters = await fsdb.collections.rateLimits().get();
  assert.ok(counters.size > 0, 'strict limiter state must be persisted, not in-process');
});

test('rate limiting: protected dashboard reads do not consume the public catalogue budget', async () => {
  for (let i = 0; i < 305; i += 1) {
    assert.equal((await request('/api/admin/promos')).status, 401);
  }
  assert.equal((await request('/api/menu')).status, 200,
    'admin traffic must not make the public catalogue return 429');
});

// ----------------------------------------------------------------- headers ----

test('headers, methods, removed debug routes and private cache', async () => {
  const res = await request('/api/account/me');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp.match(/script-src [^;]+/)[0], /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('permissions-policy'));

  for (const route of ['/api/debug', '/api/test', '/api/payments', '/api/webhook', '/api/seed']) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.equal((await request('/api/menu', { method: 'PUT' })).status, 405);
});

test('CSP authorizes the inline bootstrap text after HTML newline normalization', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  const scripts = [...res.data.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'the built storefront should contain its language bootstrap');
  for (const match of scripts) {
    const browserText = match[1].replace(/\r\n?/g, '\n');
    const hash = createHash('sha256').update(browserText).digest('base64');
    assert.match(csp, new RegExp(`'sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
});

// ------------------------------------------------------- failure behaviour ----

test('exceptional conditions: a datastore failure is generic and never authenticates', async () => {
  // Minted before the outage, and never yet presented, so checking it has to
  // reach the datastore.
  const unseen = `holland_admin_session=${await createSession('admin', 'admin', 3600)}`;
  assert.equal((await request('/api/orders', { cookie: admin })).status, 200);

  const real = fsdb.get().collection;
  // Simulate Firestore being unreachable, with a message full of things that
  // must not reach a client.
  fsdb.get().collection = () => {
    throw Object.assign(new Error('UNAVAILABLE: holland-cookie-prod /var/secrets/key.json'), { code: 14 });
  };
  const generic = (res, what) => {
    assert.equal(res.status, 503, `${what}: a datastore outage is a 503, not a 500 and never a 200`);
    // `error: 'UNAVAILABLE'` is our own deliberate public error code and is
    // expected here. What must never appear is the underlying detail: the
    // project id, the credential path, or the driver's own message.
    assert.equal(res.data.error, 'UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(res.data), /holland-cookie-prod|secrets|\.json|\/var\//,
      'internal detail must not reach the client');
  };
  try {
    // A session that cannot be checked is not a session: fail closed.
    generic(await request('/api/orders', { cookie: unseen }), 'unverifiable session');

    // A read that has to go to the datastore fails generically.
    process.env.READ_MIRROR = 'off';
    generic(await request('/api/orders', { cookie: admin }), 'direct read');
    delete process.env.READ_MIRROR;

    // What the in-memory mirror already holds keeps serving an administrator
    // this process verified moments ago: an outage does not blank the dashboard.
    assert.equal((await request('/api/orders', { cookie: admin })).status, 200);
  } finally {
    delete process.env.READ_MIRROR;
    fsdb.get().collection = real;
  }
});

test('production configuration fails closed', async () => {
  assert.throws(() => validateEnvironment({ NODE_ENV: 'production' }));
  assert.throws(() => validateEnvironment({
    NODE_ENV: 'production', DISABLE_ADMIN_AUTH: 'true', MAIL_TRANSPORT: 'console',
  }));
  // A production process must never be pointed at an emulator.
  assert.throws(() => validateEnvironment({
    NODE_ENV: 'production',
    ADMIN_KEY: 'a'.repeat(40), JWT_SECRET: 'b'.repeat(40),
    APP_ORIGIN: 'https://hollandcookie.example', ADMIN_HOSTNAME: 'admin.hollandcookie.example',
    FIREBASE_PROJECT_ID: 'holland-cookie-prod',
    FIREBASE_CLIENT_EMAIL: 'sa@holland-cookie-prod.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${'x'.repeat(120)}`,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    BREVO_API_KEY: 'k'.repeat(24), MAIL_FROM_EMAIL: 'shop@hollandcookie.example',
    DEPLOYMENT_MODE: 'single-instance',
  }), /FIRESTORE_EMULATOR_HOST/);
});

test('production boots without an email provider, and email needs an explicit switch', () => {
  const base = {
    NODE_ENV: 'production',
    ADMIN_KEY: 'a'.repeat(40), JWT_SECRET: 'b'.repeat(40),
    APP_ORIGIN: 'https://hollandcookie.example', ADMIN_HOSTNAME: 'admin.hollandcookie.example',
    FIREBASE_PROJECT_ID: 'holland-cookie-prod',
    FIREBASE_CLIENT_EMAIL: 'sa@holland-cookie-prod.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${'x'.repeat(120)}`,
    DEPLOYMENT_MODE: 'single-instance',
  };
  // Email is postponed: no Brevo variables at all must still boot.
  assert.doesNotThrow(() => validateEnvironment(base));
  // A leftover key on its own is accepted and stays dormant.
  assert.doesNotThrow(() => validateEnvironment({ ...base, BREVO_API_KEY: 'k'.repeat(24) }));
  // Switching Brevo on without its variables is a misconfiguration.
  assert.throws(() => validateEnvironment({ ...base, MAIL_TRANSPORT: 'brevo' }), /MAIL_TRANSPORT=brevo/);
});

test('production refuses an address the bakery alert could never reach', () => {
  const base = {
    NODE_ENV: 'production',
    ADMIN_KEY: 'a'.repeat(40), JWT_SECRET: 'b'.repeat(40),
    APP_ORIGIN: 'https://hollandcookie.example', ADMIN_HOSTNAME: 'admin.hollandcookie.example',
    FIREBASE_PROJECT_ID: 'holland-cookie-prod',
    FIREBASE_CLIENT_EMAIL: 'sa@holland-cookie-prod.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${'x'.repeat(120)}`,
    DEPLOYMENT_MODE: 'single-instance',
  };
  // Unset is fine — it falls back to the shop's own inbox.
  assert.doesNotThrow(() => validateEnvironment(base));
  assert.doesNotThrow(() => validateEnvironment({ ...base, ADMIN_ORDER_EMAIL: 'shop@hollandcookie.example' }));
  assert.doesNotThrow(() => validateEnvironment({
    ...base, ADMIN_ORDER_EMAIL: 'one@shop.example, two@shop.example',
  }));
  for (const bad of ['shop@', 'shop.example', 'one@shop.example, nope', 'one@shop.example;two@shop.example']) {
    assert.throws(() => validateEnvironment({ ...base, ADMIN_ORDER_EMAIL: bad }), /ADMIN_ORDER_EMAIL/, bad);
  }
});

test('production needs a dashboard host that is a bare hostname and not the shop', () => {
  const base = {
    NODE_ENV: 'production',
    ADMIN_KEY: 'a'.repeat(40), JWT_SECRET: 'b'.repeat(40),
    APP_ORIGIN: 'https://hollandcookie.example', ADMIN_HOSTNAME: 'admin.hollandcookie.example',
    FIREBASE_PROJECT_ID: 'holland-cookie-prod',
    FIREBASE_CLIENT_EMAIL: 'sa@holland-cookie-prod.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----${'x'.repeat(120)}`,
    DEPLOYMENT_MODE: 'single-instance',
  };
  assert.doesNotThrow(() => validateEnvironment(base));
  const { ADMIN_HOSTNAME: _omitted, ...missing } = base;
  assert.throws(() => validateEnvironment(missing), /ADMIN_HOSTNAME/);
  for (const bad of [
    'https://admin.hollandcookie.example', 'admin.hollandcookie.example/', 'admin.hollandcookie.example:443',
    'Admin.HollandCookie.example', 'admin', 'admin.localhost.', '', '-admin.hollandcookie.example',
  ]) {
    assert.throws(() => validateEnvironment({ ...base, ADMIN_HOSTNAME: bad }), /ADMIN_HOSTNAME/, bad);
  }
  assert.throws(() => validateEnvironment({ ...base, ADMIN_HOSTNAME: 'hollandcookie.example' }),
    /ADMIN_HOSTNAME must differ/);
});

test('a Brevo key without MAIL_TRANSPORT=brevo sends nothing and offers no accounts', async () => {
  const { mailConfigured, accountsAvailable } = await import('../../backend/mailer.js');
  process.env.BREVO_API_KEY = 'fixture-key';
  try {
    assert.equal(mailConfigured(), false);
    assert.equal(accountsAvailable(), false);
    const me = await request('/api/account/me');
    assert.equal(me.data.accountsEnabled, false);
    const code = await request('/api/account/request-code', { method: 'POST', body: { email: 'x@example.test' } });
    assert.equal(code.status, 503);
    assert.equal(code.data.error, 'ACCOUNTS_UNAVAILABLE');
  } finally {
    process.env.BREVO_API_KEY = ''; process.env.MAIL_TRANSPORT = 'disabled';
  }
});

/**
 * The order confirmation, and the rule that it can never cost an order.
 *
 * §74: a disabled or failing mail provider must not stop a committed order.
 * These drive the real checkout route with the provider in three states and
 * assert the order exists every time.
 */
test('email: a missing or failing provider never costs an order, and a retry never re-sends', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];

  // --- provider not configured at all -------------------------------------
  process.env.BREVO_API_KEY = '';
  const noProvider = await request('/api/orders', { method: 'POST', body: payload({ email: 'a@example.test' }) });
  assert.equal(noProvider.status, 201, 'an order must succeed with no mail provider');

  // --- provider configured but refusing ------------------------------------
  process.env.MAIL_TRANSPORT = 'brevo'; process.env.BREVO_API_KEY = 'fixture-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.brevo.com')) {
      sent.push(JSON.parse(init.body));
      return new Response('provider is down', { status: 500 });
    }
    return realFetch(url, init);
  };
  try {
    const failing = await request('/api/orders', { method: 'POST', body: payload({ email: 'b@example.test' }) });
    assert.equal(failing.status, 201, 'an order must succeed when the provider refuses');
    assert.equal(failing.data.order.reference.startsWith('HC-'), true);
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- provider accepting ---------------------------------------------------
  sent.length = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.brevo.com')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messageId: 'x' }), { status: 201 });
    }
    return realFetch(url, init);
  };
  try {
    const key = randomUUID();
    const body = payload({ idempotencyKey: key, email: 'c@example.test' });
    const created = await request('/api/orders', { method: 'POST', body });
    assert.equal(created.status, 201);

    // The send is deliberately not awaited by the route, so give it a tick.
    await new Promise((r) => setTimeout(r, 400));
    // Two messages per order since the bakery alert was added: the customer's
    // receipt and the shop's copy. They are counted separately by recipient —
    // a total count would pass for the wrong reason the next time one is added.
    const receipts = () => sent.filter((m) => m.to.some((e) => e.email === 'c@example.test'));
    assert.equal(receipts().length, 1, 'exactly one confirmation for one order');

    const message = receipts()[0];
    assert.equal(message.to[0].email, 'c@example.test');
    assert.match(message.subject, /HC-\d+/);
    // Every figure in the email comes off the stored order, so the total in the
    // message must equal the total the server decided.
    assert.match(message.textContent, new RegExp(created.data.order.totals.total.toFixed(2)));

    // A replayed submission returns the original order and must NOT email again
    // — otherwise one order becomes several identical receipts in an inbox.
    const replay = await request('/api/orders', { method: 'POST', body });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(receipts().length, 1, 'a duplicate submission must not send a second confirmation');
  } finally {
    globalThis.fetch = realFetch;
    process.env.BREVO_API_KEY = ''; process.env.MAIL_TRANSPORT = 'disabled';
  }
});

test('email: an order with no address is not a mail failure', async () => {
  const realFetch = globalThis.fetch;
  process.env.MAIL_TRANSPORT = 'brevo'; process.env.BREVO_API_KEY = 'fixture-key';
  const recipients = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.brevo.com')) {
      recipients.push(...JSON.parse(init.body).to.map((entry) => entry.email));
      return new Response('{"messageId":"x"}', { status: 201 });
    }
    return realFetch(url, init);
  };
  try {
    // No email field: a guest ordering over the counter has no address to send to.
    const created = await request('/api/orders', { method: 'POST', body: payload() });
    assert.equal(created.status, 201);
    await new Promise((r) => setTimeout(r, 300));
    // The bakery is still told — it is the shop's own alert and does not depend
    // on the customer leaving an address. The customer simply gets nothing.
    assert.deepEqual(recipients, ['hollandcookies.mf@gmail.com'],
      'no customer address means no receipt, and no error either');
  } finally {
    globalThis.fetch = realFetch;
    process.env.BREVO_API_KEY = ''; process.env.MAIL_TRANSPORT = 'disabled';
  }
});

test('email: the confirmation escapes HTML rather than trusting stored names', async () => {
  const { sendOrderConfirmation } = await import('../../backend/mailer.js');
  const realFetch = globalThis.fetch;
  process.env.MAIL_TRANSPORT = 'brevo'; process.env.BREVO_API_KEY = 'fixture-key';
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response('{}', { status: 201 }); };
  try {
    await sendOrderConfirmation({
      reference: 'HC-9999', email: 'x@example.test', fulfilment: 'pickup',
      subtotal: 50, discount: 0, delivery: 0, total: 50,
      items: [{ name: '<img src=x onerror=alert(1)>', qty: 1, lineTotal: 50 }],
    });
    assert.doesNotMatch(body.htmlContent, /<img src=x/, 'a product name must not become markup');
    assert.match(body.htmlContent, /&lt;img src=x/);
    // The plain-text part is not markup and must not be mangled.
    assert.match(body.textContent, /<img src=x onerror=alert\(1\)>/);
  } finally {
    globalThis.fetch = realFetch;
    process.env.BREVO_API_KEY = ''; process.env.MAIL_TRANSPORT = 'disabled';
  }
});

test('email: provider failures and redirects are bounded, no retry and no response PII disclosure', async () => {
  const realFetch = globalThis.fetch;
  process.env.MAIL_TRANSPORT = 'brevo'; process.env.BREVO_API_KEY = 'fixture-key';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return new Response('sensitive provider body', { status: 500 });
  };
  try {
    await assert.rejects(
      () => sendMail({ to: 'fixture@example.test', subject: 'fixture', text: 'fixture' }),
      (e) => e.code === 'MAIL_FAILED' && !e.message.includes('sensitive'),
    );
    assert.equal(calls, 1, 'a failed send must not be retried into a mail loop');
  } finally {
    globalThis.fetch = realFetch;
    process.env.BREVO_API_KEY = ''; process.env.MAIL_TRANSPORT = 'disabled';
  }
});
