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
 *
 * A bundle's contents (`components`) and its customer choices (`groups`) are
 * arrays on the product document. Firestore has no foreign keys, so the rules a
 * join table would have enforced — no bundle inside a bundle, no deleting a
 * product a bundle still offers — are checked explicitly in routes/menu.js.
 */

import { collections, FieldValue, get as firestore } from '../firestore.js';
import { live, refresh } from '../mirror.js';
import { effectivePrice, money } from '../../shared/pricing.mjs';

const now = () => FieldValue.serverTimestamp();

/** Firestore timestamps out, ISO strings in the API, as SQLite's text dates were. */
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : (value ?? null));

const productFromDoc = (doc) => ({ id: doc.id, ...doc.data() });

/** Name and availability by product id, for describing what a bundle holds. */
export function lookupOf(products) {
  return new Map(products.map((product) => [product.id, {
    name: product.name ?? '',
    nameAr: product.nameAr ?? '',
    available: product.available !== false,
  }]));
}

/** The ids a bundle points at: its fixed contents, or every option it offers. */
export function referencedIds(product) {
  if (!product?.isBundle) return [];
  return product.bundleType === 'choice'
    ? (product.groups ?? []).flatMap((group) => (group.options ?? []).map((option) => option.productId))
    : (product.components ?? []).map((component) => component.productId);
}

function bundleView(product, names) {
  const lookup = names instanceof Map ? names : new Map();
  const describe = (id) => ({
    name: lookup.get(id)?.name ?? '',
    nameAr: lookup.get(id)?.nameAr || undefined,
  });
  const choice = product.bundleType === 'choice';
  return {
    isBundle: true,
    bundleType: choice ? 'choice' : 'fixed',
    components: choice ? [] : (product.components ?? []).map((component) => ({
      productId: component.productId,
      quantity: component.quantity,
      ...describe(component.productId),
    })),
    groups: choice ? (product.groups ?? []).map((group) => ({
      label: group.label,
      labelAr: group.labelAr || undefined,
      choose: group.choose,
      allowRepeats: !!group.allowRepeats,
      options: (group.options ?? []).map((option) => ({
        productId: option.productId,
        surcharge: option.surcharge ?? 0,
        ...describe(option.productId),
        available: lookup.get(option.productId)?.available !== false,
      })),
    })) : [],
  };
}

/**
 * Whether the shop can sell this product right now.
 *
 * A fixed bundle is made of its contents, so it is sold out while any one of
 * them is sold out or gone: the order transaction refuses it on the same rule,
 * and this lets the menu say so before the customer tries. The bundle's own
 * flag is left as the admin set it, so it comes back by itself with the cookie.
 */
export function sellable(product, names) {
  if (!product.available) return false;
  if (!product.isBundle || product.bundleType === 'choice' || !(names instanceof Map)) return true;
  return (product.components ?? []).every((component) => names.get(component.productId)?.available === true);
}

/**
 * A product as the storefront sees it.
 *
 * Unchanged from the SQLite implementation, deliberately: it carries both
 * languages and the *derived* selling price, so the storefront never has to know
 * how a discount is stored and cannot compute it differently from the server.
 * A bundle additionally carries what it contains or offers, named from `names`.
 */
export function publicProduct(product, names) {
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
    available: sellable(product, names),
    choices: (Array.isArray(product.choices) ? product.choices : []).map((choice) => ({
      name: choice.name,
      nameAr: choice.nameAr || undefined,
      // Always a number, even when zero: the storefront adds it to the price it
      // shows, and an absent field there would read as "no extra" only by luck
      // of `undefined + n` being NaN-shaped rather than by anything saying so.
      priceDelta: money(Number(choice.priceDelta) || 0),
    })),
    ...(product.isBundle ? bundleView(product, names) : {}),
  };
}

/** The admin list additionally needs the raw configuration it edits. */
export function adminProduct(product, names) {
  const bundle = product.isBundle ? bundleView(product, names) : null;
  return {
    ...publicProduct(product, names),
    // The flag as stored, not whether it can sell today: the editor saves this
    // value back, and a bundle blocked for a while by a sold-out cookie must not
    // be switched off for good by an unrelated edit.
    available: !!product.available,
    discountEnabled: !!product.discountEnabled,
    discountType: product.discountType,
    discountValue: product.discountValue,
    sort: product.sort ?? 0,
    isBundle: !!product.isBundle,
    bundleType: bundle?.bundleType ?? (product.bundleType === 'choice' ? 'choice' : 'fixed'),
    components: bundle?.components ?? [],
    groups: bundle?.groups ?? [],
  };
}

// ------------------------------------------------------------ categories ----

export async function listCategories({ visibleOnly = false } = {}) {
  // Ordered in memory rather than by Firestore. `ORDER BY sort, name` on a
  // filtered query needs a composite index for every filter combination, and
  // this collection is seventeen documents — sorting them here costs nothing and
  // keeps firestore.indexes.json honest about what is actually needed at scale.
  const mirror = live('categories');
  const rows = mirror
    ? mirror.docs().map(([id, data]) => ({ id, ...data })).filter((row) => !visibleOnly || row.visible === true)
    : (visibleOnly
      ? await collections.categories().where('visible', '==', true).get()
      : await collections.categories().get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return rows
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
    group: body.group ?? '',
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
  await refresh('categories', body.id);
  return { duplicate: false, category: { id: body.id, ...body } };
}

export async function updateCategory(id, patch) {
  const writable = ['name', 'nameAr', 'sort', 'visible', 'group'];
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
  await refresh('categories', id);
  return { changed: true, found: true };
}

/**
 * Delete a category.
 *
 * Refuses while it holds products unless `withProducts` is set, so a stray call
 * cannot empty a menu. Also refuses when a bundle filed elsewhere still offers
 * one of those products: the bundle would survive with a hole in it. Past orders
 * are unaffected — their lines copy the name and price.
 */
export async function deleteCategory(id, { withProducts = false } = {}) {
  const ref = collections.categories().doc(id);
  if (!(await ref.get()).exists) return { found: false };

  const snapshot = await collections.products().where('categoryId', '==', id).get();
  const products = snapshot.docs.map(productFromDoc);
  if (products.length && !withProducts) {
    return { found: true, blocked: true, productCount: products.length };
  }

  const inCategory = new Set(products.map((product) => product.id));
  const blockers = [];
  if (inCategory.size) {
    for (const bundle of await bundlesReferencing(inCategory)) {
      if (bundle.categoryId === id) continue;
      for (const referenced of referencedIds(bundle)) {
        const product = products.find((row) => row.id === referenced);
        if (product) blockers.push({ product: product.name, bundle: bundle.name });
      }
    }
  }
  if (blockers.length) return { found: true, blockers };

  const batch = firestore().batch();
  for (const product of products) batch.delete(collections.products().doc(product.id));
  batch.delete(ref);
  await batch.commit();
  await Promise.all([
    refresh('categories', id),
    refresh('products', products.map((product) => product.id)),
  ]);
  return { found: true, deletedProducts: products.length };
}

// -------------------------------------------------------------- products ----

export async function listProducts() {
  const mirror = live('products');
  const rows = mirror
    ? mirror.docs().map(([id, data]) => ({ id, ...data }))
    : (await collections.products().get()).docs.map(productFromDoc);
  return rows
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)));
}

export async function getProduct(id) {
  const doc = await collections.products().doc(id).get();
  return doc.exists ? productFromDoc(doc) : null;
}

/** Several products by id, in the same order; null where one does not exist. */
export async function getProducts(ids) {
  if (!ids.length) return [];
  const snapshots = await firestore().getAll(...ids.map((id) => collections.products().doc(id)));
  return snapshots.map((snapshot) => (snapshot.exists ? productFromDoc(snapshot) : null));
}

/** The bundles that contain or offer any of these product ids. */
export async function bundlesReferencing(ids) {
  const snapshot = await collections.products().where('isBundle', '==', true).get();
  return snapshot.docs
    .map(productFromDoc)
    .filter((bundle) => referencedIds(bundle).some((id) => ids.has(id)));
}

/** The whole catalogue, grouped, for GET /api/menu. */
export async function menu() {
  const [categories, products] = await Promise.all([
    listCategories({ visibleOnly: true }),
    listProducts(),
  ]);
  const names = lookupOf(products);
  const byCategory = new Map(categories.map((category) => [category.id, []]));
  for (const product of products) {
    byCategory.get(product.categoryId)?.push(publicProduct(product, names));
  }
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    nameAr: category.nameAr || undefined,
    group: category.group || undefined,
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
    isBundle: body.isBundle === true,
    bundleType: body.bundleType ?? 'fixed',
    components: body.components ?? [],
    groups: body.groups ?? [],
    choices: body.choices ?? [],
    createdAt: now(),
    updatedAt: now(),
  };
  try {
    await collections.products().doc(body.id).create(document);
  } catch (error) {
    if (error.code === 6) return { duplicate: true };
    throw error;
  }
  await refresh('products', body.id);
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
  'isBundle', 'bundleType', 'components', 'groups', 'choices',
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
  await refresh('products', id);
  const doc = await ref.get();
  return doc.exists ? productFromDoc(doc) : null;
}

export async function deleteProduct(id) {
  const ref = collections.products().doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  await refresh('products', id);
  return true;
}

export { iso };
