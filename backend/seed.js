/**
 * Seed the catalogue from the printed menu already transcribed in
 * `src/data/menu.ts`.
 *
 * That file stays the record of what the sheets say; this copies it into
 * Firestore once so the shop starts with its real menu rather than an empty one.
 * It is idempotent — existing products are left exactly as they are, so running
 * it again after an admin has edited a price does not undo their work.
 *
 * Run with `npm run seed`. Pass `--force` to overwrite names and prices from
 * the file again (it still never deletes anything).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { collections, settingsDoc, orderCounterDoc, FieldValue, get as firestore } from './firestore.js';

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

/** The delivery model the footer describes. */
const DEFAULT_AREAS = [
  { id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر' },
  { id: 'heliopolis', name: 'Heliopolis', nameAr: 'مصر الجديدة' },
  { id: 'maadi', name: 'Maadi', nameAr: 'المعادي' },
  { id: 'new-cairo', name: 'New Cairo', nameAr: 'القاهرة الجديدة' },
  { id: 'downtown', name: 'Downtown', nameAr: 'وسط البلد' },
  { id: 'zamalek', name: 'Zamalek', nameAr: 'الزمالك' },
  { id: 'mohandessin', name: 'Mohandessin', nameAr: 'المهندسين' },
  { id: 'sheikh-zayed', name: 'Sheikh Zayed', nameAr: 'الشيخ زايد' },
  { id: '6-october', name: '6th of October', nameAr: 'السادس من أكتوبر' },
];

async function seed({ force = false } = {}) {
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
      await queue(collections.products().doc(item.id), {
        categoryId: category.id,
        ...(productExists && !force ? {} : {
          name: item.name,
          // Left empty: the Arabic item names are on the printed sheets and
          // have not been transcribed. `localized()` falls back to English
          // until they are, which is a blemish rather than a blank.
          nameAr: '',
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
        sort: itemIndex,
        updatedAt: now(),
      }, true);
      productCount += 1;

      // A line printed with several flavors is ordered as one product per
      // flavor; the cart sends these ids, so without them it cannot be bought.
      for (const variant of menuModule.flavorVariants(item)) {
        const variantExists = haveProduct.has(variant.id);
        await queue(collections.products().doc(variant.id), {
          categoryId: category.id,
          ...(variantExists && !force ? {} : {
            name: variant.name,
            nameAr: '',
            note: item.note ?? '',
            price: item.price,
          }),
          ...(variantExists ? {} : {
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
          sort: itemIndex,
          updatedAt: now(),
        }, true);
        productCount += 1;
      }
    }
  }
  await flush();

  // Starting settings, written only if the shop has never been configured.
  const settings = await settingsDoc().get();
  if (!settings.exists || (settings.data().deliveryFee ?? 0) === 0) {
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

  return { categories: categories.length, products: productCount };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const force = process.argv.includes('--force');
  const result = await seed({ force });
  console.log(
    `[holland] seeded ${result.products} products across ${result.categories} categories`
    + `${force ? ' (forced)' : ''}`,
  );
  process.exit(0);
}

export default seed;
export { seed, readMenu, DEFAULT_AREAS };
