/* global window, document -- referenced inside page.evaluate callbacks, which run in the browser */
/**
 * Smoke test against the running dev stack.
 *
 *     npm run dev          (in one terminal)
 *     npm run verify       (in another)
 *
 * Drives a real browser through the whole customer journey against whatever
 * `npm run dev` just started — menu from Firestore, add to cart, checkout,
 * order placed — then checks with the admin API that the order really landed
 * and that an anonymous caller cannot read it.
 *
 * The e2e suite covers all of this more thoroughly against its own servers.
 * This exists for the different question a person actually asks: "is the thing
 * I just started working?" It answers in about twenty seconds.
 */
import { chromium, request } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

// --- storefront -------------------------------------------------------------
await page.goto(`${BASE}/menu`, { waitUntil: 'load' });
await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 25000 });

const sections = await page.locator('.menu-section').count();
check('menu renders sections from Firestore', sections > 0, `${sections} sections`);

const firstProduct = await page.locator('.menu-row-name, .menu-item-name').first().innerText().catch(() => '');
check('products render', firstProduct.length > 0, firstProduct.slice(0, 40));

// --- cart --------------------------------------------------------------------
await page.getByRole('button', { name: /Add .* to cart/ }).first().click();
await page.locator('.cart-badge').waitFor({ timeout: 5000 });
check('add to cart works', (await page.locator('.cart-badge').innerText()) === '1');

// --- checkout ----------------------------------------------------------------
await page.evaluate(() => {
  const r = document.documentElement; const p = r.style.scrollBehavior;
  r.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); r.style.scrollBehavior = p;
});
await page.getByRole('button', { name: 'Open cart' }).click();
await page.getByRole('button', { name: 'Checkout' }).click();
await page.waitForURL(/\/checkout$/, { timeout: 10000 });
await page.locator('.ed-srow.total').waitFor({ timeout: 10000 });
// The page prices the cart against the live catalogue before it draws a figure,
// so poll until it is no longer the placeholder zero rather than reading the
// first frame — which is what produced a spurious "0.00 EGP" here once.
await page.waitForFunction(
  () => !/^0\.00/.test(document.querySelector('.ed-srow.total span:last-child')?.textContent ?? '0.00'),
  null, { timeout: 10000 },
);
const total = await page.locator('.ed-srow.total span:last-child').innerText();
check('checkout prices from the catalogue', /\d/.test(total), total);

await page.locator('#firstName').fill('Verification');
await page.locator('#lastName').fill('Run');
await page.locator('#phone').fill('01016521650');
await page.locator('#email').fill('verify@example.test');
await page.locator('#area').selectOption({ index: 1 });
await page.locator('#address').fill('1 Test Street');
await page.getByRole('button', { name: 'Place order' }).click();

await page.locator('.rcpt-barcode-text').waitFor({ timeout: 20000 });
const reference = await page.locator('.rcpt-barcode-text').innerText();
check('order placed, reference issued', /^HC-\d+$/.test(reference), reference);
check('cart emptied only after the order existed', (await page.locator('.cart-badge').count()) === 0);
check('no console errors on the whole journey', consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(' | '));

// --- the order really is in Firestore, via the admin API ---------------------
const api = await request.newContext({ baseURL: 'http://127.0.0.1:3000' });
const login = await api.post('/api/admin/session', {
  headers: { 'x-requested-with': 'Holland', 'content-type': 'application/json' },
  data: { key: 'local-development-only-admin-key-example' },
});
check('admin sign-in', login.status() === 200);

const list = await api.get('/api/orders', { headers: { 'x-requested-with': 'Holland' } });
const body = await list.json();
check('the order is in the dashboard list', body.orders?.some((o) => o.reference === reference),
  `${body.total} order(s)`);

const found = body.orders.find((o) => o.reference === reference);
check('dashboard total equals the receipt total',
  found && total.startsWith(found.totals.total.toFixed(2)),
  `dashboard ${found?.totals?.total} vs receipt ${total}`);

// --- anonymous cannot read it ------------------------------------------------
const anon = await request.newContext({ baseURL: 'http://127.0.0.1:3000' });
const denied = await anon.get('/api/orders', { headers: { 'x-requested-with': 'Holland' } });
check('anonymous is denied the order list', denied.status() === 401);

await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
