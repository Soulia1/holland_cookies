import { validateParams, amount, imagePath, identifier, email as emailSchema } from '../validation.js';
/**
 * Customer accounts: signing in, the profile, and order history.
 *
 * Sign-in is a one-time code emailed to an address. There is no password, which
 * removes an entire class of problem — nothing to reuse across sites, nothing
 * to leak, nothing to reset. The address is proved by the code coming back, and
 * that proof is what makes it safe to attach past guest orders to the account.
 */

import { Router } from 'express';
import { z } from 'zod';
import { limit } from '../security.js';
import * as db from '../db.js';
import {
  claimProfile, clearCustomerSession, issueCustomerSession, readCustomer, requireCustomer,
} from '../customerAuth.js';
import { isEmail, normalizeEmail, requestCode, verifyCode } from '../otp.js';
import { mailConfigured, sendSignInCode } from '../mailer.js';

const router = Router();
validateParams(router);

/**
 * Per-IP limits on top of the per-address quota in otp.js.
 *
 * The two catch different attacks: the per-address quota stops one mailbox
 * being flooded, and this stops one machine walking many addresses.
 */
const requestCodeLimiter = limit('otp-request', 60 * 60 * 1000, 20);

const verifyLimiter = limit('otp-verify', 15 * 60 * 1000, 30);

// ------------------------------------------------------------------ auth ----

/** POST /api/account/request-code */
router.post('/request-code', requestCodeLimiter, async (req, res, next) => {
  const parsed = z.strictObject({
    email: emailSchema,
    lang: z.enum(['en', 'ar']).optional(),
  }).safeParse(req.body);
  if (!parsed.success || !isEmail(parsed.data.email)) {
    return res.status(400).json({ error: 'INVALID_EMAIL', message: 'That email does not look right.' });
  }

  const result = await requestCode(parsed.data.email);
  if (!result.ok) {
    if (['COOLDOWN','RATE_LIMITED','BUSY'].includes(result.code)) res.set('Retry-After', String(result.retryAfter || 60));
    return res.status(['COOLDOWN','RATE_LIMITED','BUSY'].includes(result.code) ? 429 : 400).json({
      error: result.code, message: result.message, retryAfter: result.retryAfter,
    });
  }

  try {
    const delivery = await sendSignInCode(result.email, result.code, parsed.data.lang);
    return res.json({
      ok: true,
      // True only when a provider actually accepted it. The sign-in sheet uses
      // this to tell the customer where to look, and in development it says
      // plainly that the code is in the server log instead.
      delivered: delivery.delivered,
      via: delivery.via,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    return next(error);
  }
});

/** POST /api/account/verify-code */
router.post('/verify-code', verifyLimiter, async (req, res) => {
  const parsed = z.strictObject({
    email: emailSchema,
    code: z.string().regex(/^\d{6}$/),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_CODE', message: 'That code is not right.' });
  }

  const result = await verifyCode(parsed.data.email, parsed.data.code);
  if (!result.ok) {
    return res.status(400).json({ error: result.code, message: result.message });
  }

  const { profile, linkedOrders } = claimProfile(normalizeEmail(result.email));
  issueCustomerSession(res, { profileId: profile.id, email: profile.email });

  res.json({
    customer: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone,
      defaultArea: profile.default_area,
      defaultAddress: profile.default_address,
    },
    // How many past guest orders were just attached, so the sheet can say
    // "we found 3 previous orders" rather than dropping them in silently.
    linkedOrders,
  });
});

router.post('/signout', (req, res) => {
  clearCustomerSession(res, req);
  res.json({ ok: true });
});

/**
 * GET /api/account/me
 *
 * Answers for a signed-out visitor too, with `customer: null`, because every
 * page asks this on load and a 401 for the ordinary anonymous case would be
 * noise in the console rather than information.
 */
router.get('/me', (req, res) => {
  res.json({
    customer: readCustomer(req, res),
    mailConfigured: mailConfigured(),
  });
});

// --------------------------------------------------------------- profile ----

router.patch('/profile', requireCustomer, (req, res) => {
  const parsed = z.strictObject({
    fullName: z.string().max(120).optional(),
    phone: z.string().max(24).optional(),
    defaultArea: z.string().max(80).optional(),
    defaultAddress: z.string().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID', message: 'Check the fields.' });
  }

  // The email is deliberately not editable. It is the identity the account was
  // proved with; changing it would move the account to an address nobody has
  // demonstrated they control.
  const column = {
    fullName: 'full_name', phone: 'phone',
    defaultArea: 'default_area', defaultAddress: 'default_address',
  };
  const sets = [];
  const values = { id: req.customer.id };
  for (const [key, value] of Object.entries(parsed.data)) {
    sets.push(`${column[key]} = @${key}`);
    values[key] = value;
  }
  if (sets.length) {
    db.get().prepare(
      `UPDATE profiles SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`,
    ).run(values);
  }
  res.json({ customer: readCustomer(req, res) });
});

// ---------------------------------------------------------------- orders ----

/**
 * GET /api/account/orders — everything this account has ordered.
 *
 * Keyed on `profile_id`, which is set only by `claimProfile` after the address
 * was proved. Deliberately NOT keyed on the email column directly: that would
 * make the history readable by anyone who could get a session for an address,
 * including one typed at checkout and never verified.
 */
router.get('/orders', requireCustomer, (req, res) => {
  const database = db.get();
  const orders = database.prepare(`
    SELECT * FROM orders WHERE profile_id = ? ORDER BY id DESC LIMIT 100
  `).all(req.customer.id);

  res.json({
    orders: orders.map((order) => ({
      reference: order.reference,
      status: order.status,
      fulfilment: order.fulfilment,
      createdAt: order.created_at,
      totals: {
        subtotal: order.subtotal,
        discount: order.discount,
        delivery: order.delivery,
        total: order.total,
      },
      items: database
        .prepare('SELECT name, name_ar, qty, unit_price, line_total FROM order_items WHERE order_id = ?')
        .all(order.id)
        .map((item) => ({
          name: item.name,
          nameAr: item.name_ar || undefined,
          qty: item.qty,
          unitPrice: item.unit_price,
          lineTotal: item.line_total,
        })),
    })),
  });
});

export default router;
