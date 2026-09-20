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

/*
 * The Special Edition rows are the one part of the menu file that is not a
 * transcription, and the only one carrying options that change the price. A
 * seed that dropped either — the Arabic name or the extra — would put a shop
 * live with a size that costs the same as the small one.
 */
test('the Special Edition rows arrive with their Arabic names and their option prices', async () => {
  await seed();
  const large = (await fsdb.collections.products().doc('special-dubai-chocolate-cookie').get()).data();
  assert.equal(large.categoryId, 'special-edition-cookies');
  assert.equal(large.nameAr, 'كوكي شوكولاتة دبي');
  assert.deepEqual(large.choices, [
    { name: 'Regular', nameAr: 'عادي', priceDelta: 0 },
    { name: 'Large', nameAr: 'كبير', priceDelta: 60 },
  ]);

  const category = (await fsdb.collections.categories().doc('special-edition-cookies').get()).data();
  assert.equal(category.name, 'Special Edition Cookies');
  assert.equal(category.visible, true);
});

test('a new shop starts with the Cairo and Giza delivery areas', async () => {
  await seed();
  const { areas } = (await fsdb.settingsDoc().get()).data();
  const ids = areas.map((area) => area.id);
  assert.ok(ids.includes('nasr-city') && ids.includes('haram'), 'both governorates are offered');
  assert.deepEqual(
    [...new Set(areas.map((area) => area.city))],
    ['Cairo', 'Giza'],
    'every area names the governorate checkout groups it under',
  );
});

/*
 * The flag that puts a new category onto a shop that is already live, which is
 * the only safe way Special Edition reaches production: --force would drag
 * every dashboard-edited name and price back to the menu file's version with
 * it.
 */
test('--add-new adds the rows the shop does not have and changes nothing it does', async () => {
  await seed();
  const [first] = await readMenu();
  const kept = first.items[0].id;
  await fsdb.collections.products().doc(kept).update({ name: 'Renamed in the dashboard', price: 999 });
  await fsdb.collections.products().doc('special-dubai-chocolate-cookie').delete();
  await fsdb.collections.categories().doc('special-edition-cookies').delete();

  const result = await seed({ addNew: true });
  assert.equal(result.skipped.length, 0);

  const restored = await fsdb.collections.products().doc('special-dubai-chocolate-cookie').get();
  assert.equal(restored.exists, true, 'the missing row is created');
  assert.equal(restored.data().choices.at(-1).priceDelta, 60);
  assert.equal((await fsdb.collections.categories().doc('special-edition-cookies').get()).exists, true);

  const untouched = (await fsdb.collections.products().doc(kept).get()).data();
  assert.equal(untouched.name, 'Renamed in the dashboard', 'an edited row is left alone');
  assert.equal(untouched.price, 999);
});

test('--force puts the printed menu back, deleted products included', async () => {
  await seed();
  const [first] = await readMenu();
  await fsdb.collections.products().doc(first.items[0].id).delete();
  await seed({ force: true });
  assert.equal((await fsdb.collections.products().doc(first.items[0].id).get()).exists, true);
});
