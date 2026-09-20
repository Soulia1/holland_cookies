/**
 * Categories created in the dashboard, as the storefront receives them.
 *
 * A category carries the menu page it is shown on (`group`). The storefront
 * places printed categories from its own plan; one created in the dashboard is
 * in no plan, so before `group` existed it had nowhere to appear and every
 * product filed under it was invisible to customers. Emulator only.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-categories';

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsdb from '../firestore.js';
import { createCategory, createProduct, menu, updateCategory } from '../repo/catalogue.js';
import { MENU_GROUP_IDS } from '../routes/menu.js';

test('runs against the emulator, never a real project', () => {
  fsdb.get();
  assert.match(fsdb.currentTarget(), /^emulator /);
});

async function wipe() {
  await Promise.all(['products', 'categories'].map(async (name) => {
    const snapshot = await fsdb.get().collection(name).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }));
}

beforeEach(wipe);
after(wipe);

// Read out of the storefront's own menu module rather than repeated here: the
// two lists exist to be the same, and a literal in this file would only ever
// catch the edit that remembered to update it.
test('the menu sections match the storefront pages', async () => {
  const { readMenuGroupIds } = await import('../seed.js');
  assert.deepEqual([...MENU_GROUP_IDS], await readMenuGroupIds());
});

test('a new category keeps its section, and the public menu carries it with its products', async () => {
  const created = await createCategory({ id: 'seasonal', name: 'Seasonal', nameAr: 'موسمي', group: 'desserts' });
  assert.equal(created.duplicate, false);
  await createProduct({
    id: 'pistachio-crunch', categoryId: 'seasonal', name: 'Pistachio Crunch', price: 85,
    description: 'Baked today.', descriptionAr: 'مخبوز اليوم.',
    image: '/api/images/0123456789abcdef0123456789abcdef.webp',
  });

  const categories = await menu();
  const seasonal = categories.find((category) => category.id === 'seasonal');
  assert.ok(seasonal, 'the new category is on the public menu');
  assert.equal(seasonal.group, 'desserts');
  assert.equal(seasonal.nameAr, 'موسمي');
  assert.equal(seasonal.items.length, 1);
  assert.deepEqual(
    (({ id, name, price, description, descriptionAr, image, available }) => ({ id, name, price, description, descriptionAr, image, available }))(seasonal.items[0]),
    {
      id: 'pistachio-crunch', name: 'Pistachio Crunch', price: 85,
      description: 'Baked today.', descriptionAr: 'مخبوز اليوم.',
      image: '/api/images/0123456789abcdef0123456789abcdef.webp', available: true,
    },
  );
});

test('a category can be moved to another section', async () => {
  await createCategory({ id: 'seasonal', name: 'Seasonal', group: 'desserts' });
  const result = await updateCategory('seasonal', { group: 'drinks' });
  assert.deepEqual(result, { changed: true, found: true });
  const [seasonal] = await menu();
  assert.equal(seasonal.group, 'drinks');
});

test('a category saved without a section has none, rather than a made-up one', async () => {
  await createCategory({ id: 'loose', name: 'Loose' });
  const [loose] = await menu();
  assert.equal(loose.group, undefined);
});
