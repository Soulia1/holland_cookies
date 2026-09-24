/* global document */
/**
 * How long the storefront menu takes to show real prices, in a real browser.
 *
 *   npx firebase emulators:exec --only firestore --project holland-cookie-bench "node scripts/bench-storefront.mjs"
 *
 * Emulator only. Seeds the printed menu, starts the real server on the built
 * storefront (run `npm run build` first), and times navigation start → the
 * first price on /menu: cold (a first visit, nothing cached) and warm (a
 * returning visitor, scripts cached). LATENCY_MS adds round-trip delay.
 */

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-bench';
process.env.ADMIN_HOSTNAME = 'localhost';
process.env.ADMIN_KEY = 'bench-admin-key-0123456789abcdefghijklmn';
process.env.JWT_SECRET = 'bench-jwt-secret-0123456789abcdefghijklm';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.BREVO_API_KEY = '';

const LATENCY_MS = Number(process.env.LATENCY_MS || 0);
const RUNS = Number(process.env.RUNS || 5);

const { chromium } = await import('@playwright/test');
const fsdb = await import('../backend/firestore.js');
fsdb.get();
if (!/^emulator /.test(fsdb.currentTarget())) throw new Error('refusing to run against a real Firestore project');
const { seed } = await import('../backend/seed.js');
await seed();
await import('../backend/mirror.js').then((m) => m.syncAll(), () => {});

const { default: app } = await import('../backend/server.js');
const server = app.listen(3300, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const SHOP = 'http://127.0.0.1:3300';

const browser = await chromium.launch();

async function timed(page) {
  if (LATENCY_MS) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: LATENCY_MS, downloadThroughput: 20 * 1024 * 1024 / 8, uploadThroughput: 5 * 1024 * 1024 / 8,
    });
  }
  await page.goto(`${SHOP}/menu`, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.querySelector('.menu-item-price'), null, { timeout: 30000, polling: 'raf' });
  return Math.round(await page.evaluate(() => performance.now()));
}

const cold = [];
for (let i = 0; i < RUNS; i++) {
  const context = await browser.newContext();
  cold.push(await timed(await context.newPage()));
  await context.close();
}
const warm = [];
const context = await browser.newContext();
const page = await context.newPage();
await timed(page);
for (let i = 0; i < RUNS; i++) warm.push(await timed(page));

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
console.log(JSON.stringify({ latencyMs: LATENCY_MS, coldMs: cold, warmMs: warm, coldMedian: median(cold), warmMedian: median(warm) }));
await browser.close();
server.close();
await fsdb.close().catch(() => {});
process.exit(0);
