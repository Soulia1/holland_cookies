/**
 * The catalogue: categories and products.
 *
 * Firestore stores these with the same field names the API uses (camelCase),
 * which is the one gratuitous change this migration makes to the data. SQLite
 * used snake_case columns and every route carried a hand-written mapping table
 * between the two — `{ categoryId: 'category_id', nameAr: 'name_ar', ... }`,
 * repeated in four places, each a chance to omit a field and have it silently
 * stop saving. Firestore has no column names to satisfy, so the mapping is
 * simply deleted and the document is the API shape.
 *
 * The document id is the product/category id, exactly as before: they are
 * human-authored slugs (`sea-salt-cookie`), already unique, already validated to
 * `^[a-z0-9-]+$` by the route schema. Using them as document ids means an id
 * collision is a failed `.create()` rather than a duplicate row, and a lookup by
 * id is a direct get rather than a query.
 */

import { collections, FieldValue } from '../firestore.js';
import { effectivePrice, money } from '../../shared/pricing.mjs';

const now = () => FieldValue.serverTimestamp();

/** Firestore timestamps out, ISO strings in the API, as SQLite's text dates were. */
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : (value ?? null));

const productFromDoc = (doc) => ({ id: doc.id, ...doc.data() });

/**
 * A product as the storefront sees it.
 *
 * Unchanged from the SQLite implementation, deliberately: it carries both
 * languages and the *derived* selling price, so the storefront never has to know
 * how a discount is stored and cannot compute it differently from the server.
 */
export function publicProduct(product) {
  const regular = money(product.price);
  const selling = effectivePrice(product);
  return {
    id: product.id,
    categoryId: product.categoryId,
    name: product.name,
    nameAr: product.nameAr || undefined,
    description: product.description || undefined,
    descriptionAr: product.descriptionAr || undefined,
    note: product.note || undefined,
    noteAr: product.noteAr || undefined,
    image: product.image || undefined,
    price: selling,
    regularPrice: regular,
    discounted: selling < regular,
    available: !!product.available,
  };
}

/** The admin list additionally needs the raw discount configuration it edits. */
export const adminProduct = (product) => ({
  ...publicProduct(product),
  discountEnabled: !!product.discountEnabled,
  discountType: product.discountType,
  discountValue: product.discountValue,
  sort: product.sort ?? 0,
});

// ------------------------------------------------------------ categories ----

export async function listCategories({ visibleOnly = false } = {}) {
  // Ordered in memory rather than by Firestore. `ORDER BY sort, name` on a
  // filtered query needs a composite index for every filter combination, and
  // this collection is seventeen documents — sorting them here costs nothing and
  // keeps firestore.indexes.json honest about what is actually needed at scale.
  const snapshot = visibleOnly
    ? await collections.categories().where('visible', '==', true).get()
    : await collections.categories().get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));
}

export async function getCategory(id) {
  const doc = await collections.categories().doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function categoryExists(id) {
  return (await collections.categories().doc(id).get()).exists;
}

/** Create. Fails with a DUPLICATE-shaped error if the id is taken. */
export async function createCategory(body) {
  const document = {
    name: body.name,
    nameAr: body.nameAr ?? '',
    sort: body.sort ?? 0,
    visible: body.visible !== false,
    createdAt: now(),
    updatedAt: now(),
  };
  try {
    // `.create()` not `.set()`: set would silently overwrite an existing
    // category, which is how "that id is taken" turns into "your colleague's
    // category just vanished".
    await collections.categories().doc(body.id).create(document);
  } catch (error) {
    if (error.code === 6 /* ALREADY_EXISTS */) return { duplicate: true };
    throw error;
  }
  return { duplicate: false, category: { id: body.id, ...body } };
}

export async function updateCategory(id, patch) {
  const writable = ['name', 'nameAr', 'sort', 'visible'];
  const update = Object.fromEntries(
    Object.entries(patch).filter(([key]) => writable.includes(key)),
  );
  if (!Object.keys(update).length) return { changed: false, found: true };
  try {
    await collections.categories().doc(id).update({ ...update, updatedAt: now() });
  } catch (error) {
    if (error.code === 5 /* NOT_FOUND */) return { changed: false, found: false };
    throw error;
  }
  return { changed: true, found: true };
}

export async function deleteCategory(id) {
  // SQLite had ON DELETE RESTRICT and this was a caught foreign-key error.
  // Firestore has no foreign keys at all, so the check is explicit — and it has
  // to be, because without it deleting a category orphans its products into a
  // catalogue that renders nothing.
  const used = await collections.products().where('categoryId', '==', id).limit(1).get();
  if (!used.empty) {
    const all = await collections.products().where('categoryId', '==', id).count().get();
    return { blocked: true, productCount: all.data().count };
  }
  const ref = collections.categories().doc(id);
  if (!(await ref.get()).exists) return { blocked: false, found: false };
  await ref.delete();
  return { blocked: false, found: true };
}

// -------------------------------------------------------------- products ----

export async function listProducts() {
  const snapshot = await collections.products().get();
  return snapshot.docs
    .map(productFromDoc)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));
}

export async function getProduct(id) {
  const doc = await collections.products().doc(id).get();
  return doc.exists ? productFromDoc(doc) : null;
}

/** The whole catalogue, grouped, for GET /api/menu. */
export async function menu() {
  const [categories, products] = await Promise.all([
    listCategories({ visibleOnly: true }),
    listProducts(),
  ]);
  const byCategory = new Map(categories.map((category) => [category.id, []]));
  for (const product of products) byCategory.get(product.categoryId)?.push(publicProduct(product));
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    nameAr: category.nameAr || undefined,
    items: byCategory.get(category.id) ?? [],
  }));
}

export async function createProduct(body) {
  const document = {
    categoryId: body.categoryId,
    name: body.name,
    nameAr: body.nameAr ?? '',
    description: body.description ?? '',
    descriptionAr: body.descriptionAr ?? '',
    note: body.note ?? '',
    noteAr: body.noteAr ?? '',
    price: body.price,
    image: body.image ?? '',
    discountEnabled: body.discountEnabled === true,
    discountType: body.discountType ?? 'percent',
    discountValue: body.discountValue ?? 0,
    available: body.available !== false,
    sort: body.sort ?? 0,
    createdAt: now(),
    updatedAt: now(),
  };
  try {
    await collections.products().doc(body.id).create(document);
  } catch (error) {
    if (error.code === 6) return { duplicate: true };
    throw error;
  }
  return { duplicate: false, product: { id: body.id, ...document } };
}

/**
 * Patch a product.
 *
 * The writable list is explicit and closed. This is the mass-assignment guard:
 * the route's Zod schema is already strict, but a second closed list here means
 * a field added to the schema later does not become writable by accident, and
 * nothing the client sends can ever reach `createdAt` or a field this endpoint
 * does not own.
 */
const PRODUCT_WRITABLE = [
  'categoryId', 'name', 'nameAr', 'description', 'descriptionAr', 'note', 'noteAr',
  'price', 'image', 'discountEnabled', 'discountType', 'discountValue', 'available', 'sort',
];

export async function updateProduct(id, patch) {
  const update = Object.fromEntries(
    Object.entries(patch).filter(([key]) => PRODUCT_WRITABLE.includes(key)),
  );
  const ref = collections.products().doc(id);
  if (Object.keys(update).length) {
    try {
      await ref.update({ ...update, updatedAt: now() });
    } catch (error) {
      if (error.code === 5) return null;
      throw error;
    }
  }
  const doc = await ref.get();
  return doc.exists ? productFromDoc(doc) : null;
}

export async function deleteProduct(id) {
  const ref = collections.products().doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  return true;
}

export { iso };
