/**
 * Orders: placing one, tracking one, and running them from the dashboard.
 *
 * The route does shape validation and nothing else about money. Every figure is
 * decided inside `orderTransaction.js`, which reads the catalogue itself — see
 * the note at the top of that file about why nothing the browser sends about
 * price is looked at.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db.js';
import { requireAdmin } from '../adminSession.js';
import { createOrder, normalizePhone } from '../orderTransaction.js';
// The status model is shared with the dashboard, which imports the same file
// through its `@shared` alias — so the two cannot disagree about what a status
// is. Ported from Scooby verbatim along with the dashboard it drives.
import { ORDER_STATUSES } from '../../shared/orderStatus.mjs';
import { money as money2 } from '../../shared/pricing.mjs';

const router = Router();

/**
 * The checkout payload.
 *
 * Note what is *not* here: price, subtotal, discount, delivery, total. They are
 * not optional-and-ignored, they are absent from the schema, so a client that
 * sends them gets them stripped before anything downstream could read one by
 * accident. `expectedTotal` is the single exception and it can only cause a
 * refusal.
 */
const checkoutBody = z.object({
  idempotencyKey: z.string().min(8).max(120),
  items: z.array(z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(50),
  })).min(1, 'Your cart is empty.').max(60),
  firstName: z.string().min(1, 'We need a name for the order.').max(80),
  lastName: z.string().max(80).optional(),
  phone: z.string().min(6).max(24),
  email: z.string().email('That email does not look right.').max(160).or(z.literal('')).optional(),
  fulfilment: z.enum(['delivery', 'pickup']),
  area: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
  building: z.string().max(60).optional(),
  floor: z.string().max(40).optional(),
  apartment: z.string().max(40).optional(),
  landmark: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  promoCode: z.string().max(40).optional(),
  paymentMethod: z.enum(['cash', 'card']).optional(),
  lang: z.enum(['en', 'ar']).optional(),
  expectedTotal: z.number().nonnegative().optional(),
}).superRefine((body, ctx) => {
  // Delivery needs somewhere to deliver to. Enforced here rather than by making
  // the fields unconditionally required, because a pickup order legitimately
  // has none of them and would otherwise be impossible to place.
  if (body.fulfilment !== 'delivery') return;
  if (!body.area?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['area'], message: 'Choose your area.' });
  }
  if (!body.address?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['address'], message: 'We need a street address.' });
  }
});

function orderPayload(database, order) {
  const items = database
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(order.id);
  return {
    reference: order.reference,
    status: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    fulfilment: order.fulfilment,
    createdAt: order.created_at,
    customer: {
      firstName: order.first_name,
      lastName: order.last_name,
      phone: order.phone,
      email: order.email,
    },
    delivery: {
      area: order.area,
      address: order.address,
      building: order.building,
      floor: order.floor,
      apartment: order.apartment,
      landmark: order.landmark,
      notes: order.notes,
    },
    items: items.map((item) => ({
      productId: item.product_id,
      name: item.name,
      nameAr: item.name_ar || undefined,
      note: item.note || undefined,
      unitPrice: item.unit_price,
      qty: item.qty,
      lineTotal: item.line_total,
    })),
    totals: {
      subtotal: order.subtotal,
      discount: order.discount,
      delivery: order.delivery,
      total: order.total,
    },
    promoCode: order.promo_code || undefined,
  };
}

/** POST /api/orders — place an order. */
router.post('/', async (req, res, next) => {
  const parsed = checkoutBody.safeParse(req.body);
  if (!parsed.success) {
    // Field-keyed, so the checkout form can put each message under the input it
    // belongs to instead of showing one banner for everything.
    const fields = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({ error: 'INVALID', message: 'Check the form.', fields });
  }

  try {
    const { order, duplicate } = await createOrder(parsed.data);
    return res
      .status(duplicate ? 200 : 201)
      .json({ order: orderPayload(db.get(), order), duplicate });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        error: error.code, message: error.message, details: error.details,
      });
    }
    return next(error);
  }
});

/**
 * GET /api/orders/track/:reference?phone=... — public order tracking.
 *
 * The reference alone is not enough. References are sequential and guessable by
 * design (they have to be readable over the phone), so tracking on the
 * reference by itself would let anyone walk the whole order book and read every
 * customer's name, address and phone number. The phone is the second factor.
 */
router.get('/track/:reference', (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) {
    return res.status(400).json({
      error: 'PHONE_REQUIRED',
      message: 'Enter the phone number you ordered with.',
    });
  }
  const database = db.get();
  const order = database
    .prepare('SELECT * FROM orders WHERE reference = ? AND phone = ?')
    .get(String(req.params.reference).trim().toUpperCase(), phone);

  // One message for "no such reference" and for "wrong phone" alike: telling
  // them apart would confirm which references exist.
  if (!order) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'We could not find an order with that reference and phone number.',
    });
  }

  const history = database
    .prepare('SELECT status, note, created_at FROM order_status_history WHERE order_id = ? ORDER BY id')
    .all(order.id);
  res.json({ order: orderPayload(database, order), history });
});

// ---------------------------------------------------------------- admin ----

const STATUSES = ORDER_STATUSES;

/**
 * GET /api/orders — the dashboard list.
 *
 * Search is a scan-and-filter rather than a SQL prefix match, because the
 * useful query is a *substring* ("noha", "1650", "HC-10") and none of those are
 * prefixes of the column they match. At this shop's volume the whole table is
 * small; when it is not, this is the query that gets an FTS index.
 */
router.get('/', requireAdmin, (req, res) => {
  const database = db.get();
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 25));
  const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status)
    ? req.query.status
    : null;
  const q = String(req.query.q ?? '').trim().toLowerCase();

  const where = [];
  const params = {};
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (q) {
    // Matched against the fields somebody actually searches by. `LIKE` with a
    // leading wildcard cannot use an index, which is exactly why this is capped
    // and paginated rather than open-ended.
    where.push(`(
      LOWER(reference) LIKE @q OR LOWER(first_name) LIKE @q OR LOWER(last_name) LIKE @q
      OR phone LIKE @q OR LOWER(email) LIKE @q
    )`);
    params.q = `%${q}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = database.prepare(`SELECT COUNT(*) c FROM orders ${clause}`).get(params).c;
  const rows = database.prepare(`
    SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: perPage, offset: (page - 1) * perPage });

  res.json({
    orders: rows.map((order) => orderPayload(database, order)),
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  });
});

/**
 * GET /api/orders/stats?days=N — the aggregates the overview is built on.
 *
 * Shaped to the contract the ported dashboard expects: window totals, counts by
 * status / payment / fulfilment / area, the top products, and a *dense* daily
 * series. Dense matters — a day with no orders has to appear as a zero rather
 * than be missing, or the area chart draws a straight line between the days
 * either side of it and quietly invents trade that never happened.
 *
 * Aggregated in SQL rather than by loading every order and reducing in JS: the
 * whole point of this endpoint is that it answers over the entire table, not
 * over the 25 rows the list happens to be showing.
 */
router.get('/stats', requireAdmin, (req, res) => {
  const database = db.get();
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  // Inclusive of today, so `days = 7` is today plus the six before it.
  const since = `-${days - 1} days`;

  const totals = database.prepare(`
    SELECT
      COALESCE(SUM(total), 0)                                                   AS orderValue,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0)        AS paidRevenue,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN total END), 0)           AS fulfilledRevenue,
      COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total END), 0)           AS cancelledValue,
      COUNT(*)                                                                  AS count
    FROM orders
  `).get();

  const liveValue = money2(totals.orderValue - totals.cancelledValue);
  // Owed to the bakery: live and not yet paid. Never negative.
  const pendingValue = money2(Math.max(0, liveValue - totals.paidRevenue));
  // Owed back: taken as payment and then cancelled.
  const refundDueValue = money2(Math.max(0, database.prepare(`
    SELECT COALESCE(SUM(total), 0) AS v FROM orders
    WHERE status = 'cancelled' AND payment_status = 'paid'
  `).get().v));

  const group = (column) => Object.fromEntries(
    database.prepare(`SELECT ${column} AS k, COUNT(*) AS c FROM orders GROUP BY ${column}`)
      .all().map((row) => [row.k, row.c]),
  );

  const byFulfillmentRaw = group('fulfilment');
  const byArea = database.prepare(`
    SELECT area, COUNT(*) AS count FROM orders
    WHERE fulfilment = 'delivery' AND area <> ''
    GROUP BY area ORDER BY count DESC LIMIT 12
  `).all();

  const topProducts = database.prepare(`
    SELECT name, SUM(qty) AS quantity, SUM(line_total) AS value
    FROM order_items GROUP BY name ORDER BY quantity DESC LIMIT 10
  `).all();

  // One row per day that HAS orders, then filled out to every day in the
  // window below.
  const rows = database.prepare(`
    SELECT date(created_at) AS date,
           COUNT(*)                                                        AS orders,
           COALESCE(SUM(total), 0)                                         AS orderValue,
           COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS paidRevenue
    FROM orders
    WHERE date(created_at) >= date('now', ?)
    GROUP BY date(created_at)
  `).all(since);

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const daily = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = database
      .prepare("SELECT date('now', ?) AS d").get(`-${offset} days`).d;
    const row = byDate.get(date);
    daily.push({
      date,
      orders: row?.orders ?? 0,
      orderValue: money2(row?.orderValue ?? 0),
      paidRevenue: money2(row?.paidRevenue ?? 0),
    });
  }

  res.json({
    totals: {
      orderValue: money2(totals.orderValue),
      paidRevenue: money2(totals.paidRevenue),
      fulfilledRevenue: money2(totals.fulfilledRevenue),
      cancelledValue: money2(totals.cancelledValue),
      liveValue,
      pendingValue,
      refundDueValue,
      count: totals.count,
      averageOrderValue: totals.count ? money2(totals.orderValue / totals.count) : 0,
    },
    byStatus: group('status'),
    byPaymentStatus: group('payment_status'),
    byFulfillment: {
      delivery: byFulfillmentRaw.delivery ?? 0,
      pickup: byFulfillmentRaw.pickup ?? 0,
    },
    byArea,
    topProducts: topProducts.map((row) => ({
      name: row.name, quantity: row.quantity, value: money2(row.value),
    })),
    daily,
    days,
    orderCount: totals.count,
  });
});

router.get('/:reference', requireAdmin, (req, res) => {
  const database = db.get();
  const order = database
    .prepare('SELECT * FROM orders WHERE reference = ?')
    .get(String(req.params.reference).toUpperCase());
  if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such order.' });
  const history = database
    .prepare('SELECT status, note, created_at FROM order_status_history WHERE order_id = ? ORDER BY id')
    .all(order.id);
  res.json({ order: orderPayload(database, order), history });
});

router.patch('/:reference/status', requireAdmin, (req, res) => {
  const parsed = z.object({
    status: z.enum(STATUSES),
    note: z.string().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'INVALID',
      message: `Status must be one of: ${STATUSES.join(', ')}.`,
    });
  }

  const database = db.get();
  const reference = String(req.params.reference).toUpperCase();
  const order = database.prepare('SELECT * FROM orders WHERE reference = ?').get(reference);
  if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such order.' });

  // The status change and its history entry go together or not at all —
  // an order whose status moved with no record of who moved it or when is
  // exactly the row somebody will be arguing about later.
  database.transaction(() => {
    database.prepare(
      "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(parsed.data.status, order.id);
    database.prepare(
      'INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)',
    ).run(order.id, parsed.data.status, parsed.data.note ?? '');
  })();

  const updated = database.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: orderPayload(database, updated) });
});

export default router;
export { STATUSES };
