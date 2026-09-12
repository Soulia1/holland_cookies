/**
 * The catalogue.
 *
 * Public reads, admin writes. The public shape is deliberately not the stored
 * document: it carries both languages and the *derived* selling price, so the
 * storefront never has to know how a discount is stored and cannot compute it
 * differently from the server. See shared/pricing.mjs.
 *
 * The route layer does shape validation and authorization. Every read and write
 * goes through `repo/catalogue.js`, which owns the closed list of writable
 * fields — the mass-assignment guard lives there rather than here, so it applies
 * to every caller and not just to the ones that remembered.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../adminSession.js';
import { validateParams, amount, imagePath, identifier } from '../validation.js';
import { discountProblem } from '../../shared/pricing.mjs';
import * as catalogue from '../repo/catalogue.js';

const router = Router();
validateParams(router);

/** GET /api/menu — the whole catalogue, grouped, in one request. */
router.get('/', async (_req, res, next) => {
  try {
    res.json({ categories: await catalogue.menu() });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------- admin ----

const discountFields = {
  discountEnabled: z.boolean().optional(),
  discountType: z.enum(['percent', 'fixed']).optional(),
  discountValue: amount.optional(),
};

const productCreate = z.strictObject({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens.'),
  categoryId: identifier,
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  descriptionAr: z.string().max(2000).optional(),
  note: z.string().max(200).optional(),
  noteAr: z.string().max(200).optional(),
  price: amount,
  image: imagePath.optional(),
  available: z.boolean().optional(),
  sort: z.number().int().min(-100000).max(100000).optional(),
  ...discountFields,
});

const productPatch = productCreate.partial().omit({ id: true });

const badRequest = (res, message, details) => res.status(400).json({ error: 'INVALID', message, details });

router.get('/admin/products', requireAdmin, async (_req, res, next) => {
  try {
    const products = await catalogue.listProducts();
    res.json({ products: products.map(catalogue.adminProduct) });
  } catch (error) { next(error); }
});

router.post('/admin/products', requireAdmin, async (req, res, next) => {
  try {
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

    if (!(await catalogue.categoryExists(body.categoryId))) {
      return badRequest(res, 'That category does not exist.');
    }

    const created = await catalogue.createProduct(body);
    if (created.duplicate) {
      return res.status(409).json({ error: 'DUPLICATE', message: 'That product id is taken.' });
    }
    return res.status(201).json({ product: catalogue.publicProduct(created.product) });
  } catch (error) { return next(error); }
});

router.patch('/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = productPatch.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
    const patch = parsed.data;

    const existing = await catalogue.getProduct(req.params.id);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });

    // Validated against the patch laid over what is stored, which is the only
    // view where the real trap is visible: raising the discount today and
    // cutting the price tomorrow each pass on their own, and together they sell
    // at zero.
    const problem = discountProblem({
      price: patch.price ?? existing.price,
      discountEnabled: patch.discountEnabled ?? !!existing.discountEnabled,
      discountType: patch.discountType ?? existing.discountType,
      discountValue: patch.discountValue ?? existing.discountValue,
    });
    if (problem) return badRequest(res, problem);

    if (patch.categoryId && !(await catalogue.categoryExists(patch.categoryId))) {
      return badRequest(res, 'That category does not exist.');
    }

    const product = await catalogue.updateProduct(req.params.id, patch);
    if (!product) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });
    return res.json({ product: catalogue.publicProduct(product) });
  } catch (error) { return next(error); }
});

router.delete('/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const removed = await catalogue.deleteProduct(req.params.id);
    if (!removed) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

// ------------------------------------------------------------ categories ----

const categoryBody = z.strictObject({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
  sort: z.number().int().min(-100000).max(100000).optional(),
  visible: z.boolean().optional(),
});

router.get('/admin/categories', requireAdmin, async (_req, res, next) => {
  try {
    const categories = await catalogue.listCategories();
    res.json({
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        nameAr: category.nameAr ?? '',
        sort: category.sort ?? 0,
        visible: !!category.visible,
      })),
    });
  } catch (error) { next(error); }
});

router.post('/admin/categories', requireAdmin, async (req, res, next) => {
  try {
    const parsed = categoryBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
    const created = await catalogue.createCategory(parsed.data);
    if (created.duplicate) {
      return res.status(409).json({ error: 'DUPLICATE', message: 'That category id is taken.' });
    }
    return res.status(201).json({ category: parsed.data });
  } catch (error) { return next(error); }
});

router.patch('/admin/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = categoryBody.partial().omit({ id: true }).safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'Check the fields.', parsed.error.issues);
    const result = await catalogue.updateCategory(req.params.id, parsed.data);
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such category.' });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

router.delete('/admin/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    // SQLite had ON DELETE RESTRICT; Firestore has no foreign keys, so the
    // emptiness check is explicit in the repository. Without it, deleting a
    // category orphans its products into a catalogue that renders nothing.
    const result = await catalogue.deleteCategory(req.params.id);
    if (result.blocked) {
      return res.status(409).json({
        error: 'CATEGORY_NOT_EMPTY',
        message: `Move or delete the ${result.productCount} product(s) in this category first.`,
      });
    }
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such category.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

export default router;
