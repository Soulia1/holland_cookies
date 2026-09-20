/**
 * Seed the catalogue from the printed menu already transcribed in
 * `src/data/menu.ts`.
 *
 * That file stays the record of what the sheets say; this copies it into
 * Firestore once so the shop starts with its real menu rather than an empty one.
 * Running it again over a shop the dashboard has edited undoes nothing: names,
 * prices, the category a product was moved to, products and categories that
 * were deleted, and the shop settings all stay as the admin left them. Only
 * positions (`sort`) and options a product has never had are filled in.
 *
 * Run with `npm run seed`. Two flags change what it is allowed to write:
 *
 *   --add-new  Create the rows the menu file has and the shop does not, and
 *              change nothing that is already there. This is how a category
 *              added to the menu file — Special Edition, say — reaches a shop
 *              that is already live. Without it those rows are skipped, because
 *              a printed product that is missing from a shop with a catalogue
 *              was usually deleted on purpose; with it, adding them back is the
 *              admin's explicit decision.
 *   --force    Put the printed menu back: names, prices, categories, and
 *              anything deleted since (it still never deletes). This overwrites
 *              edits made in the dashboard, so it is rarely what is wanted on a
 *              live shop.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { collections, settingsDoc, orderCounterDoc, FieldValue, get as firestore } from './firestore.js';
import { DEFAULT_AREAS } from '../shared/deliveryAreas.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the menu out of the TypeScript module.
 *
 * Transpiled with esbuild and imported as a module, rather than pattern-matched
 * out of the source. The first version of this did use a regular expression,
 * and it was wrong in the quiet way that kind of code always is: it parsed 105
 * of the 105 items correctly, which looked like proof it worked, but only
 * because every item happened to be formatted the way the pattern expected. One
 * reflow of that file and it would have silently seeded a shop with a missing
 * product.
 *
 * `menu.ts` has no imports of its own — it is pure data and type declarations —
 * so a bare transform is enough and no bundling step is needed. esbuild is
 * already here as part of Vite.
 */
async function loadMenuModule() {
  const { transform } = await import('esbuild');
  const source = readFileSync(path.join(here, '..', 'src', 'data', 'menu.ts'), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  // A data URL rather than a temporary file: nothing to write, nothing to clean
  // up, and no chance of two runs colliding on the same path.
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(url);
}

async function readMenu() {
  return (await loadMenuModule()).MENU;
}

/**
 * The storefront's menu pages, by id.
 *
 * Read out of the same module the menu is, so the list the catalogue route
 * accepts as a category's `group` can be checked against the pages that
 * actually exist rather than against a second hand-kept copy of them.
 */
async function readMenuGroupIds() {
  return (await loadMenuModule()).MENU_GROUPS.map((group) => group.id);
}


async function seed({ force = false, addNew = false } = {}) {
  const menuModule = await loadMenuModule();
  const categories = menuModule.MENU;
  if (!categories.length) {
    throw new Error('Parsed no categories out of src/data/menu.ts — has its shape changed?');
  }

  const db = firestore();
  const now = () => FieldValue.serverTimestamp();

  // Read what already exists in one pass, so "leave existing rows alone" is a
  // decision made from data rather than from a per-document round trip inside
  // the write loop.
  const [existingCategories, existingProducts] = await Promise.all([
    collections.categories().get(),
    collections.products().get(),
  ]);
  const haveCategory = new Set(existingCategories.docs.map((doc) => doc.id));
  const haveProduct = new Set(existingProducts.docs.map((doc) => doc.id));
  const storedChoices = new Map(existingProducts.docs.map((doc) => [doc.id, doc.data().choices]));
  // A shop that already has a catalogue has been through the dashboard, where
  // a printed product that is missing was deleted on purpose. Only an empty
  // shop, --add-new or --force, gets missing rows created.
  const fresh = existingCategories.empty && existingProducts.empty;
  const create = fresh || addNew || force;
  const skipped = [];

  // Firestore batches are capped at 500 writes; the menu is ~105 products plus
  // 17 categories, but the cap is respected rather than assumed away because the
  // menu file is expected to grow.
  const BATCH_LIMIT = 450;
  let batch = db.batch();
  let pending = 0;
  const flush = async () => {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  };
  const queue = async (ref, data, merge) => {
    batch.set(ref, data, merge ? { merge: true } : {});
    pending += 1;
    if (pending >= BATCH_LIMIT) await flush();
  };

  let productCount = 0;

  for (const [index, category] of categories.entries()) {
    const exists = haveCategory.has(category.id);
    if (!exists && !create) {
      skipped.push(category.id);
      continue;
    }
    // `sort` is always refreshed: it is positional data owned by the menu file,
    // not something an admin edits. Names and prices are only overwritten under
    // --force.
    await queue(collections.categories().doc(category.id), {
      ...(exists && !force ? {} : { name: category.name, nameAr: category.nameAr ?? '' }),
      sort: index,
      visible: exists ? undefined : true,
      updatedAt: now(),
      ...(exists ? {} : { createdAt: now() }),
    }, true);

    for (const [itemIndex, item] of category.items.entries()) {
      const productExists = haveProduct.has(item.id);
      if (!productExists && !create) {
        skipped.push(item.id);
        continue;
      }
      await queue(collections.products().doc(item.id), {
        ...(productExists && !force ? {} : {
          // The category too: an admin may have moved it, and a re-seed moving
          // it back is an edit nobody made.
          categoryId: category.id,
          name: item.name,
          // Blank unless the menu file carries one. The Arabic names of the
          // printed items are on the sheets and have not been transcribed, and
          // `localized()` falls back to English until they are — a blemish
          // rather than a blank. An item that does have its Arabic, like the
          // Special Edition rows, must not have it thrown away here.
          nameAr: item.nameAr ?? '',
          note: item.note ?? '',
          price: item.price,
        }),
        ...(productExists ? {} : {
          description: '',
          descriptionAr: '',
          noteAr: '',
          image: '',
          discountEnabled: false,
          discountType: 'percent',
          discountValue: 0,
          available: true,
          createdAt: now(),
        }),
        // Options: written for a new product, under --force, or onto a stored
        // product that has never had a list. Once the dashboard has saved one,
        // even an empty one, a plain re-seed leaves it alone.
        ...(item.choices && (!productExists || force || !Array.isArray(storedChoices.get(item.id)))
          ? {
            choices: item.choices.map(({ name, nameAr, priceDelta }) => ({
              name, nameAr: nameAr ?? '', priceDelta: Number(priceDelta) || 0,
            })),
          }
          : {}),
        sort: itemIndex,
        updatedAt: now(),
      }, true);
      productCount += 1;
    }
  }
  await flush();

  // Starting settings, written only if the shop has never been configured. A
  // delivery fee of 0 is a configuration — free delivery — and was being
  // overwritten, along with the areas and a closed shop's `acceptingOrders`.
  const settings = await settingsDoc().get();
  if (!settings.exists) {
    await settingsDoc().set({
      deliveryFee: 40,
      freeDeliveryOver: 600,
      acceptingOrders: true,
      areas: DEFAULT_AREAS,
      updatedAt: now(),
    }, { merge: true });
  }

  // The reference counter. Created only if absent — resetting it on an existing
  // shop would hand out reference numbers that already belong to real orders.
  const counter = await orderCounterDoc().get();
  if (!counter.exists) await orderCounterDoc().set({ value: 1000 });

  return { categories: categories.length, products: productCount, skipped };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const force = process.argv.includes('--force');
  const addNew = process.argv.includes('--add-new');
  const result = await seed({ force, addNew });
  console.log(
    `[holland] seeded ${result.products} products across ${result.categories} categories`
    + `${force ? ' (forced)' : ''}${addNew && !force ? ' (new rows added)' : ''}`,
  );
  if (result.skipped.length) {
    console.log(`[holland] left out ${result.skipped.length} printed row(s) no longer in the shop `
      + `(deleted in the dashboard; --force puts them back): ${result.skipped.join(', ')}`);
  }
  process.exit(0);
}

export default seed;
export { seed, readMenu, readMenuGroupIds, DEFAULT_AREAS };
