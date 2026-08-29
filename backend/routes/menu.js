/**
 * The catalogue.
 *
 * Public reads, admin writes. The public shape is deliberately not the database
 * row: it carries both languages and the *derived* selling price, so the
 * storefront never has to know how a discount is stored and cannot compute it
 * differently from the server. See shared/pricing.mjs.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db.js';
import { requireAdmin } from '../adminSession.js';
import { discountProblem, effectivePrice, money } from '../../shared/pricing.mjs';

const router = Router();

/** A product as the storefront sees it. */
function publicProduct(row) {
  const product = {
    ...row,
    discountEnabled: !!row.discount_enabled,
    discountType: row.discount_type,
    discountValue: row.discount_value,
  };
  const price = money(row.price);
  const sellingPrice = effectivePrice(product);
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    nameAr: row.name_ar || undefined,
    description: row.description || undefined,
    descriptionAr: row.description_ar || undefined,
    note: row.note || undefined,
    noteAr: row.note_ar || undefined,
    image: row.image || undefined,
    // Both figures, always. The card needs the struck-through original as well
    // as what it costs today, and deriving one from the other in the browser is
    // the duplicated-arithmetic trap this whole design avoids.
    price: sellingPrice,
    regularPrice: price,
    discounted: sellingPrice < price,
    available: !!row.available,
  };
}

/** GET /api/menu — the whole catalogue, grouped, in one request. */
router.get('/', (_req, res) => {
  const database = db.get();
  const categories = database
    .prepare('SELECT * FROM categories WHERE visible = 1 ORDER BY sort, name')
    .all();
  const products = database
    .prepare('SELECT * FROM products ORDER BY sort, name')
    .all()
    .map(publicProduct);

  const byCategory = new Map(categories.map((c) => [c.id, []]));
  for (const product of products) byCategory.get(product.categoryId)?.push(product);

  res.json({
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      nameAr: category.name_ar || undefined,
      items: byCategory.get(category.id) ?? [],
    })),
  });
});

// ---------------------------------------------------------------- admin ----

const discountFields = {
  discountEnabled: z.boolean().optional(),
  discountType: z.enum(['percent', 'fixed']).optional(),
  discountValue: z.number().nonnegative().optional(),
};

const productCreate = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/,
    'Use lowercase letters, numbers and hyphens.'),
  categoryId: z.string().min(1),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  descriptionAr: z.string().max(2000).optional(),
  note: z.string().max(200).optional(),
  noteAr: z.string().max(200).optional(),
  price: z.number().nonnegative(),
  image: z.string().max(500).optional(),
  available: z.boolean().optional(),
  sort: z.number().int().optional(),
  ...discountFields,
});

const productPatch = productCreate.partial().omit({ id: true });

function badRequest(res, message, details) {
  return res.status(400).json({ error: 'INVALID', message, details });
}

router.get('/admin/products', requireAdmin, (_req, res) => {
  const rows = db.get().prepare('SELECT * FROM products ORDER BY sort, name').all();
  res.json({
    products: rows.map((row) => ({
      ...publicProduct(row),
      // The admin list needs the raw discount configuration, not just its
      // effect — this is the screen where it is edited.
      discountEnabled: !!row.discount_enabled,
      discountType: row.discount_type,
      discountValue: row.discount_value,
      sort: row.sort,
    })),
  });
});

router.post('/admin/products', requireAdmin, (req, res) => {
  const parsed = productCreate.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
  const body = parsed.data;

  const problem = discountProblem({
    discountEnabled: body.discountEnabled,
    discountType: body.discountType,
    discountValue: body.discountValue,
    price: body.price,
  });
  if (problem) return badRequest(res, problem);

  const database = db.get();
  if (!database.prepare('SELECT 1 FROM categories WHERE id = ?').get(body.categoryId)) {
    return badRequest(res, 'That category does not exist.');
  }
  if (database.prepare('SELECT 1 FROM products WHERE id = ?').get(body.id)) {
    return res.status(409).json({ error: 'DUPLICATE', message: 'That product id is taken.' });
  }

  database.prepare(`
    INSERT INTO products (id, category_id, name, name_ar, description, description_ar,
                          note, note_ar, price, image, discount_enabled, discount_type,
                          discount_value, available, sort)
    VALUES (@id, @categoryId, @name, @nameAr, @description, @descriptionAr,
            @note, @noteAr, @price, @image, @discountEnabled, @discountType,
            @discountValue, @available, @sort)
  `).run({
    id: body.id,
    categoryId: body.categoryId,
    name: body.name,
    nameAr: body.nameAr ?? '',
    description: body.description ?? '',
    descriptionAr: body.descriptionAr ?? '',
    note: body.note ?? '',
    noteAr: body.noteAr ?? '',
    price: body.price,
    image: body.image ?? '',
    discountEnabled: body.discountEnabled ? 1 : 0,
    discountType: body.discountType ?? 'percent',
    discountValue: body.discountValue ?? 0,
    available: body.available === false ? 0 : 1,
    sort: body.sort ?? 0,
  });

  const row = database.prepare('SELECT * FROM products WHERE id = ?').get(body.id);
  res.status(201).json({ product: publicProduct(row) });
});

router.patch('/admin/products/:id', requireAdmin, (req, res) => {
  const parsed = productPatch.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
  const patch = parsed.data;

  const database = db.get();
  const existing = database.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });

  // Validated against the patch laid over what is stored, which is the only
  // view where the real trap is visible: raising the discount today and cutting
  // the price tomorrow each pass on their own, and together they sell at zero.
  const merged = {
    price: patch.price ?? existing.price,
    discountEnabled: patch.discountEnabled ?? !!existing.discount_enabled,
    discountType: patch.discountType ?? existing.discount_type,
    discountValue: patch.discountValue ?? existing.discount_value,
  };
  const problem = discountProblem(merged);
  if (problem) return badRequest(res, problem);

  if (patch.categoryId
    && !database.prepare('SELECT 1 FROM categories WHERE id = ?').get(patch.categoryId)) {
    return badRequest(res, 'That category does not exist.');
  }

  const column = {
    categoryId: 'category_id', name: 'name', nameAr: 'name_ar',
    description: 'description', descriptionAr: 'description_ar',
    note: 'note', noteAr: 'note_ar', price: 'price', image: 'image',
    discountEnabled: 'discount_enabled', discountType: 'discount_type',
    discountValue: 'discount_value', available: 'available', sort: 'sort',
  };
  const sets = [];
  const values = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!column[key]) continue;
    sets.push(`${column[key]} = @${key}`);
    values[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  if (sets.length) {
    database.prepare(
      `UPDATE products SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...values, id: req.params.id });
  }

  const row = database.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product: publicProduct(row) });
});

router.delete('/admin/products/:id', requireAdmin, (req, res) => {
  const info = db.get().prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });
  res.status(204).end();
});

// ------------------------------------------------------------ categories ----

const categoryBody = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
  sort: z.number().int().optional(),
  visible: z.boolean().optional(),
});

router.get('/admin/categories', requireAdmin, (_req, res) => {
  const rows = db.get().prepare('SELECT * FROM categories ORDER BY sort, name').all();
  res.json({
    categories: rows.map((row) => ({
      id: row.id, name: row.name, nameAr: row.name_ar, sort: row.sort, visible: !!row.visible,
    })),
  });
});

router.post('/admin/categories', requireAdmin, (req, res) => {
  const parsed = categoryBody.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
  const body = parsed.data;
  try {
    db.get().prepare(
      'INSERT INTO categories (id, name, name_ar, sort, visible) VALUES (?, ?, ?, ?, ?)',
    ).run(body.id, body.name, body.nameAr ?? '', body.sort ?? 0, body.visible === false ? 0 : 1);
  } catch {
    return res.status(409).json({ error: 'DUPLICATE', message: 'That category id is taken.' });
  }
  res.status(201).json({ category: body });
});

router.patch('/admin/categories/:id', requireAdmin, (req, res) => {
  const parsed = categoryBody.partial().omit({ id: true }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
  const patch = parsed.data;
  const column = { name: 'name', nameAr: 'name_ar', sort: 'sort', visible: 'visible' };
  const sets = [];
  const values = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!column[key]) continue;
    sets.push(`${column[key]} = @${key}`);
    values[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  if (!sets.length) return res.json({ ok: true });
  const info = db.get().prepare(
    `UPDATE categories SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`,
  ).run({ ...values, id: req.params.id });
  if (!info.changes) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such category.' });
  res.json({ ok: true });
});

router.delete('/admin/categories/:id', requireAdmin, (req, res) => {
  // The foreign key is ON DELETE RESTRICT, so this fails rather than orphaning
  // products. Turned into a message that says what to do about it.
  const count = db.get()
    .prepare('SELECT COUNT(*) c FROM products WHERE category_id = ?').get(req.params.id).c;
  if (count > 0) {
    return res.status(409).json({
      error: 'CATEGORY_NOT_EMPTY',
      message: `Move or delete the ${count} product(s) in this category first.`,
    });
  }
  const info = db.get().prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such category.' });
  res.status(204).end();
});

export default router;
