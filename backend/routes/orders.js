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
import { requireAdmin } from '../adminSession.js';
import { createOrder, normalizePhone } from '../orderTransaction.js';
import { validateParams, amount, identifier, email as emailSchema } from '../validation.js';
import { mailConfigured, sendOrderConfirmation } from '../mailer.js';
import { logEvent } from '../security.js';
// The status model is shared with the dashboard, which imports the same file
// through its `@shared` alias — so the two cannot disagree about what a status
// is.
import { ORDER_STATUSES } from '../../shared/orderStatus.mjs';
import { lineSignature } from '../../shared/pricing.mjs';
import * as orders from '../repo/orders.js';

const router = Router();
validateParams(router);
const STATUSES = ORDER_STATUSES;

/**
 * The checkout payload.
 *
 * Note what is *not* here: price, subtotal, discount, delivery, total. They are
 * not optional-and-ignored, they are absent from the schema, so a client that
 * sends them gets them stripped before anything downstream could read one by
 * accident. `expectedTotal` is the single exception and it can only cause a
 * refusal.
 */
const checkoutBody = z.strictObject({
  // Used as a Firestore document id, so held to characters one can take: a "/"
  // is read as a path and `__name__` is reserved, and both threw as a 500.
  idempotencyKey: z.string().min(8).max(120).regex(/^(?!__.*__$)[A-Za-z0-9._:-]+$/),
  items: z.array(z.strictObject({
    productId: identifier,
    qty: z.number().int().min(1).max(50),
    // The one option picked, for a product that has options.
    choice: z.string().trim().min(1).max(80).optional(),
    // A choice bundle's picks: which group, which product, how many.
    selections: z.array(z.strictObject({
      group: z.number().int().min(0).max(7),
      productId: identifier,
      quantity: z.number().int().min(1).max(12),
    })).max(96).optional(),
  })).min(1, 'Your cart is empty.').max(60),
  firstName: z.string().trim().min(1, 'We need a name for the order.').max(80),
  lastName: z.string().max(80).optional(),
  phone: z.string().min(6).max(24),
  email: emailSchema.or(z.literal('')).optional(),
  fulfilment: z.enum(['delivery', 'pickup']),
  area: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
  building: z.string().max(60).optional(),
  floor: z.string().max(40).optional(),
  apartment: z.string().max(40).optional(),
  landmark: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  promoCode: z.string().max(40).optional(),
  paymentMethod: z.literal('cash').optional(),
  lang: z.enum(['en', 'ar']).optional(),
  expectedTotal: amount.optional(),
}).superRefine((body, ctx) => {
  if (new Set(body.items.map((item) => lineSignature(item))).size !== body.items.length) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each product must appear once.' });
  }
  if (body.items.reduce((sum, item) => sum + item.qty, 0) > 100) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'Maximum 100 items per order.' });
  }
  // Delivery needs somewhere to deliver to. Enforced here rather than by making
  // the fields unconditionally required, because a pickup order legitimately
  // has none of them and would otherwise be impossible to place.
  if (body.fulfilment !== 'delivery') return;
  if (!body.area?.trim()) ctx.addIssue({ code: 'custom', path: ['area'], message: 'Choose your area.' });
  if (!body.address?.trim()) ctx.addIssue({ code: 'custom', path: ['address'], message: 'We need a street address.' });
});

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
    // Field names only — never the values, which are a customer's details.
    logEvent('order_rejected', req, { code: 'INVALID', fields: Object.keys(fields).slice(0, 12) });
    return res.status(400).json({ error: 'INVALID', message: 'Check the form.', fields });
  }

  try {
    const { order, duplicate } = await createOrder(parsed.data);

    // The confirmation goes out AFTER the order has committed, and its failure
    // is swallowed. Three things are load-bearing here:
    //
    //   It is not awaited. A slow or unreachable provider must not hold the
    //   customer on a spinner after their order already exists — they would
    //   retry, and the only thing standing between that and a second order is
    //   an idempotency key they cannot see.
    //
    //   It is guarded by `!duplicate`. A retried submission returns the
    //   original order, and emailing on that path is how one order becomes
    //   three identical receipts in somebody's inbox.
    //
    //   It cannot reject into an unhandled rejection. `sendMail` throws when
    //   the provider is missing or refuses; that is logged and dropped, because
    //   an order that is already in the database is not undone by a mail
    //   failure and must not be reported as failed. §74.
    //
    // And it is not attempted at all while email is switched off, which it is
    // for launch — a log line per order saying mail failed would be noise.
    if (!duplicate && mailConfigured()) {
      sendOrderConfirmation(order, parsed.data.lang)
        .then((result) => {
          if (result.delivered) logEvent('order_email_sent', req, { reference: order.reference });
        })
        .catch((error) => logEvent('order_email_failed', req, {
          reference: order.reference,
          // The code, never the provider's message: it can quote the recipient
          // address back and this goes to a shared log.
          code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
        }));
    }

    return res.status(duplicate ? 200 : 201)
      .json({ order: orders.orderPayload(order), duplicate });
  } catch (error) {
    if (error.status) {
      logEvent('order_rejected', req, { code: error.code, status: error.status });
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
router.get('/track/:reference', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) {
      return res.status(400).json({
        error: 'PHONE_REQUIRED', message: 'Enter the phone number you ordered with.',
      });
    }
    const order = await orders.getOrderForTracking(req.params.reference, phone);
    // One message for "no such reference" and for "wrong phone" alike: telling
    // them apart would confirm which references exist.
    if (!order) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'We could not find an order with that reference and phone number.',
      });
    }

    const output = orders.orderPayload(order);
    // Reference + phone is a convenience lookup, not proof of identity. Return
    // tracking information without contact/address or private staff notes.
    output.customer = { firstName: '', lastName: '', phone: '', email: '' };
    output.delivery = {
      area: order.area ?? '', address: '', building: '', floor: '',
      apartment: '', landmark: '', notes: '',
    };
    return res.json({
      order: output,
      history: orders.historyOut(order).map(({ status, created_at }) => ({ status, created_at, note: '' })),
    });
  } catch (error) { return next(error); }
});

// ---------------------------------------------------------------- admin ----

/** GET /api/orders — the dashboard list. */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const query = req.validatedQuery ?? {};
    res.json(await orders.listOrders({
      page: Math.max(1, Number(query.page) || 1),
      perPage: Math.min(100, Math.max(1, Number(query.perPage) || 25)),
      status: STATUSES.includes(query.status) ? query.status : null,
      // Filtered by the query, not after it: filtering one page of results would
      // make the page short and the total count everything.
      fulfilment: ['delivery', 'pickup'].includes(query.fulfilment) ? query.fulfilment : null,
      q: query.q ?? '',
    }));
  } catch (error) { next(error); }
});

/** GET /api/orders/stats?days=N — the aggregates the overview is built on. */
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.validatedQuery?.days) || 30));
    res.json(await orders.orderStats({ days }));
  } catch (error) { next(error); }
});

router.get('/:reference', requireAdmin, async (req, res, next) => {
  try {
    const order = await orders.getOrder(req.params.reference);
    if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such order.' });
    return res.json({ order: orders.orderPayload(order), history: orders.historyOut(order) });
  } catch (error) { return next(error); }
});

router.patch('/:reference/status', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.strictObject({
      status: z.enum(STATUSES),
      note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID', message: `Status must be one of: ${STATUSES.join(', ')}.`,
      });
    }

    const result = await orders.changeOrderStatus(
      req.params.reference, parsed.data.status, parsed.data.note,
      { actor: 'admin', requestId: req.requestId },
    );
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such order.' });
    if (result.rejected) {
      return res.status(409).json({ error: 'INVALID_TRANSITION', message: result.rejected });
    }

    const updated = await orders.getOrder(req.params.reference);
    return res.json({ order: orders.orderPayload(updated) });
  } catch (error) { return next(error); }
});

/**
 * PATCH /api/orders/:reference/payment — record whether the cash was collected.
 *
 * Cash on delivery is the only way to pay, so this is internal bookkeeping set
 * by staff after the handover. No payment provider is involved and nothing here
 * claims one was.
 */
router.patch('/:reference/payment', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.strictObject({ paymentStatus: z.enum(['paid', 'unpaid']) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID', message: 'Payment status must be paid or unpaid.' });
    }
    const result = await orders.setCashCollected(
      req.params.reference, parsed.data.paymentStatus === 'paid',
      { actor: 'admin', requestId: req.requestId },
    );
    if (!result.found) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such order.' });
    if (result.rejected) {
      return res.status(409).json({ error: 'INVALID_PAYMENT_UPDATE', message: result.rejected });
    }
    const updated = await orders.getOrder(req.params.reference);
    return res.json({ order: orders.orderPayload(updated) });
  } catch (error) { return next(error); }
});

export default router;
export { STATUSES };
