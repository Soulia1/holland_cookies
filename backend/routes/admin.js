import { validateParams, amount, imagePath, identifier, email as emailSchema } from '../validation.js';
/**
 * Sign-in, customers, discounts and shop settings.
 *
 * Grouped into one router because each is small and they share an audience:
 * everything here except the sign-in exchange itself is admin-only.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db.js';
import { money } from '../../shared/pricing.mjs';
import { logEvent } from '../security.js';
import {
  clearSession, issueSession, matchesMasterKey, readSession, requireAdmin,
} from '../adminSession.js';

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
router.post('/session', (req, res) => {
  const key = z.strictObject({ key: z.string().min(1).max(200) }).safeParse(req.body);
  if (!key.success || !matchesMasterKey(key.data.key)) {
    logEvent('admin_login_failed',req);
    // Deliberately vague and deliberately the same shape for a malformed body
    // and a wrong key.
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'That key was not accepted.' });
  }
  issueSession(res);
  logEvent('admin_login',req);
  res.json({ ok: true });
});

router.delete('/session', (req, res) => {
  clearSession(res, req);
  res.json({ ok: true });
});

/** GET /api/admin/session — "am I signed in?", for the dashboard's gate. */
router.get('/session', (req, res) => {
  res.json({ signedIn: !!readSession(req, res) });
});

// ------------------------------------------------------------- customers ----

router.get('/customers', requireAdmin, (req, res) => {
  const database = db.get();
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 25));
  const q = String(req.query.q ?? '').trim().toLowerCase();

  const clause = q
    ? `WHERE LOWER(first_name) LIKE @q OR LOWER(last_name) LIKE @q
       OR phone LIKE @q OR LOWER(email) LIKE @q`
    : '';
  const params = q ? { q: `%${q}%` } : {};

  const total = database.prepare(`SELECT COUNT(*) c FROM customers ${clause}`).get(params).c;
  const rows = database.prepare(`
    SELECT * FROM customers ${clause} ORDER BY total_spent DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  res.json({
    customers: rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      ordersCount: row.orders_count,
      totalSpent: row.total_spent,
      createdAt: row.created_at,
    })),
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  });
});

router.get('/customers/:phone', requireAdmin, (req, res) => {
  const database = db.get();
  const customer = database.prepare('SELECT * FROM customers WHERE phone = ?').get(req.params.phone);
  if (!customer) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such customer.' });
  const orders = database
    .prepare('SELECT reference, status, total, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC')
    .all(customer.id);
  res.json({
    customer: {
      id: customer.id,
      phone: customer.phone,
      firstName: customer.first_name,
      lastName: customer.last_name,
      email: customer.email,
      ordersCount: customer.orders_count,
      totalSpent: customer.total_spent,
    },
    orders,
  });
});

/**
 * GET /api/admin/users — the customer directory.
 *
 * One row per person with their orders folded in, shaped for the ported
 * dashboard's Users page. Holland has no accounts — a customer record is
 * created by their first order — so `hasAccount` is always false and the page
 * reads as a directory of people who have ordered, which is what it is.
 *
 * Aggregated over every order rather than a page of them: the totals are the
 * point of this screen, and a total over 25 rows is not a total.
 */
router.get('/users', requireAdmin, (req, res) => {
  const database = db.get();
  // The embedded order list is capped so one customer with four hundred orders
  // cannot make this response enormous. The counts and totals below are
  // computed over all of them regardless, and `truncatedOrders` says how many
  // the list left out.
  const ORDER_CAP = 25;

  const customers = database.prepare(`
    SELECT * FROM customers ORDER BY total_spent DESC, id DESC
  `).all();

  const orderRows = database.prepare(`
    SELECT o.id, o.reference, o.phone, o.total, o.status, o.payment_status,
           o.fulfilment, o.area, o.created_at,
           (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS itemCount
    FROM orders o ORDER BY o.id DESC
  `).all();

  const byPhone = new Map();
  for (const row of orderRows) {
    if (!byPhone.has(row.phone)) byPhone.set(row.phone, []);
    byPhone.get(row.phone).push(row);
  }

  const users = customers.map((customer) => {
    const orders = byPhone.get(customer.phone) ?? [];
    const cancelled = orders.filter((order) => order.status === 'cancelled');
    const live = orders.filter((order) => order.status !== 'cancelled');
    const paid = orders.filter((order) => order.payment_status === 'paid');
    const totalSpent = money(live.reduce((sum, order) => sum + order.total, 0));

    return {
      key: customer.phone,
      // Empty because there is no profile document — this person never signed
      // in, because there is nothing to sign in to.
      id: '',
      email: customer.email || '',
      name: `${customer.first_name} ${customer.last_name}`.trim(),
      phone: customer.phone,
      hasAccount: false,
      accountCreatedAt: null,
      defaultArea: orders[0]?.area || '',
      orderCount: orders.length,
      totalSpent,
      cancelledValue: money(cancelled.reduce((sum, order) => sum + order.total, 0)),
      paidValue: money(paid.reduce((sum, order) => sum + order.total, 0)),
      cancelledCount: cancelled.length,
      averageOrderValue: live.length ? money(totalSpent / live.length) : 0,
      firstOrderAt: orders.length ? orders[orders.length - 1].created_at : null,
      lastOrderAt: orders.length ? orders[0].created_at : null,
      orders: orders.slice(0, ORDER_CAP).map((order) => ({
        id: order.reference,
        orderId: order.reference,
        total: order.total,
        status: order.status,
        paymentStatus: order.payment_status,
        fulfillmentType: order.fulfilment,
        fulfillmentDate: null,
        area: order.area || '',
        itemCount: order.itemCount,
        createdAt: order.created_at,
      })),
      truncatedOrders: Math.max(0, orders.length - ORDER_CAP),
    };
  });

  // Orders whose phone matches no customer record. Should be none — the order
  // transaction upserts a customer — but a directory that silently omits an
  // order is worse than one that admits it cannot attribute it.
  const known = new Set(customers.map((customer) => customer.phone));
  const anonymousOrders = orderRows.filter((order) => !known.has(order.phone)).length;

  res.json({
    users,
    totals: {
      users: users.length,
      withAccount: 0,
      guests: users.length,
      repeatCustomers: users.filter((user) => user.orderCount > 1).length,
      neverOrdered: users.filter((user) => user.orderCount === 0).length,
      orderValue: money(orderRows.reduce((sum, order) => sum + order.total, 0)),
      anonymousOrders,
    },
  });
});

// ---------------------------------------------------------------- promos ----

const promoShape = z.strictObject({
  code: z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/,
    'Letters, numbers, hyphens and underscores only.'),
  type: z.enum(['percent', 'fixed']),
  value: z.number().positive().max(1000000),
  minSubtotal: amount.optional(),
  maxUses: z.number().int().nonnegative().max(1000000).optional(),
  active: z.boolean().optional(),
  expiresAt: z.string().datetime().nullish(),
});
const promoBody=promoShape.superRefine((body, ctx) => {
  if (body.type === 'percent' && body.value >= 100) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage must be below 100.' });
  }
});

function promoOut(row) {
  return {
    code: row.code,
    type: row.type,
    value: row.value,
    minSubtotal: row.min_subtotal,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    active: !!row.active,
    expiresAt: row.expires_at,
  };
}

router.get('/promos', requireAdmin, (_req, res) => {
  const rows = db.get().prepare('SELECT * FROM promos ORDER BY created_at DESC').all();
  res.json({ promos: rows.map(promoOut) });
});

router.post('/promos', requireAdmin, (req, res) => {
  const parsed = promoBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'INVALID', message: 'Check the fields.', details: parsed.error.issues,
    });
  }
  const body = parsed.data;
  // Stored and compared uppercase, so a customer typing `welcome10` gets the
  // same discount as one typing `WELCOME10`.
  const code = body.code.toUpperCase();
  try {
    db.get().prepare(`
      INSERT INTO promos (code, type, value, min_subtotal, max_uses, active, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(code, body.type, body.value, body.minSubtotal ?? 0, body.maxUses ?? 0,
      body.active === false ? 0 : 1, body.expiresAt ?? null);
  } catch {
    return res.status(409).json({ error: 'DUPLICATE', message: 'That code already exists.' });
  }
  res.status(201).json({ promo: promoOut(db.get().prepare('SELECT * FROM promos WHERE code = ?').get(code)) });
});

router.patch('/promos/:code', requireAdmin, (req, res) => {
  const parsed = promoShape.partial().omit({ code: true }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID', message: 'Check the fields.' });
  }
  const existing=db.get().prepare('SELECT * FROM promos WHERE code=?').get(String(req.params.code).toUpperCase());
  if(!existing)return res.status(404).json({error:'NOT_FOUND',message:'No such code.'});
  const business=promoBody.safeParse({code:existing.code,type:parsed.data.type??existing.type,value:parsed.data.value??existing.value,
    minSubtotal:parsed.data.minSubtotal??existing.min_subtotal,maxUses:parsed.data.maxUses??existing.max_uses,
    active:parsed.data.active??!!existing.active,expiresAt:parsed.data.expiresAt===undefined?existing.expires_at:parsed.data.expiresAt});
  if(!business.success || (business.data.maxUses>0 && business.data.maxUses<existing.used_count))return res.status(400).json({error:'INVALID',message:'Invalid discount configuration.'});
  const column = {
    type: 'type', value: 'value', minSubtotal: 'min_subtotal',
    maxUses: 'max_uses', active: 'active', expiresAt: 'expires_at',
  };
  const sets = [];
  const values = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!column[key]) continue;
    sets.push(`${column[key]} = @${key}`);
    values[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  if (!sets.length) return res.json({ ok: true });
  const info = db.get().prepare(
    `UPDATE promos SET ${sets.join(', ')} WHERE code = @code`,
  ).run({ ...values, code: String(req.params.code).toUpperCase() });
  if (!info.changes) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such code.' });
  res.json({ ok: true });
});

router.delete('/promos/:code', requireAdmin, (req, res) => {
  const info = db.get().prepare('DELETE FROM promos WHERE code = ?')
    .run(String(req.params.code).toUpperCase());
  if (!info.changes) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such code.' });
  res.status(204).end();
});

/**
 * POST /api/admin/promos/validate — used by the storefront, not the dashboard.
 *
 * Mounted here beside the definitions it reads. Public, because the checkout
 * has to tell a customer their code is good *before* they commit to the order —
 * but it returns only the discount, never the promo's configuration, and the
 * authoritative evaluation still happens inside the order transaction.
 */
router.post('/promos/validate', async (req, res) => {
  const parsed = z.strictObject({
    code: z.string().min(1).max(40),
    subtotal: amount,
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID', message: 'Enter a code.' });

  const { evaluatePromo } = await import('../orderTransaction.js');
  const promo = db.get().prepare('SELECT * FROM promos WHERE code = ?')
    .get(parsed.data.code.trim().toUpperCase());
  const result = evaluatePromo(promo, parsed.data.subtotal);
  if (!result.valid) return res.status(400).json({ error: 'INVALID_PROMO', message: result.reason });
  res.json({ code: promo.code, discount: result.discount });
});

// -------------------------------------------------------------- settings ----

/** GET /api/admin/settings — public: the storefront needs the delivery fee. */
router.get('/settings', (_req, res) => {
  const row = db.get().prepare('SELECT * FROM settings WHERE id = 1').get();
  res.json({
    settings: {
      deliveryFee: row.delivery_fee,
      freeDeliveryOver: row.free_delivery_over,
      acceptingOrders: !!row.accepting_orders,
      areas: JSON.parse(row.areas || '[]'),
    },
  });
});

router.patch('/settings', requireAdmin, (req, res) => {
  const parsed = z.strictObject({
    deliveryFee: amount.optional(),
    freeDeliveryOver: amount.optional(),
    acceptingOrders: z.boolean().optional(),
    areas: z.array(z.strictObject({
      id: z.string().min(1).max(60),
      name: z.string().min(1).max(120),
      nameAr: z.string().max(120).optional(),
    })).max(80).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'INVALID', message: 'Check the fields.', details: parsed.error.issues,
    });
  }
  const column = {
    deliveryFee: 'delivery_fee', freeDeliveryOver: 'free_delivery_over',
    acceptingOrders: 'accepting_orders', areas: 'areas',
  };
  const sets = [];
  const values = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    sets.push(`${column[key]} = @${key}`);
    values[key] = key === 'areas'
      ? JSON.stringify(value)
      : (typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (sets.length) {
    db.get().prepare(
      `UPDATE settings SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    ).run(values);
  }
  res.json({ ok: true });
});

export default router;
