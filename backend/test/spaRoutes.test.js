/**
 * The SPA fallback.
 *
 * The client router owns more addresses than the server serves, and the two
 * lists drifting apart is invisible from inside the app: every in-app link is a
 * pushState, so clicking through to `/menu/cookies` works no matter what the
 * server would have said about it. It is only a *direct* hit — a refresh, a
 * bookmark, a shared link, a crawler — that asks the server, and that is the
 * one path no amount of clicking around ever exercises.
 *
 * So these tests ask the server directly, for every address the client can put
 * in the URL bar.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-sparoutes';
process.env.JWT_SECRET = 'spa-routes-suite-0123456789abcdefghij';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported dynamically, after the assignments above. A static import is
// hoisted, and server.js boots itself at import time unless NODE_ENV is
// already 'test' — so a plain import would start a real listener on the real
// database before the first line of this file ever ran.
const { default: app } = await import('../server.js');

/** Start on an ephemeral port; return the origin and a way to stop. */
function serve() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Every address the client router resolves to a page.
 *
 * The menu ones are the point. `/menu/<group>` is what every "Menu" link on the
 * site now produces, and `/menu/<category>` is the older per-category address
 * that App.tsx still accepts and redirects.
 */
const CLIENT_ROUTES = [
  '/',
  '/menu',
  '/menu/cookies',
  '/menu/desserts',
  '/menu/drinks',
  '/menu/cookie-pans',
  '/menu/molten-cakes',
  '/checkout',
  '/account',
  '/track',
];

test('every client route serves the storefront shell on a direct hit', async () => {
  const { origin, close } = await serve();
  try {
    for (const route of CLIENT_ROUTES) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, `${route} did not serve the app shell`);
      assert.match(
        response.headers.get('content-type') ?? '',
        /text\/html/,
        `${route} served something other than HTML`,
      );
    }
  } finally {
    await close();
  }
});

test('a menu address that names nothing is still the app, not a 404', async () => {
  // The client decides what an unknown slug means — App.tsx redirects it to a
  // real group. That decision cannot happen if the server refuses to hand the
  // app over in the first place.
  const { origin, close } = await serve();
  try {
    const response = await fetch(`${origin}/menu/not-a-real-category`);
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

// ------------------------------------------------------ the admin host ----

const ADMIN_HOST = 'admin.localhost';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARD_ROUTES = ['/', '/orders', '/orders/HC-1001', '/menu', '/users', '/promos', '/settings'];

/** fetch() will not send a Host of our choosing, so this goes through node:http. */
function get(origin, route, host) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    http.get({ hostname, port, path: route, headers: { host: `${host}:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

const isDashboard = (html) => /<title>[^<]*Dashboard<\/title>/.test(html);
const firstScript = (file) => /<script[^>]+src="([^"]+)"/.exec(fs.readFileSync(path.join(root, file), 'utf8'))[1];

test('every dashboard route serves the dashboard shell on the admin host', async () => {
  const { origin, close } = await serve();
  try {
    for (const route of DASHBOARD_ROUTES) {
      const res = await get(origin, route, ADMIN_HOST);
      assert.equal(res.status, 200, `${route} on the admin host`);
      assert.ok(isDashboard(res.body), `${route} on the admin host was not the dashboard`);
    }
  } finally {
    await close();
  }
});

test('the shop host never serves the dashboard, and the admin host never serves the shop', async () => {
  const { origin, close } = await serve();
  try {
    const shopHome = await get(origin, '/', '127.0.0.1');
    assert.equal(shopHome.status, 200);
    assert.ok(!isDashboard(shopHome.body), '/ on the shop host was the dashboard');

    const menu = await get(origin, '/menu', '127.0.0.1');
    assert.ok(!isDashboard(menu.body), '/menu on the shop host must be the shop menu');

    for (const route of ['/orders', '/users', '/promos', '/settings']) {
      assert.equal((await get(origin, route, '127.0.0.1')).status, 404, `${route} on the shop host`);
    }
    for (const route of ['/checkout', '/account', '/track', '/menu/cookies']) {
      assert.equal((await get(origin, route, ADMIN_HOST)).status, 404, `${route} on the admin host`);
    }
  } finally {
    await close();
  }
});

test('each bundle is only downloadable from its own host', async () => {
  const { origin, close } = await serve();
  try {
    const dashboardScript = firstScript('dist-dashboard/index.html');
    const shopScript = firstScript('dist/index.html');
    assert.equal((await get(origin, dashboardScript, ADMIN_HOST)).status, 200);
    assert.equal((await get(origin, dashboardScript, '127.0.0.1')).status, 404,
      'a customer must never be able to download the admin bundle');
    assert.equal((await get(origin, shopScript, '127.0.0.1')).status, 200);
    assert.equal((await get(origin, shopScript, ADMIN_HOST)).status, 404);
  } finally {
    await close();
  }
});

test('shared images and the API answer on both hosts', async () => {
  const { origin, close } = await serve();
  try {
    for (const host of [ADMIN_HOST, '127.0.0.1']) {
      assert.equal((await get(origin, '/img/logo.webp', host)).status, 200, `logo on ${host}`);
      assert.equal((await get(origin, '/img/menu/matilda.webp', host)).status, 200, `menu photo on ${host}`);
      assert.equal((await get(origin, '/api/health', host)).status, 200, `API on ${host}`);
    }
  } finally {
    await close();
  }
});

test('old /dashboard addresses on the shop host move permanently to the admin host', async () => {
  const { origin, close } = await serve();
  const { port } = new URL(origin);
  try {
    for (const [from, to] of [
      ['/dashboard', '/'], ['/dashboard/', '/'], ['/dashboard/orders', '/orders'],
      ['/dashboard/orders/HC-1001', '/orders/HC-1001'], ['/dashboard/orders?q=0101', '/orders?q=0101'],
      ['/dashboard?x=1', '/?x=1'],
    ]) {
      const res = await get(origin, from, '127.0.0.1');
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.location, `http://${ADMIN_HOST}:${port}${to}`, from);
    }
    // Not a prefix match on the word: /dashboards is just an unknown page.
    assert.equal((await get(origin, '/dashboards', '127.0.0.1')).status, 404);
    // The redirect keeps the scheme and host it was given; the path cannot change the host.
    const sneaky = await get(origin, '/dashboard//evil.example', '127.0.0.1');
    assert.equal(new URL(sneaky.headers.location).host, `${ADMIN_HOST}:${port}`);
  } finally {
    await close();
  }
});

test('the fallback does not swallow the API or unknown top-level paths', async () => {
  const { origin, close } = await serve();
  try {
    const api = await fetch(`${origin}/api/nope`);
    assert.equal(api.status, 404, 'an unknown API endpoint must stay a JSON 404');
    assert.match(api.headers.get('content-type') ?? '', /application\/json/);

    const stray = await fetch(`${origin}/not-a-page`);
    assert.equal(stray.status, 404, 'the fallback must not answer for every path');
  } finally {
    await close();
  }
});
