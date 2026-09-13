/**
 * Bundles: a choice bundle priced and recorded from the customer's picks, a
 * fixed bundle carrying its contents onto the order, and the catalogue rules
 * that keep a bundle from pointing at nothing. Emulator only, like every suite.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-bundles';
process.env.JWT_SECRET = 'bundle-suite-0123456789abcdef-0123456789';

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsdb from '../firestore.js';
import { createOrder } from '../orderTransaction.js';
import { orderPayload } from '../repo/orders.js';
import { deleteCategory, listProducts, lookupOf, publicProduct } from '../repo/catalogue.js';

test('runs against the emulator, never a real project', () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /);
});

const COLLECTIONS = ['orders', 'orderIdempotency', 'customers', 'products', 'categories', 'promos'];

async function wipe() {
  await Promise.all(COLLECTIONS.map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

async function seed() {
  await wipe();
  await fsdb.collections.categories().doc('boxes')
    .set({ name: 'Boxes', nameAr: '', sort: 0, visible: true });
  const product = (id, name, price, extra = {}) => fsdb.collections.products().doc(id).set({
    categoryId: 'boxes', name, nameAr: '', price, note: '',
    discountEnabled: false, discountType: 'percent', discountValue: 0,
    available: true, sort: 0, ...extra,
  });
  await Promise.all([
    product('vanilla', 'Vanilla', 50),
    product('lotus', 'Lotus', 60),
    product('pistachio', 'Pistachio', 70, { available: false }),
    product('pick-two', 'Pick Two', 100, {
      isBundle: true, bundleType: 'choice', components: [],
      groups: [{
        label: 'Cookies', labelAr: '', choose: 2, allowRepeats: true,
        options: [
          { productId: 'vanilla', surcharge: 0 },
          { productId: 'lotus', surcharge: 15 },
          { productId: 'pistachio', surcharge: 0 },
        ],
      }],
    }),
    product('duo', 'Duo', 90, {
      isBundle: true, bundleType: 'fixed', groups: [],
      components: [{ productId: 'vanilla', quantity: 1 }, { productId: 'lotus', quantity: 2 }],
    }),
    fsdb.orderCounterDoc().set({ value: 1000 }),
    fsdb.settingsDoc().set({ deliveryFee: 0, freeDeliveryOver: 0, acceptingOrders: true, areas: [] }),
  ]);
}

function payload(items) {
  return {
    idempotencyKey: `key-${Math.random()}`,
    items,
    firstName: 'Noha',
    phone: '01016521650',
    fulfilment: 'pickup',
  };
}

const countOrders = async () => (await fsdb.collections.orders().count().get()).data().count;

beforeEach(seed);
after(async () => { await wipe(); await fsdb.close(); });

test('a choice bundle is priced with each pick\'s surcharge and records the picks', async () => {
  const { order } = await createOrder(payload([{
    productId: 'pick-two', qty: 2,
    selections: [
      { group: 0, productId: 'vanilla', quantity: 1 },
      { group: 0, productId: 'lotus', quantity: 1 },
    ],
  }]));
  const [line] = order.items;
  assert.equal(line.unitPrice, 115);
  assert.equal(line.lineTotal, 230);
  assert.equal(order.total, 230);
  assert.deepEqual(
    line.selections.map((pick) => [pick.name, pick.quantity, pick.surcharge, pick.label]),
    [['Vanilla', 1, 0, 'Cookies'], ['Lotus', 1, 15, 'Cookies']],
  );
  assert.equal(orderPayload(order).items[0].selections.length, 2);
});

test('the same bundle with different picks is two lines', async () => {
  const { order } = await createOrder(payload([
    { productId: 'pick-two', qty: 1, selections: [{ group: 0, productId: 'vanilla', quantity: 2 }] },
    { productId: 'pick-two', qty: 1, selections: [{ group: 0, productId: 'lotus', quantity: 2 }] },
  ]));
  assert.equal(order.items.length, 2);
  assert.equal(order.subtotal, 100 + 130);
});

test('the wrong number of picks is refused and nothing is written', async () => {
  await assert.rejects(
    createOrder(payload([{
      productId: 'pick-two', qty: 1, selections: [{ group: 0, productId: 'vanilla', quantity: 1 }],
    }])),
    { code: 'INVALID_SELECTION' },
  );
  assert.equal(await countOrders(), 0);
});

test('a pick the bundle does not offer is refused', async () => {
  await assert.rejects(
    createOrder(payload([{
      productId: 'pick-two', qty: 1, selections: [{ group: 0, productId: 'duo', quantity: 2 }],
    }])),
    { code: 'INVALID_SELECTION' },
  );
});

test('a sold-out pick is refused', async () => {
  await assert.rejects(
    createOrder(payload([{
      productId: 'pick-two', qty: 1, selections: [{ group: 0, productId: 'pistachio', quantity: 2 }],
    }])),
    { code: 'PRODUCT_UNAVAILABLE' },
  );
});

test('choices sent for a plain product are refused', async () => {
  await assert.rejects(
    createOrder(payload([{
      productId: 'vanilla', qty: 1, selections: [{ group: 0, productId: 'lotus', quantity: 1 }],
    }])),
    { code: 'INVALID_SELECTION' },
  );
});

test('a fixed bundle carries its contents onto the line', async () => {
  const { order } = await createOrder(payload([{ productId: 'duo', qty: 3 }]));
  const [line] = order.items;
  assert.equal(line.unitPrice, 90);
  assert.deepEqual(line.components.map((c) => [c.name, c.quantity]), [['Vanilla', 1], ['Lotus', 2]]);
  assert.equal(orderPayload(order).items[0].components.length, 2);
});

test('the public menu names a bundle\'s options and says which are sold out', async () => {
  const products = await listProducts();
  const view = publicProduct(products.find((p) => p.id === 'pick-two'), lookupOf(products));
  assert.equal(view.bundleType, 'choice');
  assert.equal(view.groups[0].options[1].name, 'Lotus');
  assert.equal(view.groups[0].options[2].available, false);
  const plain = publicProduct(products.find((p) => p.id === 'vanilla'), lookupOf(products));
  assert.equal(plain.isBundle, undefined);
});

test('a category holding products is only deleted with withProducts', async () => {
  assert.equal((await deleteCategory('boxes')).blocked, true);
  const result = await deleteCategory('boxes', { withProducts: true });
  assert.equal(result.deletedProducts, 5);
  assert.equal((await fsdb.collections.categories().doc('boxes').get()).exists, false);
});
