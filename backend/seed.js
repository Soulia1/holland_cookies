/**
 * Seed the catalogue from the printed menu already transcribed in
 * `src/data/menu.ts`.
 *
 * That file stays the record of what the sheets say; this copies it into the
 * database once so the shop starts with its real menu rather than an empty one.
 * It is idempotent — existing products are left exactly as they are, so running
 * it again after an admin has edited a price does not undo their work.
 *
 * Run with `npm run seed`. Pass `--force` to overwrite names and prices from
 * the file again (it still never deletes anything).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as db from './db.js';

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
async function readMenu() {
  const { transform } = await import('esbuild');
  const source = readFileSync(path.join(here, '..', 'src', 'data', 'menu.ts'), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  // A data URL rather than a temporary file: nothing to write, nothing to clean
  // up, and no chance of two runs colliding on the same path.
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const module = await import(url);
  return module.MENU;
}

async function seed({ force = false } = {}) {
  const database = db.get();
  const categories = await readMenu();
  if (!categories.length) {
    throw new Error('Parsed no categories out of src/data/menu.ts — has its shape changed?');
  }

  const insertCategory = database.prepare(`
    INSERT INTO categories (id, name, name_ar, sort) VALUES (@id, @name, @nameAr, @sort)
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN @force THEN excluded.name ELSE categories.name END,
      name_ar = CASE WHEN @force THEN excluded.name_ar ELSE categories.name_ar END,
      sort = excluded.sort
  `);
  const insertProduct = database.prepare(`
    INSERT INTO products (id, category_id, name, name_ar, note, price, sort)
    VALUES (@id, @categoryId, @name, @nameAr, @note, @price, @sort)
    ON CONFLICT(id) DO UPDATE SET
      category_id = excluded.category_id,
      name  = CASE WHEN @force THEN excluded.name  ELSE products.name  END,
      price = CASE WHEN @force THEN excluded.price ELSE products.price END,
      note  = CASE WHEN @force THEN excluded.note  ELSE products.note  END,
      sort  = excluded.sort
  `);

  let productCount = 0;
  database.transaction(() => {
    categories.forEach((category, index) => {
      insertCategory.run({
        id: category.id, name: category.name, nameAr: category.nameAr,
        sort: index, force: force ? 1 : 0,
      });
      category.items.forEach((item, itemIndex) => {
        insertProduct.run({
          id: item.id,
          categoryId: category.id,
          name: item.name,
          // Left empty: the Arabic item names are on the printed sheets and
          // have not been transcribed. `localized()` falls back to English
          // until they are, which is a blemish rather than a blank.
          nameAr: '',
          note: item.note ?? '',
          price: item.price,
          sort: itemIndex,
          force: force ? 1 : 0,
        });
        productCount += 1;
      });
    });

    // Sensible starting settings for the delivery model the footer describes.
    database.prepare(`
      UPDATE settings SET delivery_fee = 40, free_delivery_over = 600,
                          accepting_orders = 1, areas = ?
      WHERE id = 1 AND delivery_fee = 0
    `).run(JSON.stringify([
      { id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر' },
      { id: 'heliopolis', name: 'Heliopolis', nameAr: 'مصر الجديدة' },
      { id: 'maadi', name: 'Maadi', nameAr: 'المعادي' },
      { id: 'new-cairo', name: 'New Cairo', nameAr: 'القاهرة الجديدة' },
      { id: 'downtown', name: 'Downtown', nameAr: 'وسط البلد' },
      { id: 'zamalek', name: 'Zamalek', nameAr: 'الزمالك' },
      { id: 'mohandessin', name: 'Mohandessin', nameAr: 'المهندسين' },
      { id: 'sheikh-zayed', name: 'Sheikh Zayed', nameAr: 'الشيخ زايد' },
      { id: '6-october', name: '6th of October', nameAr: 'السادس من أكتوبر' },
    ]));
  })();

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
}

export default seed;
export { seed, readMenu };
