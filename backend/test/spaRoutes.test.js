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
process.env.DATABASE_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';

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
  '/menu/gateaux',
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
