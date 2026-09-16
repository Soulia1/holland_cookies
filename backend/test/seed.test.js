/**
 * The seed, run again over a shop the dashboard has been editing.
 *
 * `npm run seed:prod` is how a live database gets the printed menu, and it is
 * safe to run twice only if it never undoes what an admin did since: a product
 * they deleted, a product they moved, and the shop's own settings.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-seed';

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsdb from '../firestore.js';
import { seed, readMenu } from '../seed.js';

async function wipe() {
  await Promise.all(['products', 'categories', 'settings', 'counters'].map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

beforeEach(async () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /, 'refusing to run against a real Firestore project');
  await wipe();
});

after(async () => {
  await wipe();
  await fsdb.close().catch(() => {});
});

test('an empty shop gets the whole printed menu, its settings and a counter', async () => {
  const menu = await readMenu();
  const expected = menu.reduce((sum, category) => sum + category.items.length, 0);
  const result = await seed();
  assert.equal(result.products, expected);
  assert.equal((await fsdb.collections.products().count().get()).data().count, expected);
  assert.equal((await fsdb.settingsDoc().get()).data().deliveryFee, 40);
  assert.equal((await fsdb.orderCounterDoc().get()).data().value, 1000);
});

test('seeding again leaves deletions, moves and the shop settings as the admin left them', async () => {
  await seed();
  const menu = await readMenu();
  const [first, second] = menu;
  const deleted = first.items[0].id;
  const moved = first.items[1].id;

  await fsdb.collections.products().doc(deleted).delete();
  await fsdb.collections.categories().doc(second.id).delete();
  await fsdb.collections.products().doc(moved).update({ categoryId: second.id === first.id ? 'elsewhere' : menu[2].id });
  const movedTo = (await fsdb.collections.products().doc(moved).get()).data().categoryId;
  await fsdb.settingsDoc().set({ deliveryFee: 0, freeDeliveryOver: 0, acceptingOrders: false, areas: [] });

  await seed();

  assert.equal((await fsdb.collections.products().doc(deleted).get()).exists, false, 'a deleted product stays deleted');
  assert.equal((await fsdb.collections.categories().doc(second.id).get()).exists, false, 'a deleted category stays deleted');
  assert.equal((await fsdb.collections.products().doc(moved).get()).data().categoryId, movedTo, 'a moved product stays moved');
  assert.deepEqual(
    (await fsdb.settingsDoc().get()).data(),
    { deliveryFee: 0, freeDeliveryOver: 0, acceptingOrders: false, areas: [] },
    'free delivery and a closed shop are the admin\'s choice, not a blank to fill',
  );
});

test('--force puts the printed menu back, deleted products included', async () => {
  await seed();
  const [first] = await readMenu();
  await fsdb.collections.products().doc(first.items[0].id).delete();
  await seed({ force: true });
  assert.equal((await fsdb.collections.products().doc(first.items[0].id).get()).exists, true);
});
