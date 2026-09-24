/* global document, HTMLInputElement, requestAnimationFrame, indexedDB */
/**
 * How fast the dashboard's order search and reload really are, in a real
 * browser, over a realistic order book.
 *
 *   npx firebase emulators:exec --only firestore --project holland-cookie-bench "node scripts/bench-dashboard.mjs"
 *
 * Emulator only (pinned below). Seeds ORDERS orders, starts the real server,
 * signs in to the real dashboard in Chromium, then measures, inside the page:
 *
 *   - keystroke → the table showing that query's answer, for each letter typed;
 *   - the same search answered by the server (`GET /api/orders?q=`), the way
 *     every keystroke was answered before the order book;
 *   - reload → the first order row on screen.
 *
 * LATENCY_MS adds that much round-trip delay to every request (Chrome network
 * emulation), to show what the numbers look like from Cairo rather than from
 * the same machine.
 */

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-bench';
process.env.PORT = '3300';
process.env.ADMIN_HOSTNAME = 'localhost';
process.env.ADMIN_KEY = 'bench-admin-key-0123456789abcdefghijklmn';
process.env.JWT_SECRET = 'bench-jwt-secret-0123456789abcdefghijklm';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.BREVO_API_KEY = '';

const ORDERS = Number(process.env.ORDERS || 2500);
const LATENCY_MS = Number(process.env.LATENCY_MS || 0);

const { chromium } = await import('@playwright/test');
const fsdb = await import('../backend/firestore.js');
const { Timestamp } = await import('firebase-admin/firestore');
// Absent from builds before the read mirror; those read Firestore directly.
const syncAll = await import('../backend/mirror.js').then((m) => m.syncAll, () => async () => {});

fsdb.get();
if (!/^emulator /.test(fsdb.currentTarget())) throw new Error('refusing to run against a real Firestore project');

// ------------------------------------------------------------------ seed ---
const names = ['Noha Ibrahim', 'Ahmed Salem', 'أحمد سالم', 'Dina Kamal', 'Omar Farouk', 'Mariam Adel', 'Youssef Hany', 'Salma Tarek', 'Karim Nabil', 'Laila Mostafa'];
const products = [['plain', 'Plain Cookie', 100], ['lotus', 'Lotus Cookie Pan', 180], ['nutella', 'Nutella Scoop', 150]];
const statuses = ['ordered', 'confirmed', 'baking', 'in_transit', 'completed', 'cancelled'];
const existing = await fsdb.collections.orders().limit(1).get();
if (existing.empty) {
  await fsdb.collections.categories().doc('cookies').set({ name: 'Cookies', nameAr: '', sort: 0, visible: true, group: 'cookies' });
  await fsdb.settingsDoc().set({ deliveryFee: 40, freeDeliveryOver: 0, acceptingOrders: true, areas: [{ id: 'nasr-city', name: 'Nasr City', nameAr: '' }] });
  for (let start = 0; start < ORDERS; start += 400) {
    const batch = fsdb.get().batch();
    for (let i = start; i < Math.min(ORDERS, start + 400); i++) {
      const [firstName, lastName = ''] = names[i % names.length].split(' ');
      const [productId, name, unitPrice] = products[i % products.length];
      const qty = 1 + (i % 3);
      const delivery = i % 2 ? 40 : 0;
      const at = Timestamp.fromMillis(Date.now() - (ORDERS - i) * 3_600_000);
      const reference = `HC-${1001 + i}`;
      batch.set(fsdb.collections.orders().doc(reference), {
        reference, seq: 1001 + i, customerPhone: `+2010${String(10000000 + i).slice(-8)}`, profileId: null,
        firstName, lastName, phone: `+2010${String(10000000 + i).slice(-8)}`, email: `c${i}@example.com`,
        fulfilment: delivery ? 'delivery' : 'pickup', area: delivery ? 'nasr-city' : '',
        address: delivery ? `${i} Makram Ebeid Street` : '', building: '', floor: '', apartment: '', landmark: '', notes: '',
        lang: 'en', subtotal: unitPrice * qty, discount: 0, delivery, total: unitPrice * qty + delivery, promoCode: null,
        status: statuses[i % statuses.length], paymentMethod: 'cash', paymentStatus: 'unpaid', paymentRef: '',
        items: [{ productId, name, unitPrice, qty, lineTotal: unitPrice * qty }],
        history: [{ status: 'ordered', note: 'Order placed', at }], createdAt: at, updatedAt: at,
      });
    }
    await batch.commit();
  }
  await fsdb.orderCounterDoc().set({ value: 1000 + ORDERS });
}
await syncAll();

// ---------------------------------------------------------------- server ---
const { default: app } = await import('../backend/server.js');
const server = app.listen(3300, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const DASH = 'http://localhost:3300';

const browser = await chromium.launch();
const page = await browser.newPage();
if (LATENCY_MS) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: LATENCY_MS, downloadThroughput: 20 * 1024 * 1024 / 8, uploadThroughput: 5 * 1024 * 1024 / 8,
  });
}

page.setDefaultTimeout(20000);
await page.goto(`${DASH}/orders`);
await page.getByLabel(/admin key/i).fill(process.env.ADMIN_KEY);
await page.getByRole('button', { name: /unlock|sign in|continue/i }).click();
await page.locator('tbody tr').first().waitFor();
// Let the order book arrive, then settle.
await page.waitForFunction(() => /of \d+ ·/.test(document.querySelector('.adm-sub')?.textContent ?? ''));
await page.waitForTimeout(1500);

/** Type `query` one letter at a time; for each, time until the count line names it. */
async function typeTimed(query) {
  return page.evaluate(async (q) => {
    const input = document.querySelector('input[placeholder^="Search orders, customers"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const times = [];
    for (let i = 1; i <= q.length; i++) {
      const typed = q.slice(0, i);
      const started = performance.now();
      setValue.call(input, typed);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => {
        const check = () => {
          const line = document.querySelector('.adm-sub')?.textContent ?? '';
          if (line.includes(`for “${typed}”`) && !document.querySelector('.animate-spin')) resolve();
          else if (performance.now() - started > 10000) { times.push(-1); resolve(); }
          else requestAnimationFrame(check);
        };
        check();
      });
      times.push(Math.round(performance.now() - started));
    }
    return times;
  }, query);
}

async function clearSearch() {
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.waitForTimeout(300);
}

/** The same query answered by the server, as every keystroke used to be. */
async function serverTimed(query) {
  return page.evaluate(async (q) => {
    const times = [];
    for (let i = 1; i <= q.length; i++) {
      const started = performance.now();
      const response = await fetch(`/api/orders?page=1&perPage=25&q=${encodeURIComponent(q.slice(0, i))}`, {
        credentials: 'include', headers: { 'X-Requested-With': 'Holland' },
      });
      await response.json();
      times.push(Math.round(performance.now() - started));
    }
    return times;
  }, query);
}

const step = (what) => console.error(`[bench] ${what}`);
step("signed in, book loaded");
const results = {};
for (const query of ['noha', 'أحمد', '0101000', 'lotus']) {
  step(`query ${query}`);
  results[query] = { browser: await typeTimed(query), server: await serverTimed(query) };
  await clearSearch();
}

// Reload: navigation start → the first order row on screen.
const reloads = [];
for (let i = 0; i < 3; i++) {
  await page.reload();
  await page.locator('tbody tr').first().waitFor();
  reloads.push(Math.round(await page.evaluate(() => performance.now())));
}

const book = await page.evaluate(async () => {
  const started = performance.now();
  const response = await fetch('/api/orders/book', { credentials: 'include', headers: { 'X-Requested-With': 'Holland' } });
  if (!response.ok) return null; // a build without the order book
  const tag = response.headers.get('ETag');
  const body = await response.text();
  const full = Math.round(performance.now() - started);
  const again = performance.now();
  const revalidated = await fetch('/api/orders/book', { credentials: 'include', headers: { 'X-Requested-With': 'Holland', 'If-None-Match': tag } });
  return { orders: JSON.parse(body).orders.length, bytes: body.length, fullMs: full, revalidateStatus: revalidated.status, revalidateMs: Math.round(performance.now() - again) };
});

// SHOT=path: a screenshot of a live search, and proof that signing out empties
// the copy of the order book saved on this device.
let saved = null;
if (process.env.SHOT) {
  const savedKeys = () => page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('holland-dashboard');
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('reads')) return resolve([]);
      const keys = db.transaction('reads').objectStore('reads').getAllKeys();
      keys.onsuccess = () => resolve(keys.result.map(String));
    };
    open.onerror = () => resolve(null);
  }));
  await page.locator('input[placeholder^="Search orders, customers"]').fill('noha');
  await page.waitForTimeout(2500); // past the idle flush
  await page.screenshot({ path: process.env.SHOT });
  const beforeSignOut = await savedKeys();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByPlaceholder('Admin key').waitFor();
  await page.waitForTimeout(500);
  saved = { beforeSignOut, afterSignOut: await savedKeys() };
}

console.log(JSON.stringify({ orders: ORDERS, latencyMs: LATENCY_MS, search: results, reloadToFirstRowMs: reloads, book, saved }, null, 2));
await browser.close();
server.close();
await fsdb.close().catch(() => {});
process.exit(0);
