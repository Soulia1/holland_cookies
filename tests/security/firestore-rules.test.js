/**
 * Firestore security rules.
 *
 * The rules for this project deny everything to everyone, because no client ever
 * talks to Firestore — the storefront and the dashboard both speak only to the
 * Express API, and the server reaches Firestore with the Admin SDK, which
 * bypasses rules entirely. See the long comment at the top of firestore.rules.
 *
 * That makes this suite short but not pointless. It is the thing that would
 * catch somebody "temporarily" opening a collection during debugging and
 * shipping it, which is the single most common way a Firebase project leaks its
 * whole database. Every collection in the schema is enumerated explicitly rather
 * than spot-checked, so a new collection added without a rule is a visible gap
 * rather than an assumed one.
 *
 * §65 of the launch brief: never accept only successful-case tests. There are no
 * successful cases here — every assertion is a denial — so the risk is the
 * mirror image: a suite that would pass even if the rules file were empty or the
 * emulator were ignoring it. The first test guards against exactly that.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs,
} from 'firebase/firestore';

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [host, port] = HOST.split(':');

let env;

/** Every collection the application writes. Kept in step with firestore.js. */
const COLLECTIONS = [
  'categories', 'products', 'customers', 'orders', 'promos', 'settings',
  'profiles', 'otpCodes', 'sessions', 'rateLimits', 'auditEvents', 'counters',
  'orderIdempotency', 'productImages',
];

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'holland-cookie-rules',
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

after(async () => { await env?.cleanup(); });

/**
 * The meta-test.
 *
 * A deny-everything suite passes trivially if the rules were never loaded, or if
 * the harness is misconfigured and every operation fails for an unrelated
 * reason. This proves the emulator is genuinely evaluating rules by writing with
 * the rules *disabled* — which must succeed — before any denial is asserted.
 * If this fails, every other test in the file is meaningless.
 */
test('the harness is actually evaluating rules', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await assertSucceeds(setDoc(doc(db, 'products/rules-probe'), { name: 'probe' }));
    const read = await getDoc(doc(db, 'products/rules-probe'));
    assert.equal(read.exists(), true, 'a rules-disabled write must land');
  });
});

test('an unauthenticated client can read nothing, anywhere', async () => {
  const db = env.unauthenticatedContext().firestore();
  for (const name of COLLECTIONS) {
    await assertFails(getDoc(doc(db, `${name}/any-document`)));
    await assertFails(getDocs(collection(db, name)));
  }
});

test('an unauthenticated client can write nothing, anywhere', async () => {
  const db = env.unauthenticatedContext().firestore();
  for (const name of COLLECTIONS) {
    await assertFails(setDoc(doc(db, `${name}/any-document`), { injected: true }));
    await assertFails(deleteDoc(doc(db, `${name}/any-document`)));
  }
});

/**
 * A signed-in Firebase user is not privileged either.
 *
 * This is the case that catches the most dangerous plausible mistake: a rule of
 * `allow read: if request.auth != null`, which reads as "only logged-in users"
 * and actually means "anybody who can create an account". Holland has no
 * Firebase Auth users at all — customer accounts are our own OTP sessions — so
 * an authenticated Firebase identity must be worth exactly nothing here.
 */
test('an authenticated Firebase user is no more privileged than anonymous', async () => {
  const db = env.authenticatedContext('some-user-uid').firestore();
  for (const name of COLLECTIONS) {
    await assertFails(getDoc(doc(db, `${name}/any-document`)));
    await assertFails(setDoc(doc(db, `${name}/any-document`), { injected: true }));
  }
});

test('a user claiming to be an admin is still denied', async () => {
  // Custom claims are set by us and we set none — but a rule that trusted a
  // client-supplied token claim would be a total bypass, so it is tested.
  const db = env.authenticatedContext('attacker', { admin: true, role: 'admin' }).firestore();
  for (const name of ['orders', 'customers', 'auditEvents', 'settings', 'sessions']) {
    await assertFails(getDocs(collection(db, name)));
    await assertFails(setDoc(doc(db, `${name}/forged`), { injected: true }));
  }
});

test('the most sensitive collections are unreadable in particular', async () => {
  // Belt and braces on the ones whose exposure would be worst: session tokens,
  // one-time codes, customer PII, the order book and the audit trail.
  const db = env.unauthenticatedContext().firestore();
  for (const name of ['sessions', 'otpCodes', 'customers', 'orders', 'profiles', 'auditEvents']) {
    await assertFails(getDocs(collection(db, name)));
  }
});

test('an undeclared collection is denied too, so a new one is safe by default', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'somethingAddedLater/x')));
  await assertFails(setDoc(doc(db, 'somethingAddedLater/x'), { injected: true }));
  // Nested paths are covered by the {document=**} recursive wildcard.
  await assertFails(getDoc(doc(db, 'orders/HC-1001/secretSubcollection/x')));
});
