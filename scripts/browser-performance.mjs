/* global window -- referenced inside page.evaluate callbacks, which run in the browser */
import fs from 'node:fs';
import { chromium } from '@playwright/test';
process.env.NODE_ENV = 'test';
// The emulator, always. backend/firestore.js refuses a real project outside
// production, so this cannot silently measure against live data.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-perf';
process.env.ADMIN_KEY = 'browser-fixture-only-0123456789abcdefgh';
process.env.JWT_SECRET = 'browser-session-only-0123456789abcdefgh';
process.env.BREVO_API_KEY = ''; process.env.DISABLE_ADMIN_AUTH = 'false';
const { default: app } = await import('../backend/server.js');
const { seed } = await import('../backend/seed.js');
const db = await import('../backend/firestore.js');
if (!String((db.get(), db.currentTarget())).startsWith('emulator')) throw new Error('Unsafe datastore');
await seed();
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.addInitScript(() => {
      window.__metrics = {lcp: 0, cls: 0, interactions: []};
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__metrics.lcp = e.startTime; }).observe({type: 'largest-contentful-paint', buffered: true});
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__metrics.cls += e.value; }).observe({type: 'layout-shift', buffered: true});
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.interactionId) window.__metrics.interactions.push(e.duration); }).observe({type: 'event', buffered: true, durationThreshold: 16});
    });
    await page.goto(base, {waitUntil: 'networkidle'});
    await page.locator('#boot-splash').waitFor({state:'detached', timeout:15000});
    await page.locator('a[href="/menu"]').first().click();
    await page.waitForTimeout(300);
    runs.push(await page.evaluate(() => ({...window.__metrics, ttfb: performance.getEntriesByType('navigation')[0].responseStart, jsBytes: performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.js')).reduce((n,e)=>n+e.decodedBodySize,0)})));
    await page.close();
  }
  const report = {label:process.argv[2] || 'local', browser:'Chromium', scenario:'Desktop localhost, three cold contexts; external fonts blocked identically; homepage to menu. Lab observations, not field CWV/INP.', runs};
  fs.mkdirSync('docs/evidence',{recursive:true});
  fs.writeFileSync(`docs/evidence/${report.label}-browser.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {await browser?.close(); await new Promise(resolve=>server.close(resolve));await db.close().catch(() => {});}
