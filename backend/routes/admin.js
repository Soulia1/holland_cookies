/**
 * Sign-in, customers, discounts and shop settings.
 *
 * Grouped into one router because each is small and they share an audience:
 * everything here except the sign-in exchange, the promo validation and the
 * public settings read is admin-only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { money } from '../../shared/pricing.mjs';
import { mailConfigured } from '../mailer.js';
import { logEvent } from '../security.js';
import { validateParams, amount } from '../validation.js';
import {
  clearSession, issueSession, matchesMasterKey, readSession, requireAdmin,
} from '../adminSession.js';
import * as people from '../repo/people.js';
import * as shop from '../repo/shop.js';
import * as orderRepo from '../repo/orders.js';
import { versionOf } from '../mirror.js';

const router = Router();
validateParams(router);

// ------------------------------------------------------------------ auth ----

/**
 * POST /api/admin/session — exchange the master key for a session cookie.
 *
 * Rate limited by the caller (see server.js): this is the one endpoint where
 * guessing is the attack, and the key is a single shared secret rather than a
 * per-user password with a lockout behind it.
 */
router.post('/session', async (req, res, next) => {
  try {
    const key = z.strictObject({ key: z.string().min(1).max(200) }).safeParse(req.body);
    if (!key.success || !matchesMasterKey(key.data.key)) {
      logEvent('admin_login_failed', req);
      // Deliberately vague and deliberately the same shape for a malformed body
      // and a wrong key.
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'That key was not accepted.' });
    }
    await issueSession(res);
    logEvent('admin_login', req);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

router.delete('/session', async (req, res, next) => {
  try {
    await clearSession(res, req);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/** GET /api/admin/session — "am I signed in?", for the dashboard's gate. */
router.get('/session', async (req, res, next) => {
  try {
    res.json({ signedIn: !!(await readSession(req)) });
  } catch (error) { next(error); }
});

// ------------------------------------------------------------- customers ----

router.get('/customers', requireAdmin, async (req, res, next) => {
  try {
    const query = req.validatedQuery ?? {};
    res.json(await people.searchCustomers({
      page: Math.max(1, Number(query.page) || 1),
      perPage: Math.min(100, Math.max(1, Number(query.perPage) || 25)),
      q: query.q ?? '',
    }));
  } catch (error) { next(error); }
});

router.get('/customers/:phone', requireAdmin, async (req, res, next) => {
  try {
    const customer = await people.getCustomer(req.params.phone);
    if (!customer) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such customer.' });
    const orders = await orderRepo.ordersForPhone(customer.phone);
    return res.json({
      customer: people.customerOut(customer),
      orders: orders.map((order) => ({
        reference: order.reference,
        status: order.status,
        total: order.total,
        created_at: orderRepo.iso(order.createdAt),
      })),
    });
  } catch (error) { return next(error); }
});

/**
 * GET /api/admin/users — the customer directory.
 *
 * One row per person with their orders folded in, shaped for the ported
 * dashboard's Users page. Holland's customer records are created by a first
 * order, so `hasAccount` reflects whether that person later proved an email and
 * opened an account.
 *
 * Aggregated over every order rather than a page of them: the totals are the
 * point of this screen, and a total over 25 rows is not a total.
 *
 * This is the most expensive read in the system — it walks the whole orders
 * collection — so it is rate limited as a `report` class and is the first
 * candidate for a maintained aggregate if the shop outgrows it.
 */
/**
 * The last directory built from the mirrors, and the version of customers and
 * orders it was built from. Rebuilt only when either changes.
 */
let directory = null;

router.get('/users', requireAdmin, async (_req, res, next) => {
  try {
    const version = versionOf('customers', 'orders');
    // Held as the serialised text: at a few thousand customers, turning the
    // object into JSON was most of what was left of this request.
    if (version && directory?.version === version) return res.type('json').send(directory.json);

    // The embedded order list is capped so one customer with four hundred
    // orders cannot make this response enormous. The counts and totals below
    // are computed over all of them regardless, and `truncatedOrders` says how
    // many the list left out.
    const ORDER_CAP = 25;

    const [customers, orderDocs] = await Promise.all([
      people.allCustomers(),
      orderRepo.listAllOrdersForReporting(),
    ]);

    const byPhone = new Map();
    for (const order of orderDocs) {
      if (!byPhone.has(order.phone)) byPhone.set(order.phone, []);
      byPhone.get(order.phone).push(order);
    }

    const users = customers.map((customer) => {
      const orders = byPhone.get(customer.phone) ?? [];
      const cancelled = orders.filter((order) => order.status === 'cancelled');
      const live = orders.filter((order) => order.status !== 'cancelled');
      const paid = orders.filter((order) => order.paymentStatus === 'paid');
      const totalSpent = money(live.reduce((sum, order) => sum + (order.total ?? 0), 0));
      const claimed = orders.find((order) => order.profileId);

      return {
        key: customer.phone,
        id: claimed?.profileId ?? '',
        email: customer.email || '',
        name: `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim(),
        phone: customer.phone,
        hasAccount: !!claimed,
        accountCreatedAt: null,
        defaultArea: orders[0]?.area || '',
        orderCount: orders.length,
        totalSpent,
        cancelledValue: money(cancelled.reduce((sum, order) => sum + (order.total ?? 0), 0)),
        paidValue: money(paid.reduce((sum, order) => sum + (order.total ?? 0), 0)),
        cancelledCount: cancelled.length,
        averageOrderValue: live.length ? money(totalSpent / live.length) : 0,
        firstOrderAt: orders.length ? orderRepo.iso(orders[orders.length - 1].createdAt) : null,
        lastOrderAt: orders.length ? orderRepo.iso(orders[0].createdAt) : null,
        orders: orders.slice(0, ORDER_CAP).map((order) => ({
          id: order.reference,
          orderId: order.reference,
          total: order.total,
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentType: order.fulfilment,
          fulfillmentDate: null,
          area: order.area || '',
          itemCount: (order.items ?? []).reduce((sum, item) => sum + (item.qty ?? 0), 0),
          createdAt: orderRepo.iso(order.createdAt),
        })),
        truncatedOrders: Math.max(0, orders.length - ORDER_CAP),
      };
    });

    // Orders whose phone matches no customer record. Should be none — the order
    // transaction upserts a customer — but a directory that silently omits an
    // order is worse than one that admits it cannot attribute it.
    const known = new Set(customers.map((customer) => customer.phone));
    const anonymousOrders = orderDocs.filter((order) => !known.has(order.phone)).length;

    const body = {
      users,
      totals: {
        users: users.length,
        withAccount: users.filter((user) => user.hasAccount).length,
        guests: users.filter((user) => !user.hasAccount).length,
        repeatCustomers: users.filter((user) => user.orderCount > 1).length,
        neverOrdered: users.filter((user) => user.orderCount === 0).length,
        // Cancelled orders left out, like each customer's `totalSpent` and as
        // the dashboard labels it. Summing them made the headline disagree with
        // the rows beneath it.
        orderValue: money(orderDocs
          .filter((order) => order.status !== 'cancelled')
          .reduce((sum, order) => sum + (order.total ?? 0), 0)),
        anonymousOrders,
      },
    };
    // Kept only if nothing changed while it was being built.
    const json = JSON.stringify(body);
    if (version && versionOf('customers', 'orders') === version) directory = { version, json };
    return res.type('json').send(json);
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------- promos ----

const promoShape = z.strictObject({
  // `__name__` is reserved by Firestore for its own ids.
  code: z.string().min(2).max(40).regex(/^(?!__.*__$)[A-Za-z0-9_-]+$/, 'Letters, numbers, hyphens and underscores only.'),
  type: z.enum(['percent', 'fixed']),
  value: z.number().positive().max(1000000),
  minSubtotal: amount.optional(),
  maxUses: z.number().int().nonnegative().max(1000000).optional(),
  active: z.boolean().optional(),
  // A full ISO timestamp or nothing. The dashboard turns its date picker into
  // the end of that day before sending; an empty string is never an expiry.
  expiresAt: z.string().datetime({ offset: true }).nullish(),
});

const promoBody = promoShape.superRefine((body, ctx) => {
  if (body.type === 'percent' && body.value >= 100) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage must be below 100.' });
  }
});

router.get('/promos', requireAdmin, async (_req, res, next) => {
  try {
    const promos = await shop.listPromos();
    res.json({ promos: promos.map(shop.promoOut) });
  } catch (error) { next(error); }
});

router.post('/promos', requireAdmin, async (req, res, next) => {
  try {
    const parsed = promoBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID', message: 'Check the fields.', details: parsed.error.issues });
    }
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({
        error: 'INVALID', message: 'Check the fields.',
        details: [{ path: ['expiresAt'], message: 'That expiry date has already passed.' }],
      });
    }
    const created = await shop.createPromo(parsed.data);
    if (created.duplicate) {
      return res.status(409).json({ error: 'DUPLICATE', message: 'That code already exists.' });
    }
    return res.status(201).json({ promo: created.promo });
  } catch (error) { return next(error); }
});

router.patch('/promos/:code', requireAdmin, async (req, res, next) => {
  try {
    const parsed = promoShape.partial().omit({ code: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID', message: 'Check the fields.' });

    const existing = await shop.getPromo(req.params.code);
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such code.' });

    // The patch is validated as a whole promo laid over the stored one, so a
    // change that is fine alone but invalid in combination is caught.
    const merged = promoBody.safeParse({
      code: existing.code,
      type: parsed.data.type ?? existing.type,
      value: parsed.data.value ?? existing.value,
      minSubtotal: parsed.data.minSubtotal ?? existing.minSubtotal ?? 0,
      maxUses: parsed.data.maxUses ?? existing.maxUses ?? 0,
      active: parsed.data.active ?? !!existing.active,
      expiresAt: parsed.data.expiresAt === undefined ? existing.expiresAt : parsed.data.expiresAt,
    });
    // Lowering the cap below what has already been redeemed would make the used
    // count exceed the maximum, which nothing downstream expects.
    if (!merged.success || (merged.data.maxUses > 0 && merged.data.maxUses < (existing.usedCount ?? 0))) {
      return res.status(400).json({ error: 'INVALID', message: 'Invalid discount configuration.' });
    }

    const result = await shop.updatePromo(req.params.code, parsed.data);
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such code.' });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

router.delete('/promos/:code', requireAdmin, async (req, res, next) => {
  try {
    const removed = await shop.deletePromo(req.params.code);
    if (!removed) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such code.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

/**
 * POST /api/admin/promos/validate — used by the storefront, not the dashboard.
 *
 * Mounted here beside the definitions it reads. Public, because the checkout
 * has to tell a customer their code is good *before* they commit to the order —
 * but it returns only the discount, never the promo's configuration, and the
 * authoritative evaluation still happens inside the order transaction.
 */
router.post('/promos/validate', async (req, res, next) => {
  try {
    const parsed = z.strictObject({
      code: z.string().min(1).max(40),
      subtotal: amount,
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID', message: 'Enter a code.' });
    // A code that cannot name a promo is simply not one. Refused here rather than
    // handed to Firestore, which reads a "/" as a path and throws.
    if (!shop.isPromoCode(shop.normalizeCode(parsed.data.code))) {
      return res.status(400).json({ error: 'INVALID_PROMO', message: 'That code is not recognised.' });
    }

    const { evaluatePromo } = await import('../orderTransaction.js');
    const promo = await shop.getPromo(parsed.data.code);
    const result = evaluatePromo(promo, parsed.data.subtotal);
    if (!result.valid) return res.status(400).json({ error: 'INVALID_PROMO', message: result.reason });
    return res.json({ code: promo.code, discount: result.discount });
  } catch (error) { return next(error); }
});

// -------------------------------------------------------------- settings ----

/** GET /api/admin/settings — public: the storefront needs the delivery fee. */
router.get('/settings', async (_req, res, next) => {
  try {
    const settings = await shop.getSettings();
    res.json({
      settings: {
        deliveryFee: settings.deliveryFee,
        freeDeliveryOver: settings.freeDeliveryOver,
        acceptingOrders: !!settings.acceptingOrders,
        areas: settings.areas ?? [],
        emailEnabled: mailConfigured(),
      },
    });
  } catch (error) { next(error); }
});

router.patch('/settings', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.strictObject({
      deliveryFee: amount.optional(),
      freeDeliveryOver: amount.optional(),
      acceptingOrders: z.boolean().optional(),
      areas: z.array(z.strictObject({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(120),
        nameAr: z.string().max(120).optional(),
        // The governorate, which checkout groups the select by. Optional: areas
        // saved before this field existed keep working and simply show in an
        // unlabelled group.
        city: z.string().max(60).optional(),
        cityAr: z.string().max(60).optional(),
        // What delivery to this area costs. Nullable rather than merely
        // optional: `null` is how the dashboard says "back to the shop's
        // default", and leaving the key out of a whole-array write could only
        // ever mean the same thing as sending nothing at all.
        fee: amount.nullable().optional(),
      })).max(80).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID', message: 'Check the fields.', details: parsed.error.issues });
    }
    await shop.updateSettings(parsed.data);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

export default router;
