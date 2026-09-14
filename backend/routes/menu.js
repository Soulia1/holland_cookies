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

/**
 * A bundle is a product made of other products.
 *
 *   fixed  - the admin lists the contents in `components`.
 *   choice - the customer picks from named `groups`, each with its own count,
 *            its own options, and an optional surcharge per option.
 */
const bundleFields = {
  isBundle: z.boolean().optional(),
  bundleType: z.enum(['fixed', 'choice']).optional(),
  components: z.array(z.strictObject({
    productId: identifier,
    quantity: z.number().int().min(1).max(50),
  })).max(20).optional(),
  groups: z.array(z.strictObject({
    label: z.string().trim().min(1).max(80),
    labelAr: z.string().trim().max(80).optional(),
    choose: z.number().int().min(1).max(12),
    allowRepeats: z.boolean().optional(),
    options: z.array(z.strictObject({
      productId: identifier,
      surcharge: amount.optional(),
    })).min(1).max(60),
  })).max(8).optional(),
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
  ...bundleFields,
});

const productPatch = productCreate.partial().omit({ id: true });

const badRequest = (res, message, details) => res.status(400).json({ error: 'INVALID', message, details });
const conflict = (res, error, message) => res.status(409).json({ error, message });

function listed(names) {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown}, and ${names.length - 4} more` : shown;
}

/** The bundle configuration as it will be after this write: the patch over what is stored. */
function bundleShape(patch, existing) {
  return {
    isBundle: patch.isBundle ?? !!existing?.isBundle,
    bundleType: patch.bundleType ?? existing?.bundleType ?? 'fixed',
    components: patch.components ?? existing?.components ?? [],
    groups: patch.groups ?? existing?.groups ?? [],
  };
}

/** Normalised for storage: a fixed bundle keeps no groups, a choice bundle no contents. */
function bundleFieldsFor(bundle) {
  const choice = bundle.isBundle && bundle.bundleType === 'choice';
  return {
    isBundle: bundle.isBundle,
    bundleType: bundle.bundleType,
    components: bundle.isBundle && !choice
      ? bundle.components.map(({ productId, quantity }) => ({ productId, quantity }))
      : [],
    groups: choice
      ? bundle.groups.map((group) => ({
          label: group.label.trim(),
          labelAr: (group.labelAr ?? '').trim(),
          choose: group.choose,
          allowRepeats: !!group.allowRepeats,
          options: group.options.map((option) => ({
            productId: option.productId,
            surcharge: option.surcharge ?? 0,
          })),
        }))
      : [],
  };
}

/**
 * Why a bundle cannot be saved, or null.
 *
 * Checked against the merged document, because switching a fixed bundle to
 * `choice` without also setting groups passes on each half alone. Firestore has
 * no foreign keys, so existence and "no bundle inside a bundle" are checked here.
 */
async function bundleProblem(bundle, selfId) {
  if (!bundle.isBundle) return null;

  const holders = (await catalogue.bundlesReferencing(new Set([selfId])))
    .filter((row) => row.id !== selfId);
  if (holders.length) {
    return `This product is inside ${listed(holders.map((row) => row.name))}, so it cannot be a bundle itself.`;
  }

  const choice = bundle.bundleType === 'choice';
  if (choice && !bundle.groups.length) return 'Add at least one choice for the customer to make.';
  if (!choice && !bundle.components.length) return 'A fixed bundle needs at least one product inside it.';

  const lists = choice
    ? bundle.groups.map((group) => ({ group, ids: group.options.map((option) => option.productId) }))
    : [{ group: null, ids: bundle.components.map((component) => component.productId) }];

  for (const { group, ids } of lists) {
    const label = group ? `“${group.label}”` : null;
    if (new Set(ids).size !== ids.length) {
      return label ? `${label} lists the same product twice.` : 'Each product may appear once.';
    }
    if (ids.includes(selfId)) {
      return label ? `${label} cannot offer the bundle itself.` : 'A bundle cannot contain itself.';
    }
    // Three picks from two options, with no repeats, is a picker the customer
    // can never satisfy. Caught here rather than at checkout.
    if (group && !group.allowRepeats && group.choose > ids.length) {
      return `${label} asks for ${group.choose} but offers only ${ids.length}. Add more options or allow repeats.`;
    }
    const rows = await catalogue.getProducts(ids);
    const missing = ids.filter((_, index) => !rows[index]);
    if (missing.length) return `No such product: ${missing.join(', ')}.`;
    const nested = rows.filter((row) => row.isBundle).map((row) => row.name);
    if (nested.length) return `A bundle cannot contain another bundle: ${listed(nested)}.`;
  }
  return null;
}

async function adminView(product) {
  return catalogue.adminProduct(product, catalogue.lookupOf(await catalogue.listProducts()));
}

router.get('/admin/products', requireAdmin, async (_req, res, next) => {
  try {
    const products = await catalogue.listProducts();
    const names = catalogue.lookupOf(products);
    res.json({ products: products.map((product) => catalogue.adminProduct(product, names)) });
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

    const bundle = bundleShape(body, null);
    const bundleIssue = await bundleProblem(bundle, body.id);
    if (bundleIssue) return badRequest(res, bundleIssue);

    const created = await catalogue.createProduct({ ...body, ...bundleFieldsFor(bundle) });
    if (created.duplicate) {
      return conflict(res, 'DUPLICATE', 'That product id is taken.');
    }
    return res.status(201).json({ product: await adminView(created.product) });
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

    const bundle = bundleShape(patch, existing);
    const bundleIssue = await bundleProblem(bundle, req.params.id);
    if (bundleIssue) return badRequest(res, bundleIssue);

    const product = await catalogue.updateProduct(req.params.id, { ...patch, ...bundleFieldsFor(bundle) });
    if (!product) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });
    return res.json({ product: await adminView(product) });
  } catch (error) { return next(error); }
});

router.delete('/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    // A product a bundle still contains or offers cannot go on its own; the
    // bundle would be left pointing at nothing.
    const holders = (await catalogue.bundlesReferencing(new Set([req.params.id])))
      .filter((row) => row.id !== req.params.id);
    if (holders.length) {
      return conflict(res, 'PRODUCT_IN_BUNDLE',
        `This product is inside a bundle: ${listed(holders.map((row) => row.name))}. Remove it from there first.`);
    }
    const removed = await catalogue.deleteProduct(req.params.id);
    if (!removed) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such product.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

// ------------------------------------------------------------ categories ----

/**
 * `group` is the storefront page a category is shown on (`/menu/cookies` and so
 * on). The printed categories are placed by the storefront's own plan; a
 * category created in the dashboard is not in that plan, so without this it
 * had nowhere to appear and everything filed under it was invisible.
 */
export const MENU_GROUP_IDS = ['cookies', 'desserts', 'drinks'];

const categoryBody = z.strictObject({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
  sort: z.number().int().min(-100000).max(100000).optional(),
  visible: z.boolean().optional(),
  group: z.enum(MENU_GROUP_IDS).optional(),
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
        group: category.group ?? '',
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
      return conflict(res, 'DUPLICATE', 'That category id is taken.');
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

/**
 * DELETE /api/menu/admin/categories/:id — refuses while it holds products.
 * `?withProducts=1` deletes them too; opt-in, because it cannot be undone.
 */
router.delete('/admin/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const withProducts = req.validatedQuery?.withProducts === '1';
    const result = await catalogue.deleteCategory(req.params.id, { withProducts });
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such category.' });
    if (result.blocked) {
      return conflict(res, 'CATEGORY_NOT_EMPTY',
        `Move or delete the ${result.productCount} product(s) in this category first.`);
    }
    if (result.blockers?.length) {
      return conflict(res, 'PRODUCT_IN_BUNDLE',
        `Some of these products are inside a bundle elsewhere: ${listed(result.blockers.map((row) => `${row.product} (in ${row.bundle})`))}. Remove them from it first.`);
    }
    if (!result.deletedProducts) return res.status(204).end();
    return res.json({ deletedProducts: result.deletedProducts });
  } catch (error) { return next(error); }
});

export default router;
